import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconBook2, IconCode, IconFlask, IconGitCompare, IconPencil, IconSearch } from '@tabler/icons-react';
import {
  agentInputSchema, agentSchema, loadAgentRuns, loadAgents, relativeRunTime, toolOptions,
  type Agent, type AgentInput, type AgentRun,
} from './agentsData';
import { runsInLast30Days } from './runMetrics';

/** One displayed number: the value, plus either a change against the previous period or a caption. */
export type Figure = { value: string | number; change?: string; detail?: string };
/** A profile field shown as a select. Without `onChange` the field is read-only in this mode. */
export type Choice = { value: string | null; options: { value: string; label: string }[]; onChange?: (value: string) => void };
export type TrendPoint = { date: string; success: number | null; cost: number | null; latency: number | null };
export type RecentRun = { id: string; label: string; trigger: string; input: string; status: string; duration: string; cost: string; time: string };
export type SafetyItem = { label: string; state: string; tone: 'enabled' | 'restricted' | 'plain'; onToggle?: (enabled: boolean) => void };

/** Everything the Agents page displays that depends on where the data comes from. The page lays it out once. */
export type AgentsView = {
  dataLabel?: string;
  /** Accessible names for the two charts, so fixture charts are announced as illustrative. */
  chartLabels: { trend: string; sparkline: string };
  exportName: string;
  kpis: { total: Figure; active: Figure; runs: Figure; success: Figure; cost: Figure };
  row: (agent: Agent) => { provider: string; lastRun: string; cost: string; success: string; tags: string[]; status: string };
  fields: (agent: Agent) => { modelProvider: Choice; version: Choice; status: Choice; owner: Choice; created: string; updated: string };
  performance: (agent: Agent) => { runs: Figure; success: Figure; latency: Figure; cost: Figure; sparkline?: number[] };
  trend: (agent: Agent, days: 7 | 30) => {
    points: TrendPoint[]; successDomain: [number, number]; costDomain?: [number, number]; latencyDomain?: [number, number];
  };
  recentRuns: (agent: Agent) => RecentRun[];
  variables: { name: string; description: string }[];
  templates: string[];
  /** One line per section saying what the data source does and does not hold. */
  notes: { variables: string; safety: string; history?: string; versions?: string };
  toolPermissions: (agent: Agent) => { label: string; icon: ReactNode; enabled: boolean }[];
  safety: (agent: Agent) => SafetyItem[];
  versions: (agent: Agent) => { label: string; updated: string; selected: boolean }[];
  mobile: {
    metrics: { runs: Figure; reviews: Figure; evidence: Figure };
    runs: { id: string; name: string; detail: string; status: string; time: string }[];
    review?: { title: string; badge: string; detail: string; added?: string; removed?: string };
    evidence?: { title: string; detail: string; badge: string };
  };
};

/** Profiles, runs, and operations for the Agents page. Mock and Live each provide one. */
export type AgentsSource = {
  items: Agent[];
  runs: AgentRun[];
  profilesLoading: boolean;
  profilesError: boolean;
  runsLoading: boolean;
  runsError: boolean;
  saving: boolean;
  /** The last failed save, for the page to show. */
  saveError?: string;
  view: AgentsView;
  create: (input: AgentInput) => Promise<Agent>;
  update: (id: string, input: AgentInput) => Promise<Agent>;
  /** Replaces the profile list from a file. Absent where the data source cannot do it. */
  importProfiles?: (agents: Agent[]) => void;
  /** Records a labelled simulated run. Absent where runs are queued for a real worker instead. */
  simulateRun?: (agent: Agent) => void;
  /** Appended to confirmations so a local-only change is never presented as saved. */
  savedSuffix: string;
};

const unavailable = 'Unavailable';
const toolIcons: Record<string, ReactNode> = {
  'code.search': <IconSearch size={12} />, 'docs.search': <IconBook2 size={12} />, 'code.write': <IconPencil size={12} />,
  'git.diff': <IconGitCompare size={12} />, 'git.read': <IconCode size={12} />, 'tests.run': <IconFlask size={12} />,
};

const finished = (run: AgentRun) => run.status === 'succeeded' || run.status === 'failed';
function successRate(runs: AgentRun[]) {
  const done = runs.filter(finished);
  return done.length ? Math.round(done.filter((run) => run.status === 'succeeded').length / done.length * 100) : undefined;
}
/** Seconds a run spent executing, from its finished attempts; undefined while nothing has finished. */
function runSeconds(run: AgentRun) {
  const spans = (run.attempt_log ?? []).flatMap((attempt) => {
    const span = Date.parse(attempt.finished_at ?? '') - Date.parse(attempt.started_at);
    return Number.isFinite(span) && span >= 0 ? [span / 1000] : [];
  });
  return spans.length ? spans.reduce((sum, span) => sum + span, 0) : undefined;
}
function reportedCost(runs: AgentRun[]) {
  const costs = runs.flatMap((run) => run.usage?.cost_usd === undefined ? [] : [run.usage.cost_usd]);
  return costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : undefined;
}
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
const money = (value: number | undefined) => value === undefined ? undefined : `$${value.toFixed(2)}`;
function duration(seconds: number | undefined) {
  if (seconds === undefined) return undefined;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
const newest = (runs: AgentRun[]) => [...runs].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));

function liveView(items: Agent[], runs: AgentRun[], state: {
  profilesLoading: boolean; profilesError: boolean; runsLoading: boolean; runsError: boolean;
}, setStatus: (agent: Agent, status: Agent['status']) => void): AgentsView {
  const profileFigure = (value: number): string | number =>
    state.profilesLoading ? 'Loading…' : state.profilesError ? unavailable : value;
  const runFigure = (value: string | number | undefined): string | number =>
    state.runsLoading ? 'Loading…' : state.runsError ? unavailable : value ?? unavailable;
  const recent = runsInLast30Days(runs);
  const rate = successRate(recent);
  const cost = money(reportedCost(recent));
  const runsOf = (agent: Agent) => runs.filter((run) => run.agent_id === agent.id);
  const latest = newest(runs);
  const latestWithPullRequest = latest.find((run) => run.pull_request_number !== undefined);
  return {
    chartLabels: { trend: 'Agent success, cost, and latency trends', sparkline: 'Performance trend' },
    exportName: 'agents.json',
    kpis: {
      total: { value: profileFigure(items.length), detail: 'Saved profiles' },
      active: { value: profileFigure(items.filter((item) => item.status === 'active').length), detail: 'Enabled profiles' },
      runs: { value: runFigure(recent.length), detail: 'Recorded runs' },
      success: { value: runFigure(rate === undefined ? undefined : `${rate}%`), detail: 'Completed runs · last 30d' },
      cost: { value: runFigure(cost), detail: cost ? 'Reported by providers · last 30d' : 'Provider usage records are unavailable' },
    },
    row: (agent) => {
      const own = runsOf(agent);
      const ownRate = successRate(own);
      const last = newest(own)[0];
      return {
        provider: `${agent.model} · ${agent.provider}`,
        lastRun: state.runsLoading ? 'Run history loading' : state.runsError ? 'Run history unavailable'
          : last ? `Last run: ${relativeRunTime(last.updated_at)}` : 'No runs yet',
        cost: money(reportedCost(own)) ?? '—',
        success: ownRate === undefined ? '—' : `${ownRate}% of ${own.filter(finished).length}`,
        tags: agent.tools,
        status: agent.status,
      };
    },
    fields: (agent) => {
      const model = `${agent.model} · ${agent.provider}`;
      return {
        modelProvider: { value: model, options: [{ value: model, label: model }] },
        version: { value: `v${agent.version}`, options: [{ value: `v${agent.version}`, label: `v${agent.version}` }] },
        status: {
          value: agent.status, options: [{ value: 'active', label: 'Active' }, { value: 'disabled', label: 'Disabled' }],
          onChange: (status) => { if (status === 'active' || status === 'disabled') setStatus(agent, status); },
        },
        owner: { value: null, options: [] },
        created: unavailable,
        updated: new Date(agent.updated_at).toLocaleString(),
      };
    },
    performance: (agent) => {
      const own = runsInLast30Days(runsOf(agent));
      const ownRate = successRate(own);
      return {
        runs: { value: runFigure(own.length) },
        success: { value: runFigure(ownRate === undefined ? undefined : `${ownRate}%`) },
        latency: { value: runFigure(duration(mean(own.flatMap((run) => runSeconds(run) ?? [])))) },
        cost: { value: runFigure(money(reportedCost(own))) },
      };
    },
    trend: (agent, days) => {
      const start = Date.now() - days * 86_400_000;
      const byDay = new Map<string, AgentRun[]>();
      for (const run of [...runsOf(agent)].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
        const created = Date.parse(run.created_at);
        if (!Number.isFinite(created) || created < start) continue;
        const day = new Date(created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        byDay.set(day, [...(byDay.get(day) ?? []), run]);
      }
      return {
        points: [...byDay].map(([date, dayRuns]) => ({
          date, success: successRate(dayRuns) ?? null, cost: reportedCost(dayRuns) ?? null,
          latency: mean(dayRuns.flatMap((run) => runSeconds(run) ?? [])) ?? null,
        })),
        successDomain: [0, 100],
      };
    },
    recentRuns: (agent) => newest(runsOf(agent)).slice(0, 3).map((run) => ({
      id: run.id,
      label: run.pull_request_number !== undefined ? `PR #${run.pull_request_number}`
        : run.issue_number !== undefined ? `Issue #${run.issue_number}` : `Run ${run.id.slice(0, 7)}`,
      trigger: run.issue_number !== undefined ? 'GitHub issue' : 'Task prompt',
      input: run.issue_title || run.prompt || run.branch,
      status: run.status === 'succeeded' ? 'Success' : run.status[0].toUpperCase() + run.status.slice(1),
      duration: duration(runSeconds(run)) ?? '—',
      cost: money(run.usage?.cost_usd) ?? '—',
      time: relativeRunTime(run.updated_at),
    })),
    variables: [],
    templates: [],
    notes: {
      variables: 'Profile variables and templates are not stored by the control plane.',
      safety: 'Enforced by the worker on every run. These safeguards are not configurable per profile.',
      versions: 'The control plane keeps the current version only.',
    },
    toolPermissions: (agent) => toolOptions.map((tool) => ({
      label: tool.label, icon: toolIcons[tool.value], enabled: agent.tools.some((granted) => granted === tool.value),
    })),
    safety: (agent) => {
      const grants = (tool: string) => agent.tools.some((granted) => granted === tool);
      return [
        { label: 'Run workspace', state: 'Isolated worktree', tone: 'enabled' },
        { label: 'File writes', state: grants('code.write') ? 'Allowed' : 'Not granted', tone: grants('code.write') ? 'enabled' : 'restricted' },
        { label: 'Test execution', state: grants('tests.run') ? 'Allowed' : 'Not granted', tone: grants('tests.run') ? 'enabled' : 'restricted' },
        { label: 'Provider credentials', state: 'Withheld', tone: 'enabled' },
      ];
    },
    versions: (agent) => [{ label: `v${agent.version}`, updated: new Date(agent.updated_at).toLocaleString(), selected: true }],
    mobile: {
      metrics: {
        runs: { value: runFigure(recent.length) },
        reviews: { value: runFigure(runs.filter((run) => run.pull_request_number !== undefined).length) },
        evidence: { value: unavailable },
      },
      runs: latest.slice(0, 3).map((run) => ({
        id: run.id, name: run.agent_name, detail: run.issue_title || run.prompt || run.branch, status: run.status,
        time: relativeRunTime(run.updated_at),
      })),
      review: latestWithPullRequest && {
        title: `PR #${latestWithPullRequest.pull_request_number}`, badge: latestWithPullRequest.status,
        detail: latestWithPullRequest.issue_title || latestWithPullRequest.prompt,
      },
    },
  };
}

/** The Agents page's Live data source: the control plane's profiles and runs, and its real mutations. */
export function useLiveAgents(enabled: boolean): AgentsSource {
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ['agents'], queryFn: loadAgents, enabled });
  const runs = useQuery({ queryKey: ['agent-runs'], queryFn: loadAgentRuns, refetchInterval: 3_000, enabled });
  const save = useMutation({
    mutationFn: async ({ id, input }: { id?: string; input: AgentInput }) => {
      const response = await fetch(id ? `/api/v1/agents/${id}` : '/api/v1/agents', {
        method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error((await response.text()).trim() || `Request failed (${response.status})`);
      return agentSchema.parse(await response.json());
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agents'] }),
  });
  const state = {
    profilesLoading: agents.isLoading, profilesError: agents.isError, runsLoading: runs.isLoading, runsError: runs.isError,
  };
  const update = (id: string, input: AgentInput) => save.mutateAsync({ id, input });
  const items = agents.data ?? [];
  const runItems = runs.data ?? [];
  return {
    items, runs: runItems, ...state, saving: save.isPending, saveError: save.error?.message, savedSuffix: '',
    view: liveView(items, runItems, state, (agent, status) => {
      // A failed status change is reported through `saveError`; the rejection itself needs no second handler.
      void update(agent.id, agentInputSchema.parse({ ...agent, status })).catch(() => undefined);
    }),
    create: (input) => save.mutateAsync({ input }),
    update,
  };
}
