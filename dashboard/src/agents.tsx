import { useEffect, useRef, useState } from 'react';
import { useForm } from '@mantine/form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CompositeChart, Sparkline } from '@mantine/charts';
import { YAxis } from 'recharts';
import { Badge, Button, Checkbox, Menu, Modal, Select, Tabs, Text, Textarea, TextInput } from '@mantine/core';
import {
  IconActivity, IconChartBar, IconCode, IconCpu, IconFlask, IconHierarchy,
  IconPlus, IconRobot, IconRocket, IconSearch, IconShieldCheck, IconSparkles, IconChevronDown, IconDots,
  IconEye, IconPlayerPlay, IconFilter, IconArrowsSort, IconCalendar, IconCurrencyDollar, IconCircleCheck,
  IconCopy, IconBan, IconGitCompare,
} from '@tabler/icons-react';
import type { Project } from './projects';
import { MetricCard } from './MetricCard';
import { PanelHeading } from './PanelHeading';
import { PanelCard } from './PanelCard';
import { PageHeading } from './PageHeading';
import { AgentPromptEditor } from './AgentPromptEditor';
import { RunIssueSelect, runReadiness, type RunWorker } from './agentRunQueue';
import { AgentPromptCardActions } from './AgentPromptCardActions';
import { AgentsMobileSummary } from './AgentsMobileSummary';
import {
  agentInputSchema, agentRunSchema, agentsSchema, blankProfile, runInputSchema, toolOptions, validateAgentInput,
  type Agent, type AgentInput, type AgentRun, type RunInput,
} from './agentsData';
import { useLiveAgents, type Choice, type Figure } from './agentsView';
import { useMockAgents } from './agents-preview-data';
import './agents.css';
import './agents-layout.css';

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
function AgentKpiChange({ change, color = '#c65bff' }: { change: string; color?: string }) {
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
function ProfileChoice({ label, choice }: { label: string; choice: Choice }) {
  return <Select aria-label={label} data={choice.options} value={choice.value} placeholder="Unavailable"
    readOnly={!choice.onChange} allowDeselect={false} onChange={(value) => { if (value) choice.onChange?.(value); }} />;
}
function PerformanceFigure({ label, figure }: { label: string; figure: Figure }) {
  return <div><small>{label}</small><b>{figure.value}</b>{figure.change && <i>{figure.change}</i>}</div>;
}
const axisTick = { fill: '#9691a8', fontSize: 7 };
const evenTicks = ([low, high]: [number, number], count: number) =>
  Array.from({ length: count }, (_, index) => Number((low + (high - low) * index / (count - 1)).toFixed(2)));
const kpiColors = { total: undefined, active: '#16cfcb', runs: undefined, success: '#10dba0', cost: undefined };

type Worker = RunWorker;

export function AgentsPage({ projects, workers, designPreview = false, onNavigate }: {
  projects: Project[];
  workers: Worker[];
  designPreview?: boolean;
  onNavigate: (href: string) => void;
}) {
  const queryClient = useQueryClient();
  const mock = useMockAgents();
  const live = useLiveAgents(!designPreview);
  const source = designPreview ? mock : live;
  const { view, items, runs: runItems } = source;
  const [selectedID, setSelectedID] = useState<string | null>(null);
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
  const [notice, setNotice] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [mobileManagerOpen, setMobileManagerOpen] = useState(false);
  const searchTerm = agentSearch.trim().toLowerCase();
  const visibleItems = items.filter((agent) =>
    (agentStatusFilter === 'all' || agent.status === agentStatusFilter) &&
    `${agent.name} ${agent.description} ${agent.provider} ${agent.model}`.toLowerCase().includes(searchTerm),
  );
  if (agentSort !== 'default') visibleItems.sort((a, b) =>
    agentSort === 'ascending' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
  const selected = visibleItems.find((item) => item.id === selectedID) ?? visibleItems[0];
  const createForm = useForm<AgentInput>({ initialValues: blankProfile, validate: validateAgentInput });
  const editForm = useForm<AgentInput>({ initialValues: blankProfile, validate: validateAgentInput });
  const runForm = useForm<{ prompt: string }>({ initialValues: { prompt: '' }, validate: (values) => {
    const result = runInputSchema.safeParse({ project_id: runProjectID || '-', prompt: values.prompt, issue_number: runIssue ?? undefined });
    return result.success ? {} : { prompt: result.error.issues[0].message };
  } });
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);

  function resetEditForm() {
    if (!selected) return;
    editForm.setValues({
      name: selected.name, description: selected.description, provider: selected.provider, model: selected.model,
      status: selected.status, system_prompt: selected.system_prompt, goal_prompt: selected.goal_prompt,
      tools: selected.tools,
    });
  }
  function editSection(tab: string) {
    resetEditForm();
    setSubmitError('');
    setDetailTab(tab);
    setIsEditing(true);
  }
  async function copyPrompt(prompt: string) {
    try {
      await navigator.clipboard.writeText(prompt);
      setNotice('Prompt copied to clipboard');
    } catch (error) {
      setNotice(`Could not copy prompt: ${message(error)}`);
    }
  }
  function openProfile(item: Agent, confirmation: string) {
    setSelectedID(item.id);
    setDetailTab('overview');
    setSubmitError('');
    setNotice(confirmation + source.savedSuffix);
  }
  function duplicateProfile(agent: Agent) {
    const copy = agentInputSchema.safeParse({ ...agent, name: `${agent.name} Copy` });
    if (!copy.success) { setNotice(`Could not duplicate ${agent.name}: ${copy.error.issues[0].message}`); return; }
    source.create(copy.data).then((item) => openProfile(item, `${item.name} created`))
      .catch((error: unknown) => setNotice(`Could not duplicate ${agent.name}: ${message(error)}`));
  }
  function toggleStatus(agent: Agent) {
    const status = agent.status === 'active' ? 'disabled' : 'active';
    source.update(agent.id, agentInputSchema.parse({ ...agent, status }))
      .then(() => setNotice(`${agent.name} ${status === 'active' ? 'enabled' : 'disabled'}${source.savedSuffix}`))
      .catch((error: unknown) => setNotice(`Could not change ${agent.name}: ${message(error)}`));
  }
  useEffect(() => {
    if (!selected) return;
    resetEditForm();
    setIsEditing(false);
  }, [selected?.id, selected?.version]);

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
      setDetailTab('history');
    },
  });
  const onlineProjects = projects.filter((project) => project.worker_status === 'online');
  const workersByID = new Map(workers.map((worker) => [worker.id, worker]));
  const runProjectOptions = onlineProjects.map((project) => {
    const worker = workersByID.get(project.worker_id);
    const runtime = runReadiness(selected?.provider, worker).label;
    return { value: project.id, label: `${project.name} · ${worker?.name ?? project.worker_name} · ${runtime}` };
  });
  const selectedRunProject = onlineProjects.find((project) => project.id === runProjectID);
  const selectedRunWorker = selectedRunProject ? workersByID.get(selectedRunProject.worker_id) : undefined;
  const selectedRuns = runItems.filter((run) => run.agent_id === selected?.id);
  /** Mock records a labelled simulated run; Live opens the queue dialog for a real worker. */
  function runAgent(agent: Agent) {
    if (source.simulateRun) {
      source.simulateRun(agent);
      setDetailTab('history');
      return;
    }
    queueRun.reset();
    setRunProjectID(onlineProjects[0]?.id ?? '');
    setRunIssue(null);
    runForm.reset();
    setRunOpen(true);
  }
  const kpi = (key: keyof typeof kpiColors) => {
    const { value, detail, change } = view.kpis[key];
    // The caption takes the trend's place, so a card is the same height whether or not a change is known.
    return { value, trend: change ? <AgentKpiChange change={change} color={kpiColors[key]} />
      : <span className="agents-preview-kpi"><small className="agents-kpi-caption" title={detail}>{detail}</small></span> };
  };
  const fields = selected && view.fields(selected);
  const performance = selected && view.performance(selected);
  const trend = selected && view.trend(selected, performanceRange === 'Last 7 Days' ? 7 : 30);
  const safety = selected ? view.safety(selected) : [];
  const recentRuns = selected ? view.recentRuns(selected) : [];

  return <div className={`agents-page agents-design-preview${mobileManagerOpen ? ' mobile-manager-open' : ''}`}>
    <AgentsMobileSummary dataLabel={view.dataLabel} summary={view.mobile}
      onRunAgent={() => { setMobileManagerOpen(true); if (selected) runAgent(selected); }}
      onOpenRunHistory={() => { setMobileManagerOpen(true); setDetailTab('history'); }}
      onOpenReviews={() => onNavigate('#reviews')} />
    <Button className="agents-mobile-back agents-mobile-return" variant="default"
      onClick={() => setMobileManagerOpen(false)}>← Agents &amp; Reviews</Button>
    <div className="agents-preview-main">
    <div className="agents-title-row">
      <div className="agents-title-heading"><span className="agents-title-icon"><IconRobot size={22} /></span>
        <PageHeading title="Agents"
          description="Manage AI agents, profiles, prompts, tools, and governance. Define specialized agents for your engineering workflows." /></div>
      <div className="agents-preview-actions">
        {view.dataLabel && <Badge className="agents-preview-notice" variant="light">{view.dataLabel}</Badge>}
        <Button className="agents-create-button" leftSection={<IconPlus size={15} />}
          rightSection={<IconChevronDown size={13} />} onClick={() => { createForm.reset(); setSubmitError(''); setCreateOpen(true); }}>Create Agent</Button>
        <Button variant="default" onClick={() => setLibraryOpen(true)}>Agent Library</Button>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><Button variant="default" rightSection={<IconChevronDown size={13} />}>Import / Export</Button></Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => {
              const url = URL.createObjectURL(new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' }));
              const link = document.createElement('a');
              link.href = url; link.download = view.exportName; link.click();
              window.setTimeout(() => URL.revokeObjectURL(url), 1000);
              setNotice(`Exported ${items.length} profiles`);
            }}>Export profiles as JSON</Menu.Item>
            <Menu.Item disabled={!source.importProfiles} onClick={() => importInput.current?.click()}
              title={source.importProfiles ? undefined : 'Importing profiles is not available from the control plane yet'}>
              Import profiles from JSON</Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <input ref={importInput} hidden type="file" accept="application/json,.json" aria-label="Import agent profiles JSON"
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
            if (!file || !source.importProfiles) return;
            if (file.size > 1_000_000) { setNotice('Import failed · file exceeds 1 MB'); return; }
            try {
              const parsed = agentsSchema.safeParse(JSON.parse(await file.text()));
              if (!parsed.success) { setNotice('Import failed · invalid agent profile JSON'); return; }
              source.importProfiles(parsed.data); setSelectedID(parsed.data[0]?.id ?? null);
              setNotice(`Imported ${parsed.data.length} profiles${source.savedSuffix}`);
            } catch { setNotice('Import failed · invalid agent profile JSON'); }
          }} />
        {(notice || source.saveError) && <Text className="agents-preview-feedback" role="status">{source.saveError || notice}</Text>}
      </div>
    </div>
    <section className="agents-metrics" aria-label="Agent profile metrics">
      <MetricCard className="agents-metric purple" label="Total Agents" {...kpi('total')} icon={<IconRobot size={18} />} />
      <MetricCard className="agents-metric blue" label="Active Agents" {...kpi('active')} icon={<IconActivity size={18} />} />
      <MetricCard className="agents-metric" label="Total Runs (30d)" {...kpi('runs')} icon={<IconSparkles size={18} />} />
      <MetricCard className="agents-metric green" label="Success Rate" {...kpi('success')} icon={<IconShieldCheck size={18} />} />
      <MetricCard className="agents-metric" label="Total Cost (30d)" {...kpi('cost')} icon={<IconCpu size={18} />} />
    </section>
    <div className="agents-content-grid">
      <PanelCard className="agents-list-panel" withBorder>
        <PanelHeading className="agents-panel-heading" title={`Agent Profiles (${visibleItems.length})`}
          actions={<><TextInput className="agents-profile-search" aria-label="Search agents" leftSection={<IconSearch size={13} />}
            placeholder="Search agents…" value={agentSearch} onChange={(event) => setAgentSearch(event.currentTarget.value)} />
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
            </Menu></>} />
        {source.profilesError ? <div className="agents-empty">Agent profiles could not be loaded.</div> : source.profilesLoading ? (
          <div className="agents-empty">Loading agent profiles…</div>
        ) : items.length && visibleItems.length ? (
          <div className="agents-list">
            {visibleItems.map((agent) => {
              const row = view.row(agent);
              return <div className={`agent-row has-options${selected?.id === agent.id ? ' selected' : ''}`} key={agent.id}>
                <button className="agent-row-select" type="button"
                  onClick={() => { setSelectedID(agent.id); setSubmitError(''); setDetailTab('overview'); }}>
                  <span className="agent-row-icon"><AgentProfileIcon name={agent.name} size={17} /></span>
                  <span className="agent-row-body">
                    <b>{agent.name}</b><small>{agent.description || 'No description'}</small>
                    <small className="agent-preview-provider">{row.provider}</small>
                    <span className="agent-preview-meta">
                      <small><IconCalendar size={11} />{row.lastRun}</small>
                      <small><IconCurrencyDollar size={11} />Cost: {row.cost}</small>
                      <small><IconCircleCheck size={11} />Success: {row.success}</small>
                    </span>
                    <AgentToolBadges tools={row.tags} limit={3} />
                  </span>
                </button>
                <Badge className={`agent-status ${row.status}`} variant="light">{row.status}</Badge>
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target><button className="agent-row-options" type="button" aria-label={`${agent.name} options`}>
                    <IconDots size={15} />
                  </button></Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item onClick={() => { setSelectedID(agent.id); setDetailTab('overview'); }}>Open profile</Menu.Item>
                    <Menu.Item onClick={() => duplicateProfile(agent)}>Duplicate profile</Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </div>;
            })}
          </div>
        ) : items.length ? <div className="agents-empty"><b>No profiles match this search.</b></div>
          : <div className="agents-empty"><IconRobot size={25} /><b>No agent profiles yet</b>
          <span>Create a profile to define its prompts and approved tools.</span>
          <Button className="agents-create-button" onClick={() => setCreateOpen(true)}>Create first agent</Button></div>}
      </PanelCard>
      <PanelCard className="agents-detail-panel" withBorder>
        {selected && fields && performance && trend ? <>
          <PanelHeading className="agents-detail-heading entity-detail-heading" title={selected.name}
            description={selected.description || 'Agent profile'}
            icon={<span className="agent-detail-icon"><AgentProfileIcon name={selected.name} size={20} /></span>}
            actions={<div className="agents-detail-actions"><Badge className={`agent-status ${selected.status}`} variant="light">{selected.status}</Badge>
              <Button className="agents-run-button" disabled={selected.status !== 'active'} leftSection={<IconPlayerPlay size={13} />}
                onClick={() => runAgent(selected)}>Run Agent</Button>
              <Button variant="default" leftSection={<IconCopy size={13} />} onClick={() => duplicateProfile(selected)}>Duplicate Profile</Button>
              <Button variant="default" disabled={source.saving} onClick={() => toggleStatus(selected)}>
                {selected.status === 'active' ? <IconBan size={13} /> : <IconCircleCheck size={13} />}
                {selected.status === 'active' ? 'Disable' : 'Enable'}
              </Button>
              <Button variant="default" leftSection={<IconGitCompare size={13} />} onClick={() => setDetailTab('versions')}>Compare Versions</Button>
              <Menu position="bottom-end" withinPortal>
                <Menu.Target><Button variant="default" aria-label="More agent actions"><IconDots size={15} /></Button></Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item onClick={() => editSection('overview')}>Edit profile</Menu.Item>
                  <Menu.Item onClick={() => setDetailTab('history')}>Open run history</Menu.Item>
                  <Menu.Item onClick={() => setDetailTab('versions')}>Compare versions</Menu.Item>
                </Menu.Dropdown>
              </Menu></div>} />
          <form onSubmit={editForm.onSubmit((values) => {
            source.update(selected.id, agentInputSchema.parse(values)).then((item) => {
              setIsEditing(false);
              openProfile(item, `${item.name} saved`);
            }).catch((error: unknown) => setSubmitError(message(error)));
          })}>
            <Tabs value={detailTab} onChange={setDetailTab} className="agents-detail-tabs">
              <Tabs.List aria-label="Agent profile sections">
                <Tabs.Tab value="overview">Overview</Tabs.Tab>
                <Tabs.Tab value="prompts">Prompts</Tabs.Tab>
                <Tabs.Tab value="variables">Variables &amp; Templates</Tabs.Tab>
                <Tabs.Tab value="tools">Tools &amp; Permissions</Tabs.Tab>
                <Tabs.Tab value="safety">Safety &amp; Governance</Tabs.Tab>
                <Tabs.Tab value="history">Run History</Tabs.Tab>
                <Tabs.Tab value="versions">Versions</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="overview" pt={10}>
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
                    </> : <div className="agents-profile-summary agents-preview-profile-fields">
                      <div><small>Model / Provider</small><ProfileChoice label="Model / Provider" choice={fields.modelProvider} /></div>
                      <div><small>Version</small><ProfileChoice label="Version" choice={fields.version} /></div>
                      <div><small>Status</small><ProfileChoice label="Profile status" choice={fields.status} /></div>
                      <div><small>Owner</small><ProfileChoice label="Profile owner" choice={fields.owner} /></div>
                      <div><small>Created</small><b>{fields.created}</b></div>
                      <div><small>Last Updated</small><b>{fields.updated}</b></div>
                    </div>}
                  </PanelCard>
                  <PanelCard className="agents-overview-card" withBorder>
                    <PanelHeading title="Performance (30d)" actions={<button type="button" className="agents-preview-link"
                      onClick={() => setDetailTab('history')}>View Details →</button>} />
                    <div className="agents-profile-metrics" aria-label="Selected agent performance">
                      <PerformanceFigure label="Runs" figure={performance.runs} />
                      <PerformanceFigure label="Success rate" figure={performance.success} />
                      <PerformanceFigure label="Avg latency" figure={performance.latency} />
                      <PerformanceFigure label="Total cost" figure={performance.cost} />
                    </div>
                    {performance.sparkline && <Sparkline className="agents-profile-sparkline" role="img"
                      aria-label={view.chartLabels.sparkline} data={performance.sparkline}
                      color="violet.5" h={26} fillOpacity={0.14} withGradient={false} />}
                  </PanelCard>
                </div>
                <div className="agents-overview-previews">
                  <PanelCard className="agents-overview-card" withBorder>
                    <PanelHeading title="System Prompt" actions={<AgentPromptCardActions label="System Prompt"
                      onEdit={() => editSection('prompts')} onCopy={() => { void copyPrompt(selected.system_prompt); }} />} />
                    <AgentPromptPreview label="System prompt preview" value={selected.system_prompt} numbered />
                  </PanelCard>
                  <PanelCard className="agents-overview-card" withBorder>
                    <PanelHeading title="Goal Prompt" actions={<AgentPromptCardActions label="Goal Prompt"
                      onEdit={() => editSection('prompts')} onCopy={() => { void copyPrompt(selected.goal_prompt); }} />} />
                    <AgentPromptPreview label="Goal prompt preview" value={selected.goal_prompt} />
                  </PanelCard>
                </div>
                <div className="agents-preview-overview-grid">
                  <PanelCard className="agents-overview-card" withBorder><PanelHeading title="Variables & Templates" actions={<button type="button" className="agents-preview-link"
                    onClick={() => setDetailTab('variables')}>Manage →</button>} />
                    {view.variables.length ? view.variables.map(({ name, description }) => <div className="agents-preview-variable" key={name}>
                      <code>{`{ ${name} }`}</code><span>{description}</span></div>)
                      : <p className="agents-card-note">{view.notes.variables}</p>}
                    <div className="agents-preview-template">Templates {view.templates.length
                      ? view.templates.map((template) => <Badge variant="light" key={template}>{template}</Badge>) : <span>None</span>}</div>
                  </PanelCard>
                  <PanelCard className="agents-overview-card" withBorder><PanelHeading title="Tool Permissions" actions={<button type="button" className="agents-preview-link"
                    onClick={() => editSection('tools')}>Edit →</button>} />
                    <div className="agents-preview-permissions">{view.toolPermissions(selected).map(({ label, icon, enabled }) =>
                      <div key={label}><span>{icon}{label}</span>
                        <i className={enabled ? 'enabled' : ''} role="img" aria-label={enabled ? 'Allowed' : 'Not granted'} /></div>)}</div>
                  </PanelCard>
                  <PanelCard className="agents-overview-card" withBorder><PanelHeading title="Safety & Governance" actions={<button type="button" className="agents-preview-link"
                    onClick={() => setDetailTab('safety')}>Edit →</button>} />
                    <div className="agents-preview-safety">{safety.map(({ label, state, tone }) => <div key={label}>
                      <span>{tone === 'enabled' ? <IconShieldCheck size={12} /> : tone === 'restricted' ? <IconEye size={12} /> : <IconActivity size={12} />}{label}</span>
                      {tone === 'plain' ? <b>{state}</b>
                        : <Badge className={tone === 'enabled' ? 'agents-permission-enabled' : undefined} variant="light">{state}</Badge>}
                    </div>)}</div>
                  </PanelCard>
                </div>
                <div className="agents-preview-bottom">
                  <PanelCard className="agents-overview-card" withBorder><PanelHeading title="Run History (Recent)" actions={<button type="button" className="agents-preview-link"
                    onClick={() => setDetailTab('history')}>View All Runs →</button>} />
                    <div className="agents-preview-run-table-wrap" role="region" aria-label="Recent agent runs" tabIndex={0}>
                      <table className="agents-preview-run-table">
                        <thead><tr>
                          <th>Run ID</th><th>Trigger</th><th>Input</th><th>Status</th><th>Duration</th><th>Cost</th><th>Time</th>
                        </tr></thead>
                        <tbody>
                          {recentRuns.map((run) => <tr key={run.id}>
                            <td>{run.label}</td><td>{run.trigger}</td><td title={run.input}>{run.input}</td>
                            <td><b className={run.status.toLowerCase()}>{run.status}</b></td>
                            <td>{run.duration}</td><td>{run.cost}</td><td>{run.time}</td>
                          </tr>)}
                          {!recentRuns.length && <tr><td colSpan={7}>
                            {source.runsLoading ? 'Loading agent runs…' : source.runsError ? 'Agent run history is unavailable.'
                              : 'No runs recorded for this profile.'}</td></tr>}
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
                    {trend.points.length ? <CompositeChart h={72} data={trend.points} dataKey="date" series={[
                      { name: 'success', type: 'line', color: 'teal.4', label: 'Success Rate' },
                      { name: 'cost', type: 'line', color: 'violet.5', label: 'Cost (USD)', yAxisId: 'right' },
                      { name: 'latency', type: 'line', color: 'blue.4', label: 'Latency (s)', yAxisId: 'latency' },
                    ]} withRightYAxis connectNulls
                      yAxisProps={{ domain: trend.successDomain, ticks: evenTicks(trend.successDomain, 6),
                        tick: axisTick, tickFormatter: (value) => `${value}%`, interval: 0, width: 24 }}
                      rightYAxisProps={{ ...(trend.costDomain && { domain: trend.costDomain, ticks: evenTicks(trend.costDomain, 5) }),
                        tick: axisTick, tickFormatter: (value) => `$${Number(value).toFixed(1)}`, interval: 0, width: 31 }}
                      xAxisProps={{ tick: axisTick, interval: trend.points.length > 6 ? 3 : 0 }} gridAxis="xy" withDots
                      aria-label={`${view.chartLabels.trend} · ${performanceRange}`}>
                      <YAxis yAxisId="latency" orientation="right" domain={trend.latencyDomain ?? ['auto', 'auto']} hide />
                    </CompositeChart> : <p className="agents-card-note">{source.runsLoading ? 'Loading performance data…'
                      : source.runsError ? 'Performance data is unavailable.'
                        : `No runs recorded for this profile in the ${performanceRange.toLowerCase()}.`}</p>}
                  </PanelCard>
                </div>
              </Tabs.Panel>
              <Tabs.Panel value="prompts" pt="sm">
                <div className="agents-prompts-grid">
                  <AgentPromptEditor label="System prompt" value={editForm.values.system_prompt} readOnly={!isEditing}
                    onChange={(value) => editForm.setFieldValue('system_prompt', value)} />
                  <AgentPromptEditor label="Goal prompt" value={editForm.values.goal_prompt} readOnly={!isEditing}
                    onChange={(value) => editForm.setFieldValue('goal_prompt', value)} />
                </div>
              </Tabs.Panel>
              <Tabs.Panel value="variables" pt="sm"><div className="agents-preview-variable-panel">
                <h4>Variables available to this profile</h4><p>{view.notes.variables}</p>
                {view.variables.map(({ name }) => <code key={name}>{`{ ${name} }`}</code>)}
              </div></Tabs.Panel>
              <Tabs.Panel value="tools" pt="sm">
                <div className="agents-tools-block"><div><h4>Tool permissions</h4>
                  <p>Code writes stay on the isolated run branch. Tests run only for profiles granted “Run tests”.</p></div>
                  <Checkbox.Group {...editForm.getInputProps('tools')}>
                    <div className="agents-tool-options">
                      {toolOptions.map((tool) => <Checkbox key={tool.value} value={tool.value} label={tool.label} disabled={!isEditing} />)}
                    </div>
                  </Checkbox.Group>
                </div>
              </Tabs.Panel>
              <Tabs.Panel value="safety" pt="sm"><div className="agents-preview-variable-panel">
                <h4>Safety &amp; Governance</h4><p>{view.notes.safety}</p>
                {safety.map(({ label, state, onToggle }) => onToggle
                  ? <Checkbox key={label} label={label} checked={state === 'Enabled' || state === 'Allowed'}
                    onChange={(event) => onToggle(event.currentTarget.checked)} />
                  : <div className="agents-preview-variable" key={label}><span>{label}</span><small>{state}</small></div>)}
              </div></Tabs.Panel>
              <Tabs.Panel value="history" pt="sm">
                {view.notes.history && <div className="agents-preview-variable-panel">{view.notes.history}</div>}
                {source.runsLoading ? <div className="agents-run-empty">Loading agent runs…</div>
                  : source.runsError ? <div className="agents-run-empty">Agent run history is unavailable.</div>
                    : selectedRuns.length ? <div className="agents-runs-list">
                      {selectedRuns.slice(0, 8).map((run) => <AgentRunRow run={run} key={run.id} />)}
                    </div> : <div className="agents-run-empty">No runs recorded for this profile.</div>}
              </Tabs.Panel>
              <Tabs.Panel value="versions" pt="sm"><div className="agents-preview-variable-panel"><h4>Profile versions</h4>
                {view.notes.versions && <p>{view.notes.versions}</p>}
                {view.versions(selected).map((version) => <div className="agents-preview-variable" key={version.label}>
                  <span>{version.label}{version.selected ? ' · Selected' : ''}</span><small>{version.updated}</small></div>)}
              </div></Tabs.Panel>
            </Tabs>
            {isEditing && <div className="agents-form-status">
              {submitError && <Text className="agents-error" role="alert">{submitError}</Text>}
              <Button variant="default" type="button" onClick={() => { resetEditForm(); setIsEditing(false); }}>Cancel</Button>
              <Button className="agents-save-button" type="submit" loading={source.saving}>Save profile</Button>
            </div>}
          </form>
        </> : <div className="agents-detail-empty"><IconRobot size={26} /><h3>Agent profile</h3>
          <p>Select a profile or create one to manage prompts and tool permissions.</p></div>}
      </PanelCard>
    </div>
    </div>
    <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Create agent profile" centered>
      <form onSubmit={createForm.onSubmit((values) => {
        source.create(agentInputSchema.parse(values)).then((item) => {
          setCreateOpen(false);
          createForm.reset();
          openProfile(item, `${item.name} created`);
        }).catch((error: unknown) => setSubmitError(message(error)));
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
        {submitError && <Text className="agents-error" role="alert">{submitError}</Text>}
        <div className="agents-modal-actions">
          <Button variant="subtle" type="button" onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button className="agents-save-button" type="submit" loading={source.saving}>
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
            disabled={!onlineProjects.length || !runReadiness(selected?.provider, selectedRunWorker).ready}>
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
