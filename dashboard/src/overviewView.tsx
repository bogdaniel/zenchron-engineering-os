import { useQuery } from '@tanstack/react-query';
import { IconCircleCheck, IconGitBranch, IconRobot, IconStack2 } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { relativeRunTime } from './agentsData';
import type { AgentRun } from './agentsData';
import type { Objective } from './objectives';
import type { Project } from './projects';
import { useReportPullRequestMetrics } from './reportPullRequests';
import { useReportWorkflowRunMetrics } from './reportWorkflowRuns';
import { loadDiff } from './reviews';

/** A KPI card: the figure, its screen-reader detail, and the badge beside it. */
export type OverviewKpi = { value: string | number; detail?: string; badge: string };
export type OverviewActivity = { key: string; icon: ReactNode; text: string; time: string };
/** Shown in place of a panel's content when there is nothing to draw. */
export type OverviewNote = { title: string; note: string };
export type OverviewDiffLine = { number?: number; text: string };
export type OverviewReview = {
  id: string;
  chips: string[];
  status: string;
  pending: boolean;
  title: string;
  from: string;
  to: string;
  stat?: string;
  diff: OverviewDiffLine[];
};
export type OverviewTimelineRow = [label: string, start: number, end: number, color: string, state: 'done' | 'pending'];
export type OverviewAnalyticsMetric = {
  label: string;
  summary: string;
  value: string;
  delta: string;
  seriesLabel: string;
  chartLabel: string;
  points: { day: string; value: number | null }[];
  /** A fixed value scale; the chart fits the data when absent. */
  yAxis?: { domain: [number, number]; ticks: number[]; interval: 0 };
  empty?: OverviewNote;
};

/** Everything the Overview layout shows, in the same shape for Mock and Live. */
export type OverviewSource = {
  kpis: {
    /** `points` and `bars` are history; a source without history leaves them out and the card draws no graphic. */
    objectives: OverviewKpi & { points?: number[] };
    agents: OverviewKpi & { points?: number[] };
    pullRequests: OverviewKpi & { bars?: number[] };
    ci: OverviewKpi;
    budget: { value: string; summary: string; percent: number };
  };
  /** The rows the panel has room for, and every row for the All Activity dialog. */
  activity: OverviewActivity[];
  allActivity: OverviewActivity[];
  objectives: { key: string; title: string; progress: number; status: string; atRisk: boolean }[];
  objectivesEmpty: string;
  approvals: { title: string; pending: boolean }[];
  approvalsEmpty?: OverviewNote;
  agentRuns: { key: string; icon: ReactNode; name: string; detail?: string; status: string; pending: boolean; time: string }[];
  agentRunsEmpty: string;
  health: { status: string; healthy: boolean; trustedMain: string; evidence: string };
  review?: OverviewReview;
  reviewEmpty: OverviewNote;
  timeline: { description: string; sprint?: { dates: string[]; rows: OverviewTimelineRow[] }; empty: string };
  analytics: OverviewAnalyticsMetric[];
  footer: string;
};

/** What the shell already loads for the Live Overview. */
export type OverviewLiveData = {
  projects: Project[] | undefined;
  projectsLoading: boolean;
  projectsError: boolean;
  objectives: Objective[] | undefined;
  objectivesLoading: boolean;
  objectivesError: boolean;
  agentRuns: AgentRun[] | undefined;
  agentRunsLoading: boolean;
  agentRunsError: boolean;
  onlineWorkers: number;
  onlineWorkerNames: string[];
  controlPlaneOnline: boolean;
};

const previewDiffLines = 5;
const activityPanelRows = 5;
const ciRangeDays = 30;

function titleCase(status: string) {
  return status.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function countOrState(loading: boolean, failed: boolean, count: number) {
  if (loading) return '…';
  if (failed) return 'Unavailable';
  return count;
}

function stateOr(loading: boolean, failed: boolean, text: string) {
  if (loading) return 'Loading';
  if (failed) return 'Unavailable';
  return text;
}

/** The first changed lines of a unified diff, numbered as in the new file, with the totals of added and removed lines. */
function diffPreview(diff: string) {
  const lines: OverviewDiffLine[] = [];
  let added = 0;
  let removed = 0;
  let next: number | undefined;
  let started = false;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (next === undefined || line.startsWith('+++') || line.startsWith('---')) continue;
    const isAdded = line.startsWith('+');
    const isRemoved = line.startsWith('-');
    if (isAdded) added++;
    if (isRemoved) removed++;
    started ||= isAdded || isRemoved;
    if (started && lines.length < previewDiffLines && (isAdded || isRemoved || line.startsWith(' '))) {
      lines.push({ number: isRemoved ? undefined : next, text: `${line[0]} ${line.slice(1)}` });
    }
    if (!isRemoved) next++;
  }
  return { lines, stat: `+${added} −${removed}` };
}

/** The Live source: figures from the control plane and GitHub history only; what neither holds is stated as unavailable. */
export function useLiveOverview(data: OverviewLiveData, enabled: boolean): OverviewSource {
  const projects = enabled ? data.projects : undefined;
  const pullRequests = useReportPullRequestMetrics(projects, 'all');
  const workflows = useReportWorkflowRunMetrics(projects, '30d');
  const runs = data.agentRuns ?? [];
  const reviewableRuns = runs.filter((run) => run.diff_available);
  const featuredRun = reviewableRuns[0];
  const diff = useQuery({
    queryKey: ['agent-run-diff', 'overview', featuredRun?.id, featuredRun?.diff_attempt],
    queryFn: () => loadDiff(featuredRun.id),
    enabled: enabled && featuredRun !== undefined,
  });

  const activeObjectives = data.objectives?.filter((item) => item.status !== 'completed') ?? [];
  const runningAgents = runs.filter((run) => run.status === 'running').length;
  const openPullRequests = pullRequests.outcomes.find((item) => item.name === 'Open')?.value ?? 0;
  const pullRequestsLoading = data.projectsLoading || pullRequests.isLoading;
  const workflowsLoading = data.projectsLoading || workflows.isLoading;
  const workerLabel = `${data.onlineWorkers} worker${data.onlineWorkers === 1 ? '' : 's'}`;

  const pullRequestDetail = () => {
    if (data.projectsLoading) return 'Loading repositories';
    if (data.projectsError) return 'Repository inventory unavailable';
    if (!pullRequests.githubProjectCount) return 'Connect a GitHub repository';
    if (pullRequests.isLoading) return 'Loading GitHub pull-request history';
    if (!pullRequests.complete) return 'GitHub pull-request history unavailable';
    return `${openPullRequests} open GitHub pull requests`;
  };
  const workflowDetail = () => {
    if (data.projectsLoading) return 'Loading repositories';
    if (data.projectsError) return 'Repository inventory unavailable';
    if (workflows.isLoading) return 'Loading GitHub Actions history';
    if (workflows.completedRunCount) return `${workflows.successfulRuns} of ${workflows.completedRunCount} completed runs passed`;
    if (workflows.githubProjectCount) return 'No completed GitHub Actions runs in the last 30 days';
    return 'Connect a GitHub repository';
  };
  const ciValue = () => {
    if (workflowsLoading) return '…';
    if (workflows.successRate === undefined) return 'Unavailable';
    return `${workflows.successRate}%`;
  };

  const controlPlane: OverviewActivity = {
    key: 'control-plane',
    icon: <IconCircleCheck className={data.controlPlaneOnline ? 'activity-green' : 'activity-violet'} size={18} />,
    text: `Control plane ${data.controlPlaneOnline ? 'is responding' : 'is unavailable'}`, time: 'Live',
  };
  const runActivity = runs.map((run): OverviewActivity => ({
    key: run.id, icon: <IconRobot className="activity-blue" size={18} />,
    text: `Agent “${run.agent_name}” ${run.status}`, time: relativeRunTime(run.updated_at),
  }));
  const workerActivity = data.onlineWorkerNames.map((name): OverviewActivity => ({
    key: `worker-${name}`, icon: <IconRobot className="activity-blue" size={18} />,
    text: `Worker “${name}” is online`, time: 'Live',
  }));
  const projectActivity = (data.projects ?? []).map((project): OverviewActivity => ({
    key: project.id, icon: <IconGitBranch className="activity-violet" size={18} />,
    text: `Project “${project.name}” on ${project.worker_name}`, time: 'Live',
  }));

  const review = (): OverviewReview | undefined => {
    if (!featuredRun) return undefined;
    const preview = diff.data ? diffPreview(diff.data.diff) : undefined;
    const diffState = () => {
      if (diff.isLoading) return 'Loading branch diff…';
      if (diff.isError) return 'Could not load this branch diff. Open Reviews to retry.';
      return 'No file changes in this run.';
    };
    return {
      id: featuredRun.pull_request_number ? `PR #${featuredRun.pull_request_number}` : 'Local diff',
      chips: [`Comments ${featuredRun.review_comments.length}`, `Diffs ${reviewableRuns.length}`],
      status: titleCase(featuredRun.status),
      pending: featuredRun.status !== 'succeeded',
      title: `${featuredRun.agent_name} · ${featuredRun.prompt.split('\n')[0] || featuredRun.project_name}`,
      from: featuredRun.branch,
      to: featuredRun.base_branch || featuredRun.project_name,
      stat: preview && !diff.data?.truncated ? preview.stat : undefined,
      diff: preview?.lines.length ? preview.lines : [{ text: diffState() }],
    };
  };

  const historyNote = data.projectsError || pullRequests.isError ? 'GitHub history unavailable.' : 'Connect a GitHub repository to view delivery.';
  const pullRequestEmpty = (title: string): OverviewNote => ({
    title: pullRequestsLoading ? 'Loading pull-request history…' : title, note: historyNote,
  });
  const ciBuckets = workflows.trend.length;

  return {
    kpis: {
      objectives: {
        value: countOrState(data.objectivesLoading, data.objectivesError, activeObjectives.length), detail: 'Open objectives',
        badge: stateOr(data.objectivesLoading, data.objectivesError, `${activeObjectives.length} open`),
      },
      agents: {
        value: countOrState(data.agentRunsLoading, data.agentRunsError, runningAgents),
        detail: `${data.onlineWorkers} local workers online`, badge: workerLabel,
      },
      pullRequests: {
        value: pullRequestsLoading ? '…' : pullRequests.complete ? openPullRequests : 'Unavailable',
        detail: pullRequestDetail(), badge: pullRequests.githubProjectCount ? 'GitHub' : 'Connect GitHub',
      },
      ci: {
        value: ciValue(), detail: workflowDetail(),
        badge: workflows.completedRunCount ? `${workflows.successfulRuns}/${workflows.completedRunCount} passed` : 'No CI data',
      },
      budget: { value: 'Unavailable', summary: 'Not configured', percent: 0 },
    },
    activity: [controlPlane, ...runActivity.slice(0, 2), ...workerActivity.slice(0, 2), ...projectActivity.slice(0, 2)]
      .slice(0, activityPanelRows),
    allActivity: [controlPlane, ...runActivity, ...workerActivity, ...projectActivity],
    objectives: activeObjectives.slice(0, 3).map((objective) => ({
      key: objective.id, title: objective.title, progress: objective.progress, status: titleCase(objective.status),
      atRisk: objective.status === 'at_risk' || objective.status === 'blocked',
    })),
    objectivesEmpty: data.objectivesLoading ? 'Loading objectives…' : data.objectivesError ? 'Objectives unavailable' : 'No open objectives',
    approvals: [],
    approvalsEmpty: { title: 'Approval data unavailable', note: 'Approval gates are not connected yet.' },
    agentRuns: runs.slice(0, 3).map((run) => ({
      key: run.id, icon: <IconStack2 />, name: run.agent_name, detail: run.project_name, status: titleCase(run.status),
      pending: run.status !== 'succeeded', time: relativeRunTime(run.updated_at),
    })),
    agentRunsEmpty: data.agentRunsLoading ? 'Loading agent runs…' : data.agentRunsError ? 'Agent runs unavailable'
      : `No agent runs · ${workerLabel} online`,
    health: {
      status: 'Unavailable', healthy: false,
      trustedMain: 'Branch protection is not connected', evidence: 'Artifacts · Test results · Reviews · Traces',
    },
    review: review(),
    reviewEmpty: data.agentRunsError
      ? { title: 'Review runs unavailable', note: 'Check the control-plane connection.' }
      : { title: 'No local branch diffs yet', note: 'Complete an agent run to review its diff.' },
    timeline: {
      description: 'No sprint schedule connected',
      empty: 'Sprint schedule unavailable. The control plane does not record sprint stages yet.',
    },
    analytics: [
      {
        label: 'Delivery Velocity', summary: 'PRs Merged (all history)', seriesLabel: 'Merged PRs',
        chartLabel: 'Merged pull requests by period',
        value: pullRequests.complete ? String(pullRequests.mergedCount) : '—',
        delta: pullRequests.complete ? `${pullRequests.deliveryVelocity} / week` : 'History unavailable',
        points: pullRequests.trend.map(({ date, merged }) => ({ day: date, value: merged })),
        empty: pullRequests.complete && pullRequests.mergedCount > 0 ? undefined : pullRequestEmpty('No delivery data yet'),
      },
      {
        label: 'Cycle Time', summary: 'Average Cycle Time (all history)', seriesLabel: 'Cycle time (hours)',
        chartLabel: 'Pull-request cycle time by period',
        value: pullRequests.cycleTime === undefined ? '—' : `${pullRequests.cycleTime}h`,
        delta: pullRequests.complete ? `${pullRequests.mergedCount} merged PRs` : 'History unavailable',
        points: pullRequests.trend.map(({ date, cycle }) => ({ day: date, value: cycle })),
        empty: pullRequests.cycleTime === undefined ? pullRequestEmpty('No cycle-time data yet') : undefined,
      },
      {
        label: 'CI Duration', summary: `Average CI Duration (${ciRangeDays}d)`, seriesLabel: 'CI duration (minutes)',
        chartLabel: 'CI duration by period',
        value: workflows.averageMinutes === undefined ? '—' : `${workflows.averageMinutes}m`,
        delta: workflows.complete ? `${workflows.runCount} timed runs` : 'History unavailable',
        points: workflows.trend.map((value, index) => ({
          day: `${Math.round(ciRangeDays * (1 - index / ciBuckets))}d ago`, value,
        })),
        empty: workflows.averageMinutes === undefined ? {
          title: workflowsLoading ? 'Loading GitHub Actions history…' : 'No CI duration data yet',
          note: data.projectsError || workflows.isError ? 'GitHub history unavailable.' : 'Connect a GitHub repository with Actions runs.',
        } : undefined,
      },
    ],
    footer: 'Control plane · live data',
  };
}
