import type { ProductDeliverySummary } from './ReportSummaries';

export const reportPreviewTrend = [
  { date: 'Jan 1', merged: 10, cycle: 31, acceptance: 89, autonomy: 54 },
  { date: 'Jan 4', merged: 17, cycle: 25, acceptance: 90, autonomy: 57 },
  { date: 'Jan 7', merged: 18, cycle: 21, acceptance: 91, autonomy: 58 },
  { date: 'Jan 10', merged: 25, cycle: 18, acceptance: 92, autonomy: 60 },
  { date: 'Jan 13', merged: 24, cycle: 16, acceptance: 92, autonomy: 63 },
  { date: 'Jan 16', merged: 32, cycle: 13, acceptance: 93, autonomy: 64 },
  { date: 'Jan 19', merged: 38, cycle: 12, acceptance: 93, autonomy: 66 },
  { date: 'Jan 22', merged: 35, cycle: 11, acceptance: 94, autonomy: 67 },
  { date: 'Jan 25', merged: 34, cycle: 10, acceptance: 94, autonomy: 68 },
  { date: 'Jan 30', merged: 42, cycle: 9, acceptance: 94.8, autonomy: 68.4 },
];

export const reportPreviewLatency = [11.5, 9.1, 7.7, 6.4, 5.9, 5.3, 5.1, 4.9, 4.8, 4.7];

export const reportPreviewCIDistribution = [
  { duration: '<2', runs: 390 }, { duration: '2–4', runs: 920 }, { duration: '4–6', runs: 1760 },
  { duration: '6–8', runs: 2070 }, { duration: '8–10', runs: 1280 }, { duration: '10–15', runs: 880 },
  { duration: '15–20', runs: 540 }, { duration: '20–30', runs: 330 }, { duration: '>30', runs: 210 },
];

export const reportPreviewOutcomes = [
  { name: 'Accepted / Merged', value: 94.8, color: '#27dca3' },
  { name: 'Needs Changes', value: 3.6, color: '#aa62f3' },
  { name: 'Rejected', value: 1.2, color: '#5584ef' },
  { name: 'Abandoned', value: 0.4, color: '#8d93aa' },
];

export const reportPreviewSpend = [5, 6, 7, 7.5, 8, 9, 10, 11.5, 12.5, 13.6];

export const reportPreviewProducts: ProductDeliverySummary[] = [
  { id: 'core-product', name: 'Core Product', recordType: 'Product', repositories: 3, objectives: 8, runs: 421, deliveryVelocity: 18.4, cycleTime: 11.9, ciDuration: 7.6, acceptanceRate: 96.2, autonomousCompletion: 71.8 },
  { id: 'ai-platform', name: 'AI Platform', recordType: 'Product', repositories: 2, objectives: 6, runs: 318, deliveryVelocity: 9.7, cycleTime: 14.2, ciDuration: 8.9, acceptanceRate: 94.1, autonomousCompletion: 67.9 },
  { id: 'developer-tools', name: 'Developer Tools', recordType: 'Product', repositories: 3, objectives: 5, runs: 289, deliveryVelocity: 6.1, cycleTime: 16.7, ciDuration: 10.4, acceptanceRate: 92.8, autonomousCompletion: 63.5 },
  { id: 'integrations', name: 'Integrations', recordType: 'Product', repositories: 2, objectives: 4, runs: 197, deliveryVelocity: 4.8, cycleTime: 18.6, ciDuration: 9.7, acceptanceRate: 93.9, autonomousCompletion: 66.1 },
  { id: 'total', name: 'Total / Avg.', recordType: 'Product', repositories: 10, objectives: 23, runs: 1225, deliveryVelocity: 42, cycleTime: 13.6, ciDuration: 8.2, acceptanceRate: 94.8, autonomousCompletion: 68.4 },
];

export const reportPreviewWorkspaces = [
  { name: 'Platform', workItems: 6816, deliveryVelocity: 18.4, cycleTime: 12.9, acceptanceRate: 95.6, autonomousCompletion: 70.9 },
  { name: 'Product', workItems: 5491, deliveryVelocity: 12.1, cycleTime: 13.8, acceptanceRate: 94.8, autonomousCompletion: 68.1 },
  { name: 'Infrastructure', workItems: 3207, deliveryVelocity: 7.8, cycleTime: 15.6, acceptanceRate: 93.7, autonomousCompletion: 66.9 },
  { name: 'Data', workItems: 2332, deliveryVelocity: 5.2, cycleTime: 14.9, acceptanceRate: 94.3, autonomousCompletion: 66.8 },
  { name: 'Total / Avg.', workItems: 17842, deliveryVelocity: 42, cycleTime: 13.6, acceptanceRate: 94.8, autonomousCompletion: 68.4 },
];

export const reportPreviewInsights = [
  { group: 'delivery', title: 'Overall engineering performance is up', detail: 'Delivery velocity increased 27% to 42 PRs/week while cycle time decreased 34% to 13.6h.' },
  { group: 'delivery', title: 'Faster delivery', detail: 'Cycle time (13.6h, −34%) and review latency (4.7h, −41%) show sustained efficiency gains across teams.' },
  { group: 'execution', title: 'Higher autonomy & strong quality', detail: 'Autonomous completion rose to 68.4% (+9.7 pp), with a 94.8% acceptance rate (+3.1 pp).' },
  { group: 'execution', title: 'Agent spend trended higher', detail: 'Spend increased 12% to $13.6K alongside higher delivery volume and agent usage.' },
  { group: 'objectives', title: 'Product & workspace highlights', detail: 'Core Product leads delivery velocity; Developer Tools has the most room to improve cycle time.' },
];

export const reportPreviewDownloads = [
  { name: 'Executive Summary', detail: 'KPI trends, highlights, and insights (PDF)', format: 'PDF' },
  { name: 'Detailed Metrics', detail: 'All metrics by product, team, and workflow (XLSX)', format: 'XLSX' },
  { name: 'Agent Spend & Utilization', detail: 'Spend, usage, autonomy completion (CSV)', format: 'CSV' },
  { name: 'Product & Workspace Report', detail: 'Delivery, quality, and productivity summary (PDF)', format: 'PDF' },
];
