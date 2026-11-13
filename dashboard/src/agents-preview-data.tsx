import { useState, type ReactNode } from 'react';
import { IconActivity, IconBook2, IconBrandGithub, IconSearch, IconShieldCheck } from '@tabler/icons-react';
import { agentSchema, type Agent, type AgentInput, type AgentRun } from './agentsData';
import type { AgentsSource, AgentsView } from './agentsView';

// shortcut: visual-only mock profiles, replace their values after the agent schema is approved.
const updatedAt = new Date().toISOString();

export const agentsPreviewProfiles: Agent[] = [
  {
    id: 'preview-code-reviewer',
    name: 'Code Reviewer',
    description: 'Automated code review with quality, security, and standards.',
    provider: 'Anthropic',
    model: 'Claude 3.7 Sonnet',
    status: 'active',
    system_prompt: 'You are the Zenchron Code Reviewer.\nReview code changes for quality, security,\n'
      + 'correctness, performance, and maintainability.\nFollow the team’s engineering standards and\n'
      + 'provide concise, actionable feedback with\nclear severity and suggested fixes.',
    goal_prompt: 'Review the provided code changes, identify issues,\nassess risk and impact, and return structured feedback\n'
      + 'with recommended actions and code suggestions.',
    tools: ['code.search', 'code.write', 'git.diff', 'git.read'],
    version: 2,
    updated_at: updatedAt,
  },
  {
    id: 'preview-test-generator', name: 'Test Generator',
    description: 'Generate comprehensive tests (unit, integration, e2e).',
    provider: 'OpenAI', model: 'GPT-4o', status: 'active',
    system_prompt: 'Generate reliable tests that cover expected behavior and edge cases.',
    goal_prompt: 'Add focused tests for the requested change.',
    tools: ['code.search', 'tests.run'], version: 3, updated_at: updatedAt,
  },
  {
    id: 'preview-planner', name: 'Planner',
    description: 'Break objectives into executable plans.',
    provider: 'Anthropic', model: 'Claude 3.5 Haiku', status: 'active',
    system_prompt: 'Create clear, bounded engineering plans.',
    goal_prompt: 'Decompose the objective into verifiable tasks.',
    tools: ['docs.search'], version: 1, updated_at: updatedAt,
  },
  {
    id: 'preview-release-manager', name: 'Release Manager',
    description: 'Coordinate releases, changelogs, and rollout strategies.',
    provider: 'Anthropic', model: 'Claude 3.5 Haiku', status: 'active',
    system_prompt: 'Coordinate safe and observable releases.',
    goal_prompt: 'Prepare a release plan and changelog.',
    tools: ['git.read'], version: 2, updated_at: updatedAt,
  },
  {
    id: 'preview-research-analyst', name: 'Research Analyst',
    description: 'Research, analyze, and synthesize technical information.',
    provider: 'Google', model: 'Gemini 1.5 Pro', status: 'disabled',
    system_prompt: 'Research technical topics using approved sources.',
    goal_prompt: 'Summarize evidence and open questions.',
    tools: ['docs.search'], version: 1, updated_at: updatedAt,
  },
  {
    id: 'preview-coverage-analyzer', name: 'Coverage Analyzer',
    description: 'Analyze test coverage and identify gaps.',
    provider: 'OpenAI', model: 'GPT-4o', status: 'active',
    system_prompt: 'Find meaningful gaps in test coverage.',
    goal_prompt: 'Report uncovered behavior and risk.',
    tools: ['git.diff', 'tests.run'], version: 1, updated_at: updatedAt,
  },
];

function previewRun(id: string, branch: string, prompt: string, ageMinutes: number): AgentRun {
  const timestamp = new Date(Date.now() - ageMinutes * 60_000).toISOString();
  return {
    id, agent_id: agentsPreviewProfiles[0].id, agent_name: 'Code Reviewer',
    project_id: 'preview-project', project_name: 'Nova Platform', worker_id: 'preview-worker',
    worker_name: 'Cloud Runner', branch, prompt, output: 'Review completed', status: 'succeeded',
    attempts: 1, diff_attempt: 0, diff_available: true, diff_truncated: false,
    pull_request_enabled: false, can_request_changes: false, cancel_requested: false,
    review_comments: [], created_at: timestamp, updated_at: timestamp,
  };
}

export const agentsPreviewRuns: AgentRun[] = [
  previewRun('preview-run-1', 'feat/auth-improvements', 'Review auth changes', 2),
  previewRun('preview-run-2', 'fix/rate-limit-edgecase', 'Review rate limit changes', 18),
  previewRun('preview-run-3', 'main', 'Daily review', 60),
];

export const agentsPreviewTrend = [
  { date: 'Jan 1', success: 93, cost: 0.42, latency: 1.8 },
  { date: 'Jan 4', success: 95, cost: 0.48, latency: 1.7 },
  { date: 'Jan 7', success: 94, cost: 0.51, latency: 1.65 },
  { date: 'Jan 10', success: 96, cost: 0.57, latency: 1.5 },
  { date: 'Jan 13', success: 97, cost: 0.63, latency: 1.4 },
  { date: 'Jan 16', success: 96, cost: 0.68, latency: 1.35 },
  { date: 'Jan 19', success: 98, cost: 0.74, latency: 1.2 },
  { date: 'Jan 22', success: 97, cost: 0.8, latency: 1.1 },
  { date: 'Jan 25', success: 99, cost: 0.9, latency: 0.95 },
];

export const agentsPreviewTools: { label: string; icon: ReactNode }[] = [
  { label: 'GitHub (PRs, diffs, comments)', icon: <IconBrandGithub size={12} /> },
  { label: 'Code Search (repo context)', icon: <IconSearch size={12} /> },
  { label: 'Static Analysis (linters, SAST)', icon: <IconShieldCheck size={12} /> },
  { label: 'Docs Search (internal wiki)', icon: <IconBook2 size={12} /> },
  { label: 'Issue Tracker (create/update)', icon: <IconActivity size={12} /> },
];

export const agentsPreviewTags: Record<string, string[]> = {
  'preview-code-reviewer': ['Code Review', 'Security', 'Best Practices', 'Accessibility', 'Performance'],
  'preview-test-generator': ['Test Generation', 'Coverage', 'Edge Cases', 'Unit Tests'],
  'preview-planner': ['Task Planning', 'Decomposition', 'Estimation', 'Prioritization', 'Dependencies'],
  'preview-release-manager': ['Release Orchestration', 'Changelog', 'Rollout', 'Versioning', 'Risk Review'],
  'preview-research-analyst': ['Research', 'Summarization', 'Comparison', 'Synthesis', 'Technical Docs'],
  'preview-coverage-analyzer': ['Coverage Analysis', 'Test Gaps', 'Risk Review'],
};

export const agentsPreviewListMetrics: Record<string, { lastRun: string; cost: string; success: string }> = {
  'preview-code-reviewer': { lastRun: 'Last run: 2m ago', cost: '$0.42', success: '98.4%' },
  'preview-test-generator': { lastRun: 'Last run: 7m ago', cost: '$0.28', success: '96.1%' },
  'preview-planner': { lastRun: 'Last run: 15m ago', cost: '$0.31', success: '97.6%' },
  'preview-release-manager': { lastRun: 'Last run: 32m ago', cost: '$0.19', success: '95.8%' },
  'preview-research-analyst': { lastRun: 'Last run: 3h ago', cost: '$0.38', success: '94.2%' },
  'preview-coverage-analyzer': { lastRun: 'Last run: 1h ago', cost: '$0.21', success: '95.4%' },
};

const previewVersions = [
  { label: 'v2.4.1', updated: 'Jan 26, 2025' }, { label: 'v2.4.0', updated: 'Jan 20, 2025' },
  { label: 'v2.3.8', updated: 'Jan 12, 2025' },
];
const previewOwners = ['Platform Engineering', 'AI Platform'];
const previewRecentRuns = [
  { id: 'preview-recent-1', label: 'PR #4827', trigger: 'PR Review', input: 'feat/auth-improvements', status: 'Success', duration: '7.9s', cost: '$0.42', time: '2m ago' },
  { id: 'preview-recent-2', label: 'PR #4819', trigger: 'PR Review', input: 'fix/rate-limit-edgecase', status: 'Success', duration: '8.4s', cost: '$0.39', time: '18m ago' },
  { id: 'preview-recent-3', label: 'PR #4812', trigger: 'Scheduled', input: 'main (daily)', status: 'Success', duration: '9.1s', cost: '$0.41', time: '1h ago' },
];

/** The Agents page's Mock data source: the approved fixtures, changed only in this browser tab. */
export function useMockAgents(): AgentsSource {
  const [items, setItems] = useState<Agent[]>(agentsPreviewProfiles);
  const [runs, setRuns] = useState<AgentRun[]>(agentsPreviewRuns);
  const [owners, setOwners] = useState<Record<string, string>>({});
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [safety, setSafety] = useState<Record<string, boolean>>({
    'Content Safety': true, 'PII/Secret Detection': true, 'Policy Compliance': true, 'Allow Code Changes': false,
  });
  const patch = (id: string, change: Partial<Agent>) => setItems((current) => current.map((item) =>
    item.id === id ? agentSchema.parse({ ...item, ...change }) : item));
  const modelOptions = agentsPreviewProfiles.map((agent) => ({ value: agent.id, label: `${agent.model} · ${agent.provider}` }));
  const view: AgentsView = {
    dataLabel: 'ILLUSTRATIVE DATA',
    chartLabels: { trend: 'Mock agent success, cost, and latency trends', sparkline: 'Illustrative performance trend' },
    exportName: 'agents-preview.json',
    kpis: {
      total: { value: items.length, change: '↑ +2' },
      active: { value: items.filter((item) => item.status === 'active').length, change: '↑ +1' },
      runs: { value: '1,842', change: '↑ +18%' },
      success: { value: '96.7%', change: '↑ +1.9pp' },
      cost: { value: '$412.36', change: '↓ -12%' },
    },
    row: (agent) => ({
      provider: `${agent.model} · ${agent.provider}`,
      lastRun: agentsPreviewListMetrics[agent.id]?.lastRun ?? 'No runs yet',
      cost: agentsPreviewListMetrics[agent.id]?.cost ?? '—',
      success: agentsPreviewListMetrics[agent.id]?.success ?? '—',
      tags: agentsPreviewTags[agent.id] ?? agent.tools,
      status: agent.id === 'preview-research-analyst' && agent.status === 'disabled' ? 'idle' : agent.status,
    }),
    fields: (agent) => ({
      modelProvider: {
        value: agentsPreviewProfiles.find((item) => item.model === agent.model && item.provider === agent.provider)?.id ?? agent.id,
        options: modelOptions,
        onChange: (id) => {
          const chosen = agentsPreviewProfiles.find((item) => item.id === id);
          if (chosen) patch(agent.id, { model: chosen.model, provider: chosen.provider });
        },
      },
      version: {
        value: versions[agent.id] ?? previewVersions[0].label, options: previewVersions.map(({ label }) => ({ value: label, label })),
        onChange: (version) => setVersions((current) => ({ ...current, [agent.id]: version })),
      },
      status: {
        value: agent.status, options: [{ value: 'active', label: 'Active' }, { value: 'disabled', label: 'Disabled' }],
        onChange: (status) => { if (status === 'active' || status === 'disabled') patch(agent.id, { status }); },
      },
      owner: {
        value: owners[agent.id] ?? previewOwners[0], options: previewOwners.map((owner) => ({ value: owner, label: owner })),
        onChange: (owner) => setOwners((current) => ({ ...current, [agent.id]: owner })),
      },
      created: 'Jan 12, 2025',
      updated: 'Jan 26, 2025, 10:24 AM',
    }),
    performance: () => ({
      runs: { value: '482', change: '↑ +21%' }, success: { value: '98.4%', change: '↑ +1.6pp' },
      latency: { value: '8.7s', change: '↓ -18%' }, cost: { value: '$203.86', change: '↓ -14%' },
      sparkline: agentsPreviewTrend.map(({ success }) => success - 90),
    }),
    trend: (_agent, days) => ({
      points: days === 7 ? agentsPreviewTrend.slice(-3) : agentsPreviewTrend, successDomain: [90, 100], costDomain: [0.4, 1.2],
      latencyDomain: [0.8, 1.9],
    }),
    recentRuns: () => previewRecentRuns,
    variables: [
      { name: 'repo_url', description: 'Git repository URL or PR link' }, { name: 'diff', description: 'Code diff or change set' },
      { name: 'standards', description: 'Engineering standards' },
    ],
    templates: ['Default Review'],
    notes: {
      variables: 'Values are supplied by workflow or repository context for each run.',
      safety: 'Changes apply to this preview only.',
      history: 'Illustrative local preview · simulated runs are not submitted.',
    },
    toolPermissions: () => agentsPreviewTools.map((tool, index) => ({ ...tool, enabled: index < 4 })),
    safety: () => [
      ...['Content Safety', 'PII/Secret Detection', 'Policy Compliance'].map((label) => ({
        label, state: safety[label] ? 'Enabled' : 'Disabled', tone: 'enabled' as const,
        onToggle: (enabled: boolean) => setSafety((current) => ({ ...current, [label]: enabled })),
      })),
      {
        label: 'Allow Code Changes', state: safety['Allow Code Changes'] ? 'Allowed' : 'Restricted', tone: 'restricted' as const,
        onToggle: (enabled: boolean) => setSafety((current) => ({ ...current, 'Allow Code Changes': enabled })),
      },
      { label: 'Data Retention', state: '30 days', tone: 'plain' as const },
    ],
    versions: (agent) => previewVersions.map((version) => ({
      ...version, updated: `Updated ${version.updated}`, selected: version.label === (versions[agent.id] ?? previewVersions[0].label),
    })),
    mobile: {
      metrics: {
        runs: { value: '18', change: '↑ +4' }, reviews: { value: '42', change: '↑ +27%' }, evidence: { value: '99.4%' },
      },
      runs: [
        { id: 'mobile-1', name: 'Code Reviewer', detail: 'PR #4827 · Review and comment', status: 'Success', time: '2m ago' },
        { id: 'mobile-2', name: 'Test Generator', detail: 'Generate unit and integration tests', status: 'Success', time: '4m ago' },
        { id: 'mobile-3', name: 'Coverage Analyzer', detail: 'Analyze coverage and gaps', status: 'Success', time: '7m ago' },
      ],
      review: { title: 'PR #4827', badge: '✓ Approved', detail: 'Add usage analytics (v1.3)', added: '+12', removed: '−3' },
      evidence: { title: 'Trusted-main', detail: 'Evidence · Test results · Reviews · Traces', badge: 'Healthy' },
    },
  };
  const add = (input: AgentInput, name = input.name) => {
    const item = agentSchema.parse({ ...input, name, id: crypto.randomUUID(), version: 1, updated_at: new Date().toISOString() });
    setItems((current) => [...current, item]);
    return Promise.resolve(item);
  };
  return {
    items, runs, view, profilesLoading: false, profilesError: false, runsLoading: false, runsError: false, saving: false,
    savedSuffix: ' in this preview only',
    create: (input) => add(input),
    update: (id, input) => {
      const current = items.find((item) => item.id === id);
      const updated = agentSchema.parse({ ...current, ...input, id, version: (current?.version ?? 0) + 1, updated_at: new Date().toISOString() });
      setItems((list) => list.map((item) => item.id === id ? updated : item));
      return Promise.resolve(updated);
    },
    importProfiles: setItems,
    simulateRun: (agent) => {
      const now = new Date().toISOString();
      setRuns((current) => [{
        id: crypto.randomUUID(), agent_id: agent.id, agent_name: agent.name, project_id: 'preview-project',
        project_name: 'Illustrative project', worker_id: 'preview-worker', worker_name: 'Preview worker',
        branch: 'preview/simulated-run', prompt: 'SIMULATED · local preview run', output: 'Illustrative run only.',
        status: 'succeeded', attempts: 1, created_at: now, updated_at: now, diff_available: false,
        diff_attempt: 0, diff_truncated: false, pull_request_enabled: false, can_request_changes: false,
        cancel_requested: false, review_comments: [],
      }, ...current]);
    },
  };
}
