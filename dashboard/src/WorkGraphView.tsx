import { useEffect, useState } from 'react';
import { Badge, Button, Textarea } from '@mantine/core';
import { IconGitPullRequest } from '@tabler/icons-react';
import { openDecisions } from './orchestration';
import type { GraphMessage, OrchestrationSource, PlanUnit, WorkGraph, WorkUnit } from './orchestration';
import { livePageHref } from './livePageHref';
import './orchestration.css';

const messageLabels: Record<GraphMessage['type'], string> = {
  handoff: 'Handoff', collaboration_request: 'Request', finding: 'Finding', decision_request: 'Decision needed',
  decision_resolution: 'Decision', state_update: 'Update',
};
const shortCommit = (commit?: string) => commit ? commit.slice(0, 7) : '';

export function StateBadge({ state }: { state: string }) {
  return <Badge className={`work-state ${state}`} variant="light">{state}</Badge>;
}

/** What a unit is, who executes it, and what it waits for. A plan's units have no state yet. */
export function UnitFacts({ unit, agent, planned = false, live = false }: {
  unit: PlanUnit; agent: string; planned?: boolean; live?: boolean;
}) {
  return <>
    <span className="work-unit-title"><b>{unit.key}</b><span>{unit.title}</span></span>
    <span className="work-unit-meta">
      <span>{unit.kind}</span>
      <span>{unit.kind === 'integrate' ? 'Zenchron (deterministic merge)' : planned && live && unit.agent_id
        ? <a href={livePageHref('agents', { profile: unit.agent_id })}>{agent || unit.agent_id}</a> : agent || 'Unassigned'}</span>
      {unit.profile_version && <span>{planned ? 'Planned profile' : 'Recorded profile'} v{unit.profile_version}</span>}
      {unit.persona_id && <span>{planned ? 'Planned persona' : 'Recorded persona'} {unit.persona_id} · v{unit.persona_version ?? 'unknown'}</span>}
      {unit.depends_on.length > 0 && <span>after {unit.depends_on.join(', ')}</span>}
      {unit.capabilities.length > 0 && <span>needs {unit.capabilities.join(', ')}</span>}
    </span>
  </>;
}

function Unit({ graph, unit, source, showRunLinks }: {
  graph: WorkGraph; unit: WorkUnit; source: OrchestrationSource; showRunLinks: boolean;
}) {
  const [error, setError] = useState('');
  return <li className="work-unit">
    <UnitFacts unit={unit} agent={unit.agent_name ?? ''} />
    <StateBadge state={unit.state} />
    {(unit.failure || unit.reason) && <p className={unit.failure ? 'work-unit-failure' : 'work-unit-reason'}>
      {unit.failure || unit.reason}</p>}
    <span className="work-unit-meta">
      {unit.candidate && <span>candidate <code>{shortCommit(unit.candidate)}</code></span>}
      {unit.verdict && <span>verdict: {unit.verdict}</span>}
      {unit.run_ids.length > 0 && <span>{unit.run_ids.length} run{unit.run_ids.length === 1 ? '' : 's'}</span>}
      {showRunLinks && unit.run_ids.map((runID) => <a key={runID} href={livePageHref('reviews', { run: runID })}
        aria-label={`Open run ${runID} in Reviews`} title={runID}>Review run {shortCommit(runID)} ↗</a>)}
      {unit.pull_request_url && <a href={unit.pull_request_url} target="_blank" rel="noreferrer">
        <IconGitPullRequest size={12} aria-hidden="true" /> Open pull request ↗</a>}
      {unit.publication_authorization_required && unit.run_ids.length > 0 && <Button id={`authorize-publication-${graph.id}`}
        size="compact-xs" color="violet" disabled={!source.authorizePublication} title={source.readOnlyReason || undefined}
        onClick={() => { setError(''); source.authorizePublication?.(unit.run_ids.at(-1)!, unit.candidate ?? '')
          .catch((cause: Error) => setError(cause.message)); }}>
        Authorize PR creation for {shortCommit(unit.candidate)}
      </Button>}
      {unit.state === 'failed' && <Button size="compact-xs" variant="default" disabled={!source.retryUnit}
        title={source.readOnlyReason || undefined}
        onClick={() => { setError(''); source.retryUnit?.(graph.id, unit.key).catch((cause: Error) => setError(cause.message)); }}>
        Retry {unit.key}</Button>}
    </span>
    {error && <p className="work-unit-failure" role="alert">{error}</p>}
  </li>;
}

function Decision({ graph, request, source }: { graph: WorkGraph; request: GraphMessage; source: OrchestrationSource }) {
  const [resolution, setResolution] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const isRequestedAction = new URLSearchParams(window.location.search).get('decision') === request.id;
  useEffect(() => {
    if (isRequestedAction) document.getElementById(`work-decision-${request.id}`)?.querySelector('textarea')?.focus();
  }, [isRequestedAction, request.id]);
  async function resolve() {
    setSending(true);
    setError('');
    try {
      await source.resolve?.(graph.id, request.id, resolution.trim());
      setResolution('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not record the decision.');
    } finally {
      setSending(false);
    }
  }
  return <form id={`work-decision-${request.id}`} className="work-decision" aria-label={`Decision for ${request.from}`}
    onSubmit={(event) => { event.preventDefault(); void resolve(); }}>
    <b>{request.from} needs a decision</b>
    <p>{request.body}</p>
    {request.notes.length > 0 && <div className="work-decision-options">{request.notes.map((option) =>
      <Button key={option} size="compact-xs" variant="default" type="button" onClick={() => setResolution(option)}>{option}</Button>)}</div>}
    <Textarea aria-label={`Decision for ${request.from}`} placeholder="Your decision; the agent continues with it"
      value={resolution} maxLength={2000} minRows={2} onChange={(event) => setResolution(event.currentTarget.value)} />
    {error && <p className="work-unit-failure" role="alert">{error}</p>}
    <Button type="submit" size="xs" color="violet" loading={sending} disabled={!source.resolve || !resolution.trim()}
      title={source.readOnlyReason || undefined}>Resolve decision</Button>
  </form>;
}

/** Typed messages of a graph, oldest first: who said what to whom about which commit. */
export function GraphMessages({ messages }: { messages: GraphMessage[] }) {
  if (!messages.length) return <p className="work-empty">No handoffs, findings, or decisions yet.</p>;
  return <ol className="work-messages" aria-label="Handoffs, findings, and decisions">{messages.map((message) =>
    <li key={message.id} className={message.type}>
      <span className="work-message-head"><b>{messageLabels[message.type]}</b>
        <span>{message.type === 'decision_resolution' ? `by ${message.by}` : message.from}
          {message.to.length > 0 && ` → ${message.to.join(', ')}`}</span>
        {message.commit && <code>{shortCommit(message.commit)}</code>}
        {message.severity && <em>{message.severity}</em>}</span>
      {message.title && <b>{message.title}{message.file && <small> {message.file}{message.line ? `:${message.line}` : ''}</small>}</b>}
      {message.body && <p>{message.body}</p>}
      {message.notes.length > 0 && message.type !== 'decision_request' && <ul>{message.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
    </li>)}</ol>;
}

/** One work graph: status, every unit with its state and waiting reason, open decisions, and the messages. */
export function WorkGraphView({ graph, source, showRunLinks = false }: {
  graph: WorkGraph; source: OrchestrationSource; showRunLinks?: boolean;
}) {
  const [error, setError] = useState('');
  const requestedPublication = new URLSearchParams(window.location.search).get('publication_graph') === graph.id;
  useEffect(() => {
    if (requestedPublication) document.getElementById(`authorize-publication-${graph.id}`)?.focus();
  }, [graph.id, requestedPublication]);
  const finished = graph.status === 'completed' || graph.status === 'cancelled';
  const done = graph.units.filter((unit) => unit.state === 'completed').length;
  return <section className="work-graph" aria-label={`Work graph for ${graph.objective_title}`}>
    <div className="work-graph-head">
      <StateBadge state={graph.status} />
      <span>{done} of {graph.units.length} units done · plan revision {graph.plan_revision} · {graph.project_name} ·
        up to {graph.max_parallel} in parallel</span>
      {!finished && <Button size="compact-xs" variant="default" disabled={!source.cancel} title={source.readOnlyReason || undefined}
        onClick={() => { setError(''); source.cancel?.(graph.id).catch((cause: Error) => setError(cause.message)); }}>
        Cancel work</Button>}
    </div>
    {error && <p className="work-unit-failure" role="alert">{error}</p>}
    {openDecisions(graph).map((request) => <Decision key={request.id} graph={graph} request={request} source={source} />)}
    <ul className="work-units" aria-label="Work units">
      {graph.units.map((unit) => <Unit key={unit.key} graph={graph} unit={unit} source={source}
        showRunLinks={showRunLinks} />)}
    </ul>
    <GraphMessages messages={graph.messages} />
  </section>;
}
