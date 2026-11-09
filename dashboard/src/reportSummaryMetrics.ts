import type { Project } from './projects';
import {
  summarizePullRequestMetrics,
  type PullRequestRepositoryHistory,
  type ReportTimeRange as PullRequestTimeRange,
} from './reportPullRequests';
import {
  summarizeWorkflowRunSamples,
  type WorkflowRunRepositoryHistory,
} from './reportWorkflowRuns';

export function summarizeProductDelivery(
  projects: Project[],
  pullRequestRepositories: PullRequestRepositoryHistory[] | undefined,
  workflowRunRepositories: WorkflowRunRepositoryHistory[] | undefined,
  range: PullRequestTimeRange,
) {
  const remotes = new Set(projects.map((project) => project.git_remote).filter((remote) => remote.startsWith('github.com/')));
  const pullRequests = pullRequestRepositories?.filter((repository) => remotes.has(repository.remote)) ?? [];
  const workflows = workflowRunRepositories?.filter((repository) => remotes.has(repository.remote)) ?? [];
  const pullRequestsComplete = remotes.size > 0 && pullRequests.length === remotes.size &&
    pullRequests.every((repository) => repository.complete);
  const workflowsComplete = remotes.size > 0 && workflows.length === remotes.size &&
    workflows.every((repository) => repository.complete);
  const pullRequestMetrics = summarizePullRequestMetrics(pullRequests.flatMap((repository) => repository.items), range);
  const runSamples = summarizeWorkflowRunSamples(workflows.flatMap((repository) => repository.items), range);
  const runDurations = runSamples.map((sample) => sample.duration);
  return {
    deliveryVelocity: pullRequestsComplete ? pullRequestMetrics.deliveryVelocity : undefined,
    cycleTime: pullRequestsComplete ? pullRequestMetrics.cycleTime : undefined,
    acceptanceRate: pullRequestsComplete ? pullRequestMetrics.acceptanceRate : undefined,
    ciDuration: workflowsComplete && runDurations.length
      ? Math.round(runDurations.reduce((sum, value) => sum + value, 0) / runDurations.length * 10) / 10
      : undefined,
  };
}
