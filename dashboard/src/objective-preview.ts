import type { Objective } from './objectives';

const visibleObjectives = [
  { id: 'OBJ-1487', title: 'Launch AI code review v2', description: 'Launch the next iteration of AI code review with higher accuracy, lower latency, and expanded repository coverage.', owner: 'Alex Chen', product: 'Core Product', product_id: '', status: 'on_track', progress: 78, due_date: '2025-01-27', created_at: '2024-12-01T00:00:00Z', updated_at: '2025-01-10T00:00:00Z', approval: 'Approved', workflow_count: 3 },
  { id: 'OBJ-1492', title: 'Improve review velocity', description: 'Reduce the time needed to review pull requests.', owner: 'Priya Shah', product: 'CI Health', product_id: '', status: 'on_track', progress: 62, due_date: '2025-02-14', created_at: '2024-12-01T00:00:00Z', updated_at: '2025-01-10T00:00:00Z', approval: 'Approved', workflow_count: 2 },
  { id: 'OBJ-1501', title: 'Reduce CI cycle time', description: 'Shorten build and validation cycles.', owner: 'Marco Rossi', product: 'Build Platform', product_id: '', status: 'at_risk', progress: 34, due_date: '2025-02-21', created_at: '2024-12-01T00:00:00Z', updated_at: '2025-01-10T00:00:00Z', approval: 'Pending', workflow_count: 4 },
  { id: 'OBJ-1506', title: 'Expand test coverage (L1)', description: 'Expand automated coverage across core services.', owner: 'Elena Marin', product: 'Core Product', product_id: '', status: 'on_track', progress: 71, due_date: '2025-02-28', created_at: '2024-12-01T00:00:00Z', updated_at: '2025-01-10T00:00:00Z', approval: 'Approved', workflow_count: 2 },
  { id: 'OBJ-1510', title: 'Ship agent orchestration', description: 'Deliver reliable agent orchestration for engineering teams.', owner: 'Ravi Kumar', product: 'Running Agents', product_id: '', status: 'in_progress', progress: 46, due_date: '2025-03-07', created_at: '2024-12-01T00:00:00Z', updated_at: '2025-01-10T00:00:00Z', approval: 'Approved', workflow_count: 5 },
  { id: 'OBJ-1517', title: 'Migrate to unified pipeline', description: 'Move projects onto the shared delivery pipeline.', owner: 'Dana Lee', product: 'CI Health', product_id: '', status: 'blocked', progress: 19, due_date: '2025-03-14', created_at: '2024-12-01T00:00:00Z', updated_at: '2025-01-10T00:00:00Z', approval: 'Changes Req.', workflow_count: 2 },
] satisfies Objective[];

const extraObjectives = Array.from({ length: 36 }, (_, index) => {
  const status: Objective['status'] = index < 25 ? 'on_track' : index < 31 ? 'at_risk'
    : index < 33 ? 'blocked' : index < 35 ? 'in_progress' : 'completed';
  return {
  id: `OBJ-${1520 + index}`,
  title: `Engineering objective ${index + 7}`,
  description: 'Sample objective for the local dashboard preview.',
  owner: ['Alex Chen', 'Priya Shah', 'Marco Rossi', 'Elena Marin'][index % 4],
  product: ['Core Product', 'CI Health', 'Build Platform', 'Running Agents'][index % 4],
  status,
  progress: status === 'completed' ? 100 : (index * 17 + 23) % 100,
  due_date: `2025-${String(index % 3 + 1).padStart(2, '0')}-${String(index % 27 + 1).padStart(2, '0')}`,
  approval: ['Approved', 'Pending', 'Changes Req.'][index % 3],
  workflow_count: index % 5 + 1,
  created_at: '2024-12-01T00:00:00Z',
  updated_at: '2025-01-10T00:00:00Z',
  };
});

export const objectivePreviewRecords: Objective[] = [...visibleObjectives, ...extraObjectives].map((item) => ({
  ...item,
  product_id: '',
  created_at: '2024-12-01T00:00:00Z',
  updated_at: '2025-01-10T00:00:00Z',
}));

export const objectivePreviewDetails = {
  blocker: 'Model training run (PR #1462) is still validating on the full dataset.',
  acceptanceCriteria: [
    '≥ 90% review suggestion precision', 'p95 review latency ≤ 10s', 'Coverage for Core Product, CI Health, and Build repos',
    'Edit suggestions and reasoning in the review UI', 'GA-ready docs and rollout plan',
  ],
  relatedPullRequests: [
    { id: '#1462', title: 'Improve model precision (v2)', status: 'Review' },
    { id: '#1467', title: 'Update review UI diff (+ suggestions)', status: 'Merged' },
    { id: '#1473', title: 'Add repo coverage (CI Health)', status: 'Review' },
    { id: '#1479', title: 'Rollout config & flags', status: 'Open' },
  ],
  planSummary: [
    'Approach: Incremental rollout (25% → 50% → 100%)',
    'Key deliverables: Model v2, review UI updates, docs, telemetry',
    'Dependencies: Model training, rollout toolkit (OBJ-1464)',
    'Rollout: Start Jan 13, 2025 (25%), ramp weekly',
    'Success metric: ≥ 90% precision and ≥ 70% adoption in 4 weeks',
  ],
  activity: [
    { text: 'Alex Chen updated progress to 78%', time: '2m ago' },
    { text: 'PR #1462 moved to Review', time: '24m ago' },
    { text: 'Priya S. added a blocker: Model training run…', time: '1h ago' },
    { text: 'Objective approved by Product (Alex Chen)', time: '3h ago' },
  ],
  milestones: [
    { title: 'Model v2 ready', progress: 100, status: 'Complete', date: 'Jan 10, 2025' },
    { title: 'Review UI updates', progress: 100, status: 'Complete', date: 'Jan 15, 2025' },
    { title: 'Expanded repo coverage', progress: 60, status: 'In Progress', date: 'Jan 22, 2025' },
    { title: 'GA rollout (100%)', progress: 0, status: 'Planned', date: 'Jan 27, 2025' },
  ],
};

export const objectivePreviewCapacity = [
  { week: 'Jan 6', planned: 6, completed: 5 }, { week: 'Jan 13', planned: 12, completed: 10 },
  { week: 'Jan 20', planned: 16, completed: 13 }, { week: 'Jan 27', planned: 19, completed: 16 },
  { week: 'Feb 3', planned: 23, completed: 18 }, { week: 'Feb 10', planned: 27, completed: 22 },
  { week: 'Feb 17', planned: 33, completed: 25 }, { week: 'Feb 24', planned: 37, completed: 29 },
  { week: 'Mar 3', planned: 41, completed: 32 },
];
