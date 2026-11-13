import type { ReactNode } from 'react';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { AgentRun } from './agentsData';
import type { Project } from './projects';

const githubItem = z.object({
  number: z.number(), title: z.string(), state: z.string(), html_url: z.string(), body: z.string().optional(),
  updated_at: z.string(), user: z.object({ login: z.string() }),
});
const pullRequestSchema = z.array(githubItem.extend({
  draft: z.boolean(), head: z.object({ ref: z.string() }), base: z.object({ ref: z.string() }),
}));
const issueSchema = z.array(githubItem.extend({ labels: z.array(z.object({ name: z.string() })) }));
const diffSchema = z.object({ run_id: z.string(), diff: z.string(), truncated: z.boolean() });
const pullRequestDiffSchema = z.object({ diff: z.string().max(1 << 20) });
const reviewResultSchema = z.object({
  agent_run_linked: z.boolean().optional(), agent_run_queued: z.boolean().optional(),
  feedback_sync_error: z.string().optional(),
});
export type GitHubPullRequest = z.infer<typeof pullRequestSchema>[number];
export type GitHubIssue = z.infer<typeof issueSchema>[number];
export type ReviewSection = 'pull-requests' | 'issues' | 'local-branches';
export type DetailTab = 'code-changes' | 'conversations' | 'ai-suggestions' | 'evidence' | 'checklist' | 'approvals';
export type ReviewEvent = 'COMMENT' | 'REQUEST_CHANGES';

export async function loadDiff(runID: string) {
  const response = await fetch(`/api/v1/agent-runs/${runID}/diff`);
  if (!response.ok) throw new Error(`Could not load local branch diff (${response.status})`);
  return diffSchema.parse(await response.json());
}

async function loadGitHubItems<T>(projectID: string, kind: 'issues' | 'pull-requests', schema: z.ZodType<T>) {
  const response = await fetch(`/api/v1/projects/${projectID}/${kind}`);
  if (!response.ok) throw new Error((await response.text()).trim() || `Could not load GitHub ${kind} (${response.status})`);
  return schema.parse(await response.json());
}

async function sendJSON(path: string, method: 'POST' | 'PATCH', body: unknown, failure: string) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.text()).trim() || `${failure} (${response.status})`);
  return response;
}

/** Files and changed lines in a unified diff. `path` is the first file the diff names. */
export function summarizeDiff(diff: string) {
  let files = 0;
  let added = 0;
  let removed = 0;
  let inHunk = false;
  let path: string | undefined;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      files += 1;
      inHunk = false;
      path ??= line.match(/^diff --git a\/(.+) b\//)?.[1];
    } else if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('+')) added += 1;
    else if (inHunk && line.startsWith('-')) removed += 1;
  }
  return { files, added, removed, path };
}

export type Listing<T> = { items: T[]; loading: boolean; failed: boolean; syncing: boolean };
/** A pull request's place in the queue. `tone` colours the card badge; a source without review states leaves it out. */
export type QueueStatus = { value: string; label: string; tone?: string };
export type ReviewSignals = {
  category: string; risk: number; evidence: number; ciPassed: boolean; comments: number; otherReviewers: number;
};
export type ReviewContextData = {
  suggestions: { title: string; impact: string }[];
  suggestionCount: string;
  artifacts: string[];
  checklist: { done: string; items: string[] };
  approvals: { summary: string; lines: string[] };
  policyGates: { summary: string; lines: string[] };
  readiness: string[];
};
/** Display values for the selected pull request. An absent value is shown as Unavailable or left out. */
export type PullRequestView = {
  badge?: string;
  metadata?: string;
  /** Code review, Evidence, Policy gates, CI, Merge. */
  stages: (string | undefined)[];
  conversation: { note: string; announced: boolean };
  diff?: { file: string; added: string; removed: string; thread?: { initials: string; color: string; author: string; text: string }[] };
  stats: { files?: string; added?: string; commits?: string; removed?: string; risk?: string; evidence?: string };
  evidencePercent?: number;
  checks?: { summary: string; items: [string, string][] };
  governance: { strategy?: string; target?: string; policy?: string };
  mergeLabel: string;
};

/**
 * Queues, display values, and operations for the Reviews page. Mock and Live each provide one.
 * An operation a source cannot perform is absent, and the page disables its control.
 */
export type ReviewsSource = {
  sections: ReviewSection[];
  /** Pull Requests, In Review, Review Queue, Avg. Review Time, Merge Success Rate, Policy Gate Pass. */
  metrics: { value: string | number; trend?: ReactNode }[];
  repositories: { value: string; label: string }[];
  repository: string;
  repositoryLabel: string;
  chooseRepository: (value: string) => void;
  dateRange?: { days: number; choose: (days: number) => void };
  /** Clears the filters the source holds and returns the confirmation to show. */
  resetFilters: () => string;
  project?: Project;
  pullRequests: Listing<GitHubPullRequest>;
  pullRequestTotal?: string;
  pullRequestFilters: { value: string; label: string }[];
  pullRequestStatus: (pullRequest: GitHubPullRequest) => QueueStatus;
  signals: (number: number) => ReviewSignals | undefined;
  issues: Listing<GitHubIssue>;
  runs: Listing<AgentRun>;
  view: (pullRequest: GitHubPullRequest | undefined, patch: string | undefined) => PullRequestView;
  detailTabCounts?: number[];
  notes: { suggestions: [string, string]; approvals: [string, string] };
  context?: ReviewContextData;
  pagination: { note: string; reason: string };
  createPullRequest?: (title: string, branch: string) => number;
  /** Approve and merge return the confirmation to show. */
  approve?: (pullRequest: GitHubPullRequest) => string;
  requestChanges?: (pullRequest: GitHubPullRequest) => void;
  merge?: (pullRequest: GitHubPullRequest) => string;
  exportEvidence?: (pullRequest: GitHubPullRequest) => void;
  bookmarks?: { has: (number: number) => boolean; toggle: (number: number) => void };
  autoMerge?: { checked: boolean; set: (checked: boolean) => void };
  /** GitHub writes through the control plane. Each resolves with the confirmation to show. */
  github?: {
    submitReview: (number: number, event: ReviewEvent, body: string) => Promise<string>;
    commentOnIssue: (number: number, body: string) => Promise<string>;
    setIssueState: (number: number, state: 'open' | 'closed') => Promise<string>;
  };
};

export type PullRequestDiff = { patch?: string; loading: boolean; error: Error | null };

export function useLivePullRequestDiff(enabled: boolean, projectID: string | undefined, number: number | undefined): PullRequestDiff {
  const diff = useQuery({
    queryKey: ['github-pull-request-diff', projectID, number],
    queryFn: async () => {
      const response = await fetch(`/api/v1/projects/${projectID}/pull-requests/${number}/diff`);
      if (!response.ok) throw new Error((await response.text()).trim() || `Could not load pull request diff (${response.status})`);
      return pullRequestDiffSchema.parse(await response.json());
    },
    enabled: enabled && Boolean(projectID) && number !== undefined, staleTime: 60_000,
  });
  return { patch: diff.data?.diff, loading: diff.isLoading, error: diff.error };
}

const liveNotes: ReviewsSource['notes'] = {
  suggestions: ['AI suggestions unavailable', 'The control plane does not generate review suggestions.'],
  approvals: ['Approvals unavailable', 'GitHub review approvals are not synchronized yet.'],
};
export const capitalize = (value: string) => value.slice(0, 1).toUpperCase() + value.slice(1);
const liveStatus = (pullRequest: GitHubPullRequest): QueueStatus =>
  pullRequest.draft ? { value: 'draft', label: 'Draft' } : { value: pullRequest.state, label: capitalize(pullRequest.state) };

/** GitHub items for one connected repository and agent-run branches, from the control plane. */
export function useLiveReviews(
  enabled: boolean, projects: Project[], runs: { items: AgentRun[]; loading: boolean; failed: boolean },
): ReviewsSource {
  const queryClient = useQueryClient();
  const [projectID, setProjectID] = useState<string | null>(null);
  const gitHubProjects = projects.filter((project) => project.git_remote.startsWith('github.com/'));
  const project = gitHubProjects.find((item) => item.id === projectID) ?? gitHubProjects[0];
  const pullRequests = useQuery({
    queryKey: ['github-pull-requests', project?.id],
    queryFn: () => loadGitHubItems(project!.id, 'pull-requests', pullRequestSchema),
    enabled: enabled && Boolean(project), refetchInterval: 60_000,
  });
  const issues = useQuery({
    queryKey: ['github-issues', project?.id],
    queryFn: () => loadGitHubItems(project!.id, 'issues', issueSchema),
    enabled: enabled && Boolean(project), refetchInterval: 60_000,
  });
  const pulls = pullRequests.data ?? [];
  const count = (value: number | undefined, query: { isLoading: boolean }) =>
    value ?? (query.isLoading ? '…' : 'Unavailable');
  const inReview = pullRequests.data?.filter((item) => liveStatus(item).value === 'open').length;
  const localBranches = runs.items.filter((run) => run.diff_available || ['queued', 'running', 'cancelled'].includes(run.status));
  const listing = <T>(query: { data?: T[]; isLoading: boolean; isError: boolean; isFetching: boolean }): Listing<T> =>
    ({ items: query.data ?? [], loading: query.isLoading, failed: query.isError, syncing: query.isFetching });
  return {
    sections: ['pull-requests', 'issues', 'local-branches'],
    metrics: [
      { value: count(pullRequests.data?.length, pullRequests) },
      { value: count(inReview, pullRequests) },
      { value: runs.loading ? '…' : runs.failed ? 'Unavailable' : localBranches.filter((run) => run.diff_available).length },
      { value: 'Unavailable' }, { value: 'Unavailable' }, { value: 'Unavailable' },
    ],
    repositories: gitHubProjects.map((item) => ({ value: item.id, label: item.name })),
    repository: project?.id ?? '',
    repositoryLabel: project?.name ?? 'GitHub not connected',
    chooseRepository: setProjectID,
    resetFilters: () => 'Review filters reset.',
    project,
    pullRequests: listing(pullRequests),
    pullRequestTotal: pullRequests.data ? String(pulls.length) : undefined,
    pullRequestFilters: [
      { value: 'all', label: `All ${pulls.length}` },
      { value: 'open', label: `Open ${inReview ?? 0}` },
      { value: 'draft', label: `Draft ${pulls.filter((item) => item.draft).length}` },
    ],
    pullRequestStatus: liveStatus,
    signals: () => undefined,
    issues: listing(issues),
    runs: { items: localBranches, loading: runs.loading, failed: runs.failed, syncing: false },
    view: (pullRequest, patch) => {
      const file = patch ? summarizeDiff(patch) : undefined;
      const changes = patch && /^@@+ /m.test(patch) ? file : undefined;
      return {
        badge: pullRequest && liveStatus(pullRequest).label,
        metadata: pullRequest && project ? `${project.name} · opened by ${pullRequest.user.login}` : undefined,
        stages: [pullRequest && (pullRequest.draft ? 'Draft' : 'Open')],
        conversation: { note: 'Existing GitHub conversation history is not synchronized yet.', announced: false },
        diff: pullRequest && {
          file: !file?.files ? pullRequest.head.ref : file.files === 1 && file.path ? file.path : `${file.files} files changed`,
          added: changes ? `+${changes.added}` : '', removed: changes ? `−${changes.removed}` : '',
        },
        stats: changes ? { files: String(changes.files), added: `+${changes.added}`, removed: `−${changes.removed}` } : {},
        governance: { target: pullRequest?.base.ref },
        mergeLabel: 'Merge to protected branch',
      };
    },
    notes: liveNotes,
    pagination: { note: `${pulls.length} open pull request${pulls.length === 1 ? '' : 's'}`,
      reason: 'The control plane returns open items as a single page' },
    github: project && {
      submitReview: async (number, event, body) => {
        const response = await sendJSON(`/api/v1/projects/${project.id}/pull-requests/${number}/reviews`, 'POST',
          { body, event }, 'GitHub review failed');
        const result = reviewResultSchema.parse(await response.json());
        await queryClient.invalidateQueries({ queryKey: ['github-pull-requests', project.id] });
        await queryClient.invalidateQueries({ queryKey: ['agent-runs'] });
        if (result.feedback_sync_error) return 'Review submitted to GitHub, but run feedback could not sync.';
        if (event === 'COMMENT') {
          return result.agent_run_linked ? 'Comment submitted to GitHub and attached to the agent run.' : 'Comment submitted to GitHub.';
        }
        if (result.agent_run_queued) return 'Changes requested on GitHub; agent run queued.';
        return result.agent_run_linked
          ? 'Changes requested on GitHub; run feedback stored, but the agent is not eligible for another pass yet.'
          : 'Changes requested on GitHub.';
      },
      commentOnIssue: async (number, body) => {
        await sendJSON(`/api/v1/projects/${project.id}/issues/${number}/comments`, 'POST', { body }, 'GitHub issue comment failed');
        await queryClient.invalidateQueries({ queryKey: ['github-issues', project.id] });
        return 'Comment submitted to GitHub.';
      },
      setIssueState: async (number, state) => {
        await sendJSON(`/api/v1/projects/${project.id}/issues/${number}`, 'PATCH', { state }, 'GitHub issue update failed');
        await queryClient.invalidateQueries({ queryKey: ['github-issues', project.id] });
        return `Issue ${state} on GitHub.`;
      },
    },
  };
}
