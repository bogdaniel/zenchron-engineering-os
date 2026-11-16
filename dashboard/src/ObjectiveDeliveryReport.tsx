import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button } from '@mantine/core';
import { z } from 'zod';
import './objective-delivery-report.css';

const executionSchema = z.object({
  run_id: z.string(), status: z.string(), profile_id: z.string().optional(), profile_name: z.string().optional(),
  profile_version: z.number().optional(), persona_id: z.string().optional(), persona_name: z.string().optional(),
  persona_version: z.number().optional(), provider: z.string().optional(), provider_version: z.string().optional(),
  attempts: z.number(), candidate_commit: z.string().optional(), review_verdict: z.string().optional(),
  publication: z.string().optional(), pull_request_url: z.string().optional(), failure_recorded: z.boolean().optional(),
});
const reportSchema = z.object({
  graph_id: z.string(), objective_id: z.string(), objective_title: z.string(), plan_revision: z.number(),
  workflow_id: z.string().optional(), workflow_version: z.number().optional(), status: z.string(),
  approved_plan: z.object({ revision: z.number(), status: z.string(), hash: z.string(), summary: z.string(),
    approved_by: z.string().optional(), approved_at: z.string().optional() }),
  units: z.array(z.object({ key: z.string(), kind: z.string(), agent_id: z.string().optional(), agent_name: z.string(),
    state: z.string(), reason: z.string().optional(), candidate: z.string().optional(), verdict: z.string().optional(), run_ids: z.array(z.string()),
    attempts: z.number(), providers: z.array(z.string()), executions: z.array(executionSchema) })),
  handoffs: z.array(z.object({ from: z.string(), run_id: z.string().optional(), attempt: z.number().optional(),
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
  pull_request_url: z.string().optional(),
});
type Report = z.infer<typeof reportSchema>;

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
  } finally { URL.revokeObjectURL(url); }
}

export function ObjectiveDeliveryReport({ graphID }: { graphID: string }) {
  const [expanded, setExpanded] = useState(false);
  const query = useQuery({ queryKey: ['work-graph-report', graphID], queryFn: () => loadReport(graphID),
    enabled: expanded, retry: false });
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
    <h5>{report.objective_title}</h5>
    <p>Approved plan revision {report.approved_plan.revision} · {report.approved_plan.status}
      {report.approved_plan.approved_by && ` · approved by ${report.approved_plan.approved_by}`}
      {report.approved_plan.approved_at && ` · ${new Date(report.approved_plan.approved_at).toLocaleString()}`}</p>
    <p>{report.approved_plan.summary || 'No plan summary recorded.'}</p>
    {report.workflow_id && <p>Workflow <a href={`?workflow=${encodeURIComponent(report.workflow_id)}#workflows`}>{report.workflow_id}</a> · version {report.workflow_version ?? 'unknown'}</p>}
    <h5>Executed work units</h5>
    <div className="objective-delivery-units">{report.units.map((unit) => <article key={unit.key}>
      <div className="objective-delivery-unit-title"><b>{unit.key} · {unit.kind}</b><Badge variant="light">{unit.state}</Badge></div>
      <p>{unit.agent_name || 'Zenchron'}{unit.agent_id && <> · <a href={`?profile=${encodeURIComponent(unit.agent_id)}#agents`}>Agent profile</a> ({unit.agent_id})</>}
        {unit.candidate && <> · candidate <code>{unit.candidate}</code></>}
        {unit.verdict && <> · verdict {unit.verdict}</>}</p>
      {unit.executions.map((run) => <div className="objective-delivery-run" key={run.run_id}>
        <span><a href={`?run=${encodeURIComponent(run.run_id)}#reviews`}>Run {run.run_id}</a> · {run.status} · {run.attempts} attempt{run.attempts === 1 ? '' : 's'}</span>
        <span>{run.profile_name ? `${run.profile_name} v${run.profile_version ?? 'unknown'}` : 'Zenchron integration'}
          {run.persona_name && ` · ${run.persona_name} v${run.persona_version ?? 'unknown'}`}
          {run.provider && ` · ${run.provider}${run.provider_version ? ` ${run.provider_version}` : ''}`}</span>
        {run.candidate_commit && <span>Commit <code>{run.candidate_commit}</code></span>}
        {run.review_verdict && <span>Review verdict: {run.review_verdict}</span>}
        {run.publication && <span>Publication state: {run.publication}</span>}
        {run.pull_request_url && <a href={run.pull_request_url} target="_blank" rel="noreferrer">Open pull request ↗</a>}
        {run.failure_recorded && <span>Failure recorded for this run.</span>}
      </div>)}
    </article>)}</div>
    <p>Pull request: {report.pull_request_url
      ? <a href={report.pull_request_url} target="_blank" rel="noreferrer">{report.pull_request_url}</a>
      : report.units.find((unit) => unit.kind === 'integrate')?.reason || 'Unknown · no pull-request link was recorded.'}</p>
    <h5>Handoffs and decisions</h5>
    {report.handoffs.map((handoff, index) => <p key={`${handoff.run_id}-${handoff.attempt}-${index}`}>
      <b>{handoff.from}</b>{handoff.commit && <> · <code>{handoff.commit}</code></>} · {handoff.summary}
      {handoff.notes.length > 0 && ` · ${handoff.notes.join('; ')}`}</p>)}
    {report.decisions.map((decision) => <p key={decision.request_id}>
      Decision: {decision.question} · {decision.resolution ? `resolved by ${decision.resolved_by}: ${decision.resolution}` : 'outstanding'}
    </p>)}
    {!report.handoffs.length && !report.decisions.length && <p>No handoffs or human decisions were recorded.</p>}
    {report.outstanding_steps.length > 0 && <><h5>Outstanding steps</h5><ul>{report.outstanding_steps.map((step) =>
      <li key={step.key}>{step.key} · {step.state}{step.reason && ` · ${step.reason}`}</li>)}</ul></>}
    <h5>Recorded measurements</h5>
    <dl className="objective-delivery-metrics">
      <dt>WorkGraph duration</dt><dd>{metrics.wall_clock_seconds === undefined || unknown.has('wall_clock_seconds')
        ? 'Unknown' : `${metrics.wall_clock_seconds.toFixed(1)} seconds`}</dd>
      <dt>Work units / runs / attempts</dt><dd>{metrics.unit_count} / {metrics.run_count} / {metrics.attempt_count}</dd>
      <dt>Failed attempts / max concurrent attempts</dt><dd>{metrics.failed_attempts} / {metrics.max_concurrency}</dd>
      <dt>Reviews / findings / remediation passes</dt><dd>{metrics.review_rounds} / {metrics.findings} / {metrics.remediation_passes}</dd>
      <dt>Recorded human actions</dt><dd>{metrics.human_actions} recorded; complete total unknown</dd>
      <dt>Provider reported tokens</dt><dd>{metrics.input_tokens === undefined ? 'Unknown' : `${metrics.input_tokens} input / ${metrics.output_tokens ?? 'unknown'} output`}
        {` · usage on ${metrics.runs_with_usage}/${metrics.run_count} runs`}</dd>
      <dt>Provider reported cost</dt><dd>{metrics.cost_usd === undefined ? 'Unknown' : `$${metrics.cost_usd.toFixed(4)}`}
        {` · cost reported on ${metrics.runs_with_cost}/${metrics.run_count} runs`}</dd>
      <dt>Pull request</dt><dd>{report.pull_request_url ? <a href={report.pull_request_url} target="_blank" rel="noreferrer">{report.pull_request_url}</a> : 'Not observed'}</dd>
    </dl>
    {unknown.size > 0 && <p className="objective-delivery-unknown">Unknown or incomplete: {Array.from(unknown).join(', ')}</p>}
    {!metrics.human_actions_complete && <p className="objective-delivery-unknown">
      Human action totals are incomplete: the system records plan approval and resolved decisions, not every operator action.
    </p>}
  </div>;
}
