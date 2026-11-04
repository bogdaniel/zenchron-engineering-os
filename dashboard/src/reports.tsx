import { useState } from 'react';
import { BarChart, CompositeChart, DonutChart } from '@mantine/charts';
import { Badge, Button, Progress, Select, Table } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconActivity, IconChartBar, IconCircleCheck, IconClockHour4, IconCurrencyDollar, IconDownload, IconFilter, IconFolders, IconRobot, IconRoute, IconSparkles } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { agentsSchema, loadAgentRuns } from './agents';
import type { Objective } from './objectives';
import type { Project } from './projects';
import { loadProducts } from './productEditor';
import { MetricCard } from './MetricCard';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import { workflowsSchema } from './workflows';
import { useReportPullRequestMetrics } from './reportPullRequests';
import { useReportWorkflowRunMetrics } from './reportWorkflowRuns';
import './reports.css';

interface ReportWorker {
  status: 'online' | 'offline';
}

interface ReportsPageProps {
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

const runStatuses = [
  { value: 'succeeded', label: 'Succeeded', color: 'teal.5' },
  { value: 'running', label: 'Running', color: 'blue.5' },
  { value: 'queued', label: 'Queued', color: 'violet.5' },
  { value: 'failed', label: 'Failed', color: 'red.5' },
  { value: 'cancelled', label: 'Cancelled', color: 'gray.5' },
] as const;
type TimeRange = '30d' | '90d' | '365d' | 'all';
type ReportScope = { timeRange: TimeRange; product: string; objectiveOwner: string; workflow: string; repository: string };
const defaultScope: ReportScope = {
  timeRange: '30d', product: 'all', objectiveOwner: 'all', workflow: 'all', repository: 'all',
};
const timeRanges: { value: TimeRange; label: string }[] = [
  { value: '30d', label: 'Last 30 days' }, { value: '90d', label: 'Last 90 days' },
  { value: '365d', label: 'Last 12 months' }, { value: 'all', label: 'All time' },
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

export function ReportsPage({ apiOnline, objectives, projects, workers }: ReportsPageProps) {
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: loadWorkflows });
  const agents = useQuery({ queryKey: ['agents'], queryFn: loadAgents });
  const runs = useQuery({ queryKey: ['agent-runs'], queryFn: loadAgentRuns });
  const products = useQuery({ queryKey: ['products'], queryFn: loadProducts });
  const [scope, setScope] = useState(defaultScope);
  const [appliedScope, setAppliedScope] = useState(defaultScope);
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
                  : `${pullRequests.mergedCount} merged pull requests from ${pullRequests.githubProjectCount} GitHub repositories` +
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
  const productSummaries = scopedProducts.map((product) => {
    const repositoryIDs = new Set(product.repository_ids);
    return {
      id: product.id,
      name: product.name,
      repositories: projects === undefined ? undefined
        : scopedProjects?.filter((project) => repositoryIDs.has(project.id)).length,
      objectives: scopedObjectives?.filter((objective) => objective.product_id === product.id).length,
      runs: scopedRuns?.filter((run) => repositoryIDs.has(run.project_id)).length,
    };
  });
  const objectiveCount = scopedObjectives?.length;
  const completed = scopedObjectives ? countStatus(scopedObjectives, 'completed') : undefined;
  const activeWorkflows = workflows.data?.filter((workflow) => workflow.status === 'active').length;
  const onlineWorkers = workers?.filter((worker) => worker.status === 'online').length;
  const finishedRuns = scopedRuns?.filter((run) => run.status === 'succeeded' || run.status === 'failed') ?? [];
  const runSuccessRate = finishedRuns.length
    ? `${Math.round(finishedRuns.filter((run) => run.status === 'succeeded').length / finishedRuns.length * 100)}%`
    : undefined;
  const inventory = [
    { label: 'Objectives', count: objectiveCount, icon: <IconCircleCheck size={15} /> },
    {
      label: 'Workflow definitions',
      count: workflows.isSuccess ? workflows.data.length : undefined,
      icon: <IconRoute size={15} />,
    },
    {
      label: 'Agent profiles',
      count: agents.isSuccess ? agents.data.length : undefined,
      icon: <IconRobot size={15} />,
    },
    { label: 'Local checkouts', count: scopedProjects?.length, icon: <IconFolders size={15} /> },
  ];
  const maximumCount = Math.max(1, ...inventory.flatMap((item) => item.count === undefined ? [] : [item.count]));
  const runSections = scopedRuns?.length
    ? runStatuses.flatMap((status) => {
        const count = scopedRuns.filter((run) => run.status === status.value).length;
        return count ? [{ name: status.label, value: count, color: status.color }] : [];
      })
    : [];
  const completeMetrics = apiOnline && objectives !== undefined && projects !== undefined && workers !== undefined &&
    workflows.isSuccess && agents.isSuccess && products.isSuccess && runs.isSuccess;
  const summaryInsights = [
    { icon: <IconCircleCheck size={15} />, title: 'Objectives', detail: objectiveCount === undefined ? 'Objective data unavailable.' : `${completed} of ${objectiveCount} completed in this scope.` },
    { icon: <IconSparkles size={15} />, title: 'Agent activity', detail: runs.isLoading ? 'Agent run data is loading.' : runs.isError ? 'Agent run data unavailable.' : `${scopedRuns?.length ?? 0} recorded runs in this period.` },
    { icon: <IconRobot size={15} />, title: 'Worker availability', detail: workers === undefined ? 'Worker inventory unavailable.' : `${onlineWorkers} of ${workers.length} workers are online.` },
    { icon: <IconFolders size={15} />, title: 'Delivery sources', detail: deliverySourceDetail },
  ];
  const objectiveOwners = [...new Set(objectives?.map((objective) => objective.owner.trim()).filter(Boolean) ?? [])]
    .sort((left, right) => left.localeCompare(right));
  const productOptions = [
    { value: 'all', label: 'All products' },
    ...(products.data?.map((product) => ({ value: product.id, label: product.name })) ?? []),
  ];
  const repositoryOptions = [
    { value: 'all', label: 'All repositories' },
    ...(projects?.map((project) => ({ value: project.id, label: project.name })) ?? []),
  ];
  const ownerOptions = [
    { value: 'all', label: 'All objective owners' },
    ...objectiveOwners.map((owner) => ({ value: owner, label: owner })),
  ];
  const downloadCSV = () => {
    const rows = [
      ['Section', 'Name', 'Value', 'Local checkouts', 'Objectives', 'Agent runs'],
      ['Snapshot', 'Time range', timeRanges.find((range) => range.value === appliedScope.timeRange)?.label ?? 'All time'],
      ['Snapshot', 'Objectives', objectiveCount ?? 'Unavailable'],
      ['Snapshot', 'Completed objectives', completed ?? 'Unavailable'],
      ['Snapshot', 'Active workflows', activeWorkflows ?? 'Unavailable'],
      ['Snapshot', 'Agent runs', scopedRuns?.length ?? 'Unavailable'],
      ['Snapshot', 'Run success rate', runSuccessRate ?? 'Unavailable'],
      ['Snapshot', 'Local checkouts', scopedProjects?.length ?? 'Unavailable'],
      ['Snapshot', 'Delivery velocity', pullRequests.deliveryVelocity ?? 'Unavailable'],
      ['Snapshot', 'Cycle time', pullRequests.cycleTime ?? 'Unavailable'],
      ['Snapshot', 'CI duration', workflowRunMetrics.averageMinutes ?? 'Unavailable'],
      ['Snapshot', 'Review latency', 'Unavailable'],
      ['Snapshot', 'Agent spend', 'Unavailable'],
      ['Snapshot', 'Acceptance rate', pullRequests.acceptanceRate === undefined ? 'Unavailable' : `${pullRequests.acceptanceRate}%`],
      ['Snapshot', 'Autonomous completion', 'Unavailable'],
      ...productSummaries.map((product) => [
        'Product', product.name, '', product.repositories ?? 'Unavailable', product.objectives ?? 'Unavailable',
        product.runs ?? 'Unavailable',
      ]),
    ];
    const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `zenchron-report-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <section className="reports-page">
      <div className="reports-scope-bar" aria-label="Report scope">
        <div className="reports-scope-label"><IconFilter size={16} /><span>Report scope</span></div>
        <Select aria-label="Time range" label="Time range" data={timeRanges}
          value={scope.timeRange} onChange={(value) => updateScope('timeRange', value)} />
        <Select aria-label="Product" label="Product" data={productOptions}
          value={scope.product} onChange={(value) => updateScope('product', value)} />
        <Select aria-label="Objective owner" label="Objective owner" data={ownerOptions} value={scope.objectiveOwner}
          onChange={(value) => updateScope('objectiveOwner', value)} />
        <Select aria-label="Workflow filter unavailable because runs are not linked to workflows" label="Workflow"
          data={[{ value: 'all', label: 'All workflows' }]} value="all" disabled />
        <Select aria-label="Repository" label="Repository" data={repositoryOptions}
          value={scope.repository} onChange={(value) => updateScope('repository', value)} />
        <div className="reports-scope-actions">
          <Button className="reports-apply-filters" onClick={() => setAppliedScope(scope)}>Apply filters</Button>
          <Button className="reports-reset-filters" variant="subtle" onClick={() => {
            setScope(defaultScope);
            setAppliedScope(defaultScope);
          }}>Reset</Button>
        </div>
      </div>

      <div className="reports-metrics" aria-label="Workspace metrics">
        <Metric tone="velocity" label="Delivery velocity" value={pullRequests.deliveryVelocity} detail="PRs / week" icon={<IconChartBar size={17} />} />
        <Metric tone="cycle-time" label="Cycle time" value={pullRequests.cycleTime} detail="Hours" icon={<IconClockHour4 size={17} />} />
        <Metric tone="ci-duration" label="CI duration" value={workflowRunMetrics.averageMinutes ?? 'Unavailable'}
          detail="Avg. minutes" icon={<IconActivity size={17} />} />
        <Metric tone="review-latency" label="Review latency" value="Unavailable" detail="Hours" icon={<IconClockHour4 size={17} />} />
        <Metric tone="agent-spend" label="Agent spend" value="Unavailable" detail="USD" icon={<IconCurrencyDollar size={17} />} />
        <Metric tone="acceptance-rate" label="Acceptance rate" value={pullRequests.acceptanceRate === undefined ? undefined : `${pullRequests.acceptanceRate}%`} detail="Closed pull requests" icon={<IconCircleCheck size={17} />} />
        <Metric tone="autonomous-completion" label="Autonomous completion" value="Unavailable" detail="Completed agent runs" icon={<IconRobot size={17} />} />
      </div>

      <div className="reports-content-grid">
        <PanelCard className="reports-panel delivery-velocity-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconChartBar size={15} />}
            title="Delivery velocity &amp; cycle time" />
          {pullRequests.complete ? <CompositeChart
            className="reports-pull-request-chart"
            h={124}
            data={pullRequests.trend}
            dataKey="date"
            series={[
              { name: 'merged', label: 'Merged PRs', color: 'violet.5', type: 'line' },
              { name: 'cycle', label: 'Cycle time (h)', color: 'teal.4', type: 'line', yAxisId: 'right' },
            ]}
            withRightYAxis
            withLegend
            legendProps={{ verticalAlign: 'top', height: 22, iconSize: 7, wrapperStyle: { fontSize: 9 } }}
            xAxisProps={{ tick: { fontSize: 9 }, interval: 'preserveStartEnd' }}
            yAxisProps={{ tick: { fontSize: 9 }, width: 28 }}
            rightYAxisProps={{ tick: { fontSize: 9 }, width: 30 }}
            gridAxis="xy"
            strokeWidth={2}
            withDots={false}
            withTooltip
            aria-label="Merged pull requests and average cycle time trend"
          /> : <UnavailableChart detail={pullRequests.isError
            ? 'GitHub pull-request history is unavailable.'
            : pullRequests.githubProjectCount ? 'Waiting for complete GitHub pull-request history.'
              : 'Connect a source to view this chart'} />}
          {!pullRequests.complete && <p className="delivery-note">{pullRequests.githubProjectCount
            ? 'Incomplete or unavailable provider history cannot produce delivery metrics.'
            : 'Requires merged pull-request history.'}</p>}
        </PanelCard>
        <PanelCard className="reports-panel ci-distribution-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconActivity size={15} />} title="CI duration distribution" />
          {workflowRunMetrics.complete ? <BarChart
            className="reports-ci-chart"
            h={124}
            data={workflowRunMetrics.distribution}
            dataKey="duration"
            series={[{ name: 'runs', label: 'Completed runs', color: 'teal.5' }]}
            withYAxis={false}
            withLegend={false}
            xAxisProps={{ tick: { fontSize: 8 }, interval: 0 }}
            gridAxis="y"
            withTooltip
            aria-label={`CI duration distribution from ${workflowRunMetrics.runCount} completed GitHub Actions runs`}
          /> : <UnavailableChart detail={workflowRunMetrics.isError
            ? 'GitHub Actions run history is unavailable.'
            : workflowRunMetrics.githubProjectCount ? 'Waiting for complete GitHub Actions history.'
              : 'Connect a source to view this chart'} />}
          {!workflowRunMetrics.complete && <p className="delivery-note">{workflowRunMetrics.githubProjectCount
            ? 'Incomplete or unavailable provider history cannot produce CI metrics.'
            : 'Requires GitHub Actions run history.'}</p>}
        </PanelCard>

        <PanelCard className="reports-panel run-outcomes-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconSparkles size={15} />} title="Work outcomes"
            description={`Recorded status · ${timeRanges.find((range) => range.value === appliedScope.timeRange)?.label.toLowerCase() ?? 'all time'}`}
            actions={runSuccessRate && <Badge className="coverage-online" variant="light">{runSuccessRate} success</Badge>} />
          {runs.isLoading ? <div className="reports-empty">Loading agent runs…</div>
            : runs.isError ? <div className="reports-empty">Agent run data unavailable.</div>
              : runSections.length ? <div className="run-chart-layout">
                <DonutChart
                  size={120}
                  thickness={15}
                  data={runSections}
                  chartLabel={`${scopedRuns?.length ?? 0}`}
                  classNames={{ label: 'report-chart-label' }}
                  aria-label={`Agent run outcomes for ${timeRanges.find((range) => range.value === appliedScope.timeRange)?.label.toLowerCase() ?? 'all time'}`}
                />
                <div className="run-outcome-legend">
                  {runStatuses.map((status) => {
                    const count = scopedRuns?.filter((run) => run.status === status.value).length ?? 0;
                    return <div key={status.value}>
                      <i className={`run-outcome-dot ${status.value}`} />
                      <span>{status.label}</span><b>{count}</b>
                    </div>;
                  })}
                </div>
              </div> : <div className="reports-empty">No agent runs match this report scope.</div>}
        </PanelCard>
        <UnavailableMetricsPanel className="review-latency-panel" title="Review latency trend"
          icon={<IconClockHour4 size={15} />}
          detail="Requires provider review events." />
        <UnavailableMetricsPanel className="agent-spend-panel" title="Agent spend"
          icon={<IconCurrencyDollar size={15} />}
          detail="Requires provider usage records." />
        <UnavailableMetricsPanel className="acceptance-panel" title="Acceptance &amp; autonomous completion"
          icon={<IconCircleCheck size={15} />}
          detail="Requires reviewed pull requests and completed agent runs." />

        <PanelCard className="reports-panel reports-summary" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconSparkles size={15} />} title="Insights &amp; narrative"
            description="Findings from the selected snapshot" />
          <div className="reports-insights">
            {summaryInsights.map((insight) => <div className="reports-insight" key={insight.title}>
              {insight.icon}<div><b>{insight.title}</b><span>{insight.detail}</span></div>
            </div>)}
          </div>
          <div className="reports-key-takeaway"><IconSparkles size={14} /><span><b>Key takeaway</b>
            Snapshot counts are available; delivery trends need provider event data.</span></div>
        </PanelCard>

        <PanelCard className="reports-panel product-summary-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconFolders size={15} />} title="Product summary"
            description="Current counts for the selected report scope" />
          {products.isLoading ? <div className="reports-empty">Loading product summaries…</div>
            : products.isError ? <div className="reports-empty">Product data unavailable.</div>
              : productSummaries.length ? (
                <div className="product-summary-table-wrap">
                  <Table className="product-summary-table" aria-label="Product summary">
                    <Table.Thead><Table.Tr>
                      <Table.Th>Product</Table.Th><Table.Th>Local checkouts</Table.Th>
                      <Table.Th>Objectives</Table.Th><Table.Th>Agent runs</Table.Th>
                    </Table.Tr></Table.Thead>
                    <Table.Tbody>{productSummaries.map((product) => (
                      <Table.Tr key={product.id}>
                        <Table.Td>{product.name}</Table.Td><Table.Td>{product.repositories ?? 'Unavailable'}</Table.Td>
                        <Table.Td>{product.objectives ?? 'Unavailable'}</Table.Td>
                        <Table.Td>{product.runs ?? 'Unavailable'}</Table.Td>
                      </Table.Tr>
                    ))}</Table.Tbody>
                  </Table>
                </div>
              ) : <div className="reports-empty">No products match this report scope.</div>}
        </PanelCard>

        <PanelCard className="reports-panel inventory-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconFolders size={15} />} title="Workspace inventory"
            description="Current configuration records and local resources" />
          <div className="inventory-bars">
            {inventory.map((item) => (
              <div className="inventory-bar-row" key={item.label}>
                <div className="inventory-label">{item.icon}<span>{item.label}</span>
                  <b>{item.count ?? 'Unavailable'}</b></div>
                <Progress
                  value={item.count === undefined ? 0 : item.count / maximumCount * 100}
                  color="violet.5"
                  size="sm"
                  aria-label={`${item.label} count`}
                />
              </div>
            ))}
          </div>
          <p className="inventory-footnote">
            {completeMetrics
              ? `${onlineWorkers} of ${workers.length} workers are online; these totals are a current snapshot, ` +
                'not delivery trends.'
              : 'One or more sources are still loading or unavailable.'}
          </p>
        </PanelCard>

        <PanelCard className="reports-panel downloadable-reports-panel" withBorder>
          <PanelHeading className="reports-panel-heading" icon={<IconDownload size={15} />} title="Downloadable reports"
            description="Export this live snapshot as CSV"
            actions={<Button className="reports-download-button" leftSection={<IconDownload size={14} />}
              onClick={downloadCSV}>Download CSV</Button>} />
          <p className="downloadable-reports-note">Includes scoped objective, workflow, run, checkout, and product counts. Unavailable measures stay marked unavailable.</p>
        </PanelCard>
      </div>
    </section>
  );
}

function Metric({ tone, label, value, detail, icon }: {
  tone: string;
  label: string;
  value: number | string | undefined;
  detail?: string;
  icon: ReactNode;
}) {
  return <MetricCard className={`reports-metric ${tone}`} label={label} value={value ?? 'Unavailable'}
    detail={detail ?? (value === undefined ? 'No source data' : 'Current workspace snapshot')} icon={icon} />;
}

function UnavailableMetricsPanel({ className, title, icon, detail }: {
  className: string;
  title: string;
  icon: ReactNode;
  detail: string;
}) {
  return (
    <PanelCard className={`reports-panel ${className}`} withBorder>
      <PanelHeading className="reports-panel-heading" icon={icon} title={title} />
      <UnavailableChart detail="Connect a source to view this chart" />
      <p className="delivery-note">{detail}</p>
    </PanelCard>
  );
}

function UnavailableChart({ detail }: { detail: string }) {
  return (
    <div className="reports-empty-chart" role="status" aria-label={detail}>
      <div className="reports-empty-chart-grid" aria-hidden="true" />
      <span><IconChartBar size={15} />{detail}</span>
    </div>
  );
}
