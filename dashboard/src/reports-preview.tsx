import { IconActivity, IconCode, IconCpu, IconDatabase, IconFolders, IconInfinity, IconPuzzle, IconRobot, IconRocket,
  IconStack } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { ProductDeliverySummary } from './ReportSummaries';
import type { LatencyPercentile, ReportScope, ReportsSource } from './reportsView';

const trend = [
  { date: 'Jan 1', merged: 10, cycle: 31, acceptance: 89, autonomy: 54 },
  { date: 'Jan 4', merged: 17, cycle: 25, acceptance: 90, autonomy: 57 },
  { date: 'Jan 7', merged: 18, cycle: 21, acceptance: 91, autonomy: 58 },
  { date: 'Jan 10', merged: 25, cycle: 18, acceptance: 92, autonomy: 60 },
  { date: 'Jan 13', merged: 24, cycle: 16, acceptance: 92, autonomy: 63 },
  { date: 'Jan 16', merged: 32, cycle: 13, acceptance: 93, autonomy: 64 },
  { date: 'Jan 19', merged: 38, cycle: 12, acceptance: 93, autonomy: 66 },
  { date: 'Jan 22', merged: 35, cycle: 11, acceptance: 94, autonomy: 67 },
  { date: 'Jan 25', merged: 34, cycle: 10, acceptance: 94, autonomy: 68 },
  { date: 'Jan 28', merged: 35, cycle: 9.5, acceptance: 94.5, autonomy: 68.1 },
  { date: 'Jan 30', merged: 42, cycle: 13.6, acceptance: 94.8, autonomy: 68.4 },
];

const latencyByPercentile: Record<LatencyPercentile, number[]> = {
  P50: [11.5, 9.1, 7.7, 6.4, 5.9, 5.3, 5.1, 4.9, 4.8, 4.75, 4.7],
  P75: [15.2, 12.1, 10.2, 8.5, 7.8, 7.1, 6.8, 6.6, 6.5, 6.45, 6.4],
  P95: [23.4, 18.6, 15.8, 13.2, 12.0, 10.9, 10.5, 10.1, 9.9, 9.8, 9.7],
};

const ciDistribution = [
  { duration: '<2', runs: 390 }, { duration: '2–4', runs: 920 }, { duration: '4–6', runs: 1760 },
  { duration: '6–8', runs: 2070 }, { duration: '8–10', runs: 1280 }, { duration: '10–15', runs: 880 },
  { duration: '15–20', runs: 540 }, { duration: '20–30', runs: 330 }, { duration: '>30', runs: 210 },
];

const outcomes = [
  { name: 'Accepted / Merged', value: 94.8, color: '#27dca3' },
  { name: 'Needs Changes', value: 3.6, color: '#aa62f3' },
  { name: 'Rejected', value: 1.2, color: '#5584ef' },
  { name: 'Abandoned', value: 0.4, color: '#8d93aa' },
];

const spend = [5, 6, 7, 7.5, 8, 9, 10, 11.5, 12.5, 13, 13.6];

const products: ProductDeliverySummary[] = [
  { id: 'core-product', name: 'Core Product', recordType: 'Product', repositories: 3, objectives: 8, runs: 421, deliveryVelocity: 18.4, cycleTime: 11.9, ciDuration: 7.6, acceptanceRate: 96.2, autonomousCompletion: 71.8 },
  { id: 'ai-platform', name: 'AI Platform', recordType: 'Product', repositories: 2, objectives: 6, runs: 318, deliveryVelocity: 9.7, cycleTime: 14.2, ciDuration: 8.9, acceptanceRate: 94.1, autonomousCompletion: 67.9 },
  { id: 'developer-tools', name: 'Developer Tools', recordType: 'Product', repositories: 3, objectives: 5, runs: 289, deliveryVelocity: 6.1, cycleTime: 16.7, ciDuration: 10.4, acceptanceRate: 92.8, autonomousCompletion: 63.5 },
  { id: 'integrations', name: 'Integrations', recordType: 'Product', repositories: 2, objectives: 4, runs: 197, deliveryVelocity: 4.8, cycleTime: 18.6, ciDuration: 9.7, acceptanceRate: 93.9, autonomousCompletion: 66.1 },
  { id: 'total', name: 'Total / Avg.', recordType: 'Product', repositories: 10, objectives: 23, runs: 1225, deliveryVelocity: 42, cycleTime: 13.6, ciDuration: 8.2, acceptanceRate: 94.8, autonomousCompletion: 68.4 },
];

const totalRow = 'Total / Avg.';
const workspaces = [
  { name: 'Platform', workItems: 6816, deliveryVelocity: 18.4, cycleTime: 12.9, acceptanceRate: 95.6, autonomousCompletion: 70.9 },
  { name: 'Product', workItems: 5491, deliveryVelocity: 12.1, cycleTime: 13.8, acceptanceRate: 94.8, autonomousCompletion: 68.1 },
  { name: 'Infrastructure', workItems: 3207, deliveryVelocity: 7.8, cycleTime: 15.6, acceptanceRate: 93.7, autonomousCompletion: 66.9 },
  { name: 'Data', workItems: 2332, deliveryVelocity: 5.2, cycleTime: 14.9, acceptanceRate: 94.3, autonomousCompletion: 66.8 },
  { name: totalRow, workItems: 17842, deliveryVelocity: 42, cycleTime: 13.6, acceptanceRate: 94.8, autonomousCompletion: 68.4 },
];

const workflows = ['PR Review & Release Orchestration', 'Nightly Regression Suite', 'Production Deployment'];
const repositories = ['zenchron/engineering-os', 'zenchron/platform-services', 'zenchron/agent-sdk', 'zenchron/devtools'];
const repositoryProducts: Record<string, string[]> = {
  'zenchron/engineering-os': ['core-product'],
  'zenchron/platform-services': ['core-product', 'integrations'],
  'zenchron/agent-sdk': ['ai-platform'],
  'zenchron/devtools': ['developer-tools'],
};
const workflowProducts: Record<string, string[]> = {
  'PR Review & Release Orchestration': ['core-product', 'ai-platform', 'developer-tools'],
  'Nightly Regression Suite': ['core-product', 'ai-platform'],
  'Production Deployment': ['core-product', 'integrations'],
};

const insights = [
  { group: 'delivery', title: 'Overall engineering performance is up', detail: 'Delivery velocity increased 27% to 42 PRs/week while cycle time decreased 34% to 13.6h.' },
  { group: 'delivery', title: 'Faster delivery', detail: 'Cycle time (13.6h, −34%) and review latency (4.7h, −41%) show sustained efficiency gains across teams.' },
  { group: 'execution', title: 'Higher autonomy & strong quality', detail: 'Autonomous completion rose to 68.4% (+9.7 pp), with a 94.8% acceptance rate (+3.1 pp).' },
  { group: 'execution', title: 'Agent spend trended higher', detail: 'Spend increased 12% to $13.6K alongside higher delivery volume and agent usage.' },
  { group: 'objectives', title: 'Product & workspace highlights', detail: 'Core Product leads delivery velocity; Developer Tools has the most room to improve cycle time.' },
];
const insightIcons = [<IconActivity size={15} />, <IconRocket size={15} />, <IconRobot size={15} />, <IconCpu size={15} />,
  <IconFolders size={15} />];

// No download function: the app has no PDF or XLSX generator, so the fixture rows stay disabled.
const downloads = [
  { name: 'Executive Summary', detail: 'KPI trends, highlights, and insights (PDF)', format: 'PDF' },
  { name: 'Detailed Metrics', detail: 'All metrics by product, team, and workflow (XLSX)', format: 'XLSX' },
  { name: 'Agent Spend & Utilization', detail: 'Spend, usage, autonomy completion (CSV)', format: 'CSV' },
  { name: 'Product & Workspace Report', detail: 'Delivery, quality, and productivity summary (PDF)', format: 'PDF' },
];

const rowIcon = (Icon: typeof IconStack, tone: string) =>
  <Icon className={`reports-preview-row-icon ${tone}`} size={12} aria-hidden="true" />;
const rowIcons: Record<string, ReactNode> = {
  'Core Product': rowIcon(IconStack, 'violet'), 'AI Platform': rowIcon(IconInfinity, 'teal'),
  'Developer Tools': rowIcon(IconCode, 'violet'), Integrations: rowIcon(IconPuzzle, 'gold'),
  Platform: rowIcon(IconActivity, 'violet'), Product: rowIcon(IconStack, 'violet'),
  Infrastructure: rowIcon(IconCode, 'teal'), Data: rowIcon(IconDatabase, 'violet'),
};
const named = (name: string) => ({ value: name, label: name });

/** The approved Reports fixtures. `scope` narrows the summary rows; the charts stay the aggregate illustration. */
export function mockReports(scope: ReportScope, percentile: LatencyPercentile): ReportsSource {
  const repositoryMatches = scope.repository === 'all' ? undefined : repositoryProducts[scope.repository] ?? [];
  const workflowMatches = scope.workflow === 'all' ? undefined : workflowProducts[scope.workflow] ?? [];
  return {
    options: {
      products: [{ value: 'all', label: 'All Products' },
        ...products.filter(({ id }) => id !== 'total').map(({ id, name }) => ({ value: id, label: name }))],
      teams: [{ value: 'all', label: 'All Teams' },
        ...workspaces.filter(({ name }) => name !== totalRow).map(({ name }) => named(name))],
      workflows: [{ value: 'all', label: 'All Workflows' }, ...workflows.map(named)],
      repositories: [{ value: 'all', label: 'All Repositories' }, ...repositories.map(named)],
    },
    scopeAppliedLabel: 'Preview scope applied',
    metrics: {
      velocity: { value: '42', delta: '+27%', sparkline: trend.map((item) => item.merged) },
      cycleTime: { value: '13.6h', delta: '−34%', sparkline: trend.map((item) => item.cycle) },
      ciDuration: { value: '8.2m', delta: '−28%', sparkline: ciDistribution.map((item) => item.runs) },
      reviewLatency: { value: '4.7h', delta: '−41%', sparkline: [12, 9, 7, 6, 5, 4.7] },
      agentSpend: { value: '$13.6K', delta: '+12%', sparkline: [5, 7, 7.5, 8, 10, 13.6] },
      acceptance: { value: '94.8%', delta: '+3.1 pp', sparkline: trend.map((item) => item.acceptance) },
      autonomy: { value: '68.4%', delta: '+9.7 pp', sparkline: trend.map((item) => item.autonomy) },
    },
    autonomyRecorded: true,
    delivery: { points: trend, label: 'Merged pull requests and average cycle time trend' },
    ci: {
      points: ciDistribution, label: 'Mock CI duration distribution by run count and CI duration in minutes',
      percentiles: { p50: '6.8', p95: '18.4' },
      yAxis: { domain: [0, 2500], ticks: [0, 500, 1000, 1500, 2000, 2500], interval: 0 },
    },
    outcomes: {
      caption: scope.workflow === 'all' ? 'All Workflows' : scope.workflow,
      sections: outcomes, legend: outcomes, total: '17,842', unit: 'Work Items', valueSuffix: '%',
      label: 'Mock work outcomes for the last 30 days', legendLabel: 'Work outcomes legend',
    },
    latency: {
      points: trend.map((item, index) => ({ date: item.date, latency: latencyByPercentile[percentile][index] })),
      label: `Illustrative ${percentile} review latency trend`, seriesLabel: `Review latency ${percentile} (h)`,
      groupLabel: 'Illustrative review latency percentile',
      yAxis: percentile === 'P95' ? { domain: [0, 25], ticks: [0, 5, 10, 15, 20, 25], interval: 0 }
        : { domain: [0, 20], ticks: [0, 4, 8, 12, 16, 20], interval: 0 },
    },
    spend: {
      points: trend.map((item, index) => ({ date: item.date, autonomy: item.autonomy, spend: spend[index] })),
      label: 'Mock agent spend and autonomous completion trend',
      tick: (value) => value === 0 ? '$0' : `$${value}K`,
      yAxis: { domain: [0, 20], ticks: [0, 4, 8, 12, 16, 20], interval: 0 },
      rightYAxis: { domain: [40, 90], ticks: [40, 50, 60, 70, 80, 90], interval: 0 },
    },
    acceptance: { points: trend, label: 'Mock acceptance and autonomous completion trends' },
    insights: insights.map((insight, index) => ({ ...insight, icon: insightIcons[index] })),
    keyTakeaway: 'Teams are delivering faster with higher autonomy and quality, at a scalable cost.',
    products: {
      rows: products.filter((product) => product.id === 'total' || (
        (scope.product === 'all' || product.id === scope.product) &&
        (!repositoryMatches || repositoryMatches.includes(product.id)) &&
        (!workflowMatches || workflowMatches.includes(product.id))
      )).map((product) => ({ ...product, icon: rowIcons[product.name] })),
      loading: false, error: false,
    },
    workspaces: workspaces
      .filter(({ name }) => scope.objectiveOwner === 'all' || name === scope.objectiveOwner || name === totalRow)
      .map((workspace) => ({ ...workspace, icon: rowIcons[workspace.name] })),
    downloads,
  };
}
