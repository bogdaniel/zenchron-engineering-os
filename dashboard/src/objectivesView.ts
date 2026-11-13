import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { loadProducts } from './productEditor';

const statusSchema = z.enum(['on_track', 'at_risk', 'blocked', 'in_progress', 'completed']);
const objectiveSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  owner: z.string(),
  product: z.string(),
  product_id: z.string().default(''),
  status: statusSchema,
  progress: z.number().int().min(0).max(100),
  due_date: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  approval: z.string().optional(),
  workflow_count: z.number().int().nonnegative().optional(),
});
export const objectivesSchema = z.array(objectiveSchema);
export const objectiveInputSchema = z.object({
  title: z.string().trim().min(1, 'Add an objective title').max(200),
  description: z.string().max(5000),
  owner: z.string().max(128),
  product_id: z.string().max(32),
  due_date: z.string().max(10),
});
export const objectiveEditSchema = objectiveInputSchema.extend({
  status: statusSchema,
  progress: z.number().int().min(0, 'Progress is between 0 and 100').max(100, 'Progress is between 0 and 100'),
});
export type Objective = z.infer<typeof objectiveSchema>;
export type ObjectiveInput = z.infer<typeof objectiveInputSchema>;
export type ObjectiveEdit = z.infer<typeof objectiveEditSchema>;

/** Field errors for a Mantine form, from the schema that also guards the request. */
export function objectiveFormErrors(schema: z.ZodType, values: unknown) {
  const result = schema.safeParse(values);
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((issue) => [String(issue.path[0]), issue.message]));
}

const objectiveDateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
export function formatObjectiveDate(value: string) {
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : objectiveDateFormat.format(date);
}

/** The parts of the detail panel that only some data sources hold. An absent part is shown as Unavailable. */
export type ObjectiveDetails = {
  blocker?: string;
  acceptanceCriteria?: string[];
  relatedPullRequests?: { id: string; title: string; status: string }[];
  planSummary?: string[];
  activity?: { text: string; time: string }[];
  milestones?: { title: string; progress: number; status: string; date: string }[];
  /** The headline beside Milestone Progress. */
  milestoneSummary?: string;
};

/** Objectives, display values, and operations for the Objectives page. Mock and Live each provide one. */
export type ObjectivesSource = {
  items: Objective[];
  loading: boolean;
  failed: boolean;
  /** Reloads the list. Absent where loading cannot fail. */
  retry?: () => void;
  products: { value: string; label: string }[];
  productsLoading: boolean;
  productsFailed: boolean;
  view: {
    /** The date "This Quarter" is measured from. */
    today: Date;
    /**
     * Mock reproduces the approved 1672×941 frame, which has no room for the search row above the table.
     * Live keeps search, the count, and retry visible at every size.
     */
    referenceFrame: boolean;
    /** `change`, `bars`, and `points` are history; a source without history leaves them out. */
    throughput: { value: string | number; detail: string; change?: string; bars?: number[] };
    successRate: { value: string | number; change?: string; points?: number[] };
    /** Cumulative planned and completed objectives per week. Absent where delivery dates are not recorded. */
    capacity?: { week: string; planned: number; completed: number }[];
    details: (item: Objective) => ObjectiveDetails;
  };
  create: (input: ObjectiveInput) => Promise<Objective>;
  update: (id: string, input: ObjectiveEdit) => Promise<Objective>;
  /** Starred objectives. Absent where nothing stores them. */
  favorites?: { ids: string[]; toggle: (id: string) => void };
  /** Appended to confirmations so a local-only change is never presented as saved. */
  savedSuffix: string;
};

async function loadObjectives(): Promise<Objective[]> {
  const response = await fetch('/api/v1/objectives');
  if (!response.ok) throw new Error(`Could not load objectives (${response.status})`);
  return objectivesSchema.parse(await response.json());
}

async function sendObjective(method: 'POST' | 'PATCH', path: string, body: ObjectiveInput | ObjectiveEdit) {
  const response = await fetch(path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text() || `Could not save objective (${response.status})`);
  return objectiveSchema.parse(await response.json());
}

/** Objectives from the control plane. Fields the API does not hold are left out so the page says Unavailable. */
export function useLiveObjectives(enabled: boolean): ObjectivesSource {
  const queryClient = useQueryClient();
  const objectives = useQuery({ queryKey: ['objectives'], queryFn: loadObjectives, enabled, retry: false });
  const products = useQuery({ queryKey: ['products'], queryFn: loadProducts, enabled, retry: false });
  const items = objectives.data ?? [];
  const loading = objectives.isLoading && !objectives.data;
  const completed = items.filter((item) => item.status === 'completed').length;
  const figure = (value: string | number) => loading ? '…' : objectives.isError ? '—' : value;
  // The saved record replaces the cached one before the list is read again, so a list request that was already
  // in flight cannot put the old record back.
  const store = async (item: Objective) => {
    await queryClient.cancelQueries({ queryKey: ['objectives'] });
    queryClient.setQueryData<Objective[]>(['objectives'], (current = []) =>
      current.some((objective) => objective.id === item.id)
        ? current.map((objective) => objective.id === item.id ? item : objective)
        : [...current, item]);
    await queryClient.invalidateQueries({ queryKey: ['objectives'] });
    return item;
  };
  return {
    items,
    loading,
    failed: objectives.isError,
    retry: () => void objectives.refetch(),
    products: products.data?.map((product) => ({ value: product.id, label: product.name })) ?? [],
    productsLoading: products.isLoading,
    productsFailed: products.isError,
    view: {
      today: new Date(),
      referenceFrame: false,
      throughput: { value: figure(completed), detail: 'Completed objectives' },
      successRate: { value: figure(items.length ? `${Math.round(completed / items.length * 100)}%` : '—') },
      details: (item) => ({
        planSummary: [
          item.due_date ? `Target date: ${formatObjectiveDate(item.due_date)}` : 'Target date: not set',
          `Created: ${formatObjectiveDate(item.created_at)}`,
          `Last updated: ${formatObjectiveDate(item.updated_at)}`,
        ],
      }),
    },
    create: async (input) => store(await sendObjective('POST', '/api/v1/objectives', input)),
    update: async (id, input) => store(await sendObjective('PATCH', `/api/v1/objectives/${id}`, input)),
    savedSuffix: '',
  };
}
