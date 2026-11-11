import type { ReactNode } from 'react';
import { IconActivity, IconBook2, IconBrandGithub, IconSearch, IconShieldCheck } from '@tabler/icons-react';
import type { Agent, AgentRun } from './agents';

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
