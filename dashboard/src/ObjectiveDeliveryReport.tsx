import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button } from '@mantine/core';
import { z } from 'zod';
import { livePageHref } from './livePageHref';
import './objective-delivery-report.css';

const executionSchema = z.object({
  run_id: z.string(), result_attempt: z.number().optional(), updated_at: z.string().optional(), status: z.string(),
  profile_id: z.string().optional(), profile_name: z.string().optional(),
  profile_version: z.number().optional(), model: z.string().optional(),
  persona_id: z.string().optional(), persona_name: z.string().optional(),
  persona_version: z.number().optional(), provider: z.string().optional(), provider_version: z.string().optional(),
  attempts: z.number(), candidate_commit: z.string().optional(), base_commit_sha: z.string().optional(),
  candidate_tree_sha: z.string().optional(), review_verdict: z.string().optional(),
  verification: z.string().optional(), publication: z.string().optional(), pull_request_url: z.string().optional(),
  failure_recorded: z.boolean().optional(),
});
const reportSchema = z.object({
  graph_id: z.string(), graph_revision: z.number().optional(), objective_id: z.string(), objective_title: z.string(), plan_revision: z.number(),
  workflow_id: z.string().optional(), workflow_version: z.number().optional(),
  workflow_mode: z.enum(['compiled', 'guidance']).optional(), status: z.string(),
  approved_plan: z.object({ revision: z.number(), status: z.string(), hash: z.string(), summary: z.string(),
    approved_by: z.string().optional(), approved_at: z.string().optional() }).optional(),
  units: z.array(z.object({ key: z.string(), kind: z.string(), agent_id: z.string().optional(), agent_name: z.string(),
    state: z.string(), reason: z.string().optional(), candidate: z.string().optional(), verdict: z.string().optional(), run_ids: z.array(z.string()),
    attempts: z.number(), providers: z.array(z.string()), executions: z.array(executionSchema) })),
  handoffs: z.array(z.object({ message_id: z.string().optional(), from: z.string(), run_id: z.string().optional(), attempt: z.number().optional(),
    commit: z.string().optional(), summary: z.string(), notes: z.array(z.string()) })),
  decisions: z.array(z.object({ request_id: z.string(), question: z.string(), options: z.array(z.string()),
    resolution: z.string().optional(), resolved_by: z.string().optional(), resolved_at: z.string().optional() })),
  outstanding_steps: z.array(z.object({ key: z.string(), state: z.string(), reason: z.string().optional() })),
  measurements: z.object({ unit_count: z.number(), run_count: z.number(), attempt_count: z.number(),
    failed_attempts: z.number(), review_rounds: z.number(), findings: z.number(), remediation_passes: z.number(),
    decisions_requested: z.number(), decisions_resolved: z.number(), human_actions: z.number(),
    human_actions_complete: z.boolean(), max_concurrency: z.number(), wall_clock_seconds: z.number().optional(),
    input_tokens: z.number().optional(), output_tokens: z.number().optional(), cost_usd: z.number().optional(),
    runs_with_usage: z.number(), runs_with_cost: z.number(), unknown: z.array(z.string()) }),
  unknown_evidence: z.array(z.string()).default([]),
  publication_authority: z.object({ source_run_id: z.string(), graph_id: z.string(), graph_revision: z.number(),
    plan_revision: z.number(), plan_hash: z.string(), commit_sha: z.string(), by: z.string(), at: z.string(), attempt: z.number() }).optional(),
  pull_request_url: z.string().optional(),
  pull_request_external_state: z.object({ number: z.number(), state: z.enum(['open', 'closed']), draft: z.boolean(),
    merged: z.boolean(), head_sha: z.string(), candidate_matches_head: z.boolean().optional(), observed_at: z.string(),
    candidate_checks: z.object({ head_sha: z.string(), observed_at: z.string(), runs: z.array(z.object({ id: z.number().optional(), name: z.string(),
      status: z.string(), conclusion: z.string().optional() })) }).optional() }).optional(),
});
type Report = z.infer<typeof reportSchema>;
const unknownEvidenceLabels: Record<string, string> = {
  candidate_tree_sha: 'candidate tree SHA',
  candidate_checks: 'GitHub checks for the integrated candidate',
  policy_backed_assurance: 'independent policy-backed assurance',
  publication_authority: 'publication authority',
  pull_request_external_state: 'current pull request state',
  missing_run_records: 'details for one or more referenced runs',
  approved_plan: 'the approved plan revision',
};
const unknownMeasurementLabels: Record<string, string> = {
  attempt_count_for_some_runs: 'attempt totals for some runs',
  failed_attempts_for_some_runs: 'failed attempt totals for some runs',
  max_concurrency_for_some_runs: 'concurrency from available attempt records',
  remediation_passes_for_some_runs: 'remediation totals for some runs',
};

async function loadReport(graphID: string): Promise<Report> {
  const response = await fetch(`/api/v1/work-graphs/${graphID}/report`);
  if (!response.ok) throw new Error((await response.text()).trim() || `Report request failed (${response.status})`);
  return reportSchema.parse(await response.json());
}

function downloadReport(report: Report) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = `zenchron-delivery-${report.graph_id}.json`;
    link.click();
  } finally { window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

export function ObjectiveDeliveryReport({ graphID }: { graphID: string }) {
  const [expanded, setExpanded] = useState(false);
  const query = useQuery({ queryKey: ['work-graph-report', graphID], queryFn: () => loadReport(graphID),
    enabled: expanded, refetchInterval: expanded ? 5_000 : false, retry: false });
  return <section className="objective-delivery-report" aria-label="Objective delivery report">
    <div className="objective-delivery-heading">
      <div><h4>Delivery evidence</h4><p>Recorded execution and publication facts for this WorkGraph.</p></div>
      <Button size="xs" variant="default" onClick={() => setExpanded((current) => !current)}>
        {expanded ? 'Hide report' : 'View delivery report'}
      </Button>
    </div>
    {!expanded ? null : query.isLoading ? <p role="status">Loading delivery report…</p>
      : query.isError ? <div><p role="alert">Could not load delivery report: {query.error.message}</p>
        <Button size="xs" variant="default" onClick={() => void query.refetch()}>Retry</Button></div>
        : query.data && <ReportDetails report={query.data} />}
  </section>;
}

function ReportDetails({ report }: { report: Report }) {
  const metrics = report.measurements;
  const unknown = new Set(metrics.unknown);
  return <div className="objective-delivery-content">
    <div className="objective-delivery-actions">
      <Badge variant="light">{report.status}</Badge>
      <Button size="xs" variant="default" onClick={() => downloadReport(report)}>Export JSON</Button>
    </div>
    <p>WorkGraph <code>{report.graph_id}</code> · revision {report.graph_revision ?? 'unknown'}</p>
    <h5>{report.objective_title}</h5>
    {report.approved_plan ? <>
      <p>Approved plan revision {report.approved_plan.revision} · {report.approved_plan.status}
        {report.approved_plan.approved_by && ` · approved by ${report.approved_plan.approved_by}`}
        {report.approved_plan.approved_at && ` · ${new Date(report.approved_plan.approved_at).toLocaleString()}`}</p>
      <p>{report.approved_plan.summary || 'No plan summary recorded.'}</p>
    </> : <p>Approved plan revision unavailable: its durable record is missing.</p>}
    {report.workflow_id && <p>{report.workflow_mode === 'compiled' ? 'Compiled from workflow ' : report.workflow_mode === 'guidance' ? 'Guided by workflow ' : 'Workflow execution mode unknown · workflow '}<a href={livePageHref('workflows', { workflow: report.workflow_id })}>{report.workflow_id}</a> · version {report.workflow_version ?? 'unknown'}</p>}
    <h5>Executed work units</h5>
    <div className="objective-delivery-units">{report.units.map((unit) => {
      const storedRunIDs = new Set(unit.executions.map((run) => run.run_id));
      return <article key={unit.key}>
      <div className="objective-delivery-unit-title"><b>{unit.key} · {unit.kind}</b><Badge variant="light">{unit.state}</Badge></div>
      <p>{unit.agent_name || 'Zenchron'}{unit.agent_id && <> · <a href={livePageHref('agents', { profile: unit.agent_id })}>Agent profile</a> ({unit.agent_id})</>}
        {unit.candidate && <> · candidate <code>{unit.candidate}</code></>}
        {unit.verdict && <> · verdict {unit.verdict}</>}</p>
      {unit.run_ids.filter((runID) => !storedRunIDs.has(runID)).map((runID) =>
        <p key={runID}>Run <code>{runID}</code> details unavailable: its durable record is missing.</p>)}
      {unit.executions.map((run) => <div className="objective-delivery-run" key={run.run_id}>
        <span>
          <a href={livePageHref('reviews', { run: run.run_id })}>Run {run.run_id}</a>
          {' · result attempt '}{run.result_attempt ?? 'unknown'}
          {' · record updated '}{run.updated_at ? new Date(run.updated_at).toLocaleString() : 'unknown'}
          {' · '}{run.status} · {run.attempts} attempt{run.attempts === 1 ? '' : 's'}
        </span>
        <span>{run.profile_name
          ? `${run.profile_name} v${run.profile_version ?? 'unknown'} · Model: ${run.model || 'unknown'}`
          : 'Zenchron integration'}
          {run.persona_name && ` · ${run.persona_name} v${run.persona_version ?? 'unknown'}`}
          {run.provider && ` · ${run.provider}${run.provider_version ? ` ${run.provider_version}` : ''}`}</span>
        {unit.kind === 'review' && <span>Reviewed candidate: {run.base_commit_sha ? <code>{run.base_commit_sha}</code> : 'unknown'}</span>}
        <span>Worker-reported verification: {run.verification || 'Not run'}</span>
        {run.candidate_commit && <span>Commit <code>{run.candidate_commit}</code></span>}
        {run.candidate_tree_sha && <span>Tree <code>{run.candidate_tree_sha}</code></span>}
        {run.review_verdict && <span>Review verdict: {run.review_verdict}</span>}
        {run.publication && <span>Publication state: {run.publication}</span>}
        {run.pull_request_url && <a href={run.pull_request_url} target="_blank" rel="noreferrer">Open pull request ↗</a>}
        {run.failure_recorded && <span>Failure recorded for this run.</span>}
      </div>)}
      </article>;
    })}</div>
    <h5>Execution and publication</h5>
    <p>WorkGraph execution: {report.status}</p>
    <p>Recorded pull request: {report.pull_request_url
      ? <a href={report.pull_request_url} target="_blank" rel="noreferrer">{report.pull_request_url}</a>
      : <>{report.units.find((unit) => unit.kind === 'integrate')?.reason || 'No pull-request URL was recorded.'}
        {' WorkGraph completion does not establish publication.'}</>}</p>
    {report.publication_authority && <p aria-label="Recorded publication authorization">
      Human authorized PR creation for candidate <code>{report.publication_authority.commit_sha}</code> ·{' '}
      {report.publication_authority.by} · {new Date(report.publication_authority.at).toLocaleString()} ·{' '}
      WorkGraph revision {report.publication_authority.graph_revision} · plan revision {report.publication_authority.plan_revision} ·{' '}
      plan hash <code>{report.publication_authority.plan_hash}</code> · run{' '}
      <a href={livePageHref('reviews', { run: report.publication_authority.source_run_id })}>
        {report.publication_authority.source_run_id}</a> · authorization attempt {report.publication_authority.attempt}
    </p>}
    {report.pull_request_external_state && <p aria-label="Observed GitHub pull request state">
      GitHub reports pull request #{report.pull_request_external_state.number} {report.pull_request_external_state.state}
      {report.pull_request_external_state.merged ? ' and merged' : ''}{report.pull_request_external_state.draft ? ' as a draft' : ''} · head{' '}
      <code>{report.pull_request_external_state.head_sha}</code>
      {report.pull_request_external_state.candidate_matches_head === undefined ? ' · candidate match unknown'
        : report.pull_request_external_state.candidate_matches_head ? ' · matches the integrated candidate' : ' · differs from the integrated candidate'}
      {' · observed '}{new Date(report.pull_request_external_state.observed_at).toLocaleString()}
    </p>}
    {report.pull_request_external_state?.candidate_checks && <div aria-label="GitHub checks for integrated candidate">
      <p>GitHub checks for candidate <code>{report.pull_request_external_state.candidate_checks.head_sha}</code>
        {' · observed '}{new Date(report.pull_request_external_state.candidate_checks.observed_at).toLocaleString()}</p>
      {report.pull_request_external_state.candidate_checks.runs.length === 0
        ? <p>No check runs were reported for this candidate.</p>
        : <ul>{report.pull_request_external_state.candidate_checks.runs.map((check, index) => <li key={`${check.name}-${index}`}>
          {check.id !== undefined && <>Check #{check.id} · </>}{check.name}{' · '}{check.status}
          {check.conclusion ? ` · ${check.conclusion}` : ''}
        </li>)}</ul>}
    </div>}
    <h5>Handoffs and decisions</h5>
    {report.handoffs.map((handoff, index) => <p key={`${handoff.run_id}-${handoff.attempt}-${index}`}>
      <b>{handoff.from}</b>{handoff.message_id && <> · message <code>{handoff.message_id}</code></>}
      {handoff.commit && <> · <code>{handoff.commit}</code></>} · {handoff.summary}
      {handoff.notes.length > 0 && ` · ${handoff.notes.join('; ')}`}</p>)}
    {report.decisions.map((decision) => <p key={decision.request_id}>
      Decision: {decision.question} · {decision.resolution ? `resolved by ${decision.resolved_by}: ${decision.resolution}` : 'outstanding'}
    </p>)}
    {!report.handoffs.length && !report.decisions.length && <p>No handoffs or human decisions were recorded.</p>}
    {report.unknown_evidence.length > 0 && <p className="objective-delivery-unknown">
      Unknown evidence: {report.unknown_evidence.map((item) => unknownEvidenceLabels[item] ?? item).join(', ')}.
    </p>}
    {report.outstanding_steps.length > 0 && <><h5>Outstanding steps</h5><ul>{report.outstanding_steps.map((step) =>
      <li key={step.key}>{step.key} · {step.state}{step.reason && ` · ${step.reason}`}</li>)}</ul></>}
    <h5>Recorded measurements</h5>
    <dl className="objective-delivery-metrics">
      <dt>WorkGraph duration</dt><dd>{metrics.wall_clock_seconds === undefined || unknown.has('wall_clock_seconds')
        ? 'Unknown' : `${metrics.wall_clock_seconds.toFixed(1)} seconds`}</dd>
      <dt>Work units / runs / attempts</dt><dd>{metrics.unit_count} / {metrics.run_count} / {metrics.attempt_count}
        {unknown.has('attempt_count_for_some_runs') ? ' (incomplete)' : ''}</dd>
      <dt>Failed attempts / max concurrent attempts</dt><dd>{metrics.failed_attempts}
        {unknown.has('failed_attempts_for_some_runs') ? ' (incomplete)' : ''} / {metrics.max_concurrency}
        {unknown.has('max_concurrency_for_some_runs') ? ' (incomplete)' : ''}</dd>
      <dt>Reviews / findings / remediation passes</dt><dd>{metrics.review_rounds} / {metrics.findings} / {metrics.remediation_passes}
        {unknown.has('remediation_passes_for_some_runs') ? ' (incomplete)' : ''}</dd>
      <dt>Recorded human actions</dt><dd>{metrics.human_actions} recorded; complete total unknown</dd>
      <dt>Provider reported tokens</dt><dd>{metrics.input_tokens === undefined ? 'Unknown' : `${metrics.input_tokens} input / ${metrics.output_tokens ?? 'unknown'} output`}
        {` · usage on ${metrics.runs_with_usage}/${metrics.run_count} runs`}</dd>
      <dt>Provider reported cost</dt><dd>{metrics.cost_usd === undefined ? 'Unknown' : `$${metrics.cost_usd.toFixed(4)}`}
        {` · cost reported on ${metrics.runs_with_cost}/${metrics.run_count} runs`}</dd>
      <dt>Pull request</dt><dd>{report.pull_request_url ? <a href={report.pull_request_url} target="_blank" rel="noreferrer">{report.pull_request_url}</a> : 'Not observed'}</dd>
    </dl>
    {unknown.size > 0 && <p className="objective-delivery-unknown">Unknown or incomplete: {Array.from(unknown)
      .map((item) => unknownMeasurementLabels[item] ?? item).join(', ')}</p>}
    {!metrics.human_actions_complete && <p className="objective-delivery-unknown">
      Human action totals are incomplete: the system records plan approvals, resolved decisions, and publication authorizations, not every operator action.
    </p>}
  </div>;
}
