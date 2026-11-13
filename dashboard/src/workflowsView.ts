import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { loadWorkflows, mobileWorkflowGraph, workflowSchema } from './workflowModel';
import type { ComponentType, Workflow } from './workflowModel';

export const workflowStatusLabels: Record<Workflow['status'], string> = { draft: 'Draft', active: 'Active' };
export type WorkflowDraft = Pick<Workflow, 'name' | 'description' | 'status' | 'nodes' | 'edges'>;

export const runPreviewViews = ['Execution Graph', 'Logs', 'Outputs', 'Artifacts'] as const;
export type RunPreviewView = typeof runPreviewViews[number];
/** A run drawn in the builder's Run Preview. */
export type WorkflowRunTimeline = {
  title: string; verdict: string; estimate: string; axis: string[];
  steps: { label: string; type: ComponentType; start: number; span: number; status: string;
    statusTone: 'ready' | 'manual' | 'pending'; state: string }[];
  summary: [label: string, value: string][];
  conditions: string[];
  outputs: Record<Exclude<RunPreviewView, 'Execution Graph'>, { label: string; title: string; lines: string[] }>;
};
/** The run-detail cards a phone shows instead of the editor. */
export type WorkflowPhoneRun = {
  description: string; badge: string; isRunning: boolean;
  /** Percent complete; a run that never started has none and the bar is left out. */
  progress?: number;
  tasksSummary: string;
  tasks: { label: string; status: string; state: 'complete' | 'active' | 'pending' }[];
  approvalsSummary: string;
  approvals: { label: string; status: string; isApproved: boolean; action?: string }[];
};
/** Per-component settings beyond the saved name and description. */
export type WorkflowNodeSettings = {
  strategy: string; rules: [condition: string, target: string][]; newRuleTarget: string;
  budget: [label: string, value: string][];
  retry: { maxRetries: string; rest: [label: string, value: string][] };
  conditions: { expression: string; outcomes: [label: string, value: string][] };
  prompt: string; variables: [name: string, description: string][];
};

export const runDetailTabs = ['STEPS', 'LOGS', 'ARTIFACTS', 'EVENTS'] as const;
/** What the Runs, Versions, Schedules, Permissions, and Settings tabs list. An empty list shows `unavailable`. */
export type WorkflowSectionsData = {
  /** Why a tab has nothing to list and its controls are off; absent where the tab is filled. */
  unavailable?: Record<'runs' | 'versions' | 'schedules' | 'permissions' | 'settings', string>;
  runs: {
    metrics: [value: string, note: string][];
    rows: [id: string, version: string, started: string, duration: string, status: string][];
    footer: string; pages?: string;
    detail?: {
      title: string; description: string; status: string; facts: string[];
      views: Record<typeof runDetailTabs[number], [label: string, detail: string, state: string][]>;
      log: { filename: string; text: string };
    };
  };
  versions: {
    summary: string;
    rows: [version: string, state: string, detail: string, byline: string][];
    compareTitle: string; compareDescription: string;
    compare?: {
      changeCount: string; publishLabel: string;
      graphs: { label: string; version: string; nodes: string[]; foot: string }[];
      changes: [state: string, kind: string, title: string, detail: string][];
    };
  };
  schedules: {
    summary: string; timezone: string; calendarDescription: string; next: string;
    rows: { name: string; timing: string; next: string; isEvent: boolean; isEnabled: boolean }[];
    days: { label: string; events: { label: string; tone?: 'test' | 'release' }[] }[];
    selected: string[];
  };
  permissions: {
    membersLabel: string; minimumReviewers: string;
    collaborators: [initial: string, name: string, role: string, access: string][];
    matrix: string[][];
    protections: { name: string; detail: string; isEnabled: boolean }[];
  };
  settings: {
    /** A fixture name is shown as text; without one the saved definition is edited in place. */
    name?: string;
    context: string[]; execution: string[]; checks: string[];
    services: [name: string, detail: string][];
    notifications: string[];
  };
};

/** Everything about one workflow that is not its saved graph. */
export type WorkflowView = {
  versionLabel: string;
  execution: { title: string; idle: string };
  phone: { eyebrow: string; description: string; status?: string; run: WorkflowPhoneRun };
  sectionBadges: string[]; sectionNote: string;
  /** Hand-arranged canvas positions by node id; a graph without them is laid out automatically. */
  positions?: Record<string, { x: number; y: number }>;
  /** The run shown in Run Preview; without one the panel says execution is unavailable and Run is off. */
  timeline?: WorkflowRunTimeline;
  nodeSettings?: WorkflowNodeSettings;
  /** Longer inspector copy for fixture components. A source that supplies it shows the inspector read-only. */
  inspectorDescriptions?: Record<string, string>;
  sections: WorkflowSectionsData;
};

/** What the Workflows layout needs, in the same shape for Mock and Live. */
export type WorkflowsSource = {
  workflows: Workflow[]; loading: boolean;
  /** Why the list could not be loaded. */
  error?: string;
  saving: boolean; creating: boolean;
  /** Resolves to the confirmation to show. */
  save: (id: string, draft: WorkflowDraft) => Promise<string>;
  create: (name: string, description: string) => Promise<{ workflow: Workflow; notice: string }>;
  /** Absent where nothing can publish a workflow; the control is then off. */
  publish?: () => string;
  /** Absent where run, schedule, permission, and approval controls have no service behind them. */
  acknowledge?: (action: string, outcome: string) => string;
  blockAddedNotice: string;
  describe: (workflow: Workflow) => WorkflowView;
};

const runnerOffline = 'Workflow execution is not connected';
const liveUnavailable: NonNullable<WorkflowSectionsData['unavailable']> = {
  runs: `Unavailable · ${runnerOffline.toLowerCase()}, so no run has been recorded`,
  versions: 'Unavailable · the control plane keeps only the latest saved version',
  schedules: 'Unavailable · workflow schedules and triggers are not connected',
  permissions: 'Unavailable · access follows the dashboard session; per-workflow roles are not stored',
  settings: 'Unavailable · the control plane stores a workflow\'s name, description, status, and graph only',
};

function describeLiveWorkflow(workflow: Workflow): WorkflowView {
  const status = workflowStatusLabels[workflow.status];
  const counts = `${workflow.nodes.length} components · ${workflow.edges.length} connections`;
  const approvals = workflow.nodes.filter((node) => node.type === 'human-approval');
  const saved = new Date(workflow.updated_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return {
    versionLabel: `v${workflow.version} (${status})`,
    execution: { title: `Execution Flow (v${workflow.version})`, idle: `Not run · ${workflow.nodes.length} nodes · runner not connected` },
    phone: {
      eyebrow: 'Workflow', description: workflow.name,
      run: {
        description: `${counts} · runner not connected`, badge: 'Not run', isRunning: false,
        tasksSummary: 'Not run',
        tasks: mobileWorkflowGraph(workflow, false, true).nodes
          .map((stage) => ({ label: stage.data.label, status: 'Not run', state: 'pending' as const })),
        approvalsSummary: approvals.length ? 'Not requested' : 'No approval step',
        approvals: approvals.map((node) => ({ label: node.data.label, status: 'Not requested', isApproved: false })),
      },
    },
    sectionBadges: [`v${workflow.version}`, `${workflow.nodes.length} Nodes`, 'Agent profiles unavailable'],
    sectionNote: 'SAVED DEFINITION · NO RUN DATA',
    sections: {
      unavailable: liveUnavailable,
      runs: { metrics: Array.from({ length: 4 }, () => ['Unavailable', '']), rows: [], footer: 'No runs recorded' },
      versions: {
        summary: '1 saved version · earlier versions are not kept',
        rows: [[`v${workflow.version}`, workflow.status === 'active' ? 'ACTIVE' : 'CURRENT DRAFT',
          workflow.description || 'No description', `Saved ${saved}`]],
        compareTitle: 'Compare versions',
        compareDescription: `Current ${status.toLowerCase()} · ${workflow.nodes.length} nodes · ${workflow.edges.length} edges`,
      },
      schedules: {
        summary: 'No schedules configured', timezone: 'Timezone: Unavailable', calendarDescription: 'No scheduled runs',
        next: 'Next: Unavailable', rows: [], days: [], selected: Array.from({ length: 4 }, () => 'Unavailable'),
      },
      permissions: { membersLabel: 'Unavailable', minimumReviewers: 'Unavailable', collaborators: [], matrix: [], protections: [] },
      settings: {
        context: ['Unavailable', 'Unavailable'], execution: Array.from({ length: 4 }, () => 'Unavailable'),
        checks: [], services: [], notifications: [],
      },
    },
  };
}

async function workflowResponse(response: Response, action: string): Promise<Workflow> {
  if (!response.ok) throw new Error((await response.text()).trim() || `${action} failed: ${response.status}`);
  return workflowSchema.parse(await response.json());
}

export function useLiveWorkflows(enabled: boolean): WorkflowsSource {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['workflows'], queryFn: loadWorkflows, enabled });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['workflows'] });
  const save = useMutation({
    mutationFn: async ({ id, draft }: { id: string; draft: WorkflowDraft }) => workflowResponse(await fetch(`/api/v1/workflows/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
    }), 'Save'),
    onSuccess: refresh,
  });
  const create = useMutation({
    mutationFn: async (input: { name: string; description: string }) => workflowResponse(await fetch('/api/v1/workflows', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }), 'Create'),
    onSuccess: refresh,
  });
  return {
    workflows: query.data ?? [], loading: query.isLoading, error: query.error?.message,
    saving: save.isPending, creating: create.isPending,
    save: async (id, draft) => `Saved v${(await save.mutateAsync({ id, draft })).version}`,
    create: async (name, description) => {
      const workflow = await create.mutateAsync({ name, description });
      return { workflow, notice: `Created ${workflow.name}` };
    },
    blockAddedNotice: 'Block added · save to keep it',
    describe: describeLiveWorkflow,
  };
}
