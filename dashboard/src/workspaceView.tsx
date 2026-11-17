import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { loadAgents, loadPersonas } from './agentsData';
import { profileReadiness } from './agentReadiness';
import { livePageHref } from './livePageHref';
import type { RunWorker } from './agentRunQueue';
import type { Objective } from './objectives';
import { loadProducts, productSchema } from './productEditor';
import type { Product, ProductInput } from './productEditor';
import type { Project } from './projects';
import { loadWorkflows } from './workflowModel';

/** Shown in place of a card's rows: an empty state, a loading line, or (with `alert`) a failed request. */
export type WorkspaceNote = { text: string; alert?: boolean };
export type WorkspaceProduct = { id: string; name: string; summary: string; state: string; healthy: boolean; icon: string };
export type WorkspaceRoadmapRow = {
  name: string; status: string; tone: string; detail?: string; bar?: { left: string; width: string };
};
export type WorkspaceObjectiveRow = { title: string; detail?: string; progress: number; done: boolean; href?: string };
export type WorkspaceRepositoryRow = { name: string; detail?: string; branch: string };
export type WorkspaceStatusRow = { name: string; state: string; detail?: string; href?: string; note?: string };

/** Display values for the selected product, in the same shape for Mock and Live. */
export type WorkspaceView = {
  name: string;
  description: string;
  status: { label: string; healthy: boolean };
  facts: string[];
  metrics: {
    health: { value: string; badge: string; healthy: boolean; trend?: string };
    initiatives: { label: string; value: string; delta?: string; caption?: string; trend?: string };
    delivery: { value: string; caption: string; delta?: string; bars?: number[] };
    decisions: { value: string; detail: string };
  };
  roadmap: {
    quarters: string[];
    labels: { text: string; today?: boolean }[];
    /** Horizontal position of today on the track; absent when today is outside the quarters shown. */
    todayAt?: string;
    rows: WorkspaceRoadmapRow[];
    note?: WorkspaceNote;
  };
  objectives: {
    title: string; rows: WorkspaceObjectiveRow[]; note?: WorkspaceNote;
    allTitle: string; allRows: WorkspaceObjectiveRow[]; allNote?: WorkspaceNote;
  };
  repositories: {
    title: string; rows: WorkspaceRepositoryRow[]; more?: string; allRows: WorkspaceRepositoryRow[]; note?: WorkspaceNote;
  };
  workflows: {
    title: string; rows: WorkspaceStatusRow[]; note?: WorkspaceNote;
    templatesTitle: string; templateRows: WorkspaceStatusRow[]; templatesNote?: WorkspaceNote;
  };
  files: { rows: [name: string, count: string][]; note?: WorkspaceNote };
  stakeholders: {
    title: string; rows: { name: string; role: string; avatar?: string }[]; more?: string; manageNote: string;
    note?: WorkspaceNote;
  };
  releases: { rows: { name: string; state: string; version: string; progress: number; tone: string }[]; note?: WorkspaceNote };
  decisions: { rows: { name: string; state: string; time?: string; href?: string }[]; note?: WorkspaceNote };
  delivery: {
    ranges: string[];
    metrics: (range: string) => [label: string, value: string, delta: string][];
    chart?: { label: string; points: [x: number, y: number][]; dates: string[] };
    note?: WorkspaceNote;
  };
};

export type WorkspaceEditable = Pick<Product, 'id' | 'name' | 'description' | 'repository_ids'>;

/** Everything the Product Workspace layout needs. Operations a mode cannot perform are absent. */
export type WorkspaceSource = {
  products: WorkspaceProduct[];
  /** Why the directory has no product rows. */
  directoryNote?: WorkspaceNote;
  statuses: string[];
  view: (productID: string | undefined, quarter: string | undefined) => WorkspaceView;
  favorites: string[];
  toggleFavorite?: (productID: string) => void;
  editable: (productID: string) => WorkspaceEditable | undefined;
  /** Repositories the editor can link; absent where links cannot be stored, with `editorNote` as the reason. */
  repositories?: Project[];
  editorNote?: string;
  saveProduct: (input: ProductInput, productID?: string) => Promise<{ id: string }>;
  saving: boolean;
  shareNote: string;
};

export interface WorkspaceFacts {
  projects: Project[] | undefined;
  objectives: Objective[] | undefined;
  projectsLoading: boolean;
  projectsError: boolean;
  objectivesLoading: boolean;
  objectivesError: boolean;
  workers?: RunWorker[];
  workersLoading?: boolean;
}

const unavailable = 'Unavailable';
// Short enough to sit beside a product name in the 250px directory.
const noRepositories = 'No repos';
const roadmapQuarterCount = 5;
const overviewRowLimit = 4;
const openObjectiveLimit = 5;
const statusTones: Record<Objective['status'], string> = {
  on_track: 'green', in_progress: 'purple', at_risk: 'amber', blocked: 'red', completed: 'teal',
};
const missing = (what: string): WorkspaceNote => ({ text: `${unavailable}: ${what}` });
const failed = (text: string): WorkspaceNote => ({ text, alert: true });
const environmentSchema = z.object({
  product_id: z.string(),
  objectives: z.array(z.object({ graph_id: z.string().optional(), graph_status: z.string().optional(),
    findings: z.number().int().nonnegative().optional(), handoffs: z.number().int().nonnegative().optional(),
    pull_request_url: z.string().optional() })),
  decisions: z.array(z.object({ graph_id: z.string().optional(), graph_status: z.string().optional(), message_id: z.string().optional(),
    objective_id: z.string(), question: z.string(), resolved_by: z.string().optional() })),
});
type WorkspaceEnvironment = z.infer<typeof environmentSchema>;

async function loadEnvironment(productID: string): Promise<WorkspaceEnvironment> {
  const response = await fetch(`/api/v1/products/${encodeURIComponent(productID)}/environment`);
  if (!response.ok) throw new Error(`Could not load product execution (${response.status})`);
  const environment = environmentSchema.parse(await response.json());
  if (environment.product_id !== productID) throw new Error('Product execution response does not match the selected product');
  return environment;
}

function statusLabel(status: string) {
  const text = status.replace('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function objectiveDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

// Quarters are numbered year * 4 + quarter so that consecutive quarters are consecutive integers.
const quarterOf = (date: Date) => date.getUTCFullYear() * 4 + Math.floor(date.getUTCMonth() / 3);
const quarterStart = (quarter: number) => Date.UTC(Math.floor(quarter / 4), (quarter % 4) * 3, 1);
const quarterLabel = (quarter: number) => `Q${(quarter % 4) + 1} ’${String(Math.floor(quarter / 4)).slice(-2)}`;
const percent = (value: number) => `${Math.round(value * 1000) / 10}%`;

function productHealth(product: Product, projects: Project[] | undefined) {
  const linked = projects?.filter((project) => product.repository_ids.includes(project.id)) ?? [];
  const online = linked.filter((project) => project.worker_status === 'online').length;
  const label = product.repository_ids.length === 0 ? noRepositories
    : online ? 'Healthy' : linked.length ? 'Offline' : unavailable;
  return { label, online, total: product.repository_ids.length, healthy: online > 0 };
}

function liveRoadmap(objectives: Objective[], quarter: string | undefined, now: number): Pick<WorkspaceView['roadmap'],
  'quarters' | 'labels' | 'todayAt' | 'rows'> {
  const dated = objectives
    .map((objective) => ({ objective, due: objectiveDate(objective.due_date) }))
    .filter((item): item is { objective: Objective; due: Date } => item.due !== null)
    .sort((a, b) => a.due.getTime() - b.due.getTime());
  if (!dated.length) return { quarters: [], labels: [], rows: [] };

  const firstQuarter = quarterOf(dated[0].due);
  const quarterIDs = Array.from({ length: quarterOf(dated.at(-1)!.due) - firstQuarter + 1 }, (_, index) => firstQuarter + index);
  const from = quarterIDs.find((id) => quarterLabel(id) === quarter) ?? firstQuarter;
  const start = quarterStart(from);
  const end = quarterStart(from + roadmapQuarterCount);
  const position = (time: number) => (Math.min(Math.max(time, start), end) - start) / (end - start);
  return {
    quarters: quarterIDs.map(quarterLabel),
    labels: Array.from({ length: roadmapQuarterCount }, (_, index) => ({ text: quarterLabel(from + index) })),
    todayAt: now >= start && now < end ? percent(position(now)) : undefined,
    rows: dated.filter(({ due }) => due.getTime() >= start).slice(0, overviewRowLimit).map(({ objective, due }) => {
      // The bar runs from when the objective was recorded to its due date; no start estimate is implied.
      const created = Date.parse(objective.created_at);
      const right = position(due.getTime());
      const left = Math.min(Number.isFinite(created) ? position(created) : right, right);
      const dueText = due.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      return {
        name: objective.title,
        status: statusLabel(objective.status),
        tone: statusTones[objective.status],
        detail: `Due ${dueText} · ${objective.progress}%`,
        // ponytail: bars under 3% of the track are widened to stay visible; drop when rows get their own scale
        bar: { left: percent(Math.min(left, 0.97)), width: percent(Math.max(right - left, 0.03)) },
      };
    }),
  };
}

function liveView(product: Product | undefined, quarter: string | undefined, facts: WorkspaceFacts, definitions: {
  workflows: WorkspaceStatusRow[]; workflowsNote?: WorkspaceNote; agents: WorkspaceStatusRow[];
}, environment: WorkspaceEnvironment | undefined, environmentNote: WorkspaceNote | undefined): WorkspaceView {
  const { projects, objectives, projectsLoading, projectsError, objectivesLoading, objectivesError } = facts;
  const health = product ? productHealth(product, projects) : { label: unavailable, online: 0, total: 0, healthy: false };
  const productObjectives = objectives?.filter((objective) => objective.product_id === product?.id) ?? [];
  const openObjectives = productObjectives.filter((objective) => objective.status !== 'completed');
  const objectiveRow = (objective: Objective): WorkspaceObjectiveRow => ({
    title: objective.title,
    href: livePageHref('objectives', { objective: objective.id, tab: 'plan' }),
    detail: `${statusLabel(objective.status)} · ${objective.owner || 'No owner'}`,
    progress: objective.progress,
    done: objective.status === 'completed',
  });
  const objectivesPending = objectivesError ? failed('Objective data unavailable.')
    : objectivesLoading ? { text: 'Loading objectives…' } : undefined;
  const roadmap = liveRoadmap(productObjectives, quarter, Date.now());
  const repositoryRows = product?.repository_ids.map((id): WorkspaceRepositoryRow => {
    const project = projects?.find((item) => item.id === id);
    if (!project) {
      return { name: `Unavailable repository · ${id.slice(0, 8)}`, detail: 'Worker has not reported this checkout', branch: 'unavailable' };
    }
    return { name: project.name, detail: `${project.worker_name} · ${project.worker_status}`, branch: project.branch || 'Unknown branch' };
  }) ?? [];
  const hiddenRepositories = repositoryRows.length - overviewRowLimit;
  const templateRows = [...definitions.workflows, ...definitions.agents];
  const graphCount = environment?.objectives.filter((item) => item.graph_id).length ?? 0;
  const pullRequestCount = environment?.objectives.filter((item) => item.pull_request_url).length ?? 0;
  const pendingDecisions = environment?.decisions.filter((item) => !item.resolved_by && item.graph_status !== 'cancelled').length ?? 0;
  const findingCount = environment?.objectives.reduce((count, item) => count + (item.findings ?? 0), 0) ?? 0;
  const handoffCount = environment?.objectives.reduce((count, item) => count + (item.handoffs ?? 0), 0) ?? 0;

  return {
    name: product?.name ?? 'No product selected',
    description: product?.description || 'Group repositories and view current engineering work.',
    status: { label: health.label, healthy: health.healthy },
    facts: product ? ['Product', `${health.online} of ${health.total} repositories online`,
      `Updated ${new Date(product.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`]
      : ['Product'],
    metrics: {
      health: { value: product ? `${health.online} of ${health.total}` : unavailable,
        badge: health.healthy ? '✓ Healthy' : product ? health.label : 'No product selected', healthy: health.healthy },
      initiatives: { label: 'Open Objectives', caption: 'Assigned to this product',
        value: objectivesLoading ? 'Loading' : objectivesError ? unavailable : String(openObjectives.length) },
      delivery: { value: environment ? String(pullRequestCount) : unavailable, caption: 'Observed feature PR links' },
      decisions: { value: environment ? String(pendingDecisions) : unavailable, detail: 'Pending in current WorkGraphs' },
    },
    roadmap: { ...roadmap,
      note: objectivesError ? failed('Objective roadmap unavailable.')
        : objectivesLoading ? { text: 'Loading objective roadmap…' }
        : !product ? { text: 'Add a product and link dated objectives to see a roadmap.' }
        : roadmap.quarters.length ? undefined : { text: 'Add due dates to product objectives to see them on the roadmap.' } },
    objectives: {
      title: objectivesPending ? 'Open Objectives' : `Open Objectives (${openObjectives.length})`,
      rows: openObjectives.slice(0, openObjectiveLimit).map(objectiveRow),
      note: objectivesPending ?? (openObjectives.length ? undefined : { text: 'No open workspace objectives.' }),
      allTitle: objectivesPending ? 'Objectives' : `Objectives (${productObjectives.length})`,
      allRows: productObjectives.map(objectiveRow),
      allNote: objectivesPending ?? (productObjectives.length ? undefined : { text: 'No workspace objectives.' }),
    },
    repositories: {
      title: product ? `Repositories (${repositoryRows.length})` : 'Repositories',
      rows: repositoryRows.slice(0, overviewRowLimit),
      more: hiddenRepositories > 0 ? `+ ${hiddenRepositories} more ${hiddenRepositories === 1 ? 'repository' : 'repositories'}` : undefined,
      allRows: repositoryRows,
      note: !product ? { text: 'Add a product to link repositories.' }
        : projectsError ? failed('Repository inventory unavailable.')
        : projectsLoading ? { text: 'Loading repository inventory…' }
        : repositoryRows.length ? undefined : { text: 'No repositories linked yet.' },
    },
    workflows: {
      // Workflow definitions and agent profiles are workspace-wide; the control plane does not link them to a product.
      title: definitions.workflowsNote ? 'Available Workflows' : `Available Workflows (${definitions.workflows.length})`,
      rows: definitions.workflows.slice(0, overviewRowLimit),
      note: definitions.workflowsNote ?? (definitions.workflows.length ? undefined : { text: 'No workflow definitions saved.' }),
      templatesTitle: `Workflows and Agent Profiles (${templateRows.length})`,
      templateRows,
      templatesNote: definitions.workflowsNote ?? (templateRows.length ? undefined : { text: 'No definitions saved.' }),
    },
    files: { rows: [], note: missing('files and evidence appear once a storage integration and agent runs exist.') },
    stakeholders: { title: 'Stakeholders', rows: [], note: missing('workspace membership and roles are not configured.'),
      manageNote: 'Workspace membership and roles are not configured in the control plane, so there is nothing to manage yet.' },
    releases: { rows: [], note: missing('release streams are not recorded by the control plane.') },
    decisions: { rows: environment?.decisions.map((item) => ({ name: item.question,
      state: item.resolved_by ? 'Resolved' : item.graph_status === 'cancelled' ? 'Cancelled' : 'Pending',
      href: item.graph_status === 'cancelled' ? undefined : livePageHref('objectives', { objective: item.objective_id, tab: 'plan',
        ...(item.graph_id ? { graph_id: item.graph_id } : {}), ...(item.message_id ? { decision: item.message_id } : {}) }) })) ?? [],
      note: environmentNote ?? (environment?.decisions.length ? undefined : { text: 'No decisions recorded in current WorkGraphs.' }) },
    delivery: { ranges: [], metrics: () => [
      ['WorkGraphs', String(graphCount), 'current'], ['PR links', String(pullRequestCount), 'observed'],
      ['Findings', String(findingCount), 'recorded'], ['Handoffs', String(handoffCount), 'recorded'],
    ], note: environmentNote },
  };
}

/**
 * The Live source: products, workflow definitions, and agent profiles from the API, joined with the shell's project
 * and objective queries. Queries are disabled in Mock so the fixtures never touch the control plane.
 */
export function useLiveWorkspace(enabled: boolean, facts: WorkspaceFacts, selectedProductID: string): WorkspaceSource {
  const queryClient = useQueryClient();
  const products = useQuery({ queryKey: ['products'], queryFn: loadProducts, enabled });
  const environmentID = products.data?.find((item) => item.id === selectedProductID)?.id ?? products.data?.[0]?.id;
  const environment = useQuery({ queryKey: ['product-environment', environmentID],
    queryFn: () => loadEnvironment(environmentID!), enabled: enabled && Boolean(environmentID) });
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: loadWorkflows, enabled });
  const agents = useQuery({ queryKey: ['agents'], queryFn: loadAgents, enabled });
  const personas = useQuery({ queryKey: ['personas'], queryFn: loadPersonas, enabled });
  const save = useMutation({
    mutationFn: async ({ input, productID }: { input: ProductInput; productID?: string }) => {
      const response = await fetch(productID ? `/api/v1/products/${productID}` : '/api/v1/products', {
        method: productID ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(await response.text());
      return productSchema.parse(await response.json());
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['products'] }),
  });
  const definitions = {
    workflows: workflows.data?.map((workflow) => ({ name: workflow.name, state: workflow.status,
      detail: `Workflow v${workflow.version}`, href: livePageHref('workflows', { workflow: workflow.id }) })) ?? [],
    workflowsNote: workflows.isError ? failed('Workflow definitions unavailable.')
      : workflows.isLoading ? { text: 'Loading workflow definitions…' } : undefined,
    agents: agents.isError ? [{ name: 'Agent profiles', state: unavailable }]
      : agents.isLoading ? [{ name: 'Agent profiles', state: 'Loading' }]
      : agents.data?.map((agent) => {
        const persona = personas.data?.find((item) => item.id === agent.persona_id);
        const readiness = personas.isError && agent.persona_id
          ? { label: 'Persona data unavailable', note: 'Could not check the linked persona.' }
          : profileReadiness(agent, facts.workers ?? [], persona, personas.isLoading, false, facts.workersLoading);
        return { name: agent.name, state: readiness.label, note: readiness.note,
          detail: `${persona?.name ?? (agent.persona_id ? 'Persona unavailable' : 'No persona')} · ${agent.provider} · ${agent.model}`,
          href: livePageHref('agents', { profile: agent.id }) };
      }) ?? [],
  };

  return {
    products: products.data?.map((product) => {
      const health = productHealth(product, facts.projects);
      return { id: product.id, name: product.name, summary: `${product.repository_ids.length} linked repositories`,
        state: health.label, healthy: health.healthy, icon: 'layers' };
    }) ?? [],
    directoryNote: products.isError ? failed('Product list unavailable.')
      : facts.projectsLoading ? { text: 'Loading worker inventory…' }
      : products.isLoading ? { text: 'Loading products…' }
      : products.data?.length ? undefined : { text: 'No products yet. Add a product to group repositories.' },
    statuses: ['All', 'Healthy', 'Offline', noRepositories, unavailable],
    view: (productID, quarter) => {
      const product = products.data?.find((item) => item.id === productID);
      const selectedEnvironment = !environment.isError && environment.data?.product_id === product?.id
        ? environment.data : undefined;
      const environmentNote = !product ? { text: 'Add a product to see execution evidence.' }
        : environment.isError ? failed('Product execution evidence unavailable.')
        : selectedEnvironment ? undefined : { text: 'Loading product execution evidence…' };
      return liveView(product, quarter, facts, definitions, selectedEnvironment, environmentNote);
    },
    favorites: [],
    editable: (productID) => products.data?.find((product) => product.id === productID),
    repositories: facts.projects ?? [],
    saveProduct: (input, productID) => save.mutateAsync({ input, productID }),
    saving: save.isPending,
    shareNote: 'Invitations are not sent from the control plane. Share the page URL with a signed-in teammate to open this workspace.',
  };
}
