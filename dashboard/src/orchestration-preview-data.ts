import type { GraphMessage, ObjectivePlan, OrchestrationSource, PlanUnit, WorkGraph } from './orchestration';

// Sample orchestration for Mock mode only. It belongs to the fixture objective "Ship agent orchestration".
const sampleObjectiveID = 'OBJ-1510';
const at = '2025-01-10T09:00:00Z';

const unit = (key: string, kind: PlanUnit['kind'], title: string, agent_id: string, depends_on: string[],
  acceptance: string[]): PlanUnit => ({ key, kind, title, instructions: '', acceptance, depends_on,
  capabilities: kind === 'produce' ? ['code.write'] : [], agent_id });

const sampleUnits = [
  { ...unit('api', 'produce', 'Expose run usage over the API', 'preview-test-generator', [], ['GET /usage returns totals per run']),
    profile_version: 1, persona_id: 'preview-persona', persona_version: 1 },
  unit('ui', 'produce', 'Show usage on the run page', 'preview-release-manager', [], ['Usage is visible at 390px wide']),
  unit('review-api', 'review', 'Review the API change', 'preview-code-reviewer', ['api'], []),
  unit('integrate', 'integrate', 'Combine and publish', '', ['review-api', 'ui'], ['Verification passes on the combined change']),
];
const agentNames = { 'preview-test-generator': 'Test Generator', 'preview-release-manager': 'Release Manager',
  'preview-code-reviewer': 'Code Reviewer' };

const message = (index: number, fields: Partial<GraphMessage> & Pick<GraphMessage, 'type' | 'from'>): GraphMessage =>
  ({ id: `sample-${index}`, to: [], notes: [], created_at: at, ...fields });

const sampleGraph: WorkGraph = {
  id: 'sample-graph', objective_id: sampleObjectiveID, objective_title: 'Ship agent orchestration', plan_revision: 1,
  revision: 9, status: 'blocked', project_name: 'Nova Platform', base_branch: 'main', max_parallel: 2,
  created_at: at, updated_at: at,
  units: [
    { ...sampleUnits[0], agent_name: 'Test Generator', state: 'completed', run_ids: ['sample-run-1'], candidate: '3f9a1c27d0' },
    { ...sampleUnits[1], agent_name: 'Release Manager', state: 'blocked', reason: 'Waiting for a decision from a person.',
      run_ids: ['sample-run-2'] },
    { ...sampleUnits[2], agent_name: 'Code Reviewer', state: 'completed', run_ids: ['sample-run-3', 'sample-run-4'], verdict: 'accept' },
    { ...sampleUnits[3], state: 'waiting', reason: 'Waiting for every produced candidate to be admitted.', run_ids: [] },
  ],
  messages: [
    message(1, { type: 'handoff', from: 'api', commit: '81c0de4', body: 'Added the usage endpoint with a table test.' }),
    message(2, { type: 'finding', from: 'review-api', to: ['api'], commit: '81c0de4', severity: 'high',
      title: 'Totals ignore cancelled runs', file: 'cmd/api/usage.go', line: 42, body: 'Cancelled runs still report tokens.' }),
    message(3, { type: 'handoff', from: 'api', commit: '3f9a1c27d0', body: 'Counted cancelled runs; added a regression test.' }),
    message(4, { type: 'state_update', from: 'review-api', commit: '3f9a1c27d0', body: 'Accepted candidate 3f9a1c27d0.' }),
    message(5, { type: 'decision_request', from: 'ui', body: 'Show cost in USD or in tokens only?', notes: ['USD', 'Tokens only'] }),
  ],
};

const samplePlan: ObjectivePlan = { objective_id: sampleObjectiveID, revision: 1, status: 'approved', project_id: 'preview-project',
  summary: 'Two independent producers, a review of the API change, then one integrated pull request.', max_parallel: 2,
  workflow_id: 'preview-workflow', workflow_version: 1,
  units: sampleUnits, problems: [], graph_id: sampleGraph.id, created_at: at, approved_by: 'Ravi Kumar' };

/** Sample plans and one sample work graph. Mock performs no operations, so every control is off with the reason. */
export function useMockOrchestration(objectiveID?: string): OrchestrationSource {
  return {
    graphs: [sampleGraph],
    loading: false,
    failed: false,
    plans: objectiveID === sampleObjectiveID ? [samplePlan] : [],
    plansLoading: false,
    plansFailed: false,
    options: { projects: [], projectWorkerIDs: {}, planners: [], workflows: [], agents: [], personas: [],
      agentsLoading: false, workers: [], workersFailed: false, workersLoading: false },
    agentNames,
    readOnlyReason: 'Illustrative data: plans are proposed, approved, and executed in Live mode only.',
  };
}
