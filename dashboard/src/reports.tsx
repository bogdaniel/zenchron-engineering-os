import { useState } from 'react';
import { BarChart, CompositeChart, DonutChart, LineChart, Sparkline } from '@mantine/charts';
import { Button, Select } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import {
  IconActivity, IconChartBar, IconCircleCheck, IconCpu, IconFilter, IconFolders,
  IconInfinity, IconMessageCircle, IconRobot, IconRocket, IconRoute, IconSparkles, IconStack, IconStopwatch,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { agentsSchema, loadAgentRuns } from './agents';
import type { Objective } from './objectives';
import type { Project } from './projects';
import { loadProducts } from './productEditor';
import { ChartLegend, ReportOutcomeLegend, UnavailableChart, UnavailableMetricsPanel } from './ReportVisuals';
import { MetricCard } from './MetricCard';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import { workflowsSchema } from './workflows';
import { useReportPullRequestMetrics } from './reportPullRequests';
import { useReportWorkflowRunMetrics } from './reportWorkflowRuns';
import { summarizeProductDelivery } from './reportSummaryMetrics';
import type { ProductDeliverySummary } from './ReportSummaries';
import { ProductSummaryPanel, WorkspaceSummaryPanel } from './ReportSummaries';
import { DownloadableReports } from './DownloadableReports';
import { reportPreviewCIDistribution, reportPreviewDownloads, reportPreviewInsights, reportPreviewLatency, reportPreviewOutcomes,
  reportPreviewProducts, reportPreviewSpend, reportPreviewTrend, reportPreviewWorkspaces } from './reports-preview';
import './reports.css';
import './reports-preview.css';

interface ReportWorker {
  status: 'online' | 'offline';
}

interface ReportsPageProps {
  designPreview?: boolean;
  apiOnline: boolean;
  objectives: Objective[] | undefined;
  projects: Project[] | undefined;
  workers: ReportWorker[] | undefined;
}

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

type TimeRange = '30d' | '90d' | '365d' | 'all';
type ReportScope = { timeRange: TimeRange; product: string; objectiveOwner: string; workflow: string; repository: string };
const defaultScope: ReportScope = {
  timeRange: '30d', product: 'all', objectiveOwner: 'all', workflow: 'all', repository: 'all',
};
const timeRanges: { value: TimeRange; label: string }[] = [
  { value: '30d', label: 'Last 30 Days' }, { value: '90d', label: 'Last 90 Days' },
  { value: '365d', label: 'Last 12 Months' }, { value: 'all', label: 'All Time' },
];
const insightViews = [
  { value: 'executive', label: 'Executive Summary' },
  { value: 'delivery', label: 'Delivery' },
  { value: 'execution', label: 'Execution' },
  { value: 'objectives', label: 'Objectives' },
];
const rangeDurations: Record<Exclude<TimeRange, 'all'>, number> = {
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
  '365d': 365 * 24 * 60 * 60 * 1000,
};
function isInRange(createdAt: string, range: TimeRange, now = Date.now()) {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp) || timestamp > now) return false;
  return range === 'all' || timestamp >= now - rangeDurations[range];
}

function countStatus(objectives: Objective[], status: string) {
  return objectives.filter((objective) => objective.status === status).length;
}

export function ReportsPage({ apiOnline, objectives, projects, workers, designPreview = false }: ReportsPageProps) {
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: loadWorkflows, enabled: !designPreview });
  const agents = useQuery({ queryKey: ['agents'], queryFn: loadAgents, enabled: !designPreview });
  const runs = useQuery({ queryKey: ['agent-runs'], queryFn: loadAgentRuns, enabled: !designPreview });
  const products = useQuery({ queryKey: ['products'], queryFn: loadProducts, enabled: !designPreview });
  const [scope, setScope] = useState(defaultScope);
  const [appliedScope, setAppliedScope] = useState(defaultScope);
  const [insightView, setInsightView] = useState('executive');
  const updateScope = (key: keyof ReportScope, value: string | null) => {
    setScope((current) => ({ ...current, [key]: value ?? 'all' }));
  };
  const selectedProduct = products.data?.find((product) => product.id === appliedScope.product);
  const productRepositoryIDs = new Set(selectedProduct?.repository_ids ?? []);
  const scopedObjectives = objectives?.filter((objective) =>
    isInRange(objective.created_at, appliedScope.timeRange) &&
    (appliedScope.product === 'all' || objective.product_id === appliedScope.product) &&
    (appliedScope.objectiveOwner === 'all' || objective.owner === appliedScope.objectiveOwner),
  );
  const scopedProjects = projects?.filter((project) =>
    (appliedScope.product === 'all' || productRepositoryIDs.has(project.id)) &&
    (appliedScope.repository === 'all' || project.id === appliedScope.repository),
  );
  const pullRequests = useReportPullRequestMetrics(scopedProjects, appliedScope.timeRange);
  const workflowRunMetrics = useReportWorkflowRunMetrics(scopedProjects, appliedScope.timeRange);
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
    isInRange(run.created_at, appliedScope.timeRange) &&
    (appliedScope.product === 'all' || productRepositoryIDs.has(run.project_id)) &&
    (appliedScope.repository === 'all' || run.project_id === appliedScope.repository),
  );
  const scopedProducts = products.data?.filter((product) =>
    appliedScope.product === 'all' || product.id === appliedScope.product,
  ) ?? [];
  const productSummaries: ProductDeliverySummary[] = scopedProducts.map((product) => {
    const repositoryIDs = new Set(product.repository_ids);
    return {
      id: product.id,
      name: product.name,
      recordType: 'Product' as const,
      autonomousCompletion: undefined,
      ...summarizeProductDelivery(
        (projects ?? []).filter((project) => repositoryIDs.has(project.id) &&
          (appliedScope.repository === 'all' || project.id === appliedScope.repository)),
        pullRequests.repositories,
        workflowRunMetrics.repositories,
        appliedScope.timeRange,
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
      recordType: 'Unassigned repositories',
      autonomousCompletion: undefined,
      ...summarizeProductDelivery(scopedProjects, pullRequests.repositories,
        workflowRunMetrics.repositories, appliedScope.timeRange),
      repositories: scopedProjects.length,
      objectives: scopedObjectives?.length,
      runs: scopedRuns?.length,
    });
  }
  const objectiveCount = scopedObjectives?.length;
  const completed = scopedObjectives ? countStatus(scopedObjectives, 'completed') : undefined;
  const activeWorkflows = workflows.data?.filter((workflow) => workflow.status === 'active').length;
  const onlineWorkers = workers?.filter((worker) => worker.status === 'online').length;
  const finishedRuns = scopedRuns?.filter((run) => run.status === 'succeeded' || run.status === 'failed') ?? [];
  const runSuccessRate = finishedRuns.length
    ? `${Math.round(finishedRuns.filter((run) => run.status === 'succeeded').length / finishedRuns.length * 100)}%`
    : undefined;
  const recordedRunCount = scopedRuns?.length ?? 0;
  const selectedRangeLabel = timeRanges.find((range) => range.value === appliedScope.timeRange)?.label.toLowerCase()
    ?? 'all time';
  const inventory = [
    { label: 'Objectives', count: objectiveCount },
    { label: 'Workflow definitions', count: workflows.isSuccess ? workflows.data.length : undefined },
    { label: 'Agent profiles', count: agents.isSuccess ? agents.data.length : undefined },
    { label: 'Local checkouts', count: scopedProjects?.length },
  ];
  const pullRequestOutcomeSections = pullRequests.outcomes.filter((outcome) => outcome.value > 0);
  const outcomeSummary = pullRequests.outcomes.map((outcome) => `${outcome.value} ${outcome.name.toLowerCase()}`).join(' · ');
  const keyTakeaway = designPreview
    ? 'Teams are delivering faster with higher autonomy and quality, at a scalable cost.'
    : pullRequests.complete
    ? pullRequestOutcomeSections.length
      ? `Pull-request outcomes in this scope: ${outcomeSummary}.`
      : 'No pull-request activity was recorded in this scope.'
    : deliverySourceDetail;
  const summaryInsights = designPreview ? reportPreviewInsights.map((insight, index) => ({
    ...insight,
    icon: [<IconActivity size={15} />, <IconRocket size={15} />, <IconRobot size={15} />, <IconCpu size={15} />, <IconFolders size={15} />][index],
  })) : [
    { group: 'objectives', icon: <IconCircleCheck size={15} />, title: 'Objectives', detail: objectiveCount === undefined ? 'Objective data unavailable.' : `${completed} of ${objectiveCount} completed in this scope.` },
    {
      group: 'execution', icon: <IconSparkles size={15} />, title: 'Agent activity',
      detail: runs.isLoading ? 'Agent run data is loading.' : runs.isError ? 'Agent run data unavailable.'
        : `${recordedRunCount} recorded ${recordedRunCount === 1 ? 'run' : 'runs'} in this period; ` +
          `${runSuccessRate ?? 'no terminal run outcomes'}${runSuccessRate ? ' terminal success' : ''}.`,
    },
    { group: 'execution', icon: <IconRobot size={15} />, title: 'Worker availability', detail: workers === undefined ? 'Worker inventory unavailable.' : `${onlineWorkers} of ${workers.length} workers are online.` },
    { group: 'delivery', icon: <IconFolders size={15} />, title: 'Delivery sources', detail: deliverySourceDetail },
  ];
  const visibleInsights = summaryInsights.filter((insight) => insightView === 'executive' || insight.group === insightView);
  const objectiveOwners = [...new Set(objectives?.map((objective) => objective.owner.trim()).filter(Boolean) ?? [])]
    .sort((left, right) => left.localeCompare(right));
  const productOptions = [
    { value: 'all', label: 'All Products' },
    ...(products.data?.map((product) => ({ value: product.id, label: product.name })) ?? []),
  ];
  const repositoryOptions = [
    { value: 'all', label: 'All Repositories' },
    ...(projects?.map((project) => ({ value: project.id, label: project.name })) ?? []),
  ];
  const ownerOptions = [
    { value: 'all', label: designPreview ? 'All Teams' : 'All Objective Owners' },
    ...objectiveOwners.map((owner) => ({ value: owner, label: owner })),
  ];
  const downloadCSV = (name: string, rows: (string | number | undefined)[][]) => {
    const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `zenchron-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const metricRows = [
    ['Delivery velocity', pullRequests.deliveryVelocity ?? 'Unavailable', pullRequests.complete ? 'Complete history' : deliverySourceDetail],
    ['Cycle time', pullRequests.cycleTime ?? 'Unavailable', pullRequests.complete ? 'Complete history' : deliverySourceDetail],
    ['CI duration', workflowRunMetrics.averageMinutes ?? 'Unavailable', workflowRunMetrics.complete ? 'Complete history' : 'Actions history unavailable'],
    ['Review latency', 'Unavailable', 'Review event data is not connected'],
    ['Agent spend', 'Unavailable', 'Model usage data is not connected'],
    ['Acceptance rate', pullRequests.acceptanceRate === undefined ? 'Unavailable' : `${pullRequests.acceptanceRate}%`, pullRequests.complete ? 'Complete history' : deliverySourceDetail],
    ['Autonomous completion', 'Unavailable', 'Completion evidence is not connected'],
  ];
  const downloadableReports = designPreview ? reportPreviewDownloads : [
    {
      name: 'Executive Summary', detail: 'Delivery KPIs and highlights', format: 'CSV',
      download: () => downloadCSV('executive-summary', [
        ['Metric', 'Value'],
        ['Time range', timeRanges.find((range) => range.value === appliedScope.timeRange)?.label ?? 'All time'],
        ['Objectives', objectiveCount ?? 'Unavailable'], ['Completed objectives', completed ?? 'Unavailable'],
        ['Active workflows', activeWorkflows ?? 'Unavailable'], ['Agent runs', scopedRuns?.length ?? 'Unavailable'],
        ['Run success rate', runSuccessRate ?? 'Unavailable'], ['Local checkouts', scopedProjects?.length ?? 'Unavailable'],
        ['Delivery sources', deliverySourceDetail],
      ]),
    },
    {
      name: 'Detailed Metrics', detail: 'Metrics by product and team', format: 'CSV',
      download: () => downloadCSV('detailed-metrics', [['Metric', 'Value', 'Source'], ...metricRows]),
    },
    {
      name: 'Agent Spend & Utilization', detail: 'Usage data unavailable', format: 'CSV',
      download: () => downloadCSV('agent-spend-utilization', [
        ['Agent', 'Project', 'Branch', 'Status', 'Spend (USD)', 'Usage', 'Source'],
        ...(scopedRuns ?? []).map((run) => [run.agent_name, run.project_name, run.branch, run.status,
          'Unavailable', 'Unavailable', 'Provider usage records are not connected']),
      ]),
    },
    {
      name: 'Product & Workspace Report', detail: 'Delivery and workspace data', format: 'CSV',
      download: () => downloadCSV('product-workspace', [
        ['Record', 'Name', 'Repositories', 'Objectives', 'Agent runs', 'Velocity (PRs/week)', 'Cycle time (hours)',
          'CI duration (minutes)', 'Acceptance rate (%)', 'Autonomous completion (%)', 'Worker', 'Status'],
        ...productSummaries.map((product) => [
          product.recordType, product.name, product.repositories, product.objectives, product.runs,
          product.deliveryVelocity ?? 'Unavailable', product.cycleTime ?? 'Unavailable',
          product.ciDuration ?? 'Unavailable', product.acceptanceRate ?? 'Unavailable',
          product.autonomousCompletion ?? 'Unavailable', '', '',
        ]),
        ['Workspace', 'Local workspace', '', objectiveCount ?? 'Unavailable', '',
          pullRequests.deliveryVelocity ?? 'Unavailable', pullRequests.cycleTime ?? 'Unavailable',
          workflowRunMetrics.averageMinutes ?? 'Unavailable', pullRequests.acceptanceRate ?? 'Unavailable',
          'Unavailable', '', ''],
        ...scopedProjects?.map((project) => [
          'Repository', project.name, 1, '', scopedRuns?.filter((run) => run.project_id === project.id).length,
          '', '', '', '', '', project.worker_name, project.worker_status,
        ]) ?? [],
        ...inventory.map((item) => [
          'Inventory', item.label, '', '', item.count ?? 'Unavailable', '', '', '', '', '', '', 'Current snapshot',
        ]),
      ]),
    },
  ];

  return (
    <section className={`reports-page${designPreview ? ' reports-design-preview' : ''}`}>
      <div className="reports-scope-bar" aria-label="Report scope">
        <div className="reports-scope-label"><IconFilter size={16} /><span>Report Scope</span></div>
        <Select aria-label="Time Range" label="Time Range" data={timeRanges}
          value={scope.timeRange} onChange={(value) => updateScope('timeRange', value)} disabled={designPreview} />
        <Select aria-label="Product" label="Product" data={productOptions}
          value={scope.product} onChange={(value) => updateScope('product', value)} disabled={designPreview} />
        <Select aria-label={designPreview ? 'Team' : 'Objective owner'} label={designPreview ? 'Team' : 'Objective owner'} data={ownerOptions} value={scope.objectiveOwner}
          onChange={(value) => updateScope('objectiveOwner', value)} disabled={designPreview} />
        <Select aria-label="Workflow filter unavailable because runs are not linked to workflows" label="Workflow"
          data={[{ value: 'all', label: 'All Workflows' }]} value="all" disabled />
        <Select aria-label="Repository" label="Repository" data={repositoryOptions}
          value={scope.repository} onChange={(value) => updateScope('repository', value)} disabled={designPreview} />
        <div className="reports-scope-actions">
          <Button className="reports-apply-filters" disabled={designPreview} onClick={() => setAppliedScope(scope)}>Apply filters</Button>
          <Button className="reports-reset-filters" variant="subtle" onClick={() => {
            setScope(defaultScope);
            setAppliedScope(defaultScope);
          }} disabled={designPreview}>Reset</Button>
        </div>
      </div>

      <div className="reports-metrics" aria-label="Workspace metrics">
        <Metric tone="velocity" label="Delivery Velocity" value={designPreview ? previewValue('42', '+27%') : pullRequests.deliveryVelocity} detail="PRs / week"
          icon={<IconRocket size={17} />} trend={designPreview
            ? metricSparkline('Delivery velocity', reportPreviewTrend.map((item) => item.merged), 'violet.5')
            : pullRequests.complete ? metricSparkline('Delivery velocity', pullRequests.trend.map((item) => item.merged), 'violet.5') : undefined} />
        <Metric tone="cycle-time" label="Cycle Time" value={designPreview ? previewValue('13.6h', '−34%') : pullRequests.cycleTime} detail="Hours"
          icon={<IconStopwatch size={17} />} trend={designPreview
            ? metricSparkline('Cycle time', reportPreviewTrend.map((item) => item.cycle), 'teal.4')
            : pullRequests.complete ? metricSparkline('Cycle time', pullRequests.trend.map((item) => item.cycle), 'teal.4') : undefined} />
        <Metric tone="ci-duration" label="CI Duration" value={designPreview ? previewValue('8.2m', '−28%') : workflowRunMetrics.averageMinutes ?? 'Unavailable'}
          detail="Avg. minutes" icon={<IconStack size={17} />}
          trend={designPreview ? metricSparkline('CI duration', reportPreviewCIDistribution.map((item) => item.runs), 'teal.5')
            : workflowRunMetrics.complete ? metricSparkline('CI duration', workflowRunMetrics.trend, 'teal.5') : undefined} />
        <Metric tone="review-latency" label="Review Latency" value={designPreview ? previewValue('4.7h', '−41%') : 'Unavailable'} detail="Hours"
          icon={<IconMessageCircle size={17} />} trend={designPreview ? metricSparkline('Review latency', [12, 9, 7, 6, 5, 4.7], 'violet.5') : undefined} />
        <Metric tone="agent-spend" label="Agent Spend" value={designPreview ? previewValue('$13.6K', '+12%') : 'Unavailable'} detail="USD"
          icon={<IconCpu size={17} />} trend={designPreview ? metricSparkline('Agent spend', [5, 7, 7.5, 8, 10, 13.6], 'violet.5') : undefined} />
        <Metric tone="acceptance-rate" label="Acceptance Rate" value={designPreview ? previewValue('94.8%', '+3.1 pp') : pullRequests.acceptanceRate === undefined ? undefined : `${pullRequests.acceptanceRate}%`} detail="Closed pull requests"
          icon={<IconCircleCheck size={17} />}
          trend={designPreview ? metricSparkline('Acceptance rate', reportPreviewTrend.map((item) => item.acceptance), 'teal.5')
            : pullRequests.complete ? metricSparkline('Acceptance rate', pullRequests.trend.map((item) => item.acceptance), 'teal.5') : undefined} />
        <Metric tone="autonomous-completion" label="Autonomous Completion" value={designPreview ? previewValue('68.4%', '+9.7 pp') : 'Unavailable'} detail="Completed agent runs"
          icon={<IconInfinity size={17} />} trend={designPreview ? metricSparkline('Autonomous completion', reportPreviewTrend.map((item) => item.autonomy), 'teal.5') : undefined} />
      </div>

      <div className="reports-content-grid">
        <PanelCard className="reports-panel delivery-velocity-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconChartBar size={15} />}
            title="Delivery Velocity &amp; Cycle Time" />
          <ChartLegend items={[{ tone: 'violet', label: 'Delivery Velocity (PRs/week)' }, { tone: 'teal', label: 'Cycle Time (hours)' }]} />
          {designPreview || pullRequests.complete && pullRequests.mergedCount > 0 ? <CompositeChart
            className="reports-pull-request-chart"
            h={112}
            textColor="#9691a8"
            data={designPreview ? reportPreviewTrend : pullRequests.trend}
            dataKey="date"
            series={[
              { name: 'merged', label: 'Delivery Velocity (PRs/week)', color: 'violet.5', type: 'line' },
              { name: 'cycle', label: 'Cycle Time (hours)', color: 'teal.4', type: 'line', yAxisId: 'right' },
            ]}
            withRightYAxis
            withLegend={false}
            xAxisProps={{ tick: { fill: '#9691a8', fontSize: 9 }, interval: 'preserveStartEnd' }}
            yAxisProps={{ tick: { fill: '#9691a8', fontSize: 9 }, width: 28 }}
            rightYAxisProps={{ tick: { fill: '#9691a8', fontSize: 9 }, width: 30 }}
            gridAxis="xy"
            strokeWidth={2}
            withDots={false}
            withTooltip
            aria-label="Merged pull requests and average cycle time trend"
          /> : pullRequests.complete
            ? <UnavailableChart detail="No merged pull requests in this period." />
            : <UnavailableChart detail={pullRequests.isError
            ? 'GitHub pull-request history is unavailable.'
            : pullRequests.githubProjectCount ? 'Waiting for complete GitHub pull-request history.'
              : 'Connect a source to view this chart'} />}
        </PanelCard>
        <PanelCard className="reports-panel ci-distribution-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconActivity size={15} />} title="CI Duration Distribution"
            actions={(designPreview || workflowRunMetrics.p50Minutes !== undefined && workflowRunMetrics.p95Minutes !== undefined) &&
              <div className="reports-percentiles" role="group" aria-label="CI duration percentiles">
                <span>p50 {designPreview ? '6.8' : workflowRunMetrics.p50Minutes!.toFixed(1)}m</span>
                <span>p95 {designPreview ? '18.4' : workflowRunMetrics.p95Minutes!.toFixed(1)}m</span>
              </div>} />
          <ChartLegend items={[{ tone: 'teal', label: 'Completed GitHub Actions runs' }]} />
          {designPreview || workflowRunMetrics.complete && workflowRunMetrics.runCount > 0 ? <BarChart
            className="reports-ci-chart"
            h={112}
            textColor="#9691a8"
            data={designPreview ? reportPreviewCIDistribution : workflowRunMetrics.distribution}
            dataKey="duration"
            series={[{ name: 'runs', label: 'Completed runs', color: 'teal.5' }]}
            withYAxis={false}
            withLegend={false}
            xAxisProps={{ tick: { fill: '#9691a8', fontSize: 8 }, interval: 0 }}
            gridAxis="y"
            withTooltip
            aria-label={designPreview ? 'Mock CI duration distribution' : `CI duration distribution from ${workflowRunMetrics.runCount} completed GitHub Actions runs`}
          /> : workflowRunMetrics.complete
            ? <UnavailableChart detail="No completed GitHub Actions runs in this period." />
            : <UnavailableChart detail={workflowRunMetrics.isError
            ? 'GitHub Actions run history is unavailable.'
            : workflowRunMetrics.githubProjectCount ? 'Waiting for complete GitHub Actions history.'
              : 'Connect a source to view this chart'} />}
        </PanelCard>

        <PanelCard className="reports-panel work-outcomes-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconRoute size={15} />} title="Work Outcomes"
            description={designPreview ? 'All Workflows' : `Pull request status · ${selectedRangeLabel}`} />
          {designPreview ? <div className="reports-outcomes-layout reports-outcomes-preview"><div className="reports-outcomes-donut">
            <DonutChart size={120} thickness={15} data={reportPreviewOutcomes}
              aria-label="Mock work outcomes for the last 30 days" />
            <div className="reports-outcomes-label" aria-hidden="true"><b>17,842</b><span>Work Items</span></div>
          </div>
            <ReportOutcomeLegend items={reportPreviewOutcomes} valueSuffix="%" label="Work outcomes legend" /></div>
            : pullRequests.isLoading ? <div className="reports-empty">Loading pull-request outcomes…</div>
            : pullRequests.isError ? <div className="reports-empty">Pull-request outcomes are unavailable.</div>
              : !pullRequests.complete ? <div className="reports-empty" role="status">
                {pullRequests.githubProjectCount
                  ? 'Pull-request history is incomplete; narrow the time range.'
                  : 'Connect a supported GitHub repository to view pull-request outcomes.'}
              </div>
              : <div className={`reports-outcomes-layout${pullRequestOutcomeSections.length ? '' :
                ' reports-outcomes-empty'}`}>
                {pullRequestOutcomeSections.length ? <DonutChart
                  size={120}
                  thickness={15}
                  data={pullRequestOutcomeSections}
                  chartLabel={`${pullRequestOutcomeSections.reduce((count, outcome) => count + outcome.value, 0)}`}
                  classNames={{ label: 'report-chart-label' }}
                  aria-label={`Pull request outcomes for ${selectedRangeLabel}`}
                /> : <div className="reports-empty" role="status">No pull requests match this report scope.</div>}
                <ReportOutcomeLegend items={pullRequests.outcomes} />
              </div>}
        </PanelCard>
        {designPreview ? <PanelCard className="reports-panel review-latency-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconMessageCircle size={15} />} title="Review Latency Trend" />
          <ChartLegend items={[{ tone: 'violet', label: 'Review latency' }]} />
          <LineChart className="reports-latency-chart" h={76} textColor="#9691a8"
            data={reportPreviewTrend.map((item, index) => ({ date: item.date, latency: reportPreviewLatency[index] }))}
            dataKey="date" series={[{ name: 'latency', label: 'Review latency (h)', color: 'violet.5' }]}
            yAxisProps={{ tick: { fill: '#9691a8', fontSize: 8 }, width: 28 }}
            xAxisProps={{ tick: { fill: '#9691a8', fontSize: 8 }, interval: 'preserveStartEnd' }}
            gridAxis="xy" withDots={false} withTooltip aria-label="Mock review latency trend" />
        </PanelCard> : <UnavailableMetricsPanel className="review-latency-panel" title="Review Latency Trend"
          icon={<IconMessageCircle size={15} />} detail="Requires provider review events." />}
        {designPreview ? <PanelCard className="reports-panel agent-spend-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconCpu size={15} />} title="Agent Spend" />
          <ChartLegend items={[{ tone: 'violet', label: 'Spend (USD)' }, { tone: 'teal', label: 'Autonomous completion rate' }]} />
          <CompositeChart className="reports-spend-chart" h={76} textColor="#9691a8"
            data={reportPreviewTrend.map((item, index) => ({ ...item, spend: reportPreviewSpend[index] }))}
            dataKey="date" series={[{ name: 'spend', label: 'Spend (USD)', color: 'violet.5', type: 'bar' },
              { name: 'autonomy', label: 'Autonomous completion rate', color: 'teal.4', type: 'line', yAxisId: 'right' }]}
            withRightYAxis withLegend={false} xAxisProps={{ tick: { fill: '#9691a8', fontSize: 8 }, interval: 'preserveStartEnd' }}
            yAxisProps={{ tick: { fill: '#9691a8', fontSize: 8 }, width: 28 }}
            rightYAxisProps={{ tick: { fill: '#9691a8', fontSize: 8 }, width: 28 }}
            gridAxis="xy" withTooltip aria-label="Mock agent spend and autonomous completion trend" />
        </PanelCard> : <UnavailableMetricsPanel className="agent-spend-panel" title="Agent Spend"
          icon={<IconCpu size={15} />} detail="Requires provider usage records." />}
        <PanelCard className="reports-panel acceptance-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconCircleCheck size={15} />}
            title="Acceptance &amp; Autonomous Completion" />
          <ChartLegend items={[{ tone: 'violet', label: 'Acceptance rate' },
            { tone: 'teal', label: designPreview ? 'Autonomous completion rate' : 'Autonomous completion · unavailable' }]} />
          {designPreview ? <LineChart className="reports-acceptance-chart" h={76} textColor="#9691a8"
            data={reportPreviewTrend} dataKey="date" series={[
              { name: 'acceptance', label: 'Acceptance rate', color: 'violet.5' },
              { name: 'autonomy', label: 'Autonomous completion rate', color: 'teal.5' },
            ]} yAxisProps={{ domain: [0, 100], tick: { fill: '#9691a8', fontSize: 8 }, width: 28 }}
            xAxisProps={{ tick: { fill: '#9691a8', fontSize: 8 }, interval: 'preserveStartEnd' }}
            gridAxis="xy" withDots={false} withTooltip aria-label="Mock acceptance and autonomous completion trends" />
            : pullRequests.complete && pullRequests.acceptanceRate !== undefined ? <LineChart
            className="reports-acceptance-chart" h={76} textColor="#9691a8" data={pullRequests.trend}
            dataKey="date" series={[{ name: 'acceptance', label: 'Acceptance rate', color: 'teal.5' }]}
            yAxisProps={{ domain: [0, 100], tick: { fill: '#9691a8', fontSize: 8 }, width: 28 }}
            xAxisProps={{ tick: { fill: '#9691a8', fontSize: 8 }, interval: 'preserveStartEnd' }}
            gridAxis="xy" withDots={false} withTooltip aria-label="Pull request acceptance rate trend" />
            : <UnavailableChart detail={pullRequests.isError
              ? 'Pull-request history is unavailable.'
              : pullRequests.complete ? 'No closed pull requests in this period.'
                : 'Acceptance needs complete pull-request history; autonomous completion is not recorded yet.'} />}
        </PanelCard>

        <PanelCard className="reports-panel reports-summary" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconSparkles size={15} />} title="Insights &amp; Narrative"
            description={designPreview ? undefined : 'Findings from the selected snapshot'}
            actions={<Select className="reports-insight-filter" aria-label="Insights view" data={insightViews}
              value={insightView} onChange={(value) => setInsightView(value ?? 'executive')} />} />
          <div className="reports-insights">
            {visibleInsights.map((insight) => <div className="reports-insight" key={insight.title}>
              {insight.icon}<div><b>{insight.title}</b><span>{insight.detail}</span></div>
            </div>)}
          </div>
          <div className="reports-key-takeaway"><IconSparkles size={14} /><span><b>Key takeaway</b>
            {keyTakeaway}</span></div>
        </PanelCard>

        <ProductSummaryPanel rows={designPreview ? reportPreviewProducts : productSummaries} designPreview={designPreview}
          loading={!designPreview && (products.isLoading || projects === undefined)} error={!designPreview && products.isError}
          checkoutCount={scopedProjects?.length} />

        <WorkspaceSummaryPanel rows={designPreview ? reportPreviewWorkspaces : undefined} designPreview={designPreview} workItems={objectiveCount} metrics={{
          deliveryVelocity: pullRequests.deliveryVelocity,
          cycleTime: pullRequests.cycleTime,
          ciDuration: workflowRunMetrics.averageMinutes,
          acceptanceRate: pullRequests.acceptanceRate,
          autonomousCompletion: undefined,
        }} />

        <DownloadableReports reports={downloadableReports} />
      </div>
    </section>
  );
}

function previewValue(value: string, delta: string) {
  return <span className="reports-preview-value">{value}<small>{delta}</small></span>;
}

function Metric({ tone, label, value, detail, icon, trend }: {
  tone: string;
  label: string;
  value: ReactNode;
  detail?: string;
  icon: ReactNode;
  trend?: ReactNode;
}) {
  return <MetricCard className={`reports-metric ${tone}`} label={label} value={value ?? 'Unavailable'}
    detail={detail ?? (value === undefined ? 'No source data' : 'Current workspace snapshot')} icon={icon} trend={trend} />;
}

function metricSparkline(label: string, data: (number | null)[], color: string) {
  if (!data.some((value) => value !== null)) return undefined;
  return <Sparkline className="metric-sparkline" role="img" aria-label={`${label} trend`} data={data} color={color}
    w={54} h={24} withGradient={false} strokeWidth={2} />;
}
