import type { ReactNode } from 'react';
import { Button } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import './run-evidence.css';

/** Fields a run carries as execution evidence; merged into the run schema used across the dashboard. */
export const runEvidenceFields = {
  repository: z.string().optional(), issue_number: z.number().optional(), issue_title: z.string().optional(),
  issue_url: z.string().optional(), base_commit: z.string().optional(), provider: z.string().optional(),
  provider_version: z.string().optional(), termination_reason: z.string().optional(),
  verification: z.string().optional(), publication: z.string().optional(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number(), cost_usd: z.number().optional() }).optional(),
  attempt_log: z.array(z.object({
    attempt: z.number(), worker_id: z.string(), started_at: z.string(), finished_at: z.string().optional(),
    status: z.string().optional(), termination_reason: z.string().optional(), commit_sha: z.string().optional(),
  })).optional(),
};
const evidenceRunSchema = z.object({
  id: z.string(), status: z.string(), worker_name: z.string(), branch: z.string(), commit_sha: z.string().optional(),
  pull_request_number: z.number().optional(), pull_request_url: z.string().optional(), ...runEvidenceFields,
});
type EvidenceRun = z.infer<typeof evidenceRunSchema>;

const eventsSchema = z.array(z.object({
  sequence: z.number(), attempt: z.number(), at: z.string(), kind: z.string(), message: z.string(),
}));
const pullRequestSchema = z.object({
  state: z.string(), merged: z.boolean(),
  checks: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable().optional() })).nullable(),
});

async function loadJSON<T>(path: string, schema: z.ZodType<T>, label: string) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${label} unavailable (${response.status})`);
  return schema.parse(await response.json());
}

const labels: Record<string, string> = {
  passed: 'Passed', failed: 'Failed', not_configured: 'Not configured on the worker', published: 'Pull request published',
  push_failed: 'Branch push failed', pull_request_failed: 'Branch pushed; pull request not created',
  no_changes: 'No changes to publish', completed: 'Completed', provider_exit: 'Provider reported a failure',
  wall_clock_timeout: 'Wall-clock limit reached', inactivity_timeout: 'Inactivity limit reached',
  tool_timeout: 'Tool-activity limit reached', cancelled: 'Cancelled', lease_lost: 'Worker lease lost',
  lease_expired: 'Worker lease expired', verification_failed: 'Verification failed', worker_error: 'Worker error',
  succeeded: 'Succeeded',
};
const label = (value: string | undefined, fallback: string) => (value ? labels[value] ?? value : fallback);
const shortCommit = (value: string | undefined) => (value ? value.slice(0, 12) : 'None');

/** Execution evidence for one agent run: identities, verification, publication, CI checks, attempts, and events. */
export function RunEvidence({ run }: { run: EvidenceRun }) {
  const active = run.status === 'queued' || run.status === 'running';
  const events = useQuery({
    queryKey: ['agent-run-events', run.id, run.status], refetchInterval: active ? 2_000 : false,
    queryFn: () => loadJSON(`/api/v1/agent-runs/${run.id}/events`, eventsSchema, 'Run events'),
  });
  const pullRequest = useQuery({
    queryKey: ['agent-run-pull-request', run.id, run.commit_sha], enabled: Boolean(run.pull_request_number), retry: false,
    queryFn: () => loadJSON(`/api/v1/agent-runs/${run.id}/pull-request`, pullRequestSchema, 'Pull request status'),
  });
  const usage = run.usage
    ? `${run.usage.input_tokens.toLocaleString()} input · ${run.usage.output_tokens.toLocaleString()} output tokens`
      + (run.usage.cost_usd === undefined ? '' : ` · $${run.usage.cost_usd.toFixed(2)} reported`)
    : 'Not reported';
  const facts: [string, ReactNode][] = [
    ['Issue', run.issue_number
      ? <a href={run.issue_url} target="_blank" rel="noreferrer">#{run.issue_number} {run.issue_title}</a> : 'Prompt-only run'],
    ['Provider', run.provider_version || run.provider || 'Not reported'],
    ['Worker', run.worker_name],
    ['Branch', run.branch],
    ['Base commit', shortCommit(run.base_commit)],
    ['Result commit', shortCommit(run.commit_sha)],
    ['Execution', label(run.termination_reason, active ? 'In progress' : 'Not reported')],
    ['Verification', label(run.verification, 'Not run')],
    ['Publication', label(run.publication, 'Not published')],
    ['Pull request', run.pull_request_url
      ? <a href={run.pull_request_url} target="_blank" rel="noreferrer">#{run.pull_request_number} on GitHub ↗</a> : 'None'],
    ['Usage', usage],
  ];
  const queryClient = useQueryClient();
  const followUp = useMutation({
    mutationFn: async (action: 'sync-reviews' | 'publish') => {
      const response = await fetch(`/api/v1/agent-runs/${run.id}/${action}`, { method: 'POST' });
      if (!response.ok) throw new Error((await response.text()).trim() || `Request failed (${response.status})`);
      const result = await response.json() as { imported?: number };
      return action === 'publish' ? 'Pull request published.'
        : result.imported ? `Imported ${result.imported} change request${result.imported === 1 ? '' : 's'} from GitHub.`
          : 'No new change requests on GitHub.';
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-runs'] }),
  });
  const checks = pullRequest.data?.checks ?? [];
  const attempts = run.attempt_log ?? [];
  return <div className="run-evidence">
    <dl className="run-evidence-facts" aria-label="Run evidence summary">
      {facts.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
    </dl>
    {!active && (run.pull_request_number !== undefined || run.publication === 'pull_request_failed') && (
      <div className="run-evidence-actions">
        {run.publication === 'pull_request_failed' && <Button size="compact-xs" variant="default"
          loading={followUp.isPending} onClick={() => followUp.mutate('publish')}>Retry pull request</Button>}
        {run.pull_request_number !== undefined && <Button size="compact-xs" variant="default"
          loading={followUp.isPending} onClick={() => followUp.mutate('sync-reviews')}>Import change requests from GitHub</Button>}
        {followUp.isError && <span role="alert">{followUp.error.message}</span>}
        {followUp.isSuccess && <span role="status">{followUp.data}</span>}
      </div>
    )}
    {run.pull_request_number !== undefined && <section aria-label="Pull request checks">
      <h4>Pull request checks</h4>
      {pullRequest.isLoading ? <p role="status">Loading checks…</p>
        : pullRequest.isError ? <p role="alert">{pullRequest.error.message}</p>
          : checks.length === 0 ? <p>No check runs reported for this commit yet.</p>
            : <ul>{checks.map((check, index) => <li key={`${check.name}-${index}`}>
              <b>{check.name}</b><span>{check.conclusion || check.status}</span></li>)}</ul>}
    </section>}
    {attempts.length > 0 && <section aria-label="Run attempts">
      <h4>Attempts</h4>
      <ul>{attempts.map((attempt) => <li key={attempt.attempt}>
        <b>Attempt {attempt.attempt}</b>
        <span>{label(attempt.status, 'Running')}{attempt.commit_sha ? ` · commit ${shortCommit(attempt.commit_sha)}` : ''}
          {' · '}{new Date(attempt.started_at).toLocaleString()}</span>
      </li>)}</ul>
    </section>}
    <section aria-label="Run events">
      <h4>Events</h4>
      {events.isLoading ? <p role="status">Loading events…</p>
        : events.isError ? <p role="alert">{events.error.message}</p>
          : events.data?.length === 0 ? <p>No events recorded for this run.</p>
            : <ol className="run-evidence-events">{events.data?.map((event) => <li key={event.sequence}>
              <span className={`run-evidence-kind ${event.kind}`}>{event.kind}</span>
              <code>{event.message}</code>
              <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time>
            </li>)}</ol>}
    </section>
  </div>;
}
