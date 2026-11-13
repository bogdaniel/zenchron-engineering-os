import { Badge, Button, Menu, Textarea } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import {
  IconBookmark, IconChecks, IconDots, IconFileText, IconGitMerge, IconGitPullRequest, IconLink, IconMessageCircle,
  IconShieldCheck, IconSparkles, IconUserCheck,
} from '@tabler/icons-react';
import type { AgentRun } from './agentsData';
import { LocalBranchActions, LocalBranchDiff } from './LocalBranchReview';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import { GitHubMarkdown } from './reviews-markdown';
import { ReviewContext } from './reviews-preview-context';
import { PullRequestPatch } from './reviews-preview-diff';
import { RunEvidence } from './runEvidence';
import { capitalize } from './reviewsView';
import type {
  DetailTab, GitHubIssue, GitHubPullRequest, PullRequestDiff, PullRequestView, ReviewEvent, ReviewSection, ReviewsSource,
} from './reviewsView';

const stages = ['Code review', 'Evidence', 'Policy gates', 'CI', 'Merge'];
const detailTabs = [
  ['code-changes', 'Code changes', IconFileText], ['conversations', 'Conversations', IconMessageCircle],
  ['ai-suggestions', 'AI Suggestions', IconSparkles], ['evidence', 'Evidence', IconShieldCheck],
  ['checklist', 'Checklist', IconChecks], ['approvals', 'Approvals', IconUserCheck],
] as const;
const gitHubWritesUnavailable = 'This data source cannot write to GitHub';

type Draft = { value: string; set: (value: string) => void };
export type RunDiff = { data?: { diff: string; truncated: boolean }; isLoading: boolean; isError: boolean };

function PullRequestComposer({ source, pullRequest, draft }: { source: ReviewsSource; pullRequest: GitHubPullRequest; draft: Draft }) {
  const review = useMutation({
    mutationFn: (event: ReviewEvent) => source.github!.submitReview(pullRequest.number, event, draft.value.trim()),
    onSuccess: () => draft.set(''),
  });
  const blocked = !source.github || !draft.value.trim() || review.isPending;
  return <div className="reviews-github-composer">
    <Textarea aria-label="GitHub pull request review" placeholder="Leave a review comment or describe the changes needed…"
      value={draft.value} onChange={(event) => draft.set(event.currentTarget.value)}
      maxLength={1000} minRows={2} maxRows={3} disabled={!source.github || review.isPending}
      title={source.github ? undefined : gitHubWritesUnavailable} />
    <small>GitHub records the review under the configured control-plane token owner.</small>
    {review.isError && <span className="reviews-action-error" role="alert">{review.error.message}</span>}
    {review.isSuccess && <span className="reviews-action-success" role="status">{review.data}</span>}
    <div>
      <Button variant="default" disabled={blocked} onClick={() => review.mutate('COMMENT')}>Comment</Button>
      <Button color="violet" disabled={blocked} onClick={() => review.mutate('REQUEST_CHANGES')}>Request changes</Button>
    </div>
  </div>;
}

function IssueComposer({ source, issue, draft }: { source: ReviewsSource; issue: GitHubIssue; draft: Draft }) {
  const comment = useMutation({
    mutationFn: () => source.github!.commentOnIssue(issue.number, draft.value.trim()),
    onSuccess: () => draft.set(''),
  });
  const state = useMutation({
    mutationFn: () => source.github!.setIssueState(issue.number, issue.state === 'open' ? 'closed' : 'open'),
  });
  return <div className="reviews-github-composer">
    <Textarea aria-label="GitHub issue comment" placeholder="Add a comment to this issue…"
      value={draft.value} onChange={(event) => draft.set(event.currentTarget.value)}
      maxLength={1000} minRows={2} maxRows={3} disabled={!source.github || comment.isPending}
      title={source.github ? undefined : gitHubWritesUnavailable} />
    <small>GitHub records the comment under the configured control-plane token owner.</small>
    {comment.isError && <span className="reviews-action-error" role="alert">{comment.error.message}</span>}
    {comment.isSuccess && <span className="reviews-action-success" role="status">{comment.data}</span>}
    <div>
      <Button disabled={!source.github || !draft.value.trim() || comment.isPending} onClick={() => comment.mutate()}>Add comment</Button>
      <Button variant="default" disabled={!source.github || state.isPending} onClick={() => state.mutate()}>
        {issue.state === 'open' ? 'Close issue' : 'Reopen issue'}</Button>
    </div>
    {state.isError && <span className="reviews-action-error" role="alert">{state.error.message}</span>}
    {state.isSuccess && <span className="reviews-action-success" role="status">{state.data}</span>}
  </div>;
}

/** The middle pane: the selected pull request, issue, or agent-run branch with its pipeline, tabs, and actions. */
export function ReviewDetail({
  source, section, view, pullRequest, issue, run, pullRequestDiff, runDiff, detailTab, onDetailTab, draft, message, onMessage,
}: {
  source: ReviewsSource;
  section: ReviewSection;
  view: PullRequestView;
  pullRequest?: GitHubPullRequest;
  issue?: GitHubIssue;
  run?: AgentRun;
  pullRequestDiff: PullRequestDiff;
  runDiff: RunDiff;
  detailTab: DetailTab;
  onDetailTab: (tab: DetailTab) => void;
  /** The unsent GitHub review or issue comment; the page clears it when the selection changes. */
  draft: Draft;
  message: string;
  onMessage: (message: string) => void;
}) {
  const local = section === 'local-branches';
  const item = pullRequest ?? issue;
  const listing = section === 'issues' ? source.issues : source.pullRequests;
  const noun = section === 'issues' ? 'issue' : 'pull request';
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onMessage(`${what} copied`);
    } catch {
      onMessage(`Could not copy ${what.toLowerCase()}`);
    }
  };
  const copyLink = (number: number) => {
    const url = new URL(window.location.href);
    url.searchParams.set('pull', String(number));
    url.hash = 'reviews';
    return copy(url.toString(), 'Pull request link');
  };
  const badge = <Badge className="reviews-required" variant="light">{local ? run?.status ?? 'Waiting for changes'
    : view.badge ?? (issue ? capitalize(issue.state) : 'No open item')}</Badge>;
  return <PanelCard className="reviews-detail" withBorder>
    <PanelHeading
      className="reviews-detail-heading"
      icon={<span className="reviews-pr-icon"><IconGitPullRequest size={18} /></span>}
      title={local ? run?.branch ?? 'No local branch selected'
        : item ? `#${item.number} ${item.title}` : `No open ${noun}s`}
      description={local
        ? run ? `${run.project_name} · ${run.agent_name} · ${run.worker_name}` : 'Agent-run diffs will appear when a worker completes a run.'
        : pullRequest ? <>
          <span className="reviews-preview-pr-metadata">{view.metadata}</span>
          <span className="reviews-preview-branch-meta">{pullRequest.head.ref} → {pullRequest.base.ref}</span>
        </> : issue && source.project ? `${source.project.name} · opened by ${issue.user.login}`
          : source.project?.git_remote ?? 'GitHub items will appear when a repository is selected.'}
      actions={pullRequest ? <div className="reviews-preview-header-actions">
        {badge}
        <button type="button" disabled={!source.bookmarks}
          title={source.bookmarks ? undefined : 'The control plane does not store bookmarks'}
          aria-label={source.bookmarks?.has(pullRequest.number) ? 'Remove pull request bookmark' : 'Bookmark pull request'}
          aria-pressed={source.bookmarks?.has(pullRequest.number) ?? false}
          onClick={() => source.bookmarks?.toggle(pullRequest.number)}><IconBookmark size={15} /></button>
        <button type="button" aria-label="Copy pull request link" onClick={() => copyLink(pullRequest.number)}><IconLink size={15} /></button>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><button type="button" aria-label="More pull request actions"><IconDots size={16} /></button></Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => onDetailTab('evidence')}>View evidence</Menu.Item>
            <Menu.Item onClick={() => copy(pullRequest.head.ref, 'Branch name')}>Copy branch name</Menu.Item>
            {/^https:\/\//.test(pullRequest.html_url) && <Menu.Item component="a" href={pullRequest.html_url} target="_blank"
              rel="noreferrer">Open pull request on GitHub ↗</Menu.Item>}
          </Menu.Dropdown>
        </Menu>
      </div> : badge}
    />
    {message && <span className="reviews-preview-action-message" role="status">{message}</span>}
    <div className="reviews-stage-row" aria-label="Review pipeline">
      {stages.map((stage, index) => (
        <div className={`reviews-stage${view.stages[index] === undefined ? ' unavailable' : ''}`} key={stage}>
          {index > 0 && <span className="reviews-stage-line" />}
          <span className="reviews-stage-icon">
            {index === 3 ? <IconChecks size={14} /> : index === 4 ? <IconGitMerge size={14} /> : <IconShieldCheck size={14} />}
          </span>
          <b>{stage}</b>
          <small>{view.stages[index] ?? 'Unavailable'}</small>
        </div>
      ))}
    </div>
    <div className="reviews-detail-tabs" role="group" aria-label="Review detail sections">
      {detailTabs.map(([value, label, Icon], index) => <button key={value} type="button"
        aria-pressed={detailTab === value} onClick={() => onDetailTab(value)}>
        <Icon size={14} /> {label}{source.detailTabCounts && <small>{source.detailTabCounts[index]}</small>}
      </button>)}
    </div>
    {detailTab === 'conversations' ? <div className="reviews-change-empty reviews-detail-tab-panel">
      <div className="reviews-conversation-panel">
        {run?.review_comments.length ? (
          <div className="reviews-comments" aria-label="Review comments">
            {run.review_comments.map((comment, index) => <div className="reviews-comment" key={`${comment.created_at}-${index}`}>
              <b>{comment.request_changes ? 'Changes requested' : 'Comment'}</b><span>{comment.body}</span>
            </div>)}
          </div>
        ) : <p className="reviews-provider-readonly" role={view.conversation.announced ? 'status' : undefined}>{local
          ? 'No review comments are attached to this run yet.' : view.conversation.note}</p>}
        {issue && <IssueComposer source={source} issue={issue} draft={draft} />}
        {pullRequest && <PullRequestComposer source={source} pullRequest={pullRequest} draft={draft} />}
      </div>
    </div> : detailTab === 'evidence' && run ? <div className="reviews-change-empty reviews-detail-tab-panel">
      <RunEvidence run={run} />
    </div> : detailTab !== 'code-changes' ? <div className="reviews-change-empty reviews-detail-tab-panel">
      {detailTab === 'ai-suggestions' ? <div role="status"><IconSparkles size={24} />
        <b>{source.notes.suggestions[0]}</b><span>{source.notes.suggestions[1]}</span></div>
        : detailTab === 'approvals' ? <div role="status"><IconUserCheck size={24} />
          <b>{source.notes.approvals[0]}</b><span>{source.notes.approvals[1]}</span></div>
          : <div role="status">
            {detailTab === 'evidence' ? <IconShieldCheck size={24} /> : <IconChecks size={24} />}
            <b>{detailTab === 'evidence' ? 'Evidence unavailable' : 'Required checks unavailable'}</b>
            <span>{detailTab === 'evidence' ? 'CI checks and evidence artifacts are not synchronized for this item yet.'
              : 'The control plane does not currently load GitHub checks or policy results.'}</span>
          </div>}
    </div> : <div className="reviews-change-empty">
      {pullRequest && view.diff ? <div className="reviews-provider-detail">
        <PullRequestPatch diff={pullRequestDiff} view={view.diff} />
      </div> : issue ? <div className="reviews-provider-detail">
        <div className="reviews-diff-meta">
          <span>{issue.labels.map((label) => label.name).join(' · ') || 'No labels'}</span>
          <a href={issue.html_url} target="_blank" rel="noreferrer">Open issue on GitHub ↗</a>
        </div>
        <GitHubMarkdown className="reviews-pr-description reviews-markdown" value={issue.body || 'No description provided.'} />
      </div> : run && runDiff.data ? <LocalBranchDiff run={run} diff={runDiff.data.diff} truncated={runDiff.data.truncated} />
        : run && runDiff.isLoading ? <span>Loading isolated branch diff…</span>
          : run && ['queued', 'running'].includes(run.status)
            ? <span>Run is {run.cancel_requested ? 'stopping' : run.status}; its isolated branch diff will appear when the worker stops.</span>
            : run && runDiff.isError ? <span role="alert">Could not load this branch diff. Refresh to retry.</span>
              : <>
                <IconGitPullRequest size={24} />
                <b>{local ? 'No local branch diff selected' : listing.failed ? 'GitHub data unavailable' : `No open ${noun} selected`}</b>
                <span>{local ? 'Choose a completed agent run to inspect its isolated changes.'
                  : !source.project ? 'Connect a GitHub repository to see its open items.'
                    : listing.failed ? 'Check the GitHub connection, then refresh to retry.'
                      : 'Select an item from the project queue.'}</span>
              </>}
    </div>}
    {local && <LocalBranchActions run={run} onCommented={() => onDetailTab('conversations')} />}
    {detailTab === 'code-changes' && pullRequest && <ReviewContext data={source.context} />}
  </PanelCard>;
}
