import { useState } from 'react';
import { designPreviewWorkflow } from './workflowModel';
import type { Workflow } from './workflowModel';
import type { WorkflowView, WorkflowsSource } from './workflowsView';

const canvasPositions: Record<string, { x: number; y: number }> = {
  trigger: { x: 0, y: 53 }, plan: { x: 111, y: 53 }, build: { x: 216, y: 53 },
  retry: { x: 208, y: -51 }, review: { x: 327, y: -8 }, tests: { x: 327, y: 57 },
  coverage: { x: 327, y: 134 }, condition: { x: 515, y: -55 }, approval: { x: 482, y: 53 },
  merge: { x: 590, y: 53 }, publish: { x: 698, y: 53 },
};

const fixtureView: Omit<WorkflowView, 'positions'> = {
  versionLabel: 'v2.4.0 (Draft)',
  execution: { title: 'Execution Flow (v2.4.0)', idle: 'Ready to run · 7 nodes · Est. 2m 14s · Cost $0.038' },
  phone: {
    eyebrow: 'Objective', description: 'Ship AI code review v2', status: 'Running',
    run: {
      description: 'Run #8821 · Started 8m ago', badge: '● Running', isRunning: true, progress: 78,
      tasksSummary: '4 of 5 completed',
      tasks: [
        { label: 'Plan & Approve', status: 'Completed · 2m', state: 'complete' },
        { label: 'Agent Implementation', status: 'Completed · 4m', state: 'complete' },
        { label: 'Tests & Validation', status: 'In Progress · 1m', state: 'active' },
        { label: 'Review & Updates', status: 'Pending', state: 'pending' },
        { label: 'Merge to trusted-main', status: 'Pending', state: 'pending' },
      ],
      approvalsSummary: '1 of 2 approved',
      approvals: [
        { label: 'Code Reviewer', status: 'Approved · 6m ago', isApproved: true },
        { label: 'Platform Lead', status: 'Awaiting approval', isApproved: false, action: 'Review Approval' },
      ],
    },
  },
  sectionBadges: ['v2.4.0', '8 Nodes', '3 Agent Profiles'],
  sectionNote: 'CONCEPT · ILLUSTRATIVE DATA',
  timeline: {
    title: 'Simulated run (PR #4827)', verdict: '✓ All steps valid', estimate: 'Est. duration: 2m 14s　·　Est. cost: $0.038',
    axis: ['0s', '15s', '30s', '45s', '1m', '1m 15s', '1m 30s', '1m 45s', '2m 14s'],
    steps: [
      { label: 'Trigger', type: 'trigger', start: 0, span: 7, status: '✓ Ready', statusTone: 'ready', state: 'complete' },
      { label: 'Planner', type: 'planner', start: 8, span: 15, status: '✓ Ready', statusTone: 'ready', state: 'complete' },
      { label: 'Agent Router', type: 'agent-router', start: 22, span: 16, status: '✓ Ready', statusTone: 'ready', state: 'active' },
      { label: 'Code Reviewer (parallel)', type: 'code-reviewer', start: 36, span: 34, status: '✓ Ready', statusTone: 'ready', state: 'parallel' },
      { label: 'Test Generator (parallel)', type: 'test-generator', start: 36, span: 34, status: '✓ Ready', statusTone: 'ready', state: 'parallel' },
      { label: 'Coverage Analyzer (parallel)', type: 'coverage-analyzer', start: 36, span: 34, status: '✓ Ready', statusTone: 'ready', state: 'parallel' },
      { label: 'Human Approval', type: 'human-approval', start: 71, span: 15, status: '◷ Awaiting (manual)', statusTone: 'manual', state: 'manual' },
      { label: 'Merge Gate', type: 'merge-gate', start: 87, span: 9, status: '✓ Pending', statusTone: 'pending', state: 'pending' },
      { label: 'Publish Report', type: 'publish-report', start: 96, span: 4, status: '✓ Pending', statusTone: 'pending', state: 'pending' },
    ],
    summary: [['Total steps', '7'], ['Parallel steps', '3'], ['Est. duration', '2m 14s'], ['Est. cost', '$0.038']],
    conditions: ['✓ Tests pass', '✓ Coverage ≥ 80%', '✓ Approval = Approved'],
    outputs: {
      Logs: { label: 'Illustrative run logs', title: 'Run Logs · PR #4827', lines: [
        '09:41:02 Trigger received: pull_request', '09:41:10 Planner created 3 tasks', '09:42:18 Tests passed · coverage 84%',
      ] },
      Outputs: { label: 'Illustrative run outputs', title: 'Run Outputs', lines: [
        'review.status　approved', 'tests.passed　true', 'coverage.percent　84',
      ] },
      Artifacts: { label: 'Illustrative run artifacts', title: 'Verified Artifacts (7)', lines: [
        'test-results.xml', 'coverage-summary.json', 'review-report.md',
      ] },
    },
  },
  nodeSettings: {
    strategy: 'Rule-based (with LLM fallback)',
    rules: [
      ['changes.contains("*.py,*.js")', 'Code Reviewer'], ['changes.affects("/tests/")', 'Test Generator'],
      ['always', 'Coverage Analyzer'],
    ],
    newRuleTarget: 'Code Reviewer',
    budget: [['Max Cost (USD)', '$ 0.020'], ['Max Duration', '60s'], ['Max Tokens', '32,000']],
    retry: { maxRetries: '2', rest: [['Backoff', 'Exponential'], ['Initial Delay', '5s'], ['Max Delay', '30s']] },
    conditions: {
      expression: 'if (pr.changed_files_count > 0 && pr.is_draft == false)',
      outcomes: [['On Failure', 'Retry (then fail)　⌄'], ['On Success', 'Continue　⌄']],
    },
    prompt: 'Route each task to the best specialized agent using its changed files, test requirements, and task context. '
      + 'Use the configured rules first, then choose a suitable agent when no rule matches.',
    variables: [
      ['changed_files', 'Files changed by the pull request'], ['task_type', 'Planner task category'],
      ['repository', 'Repository context'], ['pr_number', 'Pull request identifier'],
    ],
  },
  inspectorDescriptions: {
    build: 'Route work to the appropriate agents (review, test, coverage) based on the plan and PR context.',
  },
  sections: {
    runs: {
      metrics: [['3', '● Live'], ['128', '+8% this month'], ['6', 'Last 30 days'], ['2m 14s', '−18%']],
      rows: [
        ['RUN-10428', 'v2.4.0', '09:41 today', '2m 18s', 'Waiting'],
        ['RUN-10427', 'v2.4.0', '09:32 today', '3m 08s', 'Success'],
        ['RUN-10426', 'v2.4.0', '09:15 today', '1m 49s', 'Success'],
        ['RUN-10425', 'v2.3.2', '08:54 today', '2m 02s', 'Running'],
        ['RUN-10424', 'v2.3.2', '08:45 today', '4m 11s', 'Failed'],
      ],
      footer: 'Showing 1–5 of 137 runs', pages: '‹　1　2　3　…　28　›',
      detail: {
        title: 'RUN-10428　/　PR #4827', description: 'Current execution · workflow v2.4.0', status: 'WAITING',
        facts: ['2m 18s', '$0.38 USD', '7 verified'],
        views: {
          STEPS: [
            ['Trigger & Plan', 'Completed in 8s', 'done'], ['Agent Router', '3 profiles assigned', 'done'],
            ['Code Review + Tests', 'Parallel steps passed', 'done'], ['Human Approval', '1 of 2 approvals received', 'waiting'],
            ['Merge Gate & Publish', 'Waiting on approval', 'pending'],
          ],
          LOGS: [
            ['09:41:02', 'Trigger received for PR #4827', 'done'], ['09:41:10', 'Code Reviewer completed', 'done'],
            ['09:42:18', 'Awaiting Platform Lead approval', 'waiting'],
          ],
          ARTIFACTS: [
            ['review-summary.md', 'Verified · 12 KB', 'done'], ['coverage-summary.json', 'Verified · 4 KB', 'done'],
            ['test-results.xml', 'Verified · 28 KB', 'done'],
          ],
          EVENTS: [
            ['09:41:02', 'Run started · v2.4.0', 'done'], ['09:41:10', 'Review stage completed', 'done'],
            ['09:42:18', 'Approval requested', 'waiting'],
          ],
        },
        log: {
          filename: 'run-10428-preview.log',
          text: '09:41:02 Trigger received for PR #4827\n09:41:10 Code Reviewer completed\n09:42:18 Awaiting Platform Lead approval\n',
        },
      },
    },
    versions: {
      summary: '6 saved versions · newest first',
      rows: [
        ['v2.4.0', 'CURRENT DRAFT', 'Coverage routing + merge gate refinement', 'Alex Chen · Today, 09:26'],
        ['v2.3.2', 'PUBLISHED', 'Review latency optimizations', 'Alex Chen · Nov 7'],
        ['v2.3.1', 'ARCHIVED', 'Test generation retries', 'Alex Chen · Nov 4'],
        ['v2.3.0', 'ARCHIVED', 'Parallel validation branch', 'Alex Chen · Oct 29'],
        ['v2.2.0', 'ARCHIVED', 'Human approval gate added', 'Alex Chen · Oct 24'],
      ],
      compareTitle: 'Compare v2.3.2 → v2.4.0', compareDescription: 'Current draft · 8 nodes · 11 edges',
      compare: {
        changeCount: '3 changes', publishLabel: 'Publish v2.4.0',
        graphs: [
          { label: 'BASELINE', version: 'v2.3.2', nodes: ['Trigger', 'Review', 'Approval'], foot: '7 nodes　•　9 edges　•　Published Nov 7' },
          { label: 'CURRENT DRAFT', version: 'v2.4.0', nodes: ['Trigger', 'Review + Test', 'Merge Gate'], foot: '8 nodes　•　11 edges　•　Saved today' },
        ],
        changes: [
          ['added', '+ ADDED', 'Coverage Analyzer node', 'Parallel coverage threshold validation'],
          ['updated', '~ UPDATED', 'Merge Gate condition', 'Requires 80% coverage and approval'],
          ['routed', '→ ROUTED', 'Agent Router outputs', 'Additional test-generation fallback paths'],
        ],
      },
    },
    schedules: {
      summary: '4 schedules configured', timezone: 'Timezone: Europe/Bucharest (EET/EEST)',
      calendarDescription: 'Week of November 9–15, 2026', next: 'Next: Tue, November 10 at 09:00',
      rows: [
        { name: 'Weekday PR Quality Check', timing: 'Mon–Fri at 09:00', next: 'Next: Tue, Nov 10 at 09:00', isEvent: false, isEnabled: true },
        { name: 'Nightly Regression Suite', timing: 'Daily at 02:30', next: 'Next: Tue, Nov 10 at 02:30', isEvent: false, isEnabled: true },
        { name: 'Release Candidate Review', timing: 'Every Friday at 15:00', next: 'Next: Fri, Nov 13 at 15:00', isEvent: false, isEnabled: true },
        { name: 'GitHub PR Webhook', timing: 'On pull_request event', next: 'Event-driven, enabled', isEvent: true, isEnabled: true },
      ],
      days: ['MON 9', 'TUE 10', 'WED 11', 'THU 12', 'FRI 13', 'SAT 14', 'SUN 15'].map((label, index) => ({
        label, events: [
          ...(index < 5 ? [{ label: '09:00 PR review' }] : []),
          ...([1, 3, 5].includes(index) ? [{ label: '02:30 Tests', tone: 'test' as const }] : []),
          ...(index === 4 ? [{ label: '15:00 Release', tone: 'release' as const }] : []),
        ],
      })),
      selected: ['Weekday PR Quality Check', 'Europe/Bucharest', 'Weekdays (Monday–Friday)', '09:00 local time'],
    },
    permissions: {
      membersLabel: '4 members', minimumReviewers: '2 distinct reviewers',
      collaborators: [
        ['A', 'Alex Chen', 'Owner', 'All permissions'], ['P', 'Priya Shah', 'Editor', 'Edit & submit reviews'],
        ['M', 'Marco Lee', 'Operator', 'Execute and monitor runs'], ['S', 'Sarah Kim', 'Viewer', 'Read-only access and audit logs'],
      ],
      matrix: [
        ['View workflow', '✓', '✓', '✓', '✓'], ['Edit workflow', '✓', '✓', '–', '–'],
        ['Start execution', '✓', '✓', '✓', '–'], ['Approve protected steps', '✓', '–', '–', '–'], ['Publish a version', '✓', '–', '–', '–'],
      ],
      protections: [
        { name: 'Require approval before merge', detail: 'Paused at Human Approval gate', isEnabled: true },
        { name: 'Restrict version publishing', detail: 'Owners only', isEnabled: true },
        { name: 'Allow public sharing', detail: 'Disabled for this workflow', isEnabled: false },
        { name: 'Signed audit trail', detail: 'Immutable event history', isEnabled: true },
      ],
    },
    settings: {
      name: 'PR Review & Release Orchestration',
      context: ['zenchron/engineering-os', 'main'],
      execution: ['45 minutes', '4', '2', 'Exponential (5s–30s)'],
      checks: ['● Stop on critical failure', '● Capture run artifacts'],
      services: [
        ['GitHub', 'Pull requests and branch events'], ['LLM provider', 'Review and test agents'],
        ['Evidence storage', 'Artifacts and logs'],
      ],
      notifications: ['Notify on failed execution', 'Notify assigned approvers'],
    },
  },
};

/** The approved fixture workflow. Nothing here reaches the control plane; every change stays in the tab. */
export function useMockWorkflows(): WorkflowsSource {
  const [workflows, setWorkflows] = useState<Workflow[]>([designPreviewWorkflow]);
  return {
    workflows, loading: false, saving: false, creating: false,
    save: async () => 'Draft acknowledged locally · changes are not persisted',
    create: async (name, description) => {
      const workflow: Workflow = {
        id: `preview-${crypto.randomUUID()}`, name, description, status: 'draft', version: 1, updated_at: new Date().toISOString(),
        nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', description: 'Start this workflow' } }],
        edges: [],
      };
      setWorkflows((current) => [...current, workflow]);
      return { workflow, notice: `Created ${name} in this preview only` };
    },
    publish: () => 'Published in preview only · no live workflow changed',
    acknowledge: (action, outcome) => `${action} previewed · ${outcome}`,
    blockAddedNotice: 'Block added locally · changes are not saved',
    describe: (workflow) => ({
      ...fixtureView, positions: workflow.id === designPreviewWorkflow.id ? canvasPositions : undefined,
    }),
  };
}
