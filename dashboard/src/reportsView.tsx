import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconActivity, IconCircleCheck, IconCode, IconFolders, IconRobot, IconSparkles, IconStack } from '@tabler/icons-react';
import { agentsSchema, loadAgentRuns, type AgentRun } from './agentsData';
import type { DownloadableReport } from './DownloadableReports';
import type { Objective } from './objectives';
import type { Project } from './projects';
import { loadProducts } from './productEditor';
import { useReportPullRequestMetrics, type ReportTimeRange } from './reportPullRequests';
import type { ProductDeliverySummary, WorkspaceDeliverySummary } from './ReportSummaries';
import { summarizeProductDelivery } from './reportSummaryMetrics';
import { useReportWorkflowRunMetrics } from './reportWorkflowRuns';
import { workflowsSchema } from './workflowModel';

export type ReportScope = {
  timeRange: ReportTimeRange; product: string; objectiveOwner: string; workflow: string; repository: string;
};
export const defaultScope: ReportScope = {
  timeRange: '30d', product: 'all', objectiveOwner: 'all', workflow: 'all', repository: 'all',
};
export const timeRanges: { value: ReportTimeRange; label: string }[] = [
  { value: '30d', label: 'Last 30 Days' }, { value: '90d', label: 'Last 90 Days' },
  { value: '365d', label: 'Last 12 Months' }, { value: 'all', label: 'All Time' },
];
export const latencyPercentiles = ['P50', 'P75', 'P95'] as const;
export type LatencyPercentile = typeof latencyPercentiles[number];

type ReportOption = { value: string; label: string };
/** A KPI card. A source without the value leaves it out and the card reads Unavailable; `delta` and `sparkline` are history. */
type ReportMetric = { value?: string | number; delta?: string; sparkline?: (number | null)[] };
/** A fixed value scale; the chart fits the data when absent. */
type ReportAxis = { domain: [number, number]; ticks: number[]; interval: 0 };
/** `empty` replaces the plot with the reason there is nothing to draw. */
type ReportChart<Point> = { points: Point[]; label: string; empty?: string };
type OutcomeSection = { name: string; value: number; color: string };

/** Everything the Reports layout shows, in the same shape for Mock and Live. */
export type ReportsSource = {
  options: { products: ReportOption[]; teams: ReportOption[]; workflows: ReportOption[]; repositories: ReportOption[] };
  /** The reason the Workflow filter cannot be used; absent where it works. */
  workflowUnavailable?: string;
  /** Introduces the applied-scope line, so a fixture scope is never presented as a real one. */
  scopeAppliedLabel: string;
  metrics: Record<'velocity' | 'cycleTime' | 'ciDuration' | 'reviewLatency' | 'agentSpend' | 'acceptance' | 'autonomy',
    ReportMetric>;
  /** False where runs carry no completion evidence: charts leave the series out and the legend says so. */
  autonomyRecorded: boolean;
  delivery: ReportChart<{ date: string; merged: number; cycle: number | null }>;
  ci: ReportChart<{ duration: string; runs: number }> & { percentiles?: { p50: string; p95: string }; yAxis?: ReportAxis };
  outcomes: {
    caption: string;
    /** Replaces the whole chart while outcomes cannot be shown. */
    message?: string;
    /** Replaces the donut when the history is complete and holds nothing. */
    empty?: string;
    sections: OutcomeSection[]; legend: OutcomeSection[];
    total: string; unit: string; valueSuffix?: string; label: string; legendLabel: string;
  };
  latency: ReportChart<{ date: string; latency: number }> & { seriesLabel: string; groupLabel: string; yAxis?: ReportAxis };
  spend: ReportChart<{ date: string; spend: number; autonomy?: number }> & {
    tick: (value: number) => string; yAxis?: ReportAxis; rightYAxis?: ReportAxis;
  };
  acceptance: ReportChart<{ date: string; acceptance: number | null; autonomy?: number }>;
  insights: { group: string; icon: ReactNode; title: string; detail: string }[];
  keyTakeaway: string;
  products: { rows: ProductDeliverySummary[]; loading: boolean; error: boolean; checkoutCount?: number };
  workspaces: WorkspaceDeliverySummary[];
  /** Why the autonomous-completion column is empty; absent where it is filled. */
  autonomyNote?: string;
  downloads: DownloadableReport[];
};

type LiveFacts = {
  apiOnline: boolean;
  objectives: Objective[] | undefined;
  projects: Project[] | undefined;
  workers: { status: 'online' | 'offline' }[] | undefined;
};

async function loadWorkflows() {
  const response = await fetch('/api/v1/workflows');
  if (!response.ok) throw new Error(`Could not load workflow reports (${response.status})`);
  return workflowsSchema.parse(await response.json());
}

async function loadAgents() {
  const response = await fetch('/api/v1/agents');
  if (!response.ok) throw new Error(`Could not load agent reports (${response.status})`);
  return agentsSchema.parse(await response.json());
}

const day = 24 * 60 * 60 * 1000;
const rangeDurations: Record<Exclude<ReportTimeRange, 'all'>, number> = { '30d': 30 * day, '90d': 90 * day, '365d': 365 * day };
function isInRange(createdAt: string, range: ReportTimeRange, now = Date.now()) {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp) || timestamp > now) return false;
  return range === 'all' || timestamp >= now - rangeDurations[range];
}

/** Provider-reported cost of the runs per period, in the same periods as the pull-request trend. */
function spendTrend(runs: AgentRun[], range: ReportTimeRange, now = Date.now()) {
  const costed = runs.flatMap((run) => run.usage?.cost_usd === undefined ? []
    : [{ created: Date.parse(run.created_at), cost: run.usage.cost_usd }]);
  const span = range === 'all' ? Math.max(7 * day, now - Math.min(...costed.map(({ created }) => created))) : rangeDurations[range];
  const count = range === '30d' ? 5 : range === '90d' ? 7 : 12;
  const start = now - span;
  const points = Array.from({ length: count }, (_, index) => ({
    date: new Date(start + index * span / count).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), spend: 0,
  }));
  for (const { created, cost } of costed) {
    points[Math.min(count - 1, Math.floor((created - start) / span * count))].spend += cost;
  }
  return points.map((point) => ({ ...point, spend: Math.round(point.spend * 100) / 100 }));
}

function downloadCSV(name: string, rows: (string | number | undefined)[][]) {
  const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `zenchron-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

const productIcon = <IconStack className="reports-preview-row-icon violet" size={12} aria-hidden="true" />;
const unavailable = 'Unavailable';
const withUnit = (value: number | undefined, unit: string) => value === undefined ? undefined : `${value}${unit}`;

/** Reports from the control plane. Nothing is fetched while `enabled` is false. */
export function useLiveReports(enabled: boolean, facts: LiveFacts, scope: ReportScope): ReportsSource {
  const { apiOnline, workers } = facts;
  const objectives = enabled ? facts.objectives : undefined;
  const projects = enabled ? facts.projects : undefined;
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: loadWorkflows, enabled });
  const agents = useQuery({ queryKey: ['agents'], queryFn: loadAgents, enabled });
  const runs = useQuery({ queryKey: ['agent-runs'], queryFn: loadAgentRuns, enabled });
  const products = useQuery({ queryKey: ['products'], queryFn: loadProducts, enabled });

  const selectedProduct = products.data?.find((product) => product.id === scope.product);
  const productRepositoryIDs = new Set(selectedProduct?.repository_ids ?? []);
  const scopedObjectives = objectives?.filter((objective) =>
    isInRange(objective.created_at, scope.timeRange) &&
    (scope.product === 'all' || objective.product_id === scope.product) &&
    (scope.objectiveOwner === 'all' || objective.owner === scope.objectiveOwner),
  );
  const scopedProjects = projects?.filter((project) =>
    (scope.product === 'all' || productRepositoryIDs.has(project.id)) &&
    (scope.repository === 'all' || project.id === scope.repository),
  );
  const pullRequests = useReportPullRequestMetrics(scopedProjects, scope.timeRange);
  const workflowRunMetrics = useReportWorkflowRunMetrics(scopedProjects, scope.timeRange);
  const deliverySourceDetail = !apiOnline
    ? 'Control plane offline; repository sources cannot be checked.'
    : scopedProjects === undefined
      ? 'Repository inventory unavailable.'
      : scopedProjects.length === 0
        ? 'No local checkouts match this report scope.'
        : !scopedProjects.some((project) => project.git_remote)
          ? 'No Git remotes are configured for these checkouts.'
          : pullRequests.githubProjectCount === 0
            ? 'No supported GitHub remotes are configured in this scope.'
            : pullRequests.isLoading
              ? 'Loading GitHub pull-request history.'
              : pullRequests.isError
                ? 'GitHub pull-request history is unavailable.'
                : !pullRequests.complete
                  ? 'History exceeds the 2,000 pull-request report limit; narrow the time range.'
                  : `${pullRequests.mergedCount} merged pull requests from ${pullRequests.githubProjectCount} GitHub ` +
                    `${pullRequests.githubProjectCount === 1 ? 'repository' : 'repositories'}` +
                    `${pullRequests.unsupportedRemoteCount ? `; ${pullRequests.unsupportedRemoteCount} non-GitHub remotes excluded` : ''}` +
                    `${pullRequests.unconfiguredCheckoutCount
                      ? `; ${pullRequests.unconfiguredCheckoutCount} checkout${pullRequests.unconfiguredCheckoutCount === 1 ? '' : 's'} ` +
                        `${pullRequests.unconfiguredCheckoutCount === 1 ? 'has' : 'have'} no remote` : ''}.`;
  const scopedRuns = runs.data?.filter((run) =>
    isInRange(run.created_at, scope.timeRange) &&
    (scope.product === 'all' || productRepositoryIDs.has(run.project_id)) &&
    (scope.repository === 'all' || run.project_id === scope.repository),
  );
  const scopedProducts = products.data?.filter((product) => scope.product === 'all' || product.id === scope.product) ?? [];
  const productSummaries: ProductDeliverySummary[] = scopedProducts.map((product) => {
    const repositoryIDs = new Set(product.repository_ids);
    return {
      id: product.id,
      name: product.name,
      icon: productIcon,
      recordType: 'Product' as const,
      autonomousCompletion: undefined,
      ...summarizeProductDelivery(
        (projects ?? []).filter((project) => repositoryIDs.has(project.id) &&
          (scope.repository === 'all' || project.id === scope.repository)),
        pullRequests.repositories,
        workflowRunMetrics.repositories,
        scope.timeRange,
      ),
      repositories: projects === undefined ? undefined
        : scopedProjects?.filter((project) => repositoryIDs.has(project.id)).length,
      objectives: scopedObjectives?.filter((objective) => objective.product_id === product.id).length,
      runs: scopedRuns?.filter((run) => repositoryIDs.has(run.project_id)).length,
    };
  });
  if (products.isSuccess && scopedProducts.length === 0 && scopedProjects?.length) {
    productSummaries.push({
      id: 'unassigned-repositories',
      name: 'Unassigned repositories',
      icon: <IconCode className="reports-preview-row-icon teal" size={12} aria-hidden="true" />,
      recordType: 'Unassigned repositories',
      autonomousCompletion: undefined,
      ...summarizeProductDelivery(scopedProjects, pullRequests.repositories, workflowRunMetrics.repositories, scope.timeRange),
      repositories: scopedProjects.length,
      objectives: scopedObjectives?.length,
      runs: scopedRuns?.length,
    });
  }
  const objectiveCount = scopedObjectives?.length;
  const completed = scopedObjectives?.filter((objective) => objective.status === 'completed').length;
  const activeWorkflows = workflows.data?.filter((workflow) => workflow.status === 'active').length;
  const onlineWorkers = workers?.filter((worker) => worker.status === 'online').length;
  const finishedRuns = scopedRuns?.filter((run) => run.status === 'succeeded' || run.status === 'failed') ?? [];
  const runSuccessRate = finishedRuns.length
    ? `${Math.round(finishedRuns.filter((run) => run.status === 'succeeded').length / finishedRuns.length * 100)}%`
    : undefined;
  const recordedRunCount = scopedRuns?.length ?? 0;
  const costedRuns = scopedRuns?.filter((run) => run.usage?.cost_usd !== undefined) ?? [];
  const spend = costedRuns.length
    ? `$${costedRuns.reduce((sum, run) => sum + run.usage!.cost_usd!, 0).toFixed(2)}` : undefined;
  const spendSource = runs.isLoading ? 'Agent run data is loading.' : runs.isError ? 'Agent run data unavailable.'
    : spend ? `Cost reported by providers for ${costedRuns.length} of ${recordedRunCount} runs.`
      : 'No run in this scope reports provider cost.';
  const spendPoints = costedRuns.length ? spendTrend(costedRuns, scope.timeRange) : [];
  const timeRangeLabel = timeRanges.find((range) => range.value === scope.timeRange)?.label ?? 'All Time';
  const selectedRangeLabel = timeRangeLabel.toLowerCase();
  const inventory = [
    { label: 'Objectives', count: objectiveCount },
    { label: 'Workflow definitions', count: workflows.isSuccess ? workflows.data.length : undefined },
    { label: 'Agent profiles', count: agents.isSuccess ? agents.data.length : undefined },
    { label: 'Local checkouts', count: scopedProjects?.length },
  ];
  const outcomeSections = pullRequests.outcomes.filter((outcome) => outcome.value > 0);
  const outcomeSummary = pullRequests.outcomes.map((outcome) => `${outcome.value} ${outcome.name.toLowerCase()}`).join(' · ');
  const pullRequestSource = pullRequests.complete ? 'Complete history' : deliverySourceDetail;
  const metricRows = [
    ['Delivery velocity', pullRequests.deliveryVelocity ?? unavailable, pullRequestSource],
    ['Cycle time', pullRequests.cycleTime ?? unavailable, pullRequestSource],
    ['CI duration', workflowRunMetrics.averageMinutes ?? unavailable, workflowRunMetrics.complete ? 'Complete history' : 'Actions history unavailable'],
    ['Review latency', unavailable, 'Review event data is not connected'],
    ['Agent spend', spend ?? unavailable, spendSource],
    ['Acceptance rate', pullRequests.acceptanceRate === undefined ? unavailable : `${pullRequests.acceptanceRate}%`, pullRequestSource],
    ['Autonomous completion', unavailable, 'Completion evidence is not connected'],
  ];
  const downloads: DownloadableReport[] = [
    {
      name: 'Executive Summary', detail: 'Delivery KPIs and highlights', format: 'CSV',
      download: () => downloadCSV('executive-summary', [
        ['Metric', 'Value'],
        ['Time range', timeRangeLabel],
        ['Objectives', objectiveCount ?? unavailable], ['Completed objectives', completed ?? unavailable],
        ['Active workflows', activeWorkflows ?? unavailable], ['Agent runs', scopedRuns?.length ?? unavailable],
        ['Run success rate', runSuccessRate ?? unavailable], ['Local checkouts', scopedProjects?.length ?? unavailable],
        ['Delivery sources', deliverySourceDetail],
      ]),
    },
    {
      name: 'Detailed Metrics', detail: 'Metrics by product and team', format: 'CSV',
      download: () => downloadCSV('detailed-metrics', [['Metric', 'Value', 'Source'], ...metricRows]),
    },
    {
      name: 'Agent Spend & Utilization', detail: 'Run cost and usage reported by providers', format: 'CSV',
      download: () => downloadCSV('agent-spend-utilization', [
        ['Agent', 'Project', 'Branch', 'Status', 'Spend (USD)', 'Usage', 'Source'],
        ...(scopedRuns ?? []).map((run) => [run.agent_name, run.project_name, run.branch, run.status,
          run.usage?.cost_usd ?? unavailable,
          run.usage ? `${run.usage.input_tokens} input / ${run.usage.output_tokens} output tokens` : unavailable,
          run.usage ? 'Reported by the provider' : 'Provider usage records are not connected']),
      ]),
    },
    {
      name: 'Product & Workspace Report', detail: 'Delivery and workspace data', format: 'CSV',
      download: () => downloadCSV('product-workspace', [
        ['Record', 'Name', 'Repositories', 'Objectives', 'Agent runs', 'Velocity (PRs/week)', 'Cycle time (hours)',
          'CI duration (minutes)', 'Acceptance rate (%)', 'Autonomous completion (%)', 'Worker', 'Status'],
        ...productSummaries.map((product) => [
          product.recordType, product.name, product.repositories, product.objectives, product.runs,
          product.deliveryVelocity ?? unavailable, product.cycleTime ?? unavailable,
          product.ciDuration ?? unavailable, product.acceptanceRate ?? unavailable,
          product.autonomousCompletion ?? unavailable, '', '',
        ]),
        ['Workspace', 'Local workspace', '', objectiveCount ?? unavailable, '',
          pullRequests.deliveryVelocity ?? unavailable, pullRequests.cycleTime ?? unavailable,
          workflowRunMetrics.averageMinutes ?? unavailable, pullRequests.acceptanceRate ?? unavailable,
          unavailable, '', ''],
        ...scopedProjects?.map((project) => [
          'Repository', project.name, 1, '', scopedRuns?.filter((run) => run.project_id === project.id).length,
          '', '', '', '', '', project.worker_name, project.worker_status,
        ]) ?? [],
        ...inventory.map((item) => [
          'Inventory', item.label, '', '', item.count ?? unavailable, '', '', '', '', '', '', 'Current snapshot',
        ]),
      ]),
    },
  ];
  const all = (label: string): ReportOption => ({ value: 'all', label });
  const owners = [...new Set(objectives?.map((objective) => objective.owner.trim()).filter(Boolean) ?? [])]
    .sort((left, right) => left.localeCompare(right));
  const pullRequestsWaiting = pullRequests.isError ? 'GitHub pull-request history is unavailable.'
    : pullRequests.githubProjectCount ? 'Waiting for complete GitHub pull-request history.' : 'Connect a source to view this chart';

  return {
    options: {
      products: [all('All Products'), ...products.data?.map((product) => ({ value: product.id, label: product.name })) ?? []],
      teams: [all('All Teams'), ...owners.map((owner) => ({ value: owner, label: owner }))],
      workflows: [all('All Workflows')],
      repositories: [all('All Repositories'), ...projects?.map((project) => ({ value: project.id, label: project.name })) ?? []],
    },
    workflowUnavailable: 'Workflow filter unavailable because runs are not linked to workflows',
    scopeAppliedLabel: 'Scope applied',
    metrics: {
      velocity: { value: pullRequests.deliveryVelocity, sparkline: pullRequests.complete ? pullRequests.trend.map((item) => item.merged) : undefined },
      cycleTime: { value: withUnit(pullRequests.cycleTime, 'h'), sparkline: pullRequests.complete ? pullRequests.trend.map((item) => item.cycle) : undefined },
      ciDuration: { value: withUnit(workflowRunMetrics.averageMinutes, 'm'), sparkline: workflowRunMetrics.complete ? workflowRunMetrics.trend : undefined },
      reviewLatency: {},
      agentSpend: { value: spend, sparkline: spend ? spendPoints.map((point) => point.spend) : undefined },
      acceptance: {
        value: pullRequests.acceptanceRate === undefined ? undefined : `${pullRequests.acceptanceRate}%`,
        sparkline: pullRequests.complete ? pullRequests.trend.map((item) => item.acceptance) : undefined,
      },
      autonomy: {},
    },
    autonomyRecorded: false,
    delivery: {
      points: pullRequests.trend, label: 'Merged pull requests and average cycle time trend',
      empty: pullRequests.complete
        ? pullRequests.mergedCount > 0 ? undefined : 'No merged pull requests in this period.'
        : pullRequestsWaiting,
    },
    ci: {
      points: workflowRunMetrics.distribution,
      label: `CI duration distribution from ${workflowRunMetrics.runCount} completed GitHub Actions runs`,
      percentiles: workflowRunMetrics.p50Minutes !== undefined && workflowRunMetrics.p95Minutes !== undefined
        ? { p50: workflowRunMetrics.p50Minutes.toFixed(1), p95: workflowRunMetrics.p95Minutes.toFixed(1) } : undefined,
      empty: workflowRunMetrics.complete
        ? workflowRunMetrics.runCount > 0 ? undefined : 'No completed GitHub Actions runs in this period.'
        : workflowRunMetrics.isError ? 'GitHub Actions run history is unavailable.'
          : workflowRunMetrics.githubProjectCount ? 'Waiting for complete GitHub Actions history.'
            : 'Connect a source to view this chart',
    },
    outcomes: {
      caption: `Pull requests · ${selectedRangeLabel}`,
      message: pullRequests.isLoading ? 'Loading pull-request outcomes…'
        : pullRequests.isError ? 'Pull-request outcomes are unavailable.'
          : pullRequests.complete ? undefined
            : pullRequests.githubProjectCount ? 'Pull-request history is incomplete; narrow the time range.'
              : 'Connect a supported GitHub repository to view pull-request outcomes.',
      empty: outcomeSections.length ? undefined : 'No pull requests match this report scope.',
      sections: outcomeSections,
      legend: pullRequests.outcomes,
      total: outcomeSections.reduce((count, outcome) => count + outcome.value, 0).toLocaleString(),
      unit: 'Pull Requests',
      label: `Pull request outcomes for ${selectedRangeLabel}`,
      legendLabel: 'Pull request outcomes legend',
    },
    latency: {
      points: [], label: 'Review latency trend', seriesLabel: 'Review latency', groupLabel: 'Review latency percentile',
      empty: 'Requires provider review events.',
    },
    spend: {
      points: spendPoints, label: `Agent spend reported by providers for ${costedRuns.length} runs`,
      tick: (value) => `$${value}`, empty: spend ? undefined : spendSource,
    },
    acceptance: {
      points: pullRequests.trend, label: 'Pull request acceptance rate trend',
      empty: pullRequests.isError ? 'Pull-request history is unavailable.'
        : !pullRequests.complete ? 'Acceptance needs complete pull-request history; autonomous completion is not recorded yet.'
          : pullRequests.acceptanceRate === undefined ? 'No closed pull requests in this period.' : undefined,
    },
    insights: [
      { group: 'objectives', icon: <IconCircleCheck size={15} />, title: 'Objectives', detail: objectiveCount === undefined ? 'Objective data unavailable.' : `${completed} of ${objectiveCount} completed in this scope.` },
      {
        group: 'execution', icon: <IconSparkles size={15} />, title: 'Agent activity',
        detail: runs.isLoading ? 'Agent run data is loading.' : runs.isError ? 'Agent run data unavailable.'
          : `${recordedRunCount} recorded ${recordedRunCount === 1 ? 'run' : 'runs'} in this period; ` +
            `${runSuccessRate ?? 'no terminal run outcomes'}${runSuccessRate ? ' terminal success' : ''}.`,
      },
      { group: 'execution', icon: <IconRobot size={15} />, title: 'Worker availability', detail: workers === undefined ? 'Worker inventory unavailable.' : `${onlineWorkers} of ${workers.length} workers are online.` },
      { group: 'delivery', icon: <IconFolders size={15} />, title: 'Delivery sources', detail: deliverySourceDetail },
    ],
    keyTakeaway: !pullRequests.complete ? deliverySourceDetail
      : outcomeSections.length ? `Pull-request outcomes in this scope: ${outcomeSummary}.`
        : 'No pull-request activity was recorded in this scope.',
    products: {
      rows: productSummaries, loading: products.isLoading || projects === undefined, error: products.isError,
      checkoutCount: scopedProjects?.length,
    },
    workspaces: [{
      name: 'Local workspace', icon: <IconActivity className="reports-preview-row-icon violet" size={12} aria-hidden="true" />,
      workItems: objectiveCount, deliveryVelocity: pullRequests.deliveryVelocity, cycleTime: pullRequests.cycleTime,
      acceptanceRate: pullRequests.acceptanceRate, autonomousCompletion: undefined,
    }],
    autonomyNote: 'Agent runs do not record autonomous-completion evidence.',
    downloads,
  };
}
