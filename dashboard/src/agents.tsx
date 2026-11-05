import { useEffect, useState } from 'react';
import { useForm } from '@mantine/form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Checkbox, Modal, Select, Tabs, Text, Textarea, TextInput } from '@mantine/core';
import { IconActivity, IconCpu, IconPlus, IconRobot, IconSearch, IconShieldCheck, IconSparkles } from '@tabler/icons-react';
import { z } from 'zod';
import type { Project } from './projects';
import { MetricCard } from './MetricCard';
import { PanelHeading } from './PanelHeading';
import { PanelCard } from './PanelCard';
import { PageHeading } from './PageHeading';
import { runsInLast30Days } from './runMetrics';
import { AgentPerformanceTrend } from './AgentPerformanceTrend';
import { AgentPromptEditor } from './AgentPromptEditor';
import { AgentExecutionOverview } from './AgentExecutionOverview';
import './agents.css';
import './agents-layout.css';

const agentToolSchema = z.enum(['code.search', 'code.write', 'docs.search', 'git.diff', 'git.read', 'tests.run']);
const agentSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), provider: z.string(), model: z.string(),
  status: z.enum(['active', 'disabled']), system_prompt: z.string(), goal_prompt: z.string(),
  tools: z.array(agentToolSchema), version: z.number(), updated_at: z.string(),
});
const agentRunSchema = z.object({
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
});
export const agentRunsSchema = z.array(agentRunSchema);
export const agentsSchema = z.array(agentSchema);
const inputSchema = z.object({
  name: z.string().trim().min(1, 'Add an agent name').max(100),
  description: z.string().max(500),
  provider: z.string().trim().min(1, 'Add a provider identifier').max(100),
  model: z.string().trim().min(1, 'Add a model identifier').max(200),
  status: z.enum(['active', 'disabled']),
  system_prompt: z.string().max(20_000),
  goal_prompt: z.string().max(5_000),
  tools: z.array(agentToolSchema),
});
const runInputSchema = z.object({
  project_id: z.string().min(1, 'Choose an online project'),
  prompt: z.string().trim().min(1, 'Add a task prompt').max(5000),
});
type Agent = z.infer<typeof agentSchema>;
export type AgentRun = z.infer<typeof agentRunSchema>;
type AgentInput = z.infer<typeof inputSchema>;
type RunInput = z.infer<typeof runInputSchema>;
function AgentToolBadges({ tools, limit }: { tools: string[]; limit?: number }) {
  if (!tools.length) return <span className="agent-tool-empty">None configured</span>;
  const visibleTools = limit === undefined ? tools : tools.slice(0, limit);
  const hiddenTools = tools.slice(visibleTools.length);
  return <span className="agent-tool-badges">
    {visibleTools.map((tool) => <Badge className="agent-tool-badge" key={tool} variant="light">{tool}</Badge>)}
    {hiddenTools.length > 0 && <Badge className="agent-tool-badge" title={hiddenTools.join(', ')} variant="light">+{hiddenTools.length}</Badge>}
  </span>;
}
const toolOptions = [
  { value: 'code.search', label: 'Code search' }, { value: 'docs.search', label: 'Documentation search' },
  { value: 'code.write', label: 'Write files in isolated branch' },
  { value: 'git.diff', label: 'Read Git diffs' }, { value: 'git.read', label: 'Read repository files' },
  { value: 'tests.run', label: 'Run tests' },
];

async function loadAgents(): Promise<Agent[]> {
  const response = await fetch('/api/v1/agents');
  if (!response.ok) throw new Error(`Could not load agents (${response.status})`);
  return agentsSchema.parse(await response.json());
}

export async function loadAgentRuns(): Promise<AgentRun[]> {
  const response = await fetch('/api/v1/agent-runs');
  if (!response.ok) throw new Error(`Could not load agent runs (${response.status})`);
  return agentRunsSchema.parse(await response.json());
}

function validateInput(values: AgentInput) {
  const result = inputSchema.safeParse(values);
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((issue) => [String(issue.path[0]), issue.message]));
}

function relativeRunTime(timestamp: string) {
  const elapsed = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(elapsed)) return 'time unknown';
  if (Math.abs(elapsed) < 60_000) return 'just now';
  const units = [{ size: 86_400_000, label: 'd' }, { size: 3_600_000, label: 'h' }, { size: 60_000, label: 'm' }];
  const unit = units.find(({ size }) => Math.abs(elapsed) >= size) ?? units[2];
  const value = Math.floor(Math.abs(elapsed) / unit.size);
  return elapsed > 0 ? `${value}${unit.label} ago` : `in ${value}${unit.label}`;
}

const blankProfile: AgentInput = {
  name: '', description: '', provider: '', model: '', status: 'active',
  system_prompt: '', goal_prompt: '', tools: [],
};

type Worker = { id: string; name: string; agent_runtime_enabled?: boolean };

export function AgentsPage({ projects, workers }: { projects: Project[]; workers: Worker[] }) {
  const queryClient = useQueryClient();
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [agentSearch, setAgentSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [runProjectID, setRunProjectID] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const agents = useQuery({ queryKey: ['agents'], queryFn: loadAgents });
  const runs = useQuery({ queryKey: ['agent-runs'], queryFn: loadAgentRuns, refetchInterval: 3_000 });
  const items = agents.data ?? [];
  const searchTerm = agentSearch.trim().toLowerCase();
  const visibleItems = items.filter((agent) =>
    `${agent.name} ${agent.description} ${agent.provider} ${agent.model}`.toLowerCase().includes(searchTerm),
  );
  const selected = items.find((item) => item.id === selectedID) ?? items[0];
  const createForm = useForm<AgentInput>({ initialValues: blankProfile, validate: validateInput });
  const editForm = useForm<AgentInput>({ initialValues: blankProfile, validate: validateInput });
  const runForm = useForm<{ prompt: string }>({ initialValues: { prompt: '' }, validate: (values) => {
    const result = z.string().trim().min(1, 'Add a task prompt').max(5000).safeParse(values.prompt);
    return result.success ? {} : { prompt: result.error.issues[0].message };
  } });

  function resetEditForm() {
    if (!selected) return;
    editForm.setValues({
      name: selected.name, description: selected.description, provider: selected.provider, model: selected.model,
      status: selected.status, system_prompt: selected.system_prompt, goal_prompt: selected.goal_prompt,
      tools: selected.tools,
    });
  }
  useEffect(() => {
    if (!selected) return;
    resetEditForm();
    setIsEditing(false);
  }, [selected?.id, selected?.version]);

  const createAgent = useMutation({
    mutationFn: async (input: AgentInput) => {
      const response = await fetch('/api/v1/agents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(await response.text());
      return agentSchema.parse(await response.json());
    },
    onSuccess: async (item) => {
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
      setSelectedID(item.id);
      createForm.reset();
      setSubmitError('');
      setCreateOpen(false);
    },
    onError: (error) => setSubmitError(error.message),
  });
  const updateAgent = useMutation({
    mutationFn: async (input: AgentInput & { id: string }) => {
      const { id, ...profile } = input;
      const response = await fetch(`/api/v1/agents/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile),
      });
      if (!response.ok) throw new Error(await response.text());
      return agentSchema.parse(await response.json());
    },
    onSuccess: async (item) => {
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
      setSelectedID(item.id);
      setSubmitError('');
      setIsEditing(false);
    },
    onError: (error) => setSubmitError(error.message),
  });
  const queueRun = useMutation({
    mutationFn: async (input: RunInput & { agent_id: string }) => {
      const response = await fetch('/api/v1/agent-runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(await response.text());
      return agentRunSchema.parse(await response.json());
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['agent-runs'] });
      runForm.reset();
      setRunOpen(false);
    },
  });
  const activeCount = items.filter((item) => item.status === 'active').length;
  const onlineProjects = projects.filter((project) => project.worker_status === 'online');
  const workersByID = new Map(workers.map((worker) => [worker.id, worker]));
  const runProjectOptions = onlineProjects.map((project) => {
    const worker = workersByID.get(project.worker_id);
    const runtime = worker?.agent_runtime_enabled === true ? 'runtime configured'
      : worker?.agent_runtime_enabled === false ? 'runtime not configured' : 'runtime status unknown';
    return { value: project.id, label: `${project.name} · ${worker?.name ?? project.worker_name} · ${runtime}` };
  });
  const selectedRunProject = onlineProjects.find((project) => project.id === runProjectID);
  const selectedRunWorker = selectedRunProject ? workersByID.get(selectedRunProject.worker_id) : undefined;
  const totalValue = agents.isLoading ? 'Loading…' : agents.isError ? 'Unavailable' : items.length;
  const activeValue = agents.isLoading ? 'Loading…' : agents.isError ? 'Unavailable' : activeCount;
  const runs30d = runs.data ? runsInLast30Days(runs.data) : [];
  const finishedRuns = runs30d.filter((run) => run.status === 'succeeded' || run.status === 'failed');
  const successRate = finishedRuns.length ? `${Math.round(finishedRuns.filter((run) => run.status === 'succeeded').length / finishedRuns.length * 100)}%` : 'Unavailable';
  const selectedRuns = runs.data?.filter((run) => run.agent_id === selected?.id) ?? [];
  const selectedRuns30d = runsInLast30Days(selectedRuns);
  const selectedFinishedRuns = selectedRuns30d.filter((run) => run.status === 'succeeded' || run.status === 'failed');
  const selectedSuccessRate = selectedFinishedRuns.length
    ? `${Math.round(selectedFinishedRuns.filter((run) => run.status === 'succeeded').length / selectedFinishedRuns.length * 100)}%`
    : 'Unavailable';

  return <div className="agents-page">
    <div className="agents-title-row">
      <div className="agents-title-heading"><span className="agents-title-icon"><IconRobot size={22} /></span>
        <PageHeading title="Agents" description="Manage AI agents, profiles, prompts, tools, and governance." /></div>
      <Button className="agents-create-button" leftSection={<IconPlus size={15} />} onClick={() => {
        setSubmitError(''); createForm.reset(); setCreateOpen(true);
      }}>Create Agent</Button>
    </div>
    <section className="agents-metrics" aria-label="Agent profile metrics">
      <MetricCard className="agents-metric purple" label="Total agents" value={totalValue} detail="Saved profiles" icon={<IconRobot size={18} />} />
      <MetricCard className="agents-metric blue" label="Active agents" value={activeValue} detail="Enabled profiles" icon={<IconActivity size={18} />} />
      <MetricCard className="agents-metric" label="Total runs (30d)" value={runs.isLoading ? 'Loading…' : runs.isError ? 'Unavailable' : runs30d.length} detail="Recorded runs" icon={<IconSparkles size={18} />} />
      <MetricCard className="agents-metric green" label="Success rate"
        value={runs.isLoading ? 'Loading…' : runs.isError ? 'Unavailable' : successRate}
        detail="Completed runs · last 30d" icon={<IconShieldCheck size={18} />} />
      <MetricCard className="agents-metric" label="Model cost (30d)" value="Unavailable" detail="Provider usage records are unavailable" icon={<IconCpu size={18} />} />
    </section>
    <div className="agents-content-grid">
      <PanelCard className="agents-list-panel" withBorder>
        <PanelHeading className="agents-panel-heading" title="Agent Profiles" description="Reusable role and permission definitions"
          actions={<><TextInput className="agents-profile-search" aria-label="Search agents" leftSection={<IconSearch size={13} />}
            placeholder="Search agents…" value={agentSearch} onChange={(event) => setAgentSearch(event.currentTarget.value)} />
          <Badge className="agents-count" variant="light">{items.length}</Badge></>} />
        {agents.isError ? <div className="agents-empty">Agent profiles could not be loaded.</div> : agents.isLoading ? (
          <div className="agents-empty">Loading agent profiles…</div>
        ) : items.length && visibleItems.length ? (
          <div className="agents-list">
            {visibleItems.map((agent) => {
              const profileRuns = runs.data?.filter((run) => run.agent_id === agent.id) ?? [];
              const completedRuns = profileRuns.filter((run) => run.status === 'succeeded' || run.status === 'failed');
              const successCount = completedRuns.filter((run) => run.status === 'succeeded').length;
              const latestRun = profileRuns.reduce<AgentRun | undefined>((latest, run) =>
                !latest || Date.parse(run.updated_at) > Date.parse(latest.updated_at) ? run : latest, undefined);
              const successRate = completedRuns.length
                ? Math.round(successCount / completedRuns.length * 100)
                : undefined;
              return <button
                className={`agent-row${selected?.id === agent.id ? ' selected' : ''}`}
                key={agent.id}
                onClick={() => { setSelectedID(agent.id); setSubmitError(''); }}
              >
                <span className="agent-row-icon"><IconRobot size={17} /></span>
                <span className="agent-row-body">
                  <b>{agent.name}</b><small>{agent.description || 'No description'}</small>
                  <small>{agent.provider} · {agent.model}</small>
                  <small>
                    {runs.isLoading ? 'Run history loading' : runs.isError ? 'Run history unavailable'
                      : latestRun ? `Last run ${relativeRunTime(latestRun.updated_at)}` : 'No runs yet'}
                    {successRate !== undefined && ` · ${completedRuns.length} completed · ${successRate}% success`}
                  </small>
                  <AgentToolBadges tools={agent.tools} limit={3} />
                </span>
                <Badge className={`agent-status ${agent.status}`} variant="light">{agent.status}</Badge>
              </button>;
            })}
          </div>
        ) : items.length ? <div className="agents-empty"><b>No profiles match this search.</b></div>
          : <div className="agents-empty"><IconRobot size={25} /><b>No agent profiles yet</b>
          <span>Create a profile to define its prompts and approved tools.</span>
          <Button className="agents-create-button" onClick={() => setCreateOpen(true)}>Create first agent</Button></div>}
      </PanelCard>
      <PanelCard className="agents-detail-panel" withBorder>
        {selected ? <>
          <PanelHeading className="agents-detail-heading entity-detail-heading" title={selected.name}
            description={selected.description || 'Agent profile'}
            icon={<span className="agent-detail-icon"><IconRobot size={20} /></span>}
            actions={<div className="agents-detail-actions"><Badge className={`agent-status ${selected.status}`} variant="light">{selected.status}</Badge>
              {isEditing ? <Button variant="default" onClick={() => { resetEditForm(); setIsEditing(false); }}>Cancel</Button>
                : <Button variant="default" onClick={() => setIsEditing(true)}>Edit profile</Button>}
              <Button variant="default" disabled={updateAgent.isPending} onClick={() => updateAgent.mutate({
                ...inputSchema.parse({ ...selected, status: selected.status === 'active' ? 'disabled' : 'active' }),
                id: selected.id,
              })}>{selected.status === 'active' ? 'Disable profile' : 'Enable profile'}</Button>
              <Button className="agents-run-button" disabled={selected.status !== 'active'} onClick={() => {
                queueRun.reset();
                setRunProjectID(onlineProjects[0]?.id ?? '');
                runForm.reset();
                setRunOpen(true);
              }}>Queue run</Button></div>} />
          <form onSubmit={editForm.onSubmit((values) => updateAgent.mutate({
            ...inputSchema.parse(values), id: selected.id,
          }))}>
            <Tabs defaultValue="overview" className="agents-detail-tabs">
              <Tabs.List aria-label="Agent profile sections">
                <Tabs.Tab value="overview">Overview</Tabs.Tab>
                <Tabs.Tab value="prompts">Prompts</Tabs.Tab>
                <Tabs.Tab value="tools">Tools &amp; Permissions</Tabs.Tab>
                <Tabs.Tab value="history">Run History</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="overview" pt="sm">
                <div className="agents-overview-top">
                  <PanelCard className="agents-overview-card" withBorder>
                    <PanelHeading title="Agent profile" />
                    {isEditing ? <>
                      <div className="agents-model-grid">
                        <TextInput label="Provider" {...editForm.getInputProps('provider')} />
                        <TextInput label="Model" {...editForm.getInputProps('model')} />
                      </div>
                      <div className="agents-model-grid">
                        <TextInput label="Profile name" {...editForm.getInputProps('name')} />
                        <TextInput label="Description" {...editForm.getInputProps('description')} />
                      </div>
                    </> : <div className="agents-profile-summary">
                      <div><small>Provider</small><b>{selected.provider}</b></div>
                      <div><small>Model</small><b>{selected.model}</b></div>
                      <div><small>Version</small><b>v{selected.version}</b></div>
                      <div><small>Updated</small><b>{new Date(selected.updated_at).toLocaleString()}</b></div>
                    </div>}
                  </PanelCard>
                  <PanelCard className="agents-overview-card" withBorder>
                    <PanelHeading title="Performance (30d)" />
                    <div className="agents-profile-metrics" aria-label="Selected agent performance">
                      <div><small>Runs</small><b>{runs.isLoading ? 'Loading…' : runs.isError ? 'Unavailable' : selectedRuns30d.length}</b></div>
                      <div><small>Success rate</small><b>
                        {runs.isLoading ? 'Loading…' : runs.isError ? 'Unavailable' : selectedSuccessRate}
                      </b></div>
                      <div><small>Avg latency</small><b>Unavailable</b></div>
                      <div><small>Total cost</small><b>Unavailable</b></div>
                    </div>
                  </PanelCard>
                </div>
                <div className="agents-overview-previews">
                  <PanelCard className="agents-overview-card" withBorder>
                    <PanelHeading title="System prompt" />
                    <p className="agents-prompt-preview" title={selected.system_prompt}>
                      {selected.system_prompt || 'No system prompt configured.'}
                    </p>
                  </PanelCard>
                  <PanelCard className="agents-overview-card" withBorder>
                    <PanelHeading title="Goal prompt" />
                    <p className="agents-prompt-preview" title={selected.goal_prompt}>
                      {selected.goal_prompt || 'No goal prompt configured.'}
                    </p>
                  </PanelCard>
                </div>
                <AgentExecutionOverview tools={selected.tools} />
              </Tabs.Panel>
              <Tabs.Panel value="prompts" pt="sm">
                <div className="agents-prompts-grid">
                  <AgentPromptEditor label="System prompt" value={editForm.values.system_prompt} readOnly={!isEditing}
                    onChange={(value) => editForm.setFieldValue('system_prompt', value)} />
                  <AgentPromptEditor label="Goal prompt" value={editForm.values.goal_prompt} readOnly={!isEditing}
                    onChange={(value) => editForm.setFieldValue('goal_prompt', value)} />
                </div>
              </Tabs.Panel>
              <Tabs.Panel value="tools" pt="sm">
                <div className="agents-tools-block"><div><h4>Tool permissions</h4>
                  <p>Code writes stay on the isolated run branch. Test execution is not enabled yet.</p></div>
                  <Checkbox.Group {...editForm.getInputProps('tools')}>
                    <div className="agents-tool-options">
                      {toolOptions.map((tool) => <Checkbox key={tool.value} value={tool.value} label={tool.label} disabled={!isEditing} />)}
                    </div>
                  </Checkbox.Group>
                </div>
              </Tabs.Panel>
              <Tabs.Panel value="history" pt="sm">
                {runs.isLoading ? <div className="agents-run-empty">Loading agent runs…</div>
                  : runs.isError ? <div className="agents-run-empty">Agent run history is unavailable.</div>
                    : selectedRuns.length ? <div className="agents-runs-list">
                      {selectedRuns.slice(0, 8).map((run) => <AgentRunRow run={run} key={run.id} />)}
                    </div> : <div className="agents-run-empty">No runs recorded for this profile.</div>}
              </Tabs.Panel>
            </Tabs>
            {isEditing && <div className="agents-form-status">
              {submitError && <Text className="agents-error">{submitError}</Text>}
              <Button className="agents-save-button" type="submit" loading={updateAgent.isPending}>Save profile</Button>
            </div>}
          </form>
        </> : <div className="agents-detail-empty"><IconRobot size={26} /><h3>Agent profile</h3>
          <p>Select a profile or create one to manage prompts and tool permissions.</p></div>}
      </PanelCard>
      <div className="agents-bottom-panels">
        <PanelCard className="agents-runs-panel" withBorder>
          <PanelHeading className="agents-panel-heading" title="Run history" description="Live control-plane status"
            actions={<Badge className="agents-count" variant="light">{runs.data?.length ?? 0}</Badge>} />
          {runs.isLoading ? <div className="agents-run-empty">Loading agent runs…</div> : runs.isError ? (
            <div className="agents-run-empty">Agent run history is unavailable.</div>
          ) : runs.data?.length ? <div className="agents-runs-list">
            {runs.data.slice(0, 8).map((run) => <AgentRunRow run={run} key={run.id} />)}
          </div> : <div className="agents-run-empty">No agent runs recorded. Configure an OpenAI-compatible endpoint on a worker to enable execution.</div>}
        </PanelCard>
        <AgentPerformanceTrend runs={selectedRuns30d} isLoading={runs.isLoading} isError={runs.isError} />
      </div>
    </div>
    <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Create agent profile" centered>
      <form onSubmit={createForm.onSubmit((values) => createAgent.mutate(inputSchema.parse(values)))}>
        <TextInput
          label="Profile name" placeholder="e.g. Code Reviewer" required {...createForm.getInputProps('name')}
        />
        <TextInput
          label="Description" placeholder="What this agent is responsible for"
          {...createForm.getInputProps('description')}
        />
        <div className="agents-model-grid">
          <TextInput
            label="Provider identifier" placeholder="e.g. anthropic" required
            {...createForm.getInputProps('provider')}
          />
          <TextInput
            label="Model identifier" placeholder="e.g. claude-sonnet" required
            {...createForm.getInputProps('model')}
          />
        </div>
        <Textarea label="System prompt" minRows={3} {...createForm.getInputProps('system_prompt')} />
        <Textarea label="Goal prompt" minRows={3} {...createForm.getInputProps('goal_prompt')} />
        <div className="agents-tools-block"><h4>Allowed tools</h4>
          <Checkbox.Group {...createForm.getInputProps('tools')}>
            <div className="agents-tool-options">
              {toolOptions.map((tool) => (
                <Checkbox key={tool.value} value={tool.value} label={tool.label} />
              ))}
            </div>
          </Checkbox.Group>
        </div>
        {submitError && <Text className="agents-error">{submitError}</Text>}
        <div className="agents-modal-actions">
          <Button variant="subtle" type="button" onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button className="agents-save-button" type="submit" loading={createAgent.isPending}>
            Create profile
          </Button>
        </div>
      </form>
    </Modal>
    <Modal opened={runOpen} onClose={() => setRunOpen(false)} title="Queue agent run" centered>
      <form onSubmit={runForm.onSubmit((values) => {
        const input = runInputSchema.safeParse({ project_id: runProjectID, prompt: values.prompt });
        if (selected && input.success) queueRun.mutate({ ...input.data, agent_id: selected.id });
      })}>
        <Select label="Project" data={runProjectOptions}
          value={runProjectID || null} allowDeselect={false}
          onChange={(value) => setRunProjectID(value ?? '')} />
        {!onlineProjects.length && <Text className="agents-error" role="status">No online projects are available to run on.</Text>}
        {onlineProjects.length > 0 && <Text className="agents-queue-note" role="status">
          {selectedRunWorker?.agent_runtime_enabled === true
            ? `${selectedRunWorker.name} reports an OpenAI-compatible endpoint configured. Queueing saves the run for the worker.`
            : selectedRunWorker?.agent_runtime_enabled === false
              ? `${selectedRunWorker.name} has no OpenAI-compatible endpoint configured; the run will stay queued.`
              : 'Worker runtime status is unknown; the run may stay queued until runtime availability is reported.'}
        </Text>}
        <Textarea label="Task prompt" minRows={3} maxLength={5000} {...runForm.getInputProps('prompt')} />
        {queueRun.isError && <Text className="agents-error" role="alert">{queueRun.error.message}</Text>}
        <div className="agents-modal-actions">
          <Button variant="subtle" type="button" onClick={() => setRunOpen(false)}>Cancel</Button>
          <Button className="agents-save-button" type="submit" loading={queueRun.isPending} disabled={!onlineProjects.length}>
            Queue run
          </Button>
        </div>
      </form>
    </Modal>
  </div>;
}

function AgentRunRow({ run }: { run: AgentRun }) {
  return <article className="agents-run-row">
    <span className={`agents-run-state ${run.status}`} aria-label={`Run ${run.status}`} />
    <div className="agents-run-copy"><b>{run.agent_name} · {run.project_name}</b>
      <span>{run.prompt}</span><small>Branch: {run.branch}</small>
      <small>{run.output || run.error || `Attempt ${run.attempts}`}
        {run.commit_sha && ` · commit ${run.commit_sha.slice(0, 7)}`} · {new Date(run.updated_at).toLocaleString()}
      </small></div>
    <Badge className={`agents-run-badge ${run.status}`} variant="light">{run.status}</Badge>
  </article>;
}
