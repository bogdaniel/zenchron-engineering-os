import { useEffect, useRef, useState } from 'react';
import { useForm } from '@mantine/form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CompositeChart, LineChart, Sparkline } from '@mantine/charts';
import { YAxis } from 'recharts';
import { Badge, Button, Checkbox, Menu, Modal, Select, Tabs, Text, Textarea, TextInput } from '@mantine/core';
import {
  IconActivity, IconBrandGithub, IconBook2, IconChartBar, IconCode, IconCpu, IconFlask, IconHierarchy,
  IconPlus, IconRobot, IconRocket, IconSearch, IconShieldCheck, IconSparkles, IconChevronDown, IconDots,
  IconEye, IconPlayerPlay, IconFilter, IconArrowsSort, IconCalendar, IconCurrencyDollar, IconCircleCheck,
  IconCopy, IconBan, IconGitCompare,
} from '@tabler/icons-react';
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
import { blocksQueueing, RunIssueSelect, runReadiness, type RunWorker } from './agentRunQueue';
import { runEvidenceFields } from './runEvidence';
import { AgentPromptCardActions } from './AgentPromptCardActions';
import { AgentsMobilePreview } from './AgentsMobilePreview';
import {
  agentsPreviewProfiles as previewAgents,
  agentsPreviewRuns as previewRuns,
  agentsPreviewTrend as previewPerformanceTrend,
  agentsPreviewTools as previewToolPermissions,
  agentsPreviewTags,
  agentsPreviewListMetrics,
} from './agents-preview-data';
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
}).extend(runEvidenceFields);
export const agentRunsSchema = z.array(agentRunSchema);
export const agentsSchema = z.array(agentSchema);
const previewProfileVersions = ['v2.4.1', 'v2.4.0', 'v2.3.8'];
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
  prompt: z.string().trim().max(5000),
  issue_number: z.number().int().positive().optional(),
}).refine((input) => input.prompt !== '' || input.issue_number !== undefined, { path: ['prompt'], message: 'Add a task prompt or choose an issue' });
export type Agent = z.infer<typeof agentSchema>;
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
function AgentPromptPreview({ label, value, numbered = false }: { label: string; value: string; numbered?: boolean }) {
  const prompt = value || 'No prompt configured.';
  return <div className={`agents-prompt-preview ${numbered ? 'agents-numbered-prompt' : 'agents-goal-prompt'}`}
    aria-label={label} title={value}>
    {numbered ? prompt.split('\n').map((line, index) => <span className="agents-prompt-line" key={index}>
      <i aria-hidden="true">{index + 1}</i><code>{line}</code>
    </span>) : prompt}
  </div>;
}
function AgentPreviewKpi({ change, color = '#c65bff' }: { change: string; color?: string }) {
  return <span className="agents-preview-kpi">
    <small>{change}</small>
    <svg viewBox="0 0 72 24" aria-hidden="true">
      <polyline points="1,20 12,16 22,18 34,9 45,13 56,5 71,2" fill="none" stroke={color} strokeWidth="2" />
    </svg>
  </span>;
}
function AgentProfileIcon({ name, size }: { name: string; size: number }) {
  if (name === 'Code Reviewer') return <IconCode size={size} />;
  if (name === 'Test Generator') return <IconFlask size={size} />;
  if (name === 'Planner') return <IconHierarchy size={size} />;
  if (name === 'Release Manager') return <IconRocket size={size} />;
  if (name === 'Research Analyst') return <IconSearch size={size} />;
  if (name === 'Coverage Analyzer') return <IconChartBar size={size} />;
  return <IconRobot size={size} />;
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

type Worker = RunWorker;

export function AgentsPage({ projects, workers, designPreview = false, onNavigate }: {
  projects: Project[];
  workers: Worker[];
  designPreview?: boolean;
  onNavigate: (href: string) => void;
}) {
  const queryClient = useQueryClient();
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [previewItems, setPreviewItems] = useState<Agent[]>(previewAgents);
  const [previewOwners, setPreviewOwners] = useState<Record<string, string>>({});
  const [previewVersions, setPreviewVersions] = useState<Record<string, string>>({});
  const [previewRunItems, setPreviewRunItems] = useState<AgentRun[]>(previewRuns);
  const [previewSafety, setPreviewSafety] = useState<Record<string, boolean>>({
    'Content Safety': true, 'PII/Secret Detection': true, 'Policy Compliance': true, 'Allow Code Changes': false,
  });
  const [performanceRange, setPerformanceRange] = useState<'Last 7 Days' | 'Last 30 Days'>('Last 30 Days');
  const [detailTab, setDetailTab] = useState<string | null>('overview');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const [agentSearch, setAgentSearch] = useState('');
  const [agentStatusFilter, setAgentStatusFilter] = useState<'all' | Agent['status']>('all');
  const [agentSort, setAgentSort] = useState<'default' | 'ascending' | 'descending'>('default');
  const [createOpen, setCreateOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [runProjectID, setRunProjectID] = useState('');
  const [runIssue, setRunIssue] = useState<number | null>(null);
  const [submitError, setSubmitError] = useState('');
  const [previewNotice, setPreviewNotice] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [mobileManagerOpen, setMobileManagerOpen] = useState(false);
  const agents = useQuery({ queryKey: ['agents'], queryFn: loadAgents, enabled: !designPreview });
  const runs = useQuery({
    queryKey: ['agent-runs'], queryFn: loadAgentRuns, refetchInterval: 3_000, enabled: !designPreview,
  });
  const sampleMode = designPreview;
  const performanceTrend = performanceRange === 'Last 7 Days' ? previewPerformanceTrend.slice(-3) : previewPerformanceTrend;
  const items = sampleMode ? previewItems : agents.data ?? [];
  const runItems = sampleMode ? previewRunItems : runs.data ?? [];
  const profilesLoading = !sampleMode && agents.isLoading;
  const runsLoading = !sampleMode && runs.isLoading;
  const profilesError = !sampleMode && agents.isError;
  const runsError = !sampleMode && runs.isError;
  const searchTerm = agentSearch.trim().toLowerCase();
  const visibleItems = items.filter((agent) =>
    (agentStatusFilter === 'all' || agent.status === agentStatusFilter) &&
    `${agent.name} ${agent.description} ${agent.provider} ${agent.model}`.toLowerCase().includes(searchTerm),
  );
  if (agentSort !== 'default') visibleItems.sort((a, b) =>
    agentSort === 'ascending' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
  const selected = visibleItems.find((item) => item.id === selectedID) ?? visibleItems[0];
  const selectedPreviewVersion = selected ? previewVersions[selected.id] ?? previewProfileVersions[0] : '';
  const createForm = useForm<AgentInput>({ initialValues: blankProfile, validate: validateInput });
  const editForm = useForm<AgentInput>({ initialValues: blankProfile, validate: validateInput });
  const runForm = useForm<{ prompt: string }>({ initialValues: { prompt: '' }, validate: (values) => {
    const result = runInputSchema.safeParse({ project_id: runProjectID || '-', prompt: values.prompt, issue_number: runIssue ?? undefined });
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
  function editPreviewPrompts() {
    resetEditForm();
    setDetailTab('prompts');
    setIsEditing(true);
  }
  async function copyPreviewPrompt(prompt: string) {
    try {
      await navigator.clipboard.writeText(prompt);
      setPreviewNotice('Prompt copied to clipboard');
    } catch (error) {
      setPreviewNotice(`Could not copy prompt: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function duplicatePreviewProfile(agent: Agent) {
    const copy = agentSchema.parse({ ...agent, id: crypto.randomUUID(), name: `${agent.name} Copy`,
      version: 1, updated_at: new Date().toISOString() });
    setPreviewItems((current) => [...current, copy]);
    setSelectedID(copy.id);
    setDetailTab('overview');
  }
  function updatePreviewProfile(patch: Partial<Agent>) {
    if (!selected) return;
    setPreviewItems((current) => current.map((item) => item.id === selected.id
      ? agentSchema.parse({ ...item, ...patch }) : item));
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
      setRunIssue(null);
      setRunOpen(false);
    },
  });
  const activeCount = items.filter((item) => item.status === 'active').length;
  const onlineProjects = projects.filter((project) => project.worker_status === 'online');
  const workersByID = new Map(workers.map((worker) => [worker.id, worker]));
  const runProjectOptions = onlineProjects.map((project) => {
    const worker = workersByID.get(project.worker_id);
    const runtime = runReadiness(selected?.provider, worker).label;
    return { value: project.id, label: `${project.name} · ${worker?.name ?? project.worker_name} · ${runtime}` };
  });
  const selectedRunProject = onlineProjects.find((project) => project.id === runProjectID);
  const selectedRunWorker = selectedRunProject ? workersByID.get(selectedRunProject.worker_id) : undefined;
  const totalValue = profilesLoading ? 'Loading…' : profilesError ? 'Unavailable' : items.length;
  const activeValue = profilesLoading ? 'Loading…' : profilesError ? 'Unavailable' : activeCount;
  const runs30d = runsInLast30Days(runItems);
  const finishedRuns = runs30d.filter((run) => run.status === 'succeeded' || run.status === 'failed');
  const successRate = finishedRuns.length
    ? `${Math.round(finishedRuns.filter((run) => run.status === 'succeeded').length / finishedRuns.length * 100)}%`
    : 'Unavailable';
  const selectedRuns = runItems.filter((run) => run.agent_id === selected?.id);
  const selectedRuns30d = runsInLast30Days(selectedRuns);
  const selectedFinishedRuns = selectedRuns30d.filter((run) => run.status === 'succeeded' || run.status === 'failed');
  const selectedSuccessRate = selectedFinishedRuns.length
    ? `${Math.round(selectedFinishedRuns.filter((run) => run.status === 'succeeded').length / selectedFinishedRuns.length * 100)}%`
    : 'Unavailable';

  return <div className={`agents-page${sampleMode ? ` agents-design-preview${mobileManagerOpen ? ' mobile-manager-open' : ''}` : ''}`}>
    {sampleMode && <AgentsMobilePreview onRunAgent={() => setRunOpen(true)}
      onOpenRunHistory={() => { setMobileManagerOpen(true); setDetailTab('history'); }}
      onOpenReviews={() => onNavigate('#reviews')} />}
    {sampleMode && <Button className="agents-mobile-back agents-mobile-return" variant="default"
      onClick={() => setMobileManagerOpen(false)}>← Agents &amp; Reviews</Button>}
    <div className="agents-preview-main">
    <div className="agents-title-row">
      <div className="agents-title-heading"><span className="agents-title-icon"><IconRobot size={22} /></span>
        <PageHeading title="Agents" description={sampleMode
          ? 'Manage AI agents, profiles, prompts, tools, and governance. Define specialized agents for your engineering workflows.'
          : 'Manage AI agents, profiles, prompts, tools, and governance.'} /></div>
      {sampleMode ? <div className="agents-preview-actions">
        <Badge className="agents-preview-notice" variant="light">ILLUSTRATIVE DATA</Badge>
        <Button className="agents-create-button" leftSection={<IconPlus size={15} />}
          rightSection={<IconChevronDown size={13} />} onClick={() => { createForm.reset(); setSubmitError(''); setCreateOpen(true); }}>Create Agent</Button>
        <Button variant="default" onClick={() => setLibraryOpen(true)}>Agent Library</Button>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><Button variant="default" rightSection={<IconChevronDown size={13} />}>Import / Export</Button></Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => {
              const url = URL.createObjectURL(new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' }));
              const link = document.createElement('a');
              link.href = url; link.download = 'agents-preview.json'; link.click();
              window.setTimeout(() => URL.revokeObjectURL(url), 1000);
              setPreviewNotice('Exported illustrative profiles');
            }}>Export profiles as JSON</Menu.Item>
            <Menu.Item onClick={() => importInput.current?.click()}>Import profiles from JSON</Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <input ref={importInput} hidden type="file" accept="application/json,.json" aria-label="Import agent profiles JSON"
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
            if (!file) return;
            if (file.size > 1_000_000) { setPreviewNotice('Import failed · file exceeds 1 MB'); return; }
            try {
              const parsed = agentsSchema.safeParse(JSON.parse(await file.text()));
              if (!parsed.success) { setPreviewNotice('Import failed · invalid agent profile JSON'); return; }
              setPreviewItems(parsed.data); setSelectedID(parsed.data[0]?.id ?? null);
              setPreviewNotice(`Imported ${parsed.data.length} illustrative profiles`);
            } catch { setPreviewNotice('Import failed · invalid agent profile JSON'); }
          }} />
        {previewNotice && <Text className="agents-preview-feedback" role="status">{previewNotice}</Text>}
      </div>
        : <Button className="agents-create-button" leftSection={<IconPlus size={15} />} onClick={() => {
          setSubmitError(''); createForm.reset(); setCreateOpen(true);
        }}>Create Agent</Button>}
    </div>
    <section className="agents-metrics" aria-label="Agent profile metrics">
      <MetricCard className="agents-metric purple" label="Total Agents" value={sampleMode ? items.length : totalValue}
        detail={sampleMode ? undefined : 'Saved profiles'} trend={sampleMode && <AgentPreviewKpi change="↑ +2" />}
        icon={<IconRobot size={18} />} />
      <MetricCard className="agents-metric blue" label="Active Agents" value={sampleMode ? activeCount : activeValue}
        detail={sampleMode ? undefined : 'Enabled profiles'} trend={sampleMode && <AgentPreviewKpi change="↑ +1" color="#16cfcb" />}
        icon={<IconActivity size={18} />} />
      <MetricCard className="agents-metric" label="Total Runs (30d)"
        value={sampleMode ? '1,842' : runsLoading ? 'Loading…' : runsError ? 'Unavailable' : runs30d.length}
        detail={sampleMode ? undefined : 'Recorded runs'} trend={sampleMode && <AgentPreviewKpi change="↑ +18%" />}
        icon={<IconSparkles size={18} />} />
      <MetricCard className="agents-metric green" label="Success Rate"
        value={sampleMode ? '96.7%' : runsLoading ? 'Loading…' : runsError ? 'Unavailable' : successRate}
        detail={sampleMode ? undefined : 'Completed runs · last 30d'}
        trend={sampleMode && <AgentPreviewKpi change="↑ +1.9pp" color="#10dba0" />}
        icon={<IconShieldCheck size={18} />} />
      <MetricCard className="agents-metric" label="Total Cost (30d)"
        value={sampleMode ? '$412.36' : 'Unavailable'}
        detail={sampleMode ? undefined : 'Provider usage records are unavailable'}
        trend={sampleMode && <AgentPreviewKpi change="↓ -12%" />} icon={<IconCpu size={18} />} />
    </section>
    <div className="agents-content-grid">
      <PanelCard className="agents-list-panel" withBorder>
        <PanelHeading className="agents-panel-heading" title={sampleMode ? `Agent Profiles (${visibleItems.length})` : 'Agent Profiles'} description={sampleMode ? undefined : 'Reusable role and permission definitions'}
          actions={<><TextInput className="agents-profile-search" aria-label="Search agents" leftSection={<IconSearch size={13} />}
            placeholder="Search agents…" value={agentSearch} onChange={(event) => setAgentSearch(event.currentTarget.value)} />
          {sampleMode && <>
            <Menu position="bottom-end" withinPortal>
              <Menu.Target><Button className="agents-list-tool" variant="default" aria-label="Filter agents"><IconFilter size={13} /></Button></Menu.Target>
              <Menu.Dropdown aria-label="Filter agents">
                <Menu.Item onClick={() => setAgentStatusFilter('all')}>All profiles</Menu.Item>
                <Menu.Item onClick={() => setAgentStatusFilter('active')}>Active only</Menu.Item>
                <Menu.Item onClick={() => setAgentStatusFilter('disabled')}>Disabled only</Menu.Item>
              </Menu.Dropdown>
            </Menu>
            <Menu position="bottom-end" withinPortal>
              <Menu.Target><Button className="agents-list-tool" variant="default" aria-label="Sort agents"><IconArrowsSort size={13} /></Button></Menu.Target>
              <Menu.Dropdown aria-label="Sort agents">
                <Menu.Item onClick={() => setAgentSort('default')}>Default order</Menu.Item>
                <Menu.Item onClick={() => setAgentSort('ascending')}>Name A–Z</Menu.Item>
                <Menu.Item onClick={() => setAgentSort('descending')}>Name Z–A</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </>}
          {!sampleMode && <Badge className="agents-count" variant="light">{visibleItems.length}</Badge>}</>} />
        {profilesError ? <div className="agents-empty">Agent profiles could not be loaded.</div> : profilesLoading ? (
          <div className="agents-empty">Loading agent profiles…</div>
        ) : items.length && visibleItems.length ? (
          <div className="agents-list">
            {visibleItems.map((agent) => {
              const profileRuns = runItems.filter((run) => run.agent_id === agent.id);
              const completedRuns = profileRuns.filter((run) => run.status === 'succeeded' || run.status === 'failed');
              const successCount = completedRuns.filter((run) => run.status === 'succeeded').length;
              const latestRun = profileRuns.reduce<AgentRun | undefined>((latest, run) =>
                !latest || Date.parse(run.updated_at) > Date.parse(latest.updated_at) ? run : latest, undefined);
              const successRate = completedRuns.length
                ? Math.round(successCount / completedRuns.length * 100)
                : undefined;
              const previewStatus = sampleMode && agent.id === 'preview-research-analyst' && agent.status === 'disabled'
                ? 'idle' : agent.status;
              return <div className={`agent-row${selected?.id === agent.id ? ' selected' : ''}${sampleMode ? ' has-options' : ''}`}
                key={agent.id}>
                <button className="agent-row-select" type="button"
                  onClick={() => { setSelectedID(agent.id); setSubmitError(''); setDetailTab('overview'); }}>
                  <span className="agent-row-icon"><AgentProfileIcon name={agent.name} size={17} /></span>
                  <span className="agent-row-body">
                    <b>{agent.name}</b><small>{agent.description || 'No description'}</small>
                    {sampleMode ? <>
                      <small className="agent-preview-provider">{agent.model} · {agent.provider}</small>
                      <span className="agent-preview-meta">
                        <small><IconCalendar size={11} />{agentsPreviewListMetrics[agent.id]?.lastRun ?? 'No runs yet'}</small>
                        <small><IconCurrencyDollar size={11} />Cost: {agentsPreviewListMetrics[agent.id]?.cost ?? '—'}</small>
                        <small><IconCircleCheck size={11} />Success: {agentsPreviewListMetrics[agent.id]?.success ?? '—'}</small>
                      </span>
                    </> : <>
                      <small>{agent.provider} · {agent.model}</small>
                      <small>{runsLoading ? 'Run history loading' : runsError ? 'Run history unavailable'
                        : latestRun ? `Last run ${relativeRunTime(latestRun.updated_at)}` : 'No runs yet'}</small>
                      <small>{successRate !== undefined ? `${completedRuns.length} completed · ${successRate}% success` : ''}</small>
                    </>}
                    <AgentToolBadges tools={sampleMode ? agentsPreviewTags[agent.id] ?? agent.tools : agent.tools} limit={3} />
                  </span>
                  {!sampleMode && <Badge className={`agent-status ${previewStatus}`} variant="light">{previewStatus}</Badge>}
                </button>
                {sampleMode && <>
                  <Badge className={`agent-status ${previewStatus}`} variant="light">{previewStatus}</Badge>
                  <Menu position="bottom-end" withinPortal>
                  <Menu.Target><button className="agent-row-options" type="button" aria-label={`${agent.name} options`}>
                    <IconDots size={15} />
                  </button></Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item onClick={() => { setSelectedID(agent.id); setDetailTab('overview'); }}>Open profile</Menu.Item>
                    <Menu.Item onClick={() => duplicatePreviewProfile(agent)}>Duplicate profile</Menu.Item>
                  </Menu.Dropdown>
                  </Menu>
                </>}
              </div>;
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
            icon={<span className="agent-detail-icon"><AgentProfileIcon name={selected.name} size={20} /></span>}
            actions={<div className="agents-detail-actions"><Badge className={`agent-status ${selected.status}`} variant="light">{selected.status}</Badge>
              {sampleMode && <>
                <Button className="agents-run-button" disabled={selected.status !== 'active'} leftSection={<IconPlayerPlay size={13} />}
                  onClick={() => {
                    const now = new Date().toISOString();
                    setPreviewRunItems((current) => [{
                      id: crypto.randomUUID(), agent_id: selected.id, agent_name: selected.name, project_id: 'preview-project',
                      project_name: 'Illustrative project', worker_id: 'preview-worker', worker_name: 'Preview worker',
                      branch: 'preview/simulated-run', prompt: 'SIMULATED · local preview run', output: 'Illustrative run only.',
                      status: 'succeeded', attempts: 1, created_at: now, updated_at: now, diff_available: false,
                      diff_attempt: 0, diff_truncated: false, pull_request_enabled: false, can_request_changes: false,
                      cancel_requested: false, review_comments: [],
                    }, ...current]);
                    setDetailTab('history');
                  }}>Run Agent</Button>
                <Button variant="default" leftSection={<IconCopy size={13} />} onClick={() => duplicatePreviewProfile(selected)}>Duplicate Profile</Button>
                <Button variant="default" onClick={() => setPreviewItems((current) => current.map((item) =>
                  item.id === selected.id ? { ...item, status: item.status === 'active' ? 'disabled' : 'active' } : item))}>
                  {selected.status === 'active' ? <IconBan size={13} /> : <IconCircleCheck size={13} />}
                  {selected.status === 'active' ? 'Disable' : 'Enable'}
                </Button>
                <Button variant="default" leftSection={<IconGitCompare size={13} />} onClick={() => setDetailTab('versions')}>Compare Versions</Button>
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target><Button variant="default" aria-label="More agent actions"><IconDots size={15} /></Button></Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item onClick={() => setDetailTab('history')}>Open run history</Menu.Item>
                    <Menu.Item onClick={() => setDetailTab('versions')}>Compare versions</Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </>}
              {sampleMode ? null : <>
              {isEditing ? <Button variant="default" onClick={() => { resetEditForm(); setIsEditing(false); }}>Cancel</Button>
                : <Button variant="default" onClick={() => setIsEditing(true)}>Edit profile</Button>}
              <Button variant="default" disabled={updateAgent.isPending} onClick={() => updateAgent.mutate({
                ...inputSchema.parse({ ...selected, status: selected.status === 'active' ? 'disabled' : 'active' }),
                id: selected.id,
              })}>{selected.status === 'active' ? 'Disable profile' : 'Enable profile'}</Button>
              <Button className="agents-run-button" disabled={selected.status !== 'active'} onClick={() => {
                queueRun.reset();
                setRunProjectID(onlineProjects[0]?.id ?? '');
                // An issue chosen before the dialog was last closed belongs to that project's list.
                setRunIssue(null);
                runForm.reset();
                setRunOpen(true);
              }}>Queue run</Button></>}</div>} />
          <form onSubmit={editForm.onSubmit((values) => {
            const profile = inputSchema.parse(values);
            if (sampleMode) {
              const updated = agentSchema.parse({ ...selected, ...profile, version: selected.version + 1, updated_at: new Date().toISOString() });
              setPreviewItems((current) => current.map((item) => item.id === selected.id ? updated : item));
              setPreviewNotice(`${selected.name} saved in this preview only`);
              setIsEditing(false);
              setDetailTab('overview');
            } else updateAgent.mutate({ ...profile, id: selected.id });
          })}>
            <Tabs value={detailTab} onChange={setDetailTab} className="agents-detail-tabs">
              <Tabs.List aria-label="Agent profile sections">
                <Tabs.Tab value="overview">Overview</Tabs.Tab>
                <Tabs.Tab value="prompts">Prompts</Tabs.Tab>
                {sampleMode && <Tabs.Tab value="variables">Variables &amp; Templates</Tabs.Tab>}
                <Tabs.Tab value="tools">Tools &amp; Permissions</Tabs.Tab>
                {sampleMode && <Tabs.Tab value="safety">Safety &amp; Governance</Tabs.Tab>}
                <Tabs.Tab value="history">Run History</Tabs.Tab>
                {sampleMode && <Tabs.Tab value="versions">Versions</Tabs.Tab>}
              </Tabs.List>
              <Tabs.Panel value="overview" pt={sampleMode ? 10 : 'sm'}>
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
                    </> : <div className={`agents-profile-summary${sampleMode ? ' agents-preview-profile-fields' : ''}`}>
                      {sampleMode ? <>
                        <div><small>Model / Provider</small><Select aria-label="Model / Provider"
                          data={previewAgents.map((agent) => ({ value: agent.id, label: `${agent.model} · ${agent.provider}` }))}
                          value={previewAgents.find((agent) => agent.model === selected.model && agent.provider === selected.provider)?.id ?? selected.id}
                          onChange={(id) => {
                            const agent = previewAgents.find((candidate) => candidate.id === id);
                            if (agent) updatePreviewProfile({ model: agent.model, provider: agent.provider });
                          }} /></div>
                        <div><small>Version</small><Select aria-label="Version" data={previewProfileVersions}
                          value={selectedPreviewVersion} onChange={(version) => version && setPreviewVersions((current) => ({
                            ...current, [selected.id]: version,
                          }))} /></div>
                        <div><small>Status</small><Select aria-label="Profile status"
                          data={[{ value: 'active', label: 'Active' }, { value: 'disabled', label: 'Disabled' }]}
                          value={selected.status} onChange={(status) => {
                            if (status === 'active' || status === 'disabled') updatePreviewProfile({ status });
                          }} /></div>
                        <div><small>Owner</small><Select aria-label="Profile owner"
                          data={['Platform Engineering', 'AI Platform']} value={previewOwners[selected.id] ?? 'Platform Engineering'}
                          onChange={(owner) => owner && setPreviewOwners((current) => ({ ...current, [selected.id]: owner }))} /></div>
                        <div><small>Created</small><b>Jan 12, 2025</b></div>
                        <div><small>Last Updated</small><b>Jan 26, 2025, 10:24 AM</b></div>
                      </> : <>
                        <div><small>Provider</small><b>{selected.provider}</b></div>
                        <div><small>Model</small><b>{selected.model}</b></div>
                        <div><small>Version</small><b>v{selected.version}</b></div>
                        <div><small>Updated</small><b>{new Date(selected.updated_at).toLocaleString()}</b></div>
                      </>}
                    </div>}
                  </PanelCard>
                  <PanelCard className="agents-overview-card" withBorder>
                    <PanelHeading title="Performance (30d)" actions={sampleMode && <button type="button" className="agents-preview-link"
                      onClick={() => setDetailTab('history')}>View Details →</button>} />
                    <div className="agents-profile-metrics" aria-label="Selected agent performance">
                      <div><small>Runs</small><b>{sampleMode ? '482' : runsLoading ? 'Loading…' : runsError ? 'Unavailable' : selectedRuns30d.length}</b>
                        {sampleMode && <i>↑ +21%</i>}</div>
                      <div><small>Success rate</small><b>
                        {sampleMode ? '98.4%' : runsLoading ? 'Loading…' : runsError ? 'Unavailable' : selectedSuccessRate}
                      </b>{sampleMode && <i>↑ +1.6pp</i>}</div>
                      <div><small>Avg latency</small><b>{sampleMode ? '8.7s' : 'Unavailable'}</b>
                        {sampleMode && <i>↓ -18%</i>}</div>
                      <div><small>Total cost</small><b>{sampleMode ? '$203.86' : 'Unavailable'}</b>
                        {sampleMode && <i>↓ -14%</i>}</div>
                    </div>
                    {sampleMode && <Sparkline className="agents-profile-sparkline" role="img"
                      aria-label="Illustrative performance trend" data={previewPerformanceTrend.map(({ success }) => success - 90)}
                      color="violet.5" h={26} fillOpacity={0.14} withGradient={false} />}
                  </PanelCard>
                </div>
                <div className="agents-overview-previews">
                  <PanelCard className="agents-overview-card" withBorder>
                    <PanelHeading title="System Prompt" actions={sampleMode && <AgentPromptCardActions label="System Prompt"
                      onEdit={editPreviewPrompts} onCopy={() => { void copyPreviewPrompt(selected.system_prompt); }} />} />
                    {sampleMode ? <AgentPromptPreview label="System prompt preview" value={selected.system_prompt} numbered />
                      : <p className="agents-prompt-preview" title={selected.system_prompt}>
                        {selected.system_prompt || 'No system prompt configured.'}
                      </p>}
                  </PanelCard>
                  <PanelCard className="agents-overview-card" withBorder>
                    <PanelHeading title="Goal Prompt" actions={sampleMode && <AgentPromptCardActions label="Goal Prompt"
                      onEdit={editPreviewPrompts} onCopy={() => { void copyPreviewPrompt(selected.goal_prompt); }} />} />
                    {sampleMode ? <AgentPromptPreview label="Goal prompt preview" value={selected.goal_prompt} />
                      : <p className="agents-prompt-preview" title={selected.goal_prompt}>
                        {selected.goal_prompt || 'No goal prompt configured.'}
                      </p>}
                  </PanelCard>
                </div>
                {sampleMode ? <div className="agents-preview-overview-grid">
                  <PanelCard className="agents-overview-card" withBorder><PanelHeading title="Variables & Templates" actions={<button type="button" className="agents-preview-link"
                    onClick={() => setDetailTab('variables')}>Manage →</button>} />
                    <div className="agents-preview-variable"><code>{'{ repo_url }'}</code><span>Git repository URL or PR link</span></div>
                    <div className="agents-preview-variable"><code>{'{ diff }'}</code><span>Code diff or change set</span></div>
                    <div className="agents-preview-variable"><code>{'{ standards }'}</code><span>Engineering standards</span></div>
                    <div className="agents-preview-template">Templates <Badge variant="light">Default Review</Badge></div>
                  </PanelCard>
                  <PanelCard className="agents-overview-card" withBorder><PanelHeading title="Tool Permissions" actions={<button type="button" className="agents-preview-link"
                    onClick={() => { resetEditForm(); setIsEditing(true); setDetailTab('tools'); }}>Edit →</button>} />
                    <div className="agents-preview-permissions">{previewToolPermissions.map(({ label, icon }, index) => <div key={label}><span>{icon}{label}</span><i className={index < 4 ? 'enabled' : ''} /></div>)}</div>
                  </PanelCard>
                  <PanelCard className="agents-overview-card" withBorder><PanelHeading title="Safety & Governance" actions={<button type="button" className="agents-preview-link"
                    onClick={() => setDetailTab('safety')}>Edit →</button>} />
                    <div className="agents-preview-safety">{['Content Safety', 'PII/Secret Detection', 'Policy Compliance'].map((label) => <div key={label}><span><IconShieldCheck size={12} />{label}</span><Badge className="agents-permission-enabled" variant="light">{previewSafety[label] ? 'Enabled' : 'Disabled'}</Badge></div>)}<div><span><IconEye size={12} />Allow Code Changes</span><Badge variant="light">{previewSafety['Allow Code Changes'] ? 'Allowed' : 'Restricted'}</Badge></div><div><span><IconActivity size={12} />Data Retention</span><b>30 days</b></div></div>
                  </PanelCard>
                </div> : <AgentExecutionOverview tools={selected.tools} />}
                {sampleMode && <div className="agents-preview-bottom">
                  <PanelCard className="agents-overview-card" withBorder><PanelHeading title="Run History (Recent)" actions={<button type="button" className="agents-preview-link"
                    onClick={() => setDetailTab('history')}>View All Runs →</button>} />
                    <div className="agents-preview-run-table-wrap" role="region"
                      aria-label="Recent illustrative agent runs" tabIndex={0}>
                      <table className="agents-preview-run-table">
                        <thead><tr>
                          <th>Run ID</th><th>Trigger</th><th>Input</th><th>Status</th><th>Duration</th><th>Cost</th><th>Time</th>
                        </tr></thead>
                        <tbody>
                          <tr>
                            <td>PR #4827</td><td>PR Review</td><td>feat/auth-improvements</td><td><b>Success</b></td>
                            <td>7.9s</td><td>$0.42</td><td>2m ago</td>
                          </tr>
                          <tr>
                            <td>PR #4819</td><td>PR Review</td><td>fix/rate-limit-edgecase</td><td><b>Success</b></td>
                            <td>8.4s</td><td>$0.39</td><td>18m ago</td>
                          </tr>
                          <tr>
                            <td>PR #4812</td><td>Scheduled</td><td>main (daily)</td><td><b>Success</b></td>
                            <td>9.1s</td><td>$0.41</td><td>1h ago</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </PanelCard>
                  <PanelCard className="agents-overview-card agents-preview-trend" withBorder><PanelHeading title="Performance Trends" actions={<Menu withinPortal position="bottom-end">
                    <Menu.Target><Button className="agents-preview-period" variant="default" aria-label="Performance trend range">{performanceRange}<IconChevronDown size={10} /></Button></Menu.Target>
                    <Menu.Dropdown><Menu.Item onClick={() => setPerformanceRange('Last 7 Days')}>Last 7 Days</Menu.Item>
                      <Menu.Item onClick={() => setPerformanceRange('Last 30 Days')}>Last 30 Days</Menu.Item></Menu.Dropdown>
                  </Menu>} />
                    <div className="agents-preview-chart-legend"><span><i className="success" />Success Rate</span><span><i className="cost" />Cost (USD)</span><span><i className="latency" />Latency (s)</span></div>
                    <CompositeChart h={72} data={performanceTrend} dataKey="date" series={[
                      { name: 'success', type: 'line', color: 'teal.4', label: 'Success Rate' },
                      { name: 'cost', type: 'line', color: 'violet.5', label: 'Cost (USD)', yAxisId: 'right' },
                      { name: 'latency', type: 'line', color: 'blue.4', label: 'Latency (s)', yAxisId: 'latency' },
                    ]} withRightYAxis
                      yAxisProps={{ domain: [90, 100], ticks: [90, 92, 94, 96, 98, 100],
                        tick: { fill: '#9691a8', fontSize: 7 }, tickFormatter: (value) => `${value}%`, interval: 0, width: 24 }}
                      rightYAxisProps={{ domain: [0.4, 1.2], ticks: [0.4, 0.6, 0.8, 1, 1.2],
                        tick: { fill: '#9691a8', fontSize: 7 }, tickFormatter: (value) => `$${Number(value).toFixed(1)}`, interval: 0, width: 31 }}
                      xAxisProps={{ tick: { fill: '#9691a8', fontSize: 7 }, interval: 3 }} gridAxis="xy" withDots
                      aria-label={`Mock agent success, cost, and latency trends · ${performanceRange}`}>
                      <YAxis yAxisId="latency" orientation="right" domain={[0.8, 1.9]} hide />
                    </CompositeChart>
                  </PanelCard>
                </div>}
              </Tabs.Panel>
              <Tabs.Panel value="prompts" pt="sm">
                <div className="agents-prompts-grid">
                  <AgentPromptEditor label="System prompt" value={editForm.values.system_prompt} readOnly={!isEditing}
                    onChange={(value) => editForm.setFieldValue('system_prompt', value)} />
                  <AgentPromptEditor label="Goal prompt" value={editForm.values.goal_prompt} readOnly={!isEditing}
                    onChange={(value) => editForm.setFieldValue('goal_prompt', value)} />
                </div>
              </Tabs.Panel>
              {sampleMode && <Tabs.Panel value="variables" pt="sm"><div className="agents-preview-variable-panel"><h4>Variables available to this profile</h4><p>Values are supplied by workflow or repository context for each run.</p><code>{'{ repo_url }'}</code><code>{'{ diff }'}</code><code>{'{ standards }'}</code></div></Tabs.Panel>}
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
              {sampleMode && <Tabs.Panel value="safety" pt="sm"><div className="agents-preview-variable-panel"><h4>Safety &amp; Governance</h4><p>Changes apply to this preview only.</p>{Object.entries(previewSafety).map(([label, checked]) => <Checkbox key={label} label={label} checked={checked}
                onChange={(event) => setPreviewSafety((current) => ({ ...current, [label]: event.currentTarget.checked }))} />)}</div></Tabs.Panel>}
              <Tabs.Panel value="history" pt="sm">
                {sampleMode && <div className="agents-preview-variable-panel">Illustrative local preview · simulated runs are not submitted.</div>}
                {runsLoading ? <div className="agents-run-empty">Loading agent runs…</div>
                  : runsError ? <div className="agents-run-empty">Agent run history is unavailable.</div>
                    : selectedRuns.length ? <div className="agents-runs-list">
                      {selectedRuns.slice(0, 8).map((run) => <AgentRunRow run={run} key={run.id} />)}
                    </div> : <div className="agents-run-empty">No runs recorded for this profile.</div>}
              </Tabs.Panel>
              {sampleMode && <Tabs.Panel value="versions" pt="sm"><div className="agents-preview-variable-panel"><h4>Profile versions</h4>{previewProfileVersions.map((version, index) => <div className="agents-preview-variable" key={version}><span>{version}{version === selectedPreviewVersion ? ' · Selected' : ''}</span><small>Updated {['Jan 26, 2025', 'Jan 20, 2025', 'Jan 12, 2025'][index]}</small></div>)}</div></Tabs.Panel>}
            </Tabs>
            {isEditing && <div className="agents-form-status">
              {submitError && <Text className="agents-error">{submitError}</Text>}
              <Button className="agents-save-button" type="submit" loading={updateAgent.isPending}>Save profile</Button>
            </div>}
          </form>
        </> : <div className="agents-detail-empty"><IconRobot size={26} /><h3>Agent profile</h3>
          <p>Select a profile or create one to manage prompts and tool permissions.</p></div>}
      </PanelCard>
      {!sampleMode && <div className="agents-bottom-panels">
        <PanelCard className="agents-runs-panel" withBorder>
          <PanelHeading className="agents-panel-heading" title="Run history" description="Live control-plane status"
            actions={<Badge className="agents-count" variant="light">{runs.data?.length ?? 0}</Badge>} />
          {runsLoading ? <div className="agents-run-empty">Loading agent runs…</div> : runsError ? (
            <div className="agents-run-empty">Agent run history is unavailable.</div>
          ) : runItems.length ? <div className="agents-runs-list">
            {runItems.slice(0, 8).map((run) => <AgentRunRow run={run} key={run.id} />)}
          </div> : <div className="agents-run-empty">No agent runs recorded. Configure an OpenAI-compatible endpoint on a worker to enable execution.</div>}
        </PanelCard>
        <AgentPerformanceTrend runs={selectedRuns30d} isLoading={runsLoading} isError={runsError} />
      </div>}
    </div>
    </div>
    <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Create agent profile" centered>
      <form onSubmit={createForm.onSubmit((values) => {
        const profile = inputSchema.parse(values);
        if (sampleMode) {
          const item = agentSchema.parse({ ...profile, id: crypto.randomUUID(), version: 1, updated_at: new Date().toISOString() });
          setPreviewItems((current) => [...current, item]); setSelectedID(item.id); setCreateOpen(false); createForm.reset(); setDetailTab('overview');
          setPreviewNotice('Agent profile added to this preview only');
        } else createAgent.mutate(profile);
      })}>
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
    <Modal opened={libraryOpen} onClose={() => setLibraryOpen(false)} title="Agent Library" centered size="lg">
      <div className="agents-library-list">{items.map((item) => <Button key={item.id} variant="default"
        onClick={() => { setSelectedID(item.id); setLibraryOpen(false); setDetailTab('overview'); }}>{item.name} · {item.provider} / {item.model}</Button>)}</div>
    </Modal>
    <Modal opened={runOpen} onClose={() => setRunOpen(false)} title="Queue agent run" centered>
      <form onSubmit={runForm.onSubmit((values) => {
        const input = runInputSchema.safeParse({ project_id: runProjectID, prompt: values.prompt, issue_number: runIssue ?? undefined });
        if (selected && input.success) queueRun.mutate({ ...input.data, agent_id: selected.id });
      })}>
        <Select label="Project" data={runProjectOptions}
          value={runProjectID || null} allowDeselect={false}
          onChange={(value) => { setRunProjectID(value ?? ''); setRunIssue(null); }} />
        {!onlineProjects.length && <Text className="agents-error" role="status">No online projects are available to run on.</Text>}
        {onlineProjects.length > 0 && <Text className="agents-queue-note" role="status">
          {runReadiness(selected?.provider, selectedRunWorker).note}
        </Text>}
        <RunIssueSelect projectID={runProjectID} value={runIssue} onChange={setRunIssue} />
        <Textarea label={runIssue === null ? 'Task prompt' : 'Task prompt (optional)'} minRows={3} maxLength={5000}
          {...runForm.getInputProps('prompt')} />
        {queueRun.isError && <Text className="agents-error" role="alert">{queueRun.error.message}</Text>}
        <div className="agents-modal-actions">
          <Button variant="subtle" type="button" onClick={() => setRunOpen(false)}>Cancel</Button>
          <Button className="agents-save-button" type="submit" loading={queueRun.isPending}
            disabled={!onlineProjects.length || blocksQueueing(selected?.provider, runReadiness(selected?.provider, selectedRunWorker).ready)}>
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
