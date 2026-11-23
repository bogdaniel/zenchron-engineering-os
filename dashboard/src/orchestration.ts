import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { loadAgents, loadPersonas } from './agentsData';
import type { Agent, AgentPersona } from './agentsData';
import { loadProducts } from './productEditor';
import { projectsSchema } from './projects';
import { workerProvidersSchema } from './agentRunQueue';
import type { RunWorker } from './agentRunQueue';
import { loadWorkflows } from './workflowModel';

// The control plane encodes an empty Go slice as null.
const list = <T extends z.ZodType>(item: T) => z.array(item).nullish().transform((value) => value ?? []);

const planUnitSchema = z.object({
  key: z.string(), kind: z.enum(['produce', 'review', 'integrate']), title: z.string(),
  instructions: z.string().optional().default(''), acceptance: list(z.string()), depends_on: list(z.string()),
  capabilities: list(z.string()), agent_id: z.string().optional().default(''),
  profile_version: z.number().optional(), persona_id: z.string().optional(), persona_version: z.number().optional(),
});
const unitSchema = planUnitSchema.extend({
  agent_name: z.string().optional(),
  state: z.enum(['waiting', 'queued', 'running', 'blocked', 'completed', 'failed', 'cancelled']),
  reason: z.string().optional(), failure: z.string().optional(), run_ids: list(z.string()),
  candidate: z.string().optional(), verdict: z.string().optional(), pull_request_url: z.string().optional(),
  publication_authorization_required: z.boolean().optional(),
});
const messageSchema = z.object({
  id: z.string(),
  type: z.enum(['handoff', 'collaboration_request', 'finding', 'decision_request', 'decision_resolution', 'state_update']),
  from: z.string(), to: list(z.string()), run_id: z.string().optional(), attempt: z.number().optional(),
  commit: z.string().optional(), title: z.string().optional(), body: z.string().optional(), notes: list(z.string()),
  file: z.string().optional(), line: z.number().optional(), severity: z.string().optional(),
  resolves: z.string().optional(), by: z.string().optional(), created_at: z.string(),
});
const graphSchema = z.object({
  id: z.string(), objective_id: z.string(), objective_title: z.string(), plan_revision: z.number(),
  revision: z.number(), status: z.enum(['active', 'blocked', 'completed', 'failed', 'cancelled']),
  project_name: z.string(), base_branch: z.string(), workflow_id: z.string().optional(), max_parallel: z.number(),
  workflow_version: z.number().optional(),
  workflow_mode: z.enum(['compiled', 'guidance']).optional(),
  units: list(unitSchema), messages: list(messageSchema), created_at: z.string(), updated_at: z.string(),
});
const planSchema = z.object({
  objective_id: z.string(), revision: z.number(),
  status: z.enum(['planning', 'proposed', 'invalid', 'approved', 'superseded']),
  project_id: z.string(), workflow_id: z.string().optional(), workflow_version: z.number().optional(), summary: z.string().optional().default(''),
  product_configuration_revision: z.number().int().nonnegative().optional(),
  workflow_mode: z.enum(['compiled', 'guidance']).optional(),
  max_parallel: z.number().optional().default(0), units: list(planUnitSchema), problems: list(z.string()),
  graph_id: z.string().optional(), created_at: z.string(), approved_by: z.string().optional(),
});
const workersSchema = z.array(z.object({
  id: z.string(), name: z.string(), status: z.enum(['online', 'offline']), providers: workerProvidersSchema,
}));
export const workGraphsSchema = z.array(graphSchema);
export const plansSchema = z.array(planSchema);
export type WorkGraph = z.infer<typeof graphSchema>;
export type WorkUnit = z.infer<typeof unitSchema>;
export type PlanUnit = z.infer<typeof planUnitSchema>;
export type GraphMessage = z.infer<typeof messageSchema>;
export type ObjectivePlan = z.infer<typeof planSchema>;

export function workflowProvenance(mode: WorkGraph['workflow_mode'] | ObjectivePlan['workflow_mode'], id: string, version?: number) {
  const identity = `workflow ${id} · version ${version ?? 'unknown'}`;
  if (mode === 'compiled') return `Compiled from ${identity}`;
  if (mode === 'guidance') return `Guided by ${identity}`;
  return `Workflow ${id} · version ${version ?? 'unknown'} · execution mode unknown`;
}
type Option = { value: string; label: string };
type ProjectOption = Option & { workerID: string };

/** Plans, work graphs, and the operations on them. Mock and Live each provide one; Mock has no operations. */
export type OrchestrationSource = {
  graphs: WorkGraph[];
  loading: boolean;
  failed: boolean;
  retry?: () => void;
  /** Plan revisions of the objective the source was asked for, newest first. */
  plans: ObjectivePlan[];
  plansLoading: boolean;
  plansFailed: boolean;
  options: { projects: ProjectOption[]; projectWorkerIDs: Record<string, string>; projectNotice?: string;
    planners: Option[]; workflows: Option[]; agents: Agent[]; personas: AgentPersona[];
    agentsLoading: boolean; workers: RunWorker[]; workersFailed: boolean; workersLoading: boolean };
  agentNames: Record<string, string>;
  /** Why operations are off; empty where they are available. */
  readOnlyReason: string;
  propose?: (input: { project_id: string; planner_agent_id?: string; workflow_id?: string }) => Promise<void>;
  approve?: (revision: number) => Promise<void>;
  cancel?: (graphID: string) => Promise<void>;
  retryUnit?: (graphID: string, key: string) => Promise<void>;
  resolve?: (graphID: string, messageID: string, resolution: string) => Promise<void>;
  authorizePublication?: (runID: string, candidateSHA: string) => Promise<void>;
};

/** The newest graph of an objective; the control plane lists graphs newest first. */
export function graphOfObjective(graphs: WorkGraph[], objectiveID: string) {
  return graphs.find((graph) => graph.objective_id === objectiveID);
}

/** Decision requests nobody has answered yet. */
export function openDecisions(graph: WorkGraph) {
  return graph.messages.filter((message) => message.type === 'decision_request'
    && !graph.messages.some((other) => other.type === 'decision_resolution' && other.resolves === message.id));
}

async function load<T>(path: string, schema: z.ZodType<T>, what: string) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${what} (${response.status})`);
  return schema.parse(await response.json());
}

/** Sends a change. A rejected plan answers with its problems; any other refusal answers with its reason as text. */
async function send(path: string, body?: unknown) {
  const response = await fetch(path, body === undefined ? { method: 'POST' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (response.ok) return;
  const text = (await response.text()).trim();
  const problems = z.object({ problems: z.array(z.string()) }).safeParse(text.startsWith('{') ? JSON.parse(text) : null);
  throw new Error(problems.success ? problems.data.problems.join(' ') : text || `Request failed (${response.status})`);
}

/** Orchestration state from the control plane. It polls while mounted so unit states follow the workers. */
export function useLiveOrchestration(enabled: boolean, objectiveID?: string, productID?: string): OrchestrationSource {
  const queryClient = useQueryClient();
  const graphs = useQuery({ queryKey: ['work-graphs'], enabled, retry: false, refetchInterval: 3_000,
    queryFn: () => load('/api/v1/work-graphs', workGraphsSchema, 'work graphs') });
  const plans = useQuery({ queryKey: ['objective-plans', objectiveID], enabled: enabled && Boolean(objectiveID),
    retry: false, refetchInterval: 3_000,
    queryFn: () => load(`/api/v1/objectives/${objectiveID}/plans`, plansSchema, 'plans') });
  const projects = useQuery({ queryKey: ['projects'], enabled,
    queryFn: () => load('/api/v1/projects', projectsSchema, 'projects') });
  const products = useQuery({ queryKey: ['products'], enabled: enabled && Boolean(productID), queryFn: loadProducts });
  const agents = useQuery({ queryKey: ['agents'], queryFn: loadAgents, enabled });
  const personas = useQuery({ queryKey: ['personas'], queryFn: loadPersonas, enabled });
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: loadWorkflows, enabled });
  const workers = useQuery({ queryKey: ['local-workers'], enabled, refetchInterval: 5_000,
    queryFn: () => load('/api/v1/workers', workersSchema, 'local workers') });
  const change = async (path: string, body?: unknown) => {
    await send(path, body);
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['work-graphs'] }),
      queryClient.invalidateQueries({ queryKey: ['objective-plans'] }),
      queryClient.invalidateQueries({ queryKey: ['action-required'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-runs'] })]);
  };
  const cliProviders = ['codex-cli', 'claude-code'];
  const product = products.data?.find((item) => item.id === productID);
  const productProjectIDs = product ? new Set(product.repository_ids) : undefined;
  const availableProjects = (projects.data ?? []).filter((project) => project.worker_status === 'online'
    && (!productID || productProjectIDs?.has(project.id)));
  const projectNotice = productID && products.isError ? 'Product repository links are unavailable.'
    : productID && products.isSuccess && !product ? 'The objective product is unavailable.'
      : productID && products.isSuccess && product?.repository_ids.length === 0 ? 'No repository is linked to this product.'
        : projects.isError ? 'Repository checkouts are unavailable.'
          : productID && projects.isSuccess && availableProjects.length === 0
            ? 'No linked repository has an online worker.' : undefined;
  return {
    graphs: graphs.data ?? [],
    loading: graphs.isLoading,
    failed: graphs.isError,
    retry: () => {
      void graphs.refetch();
      if (objectiveID) void plans.refetch();
    },
    plans: plans.data ?? [],
    plansLoading: plans.isLoading,
    plansFailed: plans.isError,
    options: {
      projects: availableProjects.map((project) => ({ value: project.id,
        label: `${project.name} · ${project.branch}`, workerID: project.worker_id })),
      projectWorkerIDs: Object.fromEntries((projects.data ?? []).map((project) => [project.id, project.worker_id])),
      projectNotice,
      // A planner only reads: a profile that may write code is refused by the control plane.
      planners: (agents.data ?? []).filter((agent) => agent.status === 'active' && cliProviders.includes(agent.provider)
        && !agent.tools.includes('code.write') && (!agent.persona_id || personas.data?.some((persona) =>
          persona.id === agent.persona_id && persona.status === 'active')))
        .map((agent) => ({ value: agent.id, label: `${agent.name} · ${agent.provider} · ${agent.model}${agent.persona_id
          ? ` · ${personas.data?.find((persona) => persona.id === agent.persona_id)?.name ?? 'persona'}` : ''}` })),
      workflows: (workflows.data ?? []).map((workflow) => ({ value: workflow.id, label: `${workflow.name} · v${workflow.version}` })),
      agents: agents.data ?? [], personas: personas.data ?? [], workers: workers.data ?? [],
      agentsLoading: agents.isLoading, workersFailed: workers.isError, workersLoading: workers.isLoading,
    },
    agentNames: Object.fromEntries((agents.data ?? []).map((agent) => {
      const persona = personas.data?.find((item) => item.id === agent.persona_id);
      return [agent.id, `${agent.name} · ${agent.provider} · ${agent.model}${persona ? ` · ${persona.name} v${persona.version}` : ''}`];
    })),
    readOnlyReason: '',
    propose: (input) => change(`/api/v1/objectives/${objectiveID}/plans`, input),
    approve: (revision) => change(`/api/v1/objectives/${objectiveID}/plans/${revision}/approve`),
    cancel: (graphID) => change(`/api/v1/work-graphs/${graphID}/cancel`),
    retryUnit: (graphID, key) => change(`/api/v1/work-graphs/${graphID}/units/${key}/retry`),
    resolve: (graphID, messageID, resolution) =>
      change(`/api/v1/work-graphs/${graphID}/decisions/${messageID}`, { resolution }),
    authorizePublication: (runID, candidateSHA) =>
      change(`/api/v1/agent-runs/${runID}/publish`, { candidate_sha: candidateSHA }),
  };
}
