import { useState } from 'react';
import { Badge, Button, Textarea } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentRun } from './agentsData';
import { CodeDiff } from './reviews-preview-diff';

async function postRunAction(runID: string, action: string, failure: string, body?: unknown) {
  const response = await fetch(`/api/v1/agent-runs/${runID}/${action}`, body === undefined ? { method: 'POST' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.text()).trim() || `${failure} (${response.status})`);
}

/** An agent run's isolated branch diff with its commit, truncation notice, and pull-request publication state. */
export function LocalBranchDiff({ run, diff, truncated }: { run: AgentRun; diff: string; truncated: boolean }) {
  return <div className="reviews-diff-view">
    <div className="reviews-diff-meta">
      <span>{run.branch} → {run.base_branch || 'base branch'}</span>
      {run.commit_sha && <span>Local commit {run.commit_sha.slice(0, 7)}</span>}
      {truncated && <Badge color="yellow">Diff truncated at 128 KiB</Badge>}
    </div>
    {run.pull_request_url ? (
      <a className="reviews-pull-request-link" href={run.pull_request_url} target="_blank" rel="noreferrer">
        Open pull request #{run.pull_request_number} ↗
      </a>
    ) : run.pull_request_error ? (
      <span className="reviews-action-error" role="status">{run.pull_request_error}</span>
    ) : run.pull_request_enabled && run.status === 'succeeded' ? (
      <span className="reviews-provider-readonly" role="status">Pushing branch and opening pull request…</span>
    ) : run.status === 'succeeded' && run.commit_sha ? (
      <span className="reviews-provider-readonly">Automatic pull-request creation needs a GitHub origin and control-plane token.</span>
    ) : null}
    <CodeDiff label="Local branch diff" value={diff || 'No file changes in this run.'} />
  </div>;
}

/** Comment on a run, request changes (queues a follow-up attempt), or cancel it while it is active. */
export function LocalBranchActions({ run, onCommented }: { run?: AgentRun; onCommented: () => void }) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');
  const canComment = Boolean(run && ['succeeded', 'failed', 'cancelled'].includes(run.status) && run.diff_available);
  const reviewAction = useMutation({
    mutationFn: ({ action, body }: { action: 'comments' | 'request-changes'; body: string }) =>
      postRunAction(run!.id, action, 'Review action failed', { comment: body }),
    onSuccess: async () => {
      setComment('');
      onCommented();
      await queryClient.invalidateQueries({ queryKey: ['agent-runs'] });
    },
  });
  const cancelRun = useMutation({
    mutationFn: () => postRunAction(run!.id, 'cancel', 'Cancel failed'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-runs'] }),
  });
  return <>
    <div className="reviews-comment-composer">
      <Textarea
        aria-label="Review comment"
        placeholder="Leave a comment or describe the changes needed…"
        value={comment}
        onChange={(event) => setComment(event.currentTarget.value)}
        maxLength={1000}
        minRows={2}
        maxRows={3}
        disabled={!canComment || reviewAction.isPending}
      />
      {run && canComment && !run.can_request_changes && (
        <span className="reviews-action-hint">
          Request changes requires an online worker, model runtime, code-write permission, and a remaining attempt.
        </span>
      )}
      {reviewAction.isError && <span className="reviews-action-error" role="alert">{reviewAction.error.message}</span>}
      <div>
        <Button
          variant="default"
          disabled={!canComment || !comment.trim() || reviewAction.isPending}
          onClick={() => reviewAction.mutate({ action: 'comments', body: comment.trim() })}
        >Add comment</Button>
        <Button
          color="violet"
          disabled={!run?.can_request_changes || !comment.trim() || reviewAction.isPending}
          onClick={() => reviewAction.mutate({ action: 'request-changes', body: comment.trim() })}
        >Request changes</Button>
      </div>
    </div>
    <div className="reviews-review-actions">
      <Button
        variant="default"
        disabled={!run || !['queued', 'running'].includes(run.status) || run.cancel_requested || cancelRun.isPending}
        onClick={() => cancelRun.mutate()}
      >{run?.cancel_requested ? 'Stopping…' : 'Cancel run'}</Button>
      <span />
      {cancelRun.isError && <span className="reviews-action-error" role="alert">{cancelRun.error.message}</span>}
    </div>
  </>;
}
