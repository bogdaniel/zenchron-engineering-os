import { z } from 'zod';
import { runEvidenceFields } from './runEvidence';

const agentToolSchema = z.enum(['code.search', 'code.write', 'docs.search', 'git.diff', 'git.read', 'tests.run']);
export const agentSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), provider: z.string(), model: z.string(),
  status: z.enum(['active', 'disabled']), system_prompt: z.string(), goal_prompt: z.string(),
  tools: z.array(agentToolSchema), version: z.number(), updated_at: z.string(),
});
export const agentRunSchema = z.object({
  id: z.string(), agent_id: z.string(), agent_name: z.string(), project_id: z.string(), project_name: z.string(),
  worker_id: z.string(), worker_name: z.string(), branch: z.string(), prompt: z.string(), output: z.string().optional(),
  base_branch: z.string().optional(),
  commit_sha: z.string().optional(),
  diff_attempt: z.number().optional().default(0),
  diff_available: z.boolean().optional().default(false), diff_truncated: z.boolean().optional().default(false),
  pull_request_enabled: z.boolean().optional().default(false), pull_request_url: z.string().optional(),
  pull_request_number: z.number().optional(), pull_request_error: z.string().optional(),
  can_request_changes: z.boolean().optional().default(false),
  cancel_requested: z.boolean().optional().default(false),
  review_comments: z.array(z.object({ body: z.string(), request_changes: z.boolean(), created_at: z.string() })).optional().default([]),
  error: z.string().optional(), status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  attempts: z.number(), created_at: z.string(), updated_at: z.string(),
}).extend(runEvidenceFields);
export const agentRunsSchema = z.array(agentRunSchema);
export const agentsSchema = z.array(agentSchema);
export const agentInputSchema = z.object({
  name: z.string().trim().min(1, 'Add an agent name').max(100),
  description: z.string().max(500),
  provider: z.string().trim().min(1, 'Add a provider identifier').max(100),
  model: z.string().trim().min(1, 'Add a model identifier').max(200),
  status: z.enum(['active', 'disabled']),
  system_prompt: z.string().max(20_000),
  goal_prompt: z.string().max(5_000),
  tools: z.array(agentToolSchema),
});
export const runInputSchema = z.object({
  project_id: z.string().min(1, 'Choose an online project'),
  prompt: z.string().trim().max(5000),
  issue_number: z.number().int().positive().optional(),
}).refine((input) => input.prompt !== '' || input.issue_number !== undefined, { path: ['prompt'], message: 'Add a task prompt or choose an issue' });
export type Agent = z.infer<typeof agentSchema>;
export type AgentRun = z.infer<typeof agentRunSchema>;
export type AgentInput = z.infer<typeof agentInputSchema>;
export type RunInput = z.infer<typeof runInputSchema>;

export const toolOptions = [
  { value: 'code.search', label: 'Code search' }, { value: 'docs.search', label: 'Documentation search' },
  { value: 'code.write', label: 'Write files in isolated branch' },
  { value: 'git.diff', label: 'Read Git diffs' }, { value: 'git.read', label: 'Read repository files' },
  { value: 'tests.run', label: 'Run tests' },
];

export const blankProfile: AgentInput = {
  name: '', description: '', provider: '', model: '', status: 'active',
  system_prompt: '', goal_prompt: '', tools: [],
};

export async function loadAgents(): Promise<Agent[]> {
  const response = await fetch('/api/v1/agents');
  if (!response.ok) throw new Error(`Could not load agents (${response.status})`);
  return agentsSchema.parse(await response.json());
}

export async function loadAgentRuns(): Promise<AgentRun[]> {
  const response = await fetch('/api/v1/agent-runs');
  if (!response.ok) throw new Error(`Could not load agent runs (${response.status})`);
  return agentRunsSchema.parse(await response.json());
}

export function validateAgentInput(values: AgentInput) {
  const result = agentInputSchema.safeParse(values);
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((issue) => [String(issue.path[0]), issue.message]));
}

export function relativeRunTime(timestamp: string) {
  const elapsed = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(elapsed)) return 'time unknown';
  if (Math.abs(elapsed) < 60_000) return 'just now';
  const units = [{ size: 86_400_000, label: 'd' }, { size: 3_600_000, label: 'h' }, { size: 60_000, label: 'm' }];
  const unit = units.find(({ size }) => Math.abs(elapsed) >= size) ?? units[2];
  const value = Math.floor(Math.abs(elapsed) / unit.size);
  return elapsed > 0 ? `${value}${unit.label} ago` : `in ${value}${unit.label}`;
}
