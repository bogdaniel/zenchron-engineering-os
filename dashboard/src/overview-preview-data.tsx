import { IconCircleCheck, IconFileText, IconRobot, IconShieldCheck, IconStack2, IconTarget } from '@tabler/icons-react';
import type { OverviewAnalyticsMetric, OverviewSource } from './overviewView';

const days = ['Jan 20', 'Jan 21', 'Jan 22', 'Jan 23', 'Jan 24', 'Jan 25', 'Jan 26'];
const fixedScale: OverviewAnalyticsMetric['yAxis'] = { domain: [0, 50], ticks: [0, 10, 20, 30, 40, 50], interval: 0 };
const series = (values: number[]) => values.map((value, index) => ({ day: days[index], value }));

const activity = [
  { key: 'merge', icon: <IconCircleCheck className="activity-green" size={18} />, text: 'PR #41827 merged to trusted-main', time: '2m ago' },
  { key: 'run', icon: <IconRobot className="activity-blue" size={18} />, text: 'Agent “Code Reviewer” completed run', time: '6m ago' },
  { key: 'plan', icon: <IconFileText className="activity-blue" size={18} />, text: 'Plan approved: Add usage analytics (v1.3)', time: '12m ago' },
  { key: 'ci', icon: <IconCircleCheck className="activity-green" size={18} />, text: 'CI passed (99.4%)', time: '16m ago' },
  { key: 'objective', icon: <IconTarget className="activity-violet" size={18} />, text: 'Objective “Improve review velocity” updated', time: '26m ago' },
];

/** The Mock source: the approved Overview fixtures. Nothing here is read from or written to the control plane. */
export const mockOverview: OverviewSource = {
  kpis: {
    objectives: { value: '12', badge: '↑ +3', points: [0, 2, 7, 5, 8, 7, 13, 15] },
    agents: { value: '7', badge: '● Live', points: [2, 6, 4, 9, 7, 11, 9, 12] },
    pullRequests: { value: '18', badge: '↑ +4', bars: [8, 14, 18, 23, 28] },
    ci: { value: '99.4%', badge: '✓ Healthy' },
    budget: { value: '68%', summary: '$13.6K / $20K', percent: 68 },
  },
  activity,
  allActivity: activity,
  objectives: [
    { key: 'review-v2', title: 'Ship AI code review v2', progress: 78, status: 'On Track', atRisk: false },
    { key: 'velocity', title: 'Improve review velocity', progress: 62, status: 'On Track', atRisk: false },
    { key: 'ci', title: 'Reduce CI cycle time', progress: 34, status: 'At Risk', atRisk: true },
  ],
  objectivesEmpty: 'No open objectives',
  approvals: [
    { title: 'Add usage analytics (v1.3)', pending: false },
    { title: 'Refactor agent runtime', pending: false },
    { title: 'Expand test coverage (v1.1)', pending: true },
  ],
  agentRuns: [
    { key: 'reviewer', icon: <IconStack2 />, name: 'Code Reviewer', status: 'Success', pending: false, time: '2m ago' },
    { key: 'tests', icon: <IconStack2 />, name: 'Test Generator', status: 'Success', pending: false, time: '4m ago' },
    { key: 'coverage', icon: <IconShieldCheck />, name: 'Coverage Analyzer', status: 'Success', pending: false, time: '7m ago' },
  ],
  agentRunsEmpty: 'No agent runs',
  health: {
    status: 'Healthy', healthy: true,
    trustedMain: 'Protected · Verified · Up to date', evidence: 'Artifacts · Test results · Reviews · Traces',
  },
  review: {
    id: 'PR #41827', chips: ['Changes 8', 'Comments 6', 'Checks ✓'], status: 'Approved', pending: false,
    title: 'feat(review): add AI feedback signals and evidence capture',
    from: 'feature/ai-review-v2', to: 'trusted-main', stat: '+427 −68',
    diff: [
      { number: 128, text: '+ const evidence = await captureEvidence({' },
      { number: 129, text: '+   prNumber,' },
      { number: 130, text: '+   signals: feedback.signals,' },
      { number: 131, text: '+   artifacts: run.artifacts,' },
      { number: 132, text: '+ });' },
    ],
  },
  reviewEmpty: { title: 'No reviews', note: 'This preview has no review to show.' },
  timeline: {
    description: 'This Sprint (Jan 20 – Jan 27)',
    sprint: {
      dates: [...days, 'Jan 27'],
      rows: [
        ['Plan & Approve', 1, 3, 'green', 'done'], ['Agent Implementation', 2, 5, 'purple', 'done'],
        ['Tests & Validation', 4, 6, 'blue', 'pending'], ['Review & Updates', 5, 7, 'lilac', 'pending'],
        ['Merge to Trusted-main', 7, 8, 'empty', 'pending'],
      ],
    },
    empty: 'No sprint in this preview.',
  },
  analytics: [
    {
      label: 'Delivery Velocity', summary: 'PRs Merged (7d)', value: '42', delta: '↑ +27% vs. prior 7d',
      seriesLabel: 'Merged PRs', chartLabel: 'Illustrative merged pull requests by day',
      points: series([10, 18, 19, 26, 32, 34, 45]), yAxis: fixedScale,
    },
    {
      label: 'Cycle Time', summary: 'Average Cycle Time (7d)', value: '21.0h', delta: '↓ −34% vs. prior 7d',
      seriesLabel: 'Cycle time (hours)', chartLabel: 'Illustrative cycle time by day',
      points: series([31, 28, 24, 21, 17, 14, 12]), yAxis: fixedScale,
    },
    {
      label: 'CI Duration', summary: 'Average CI Duration (7d)', value: '9.3m', delta: '↓ −28% vs. prior 7d',
      seriesLabel: 'CI duration (minutes)', chartLabel: 'Illustrative CI duration by day',
      points: series([12, 11, 10, 9, 8, 8, 7]), yAxis: fixedScale,
    },
  ],
  footer: 'Design preview · sample data',
};
