import {
  IconActivity, IconBrandDocker, IconBrandGithub, IconBrandGitlab, IconBrandGoogle, IconBrandJira, IconBrandOpenai,
  IconBrandSlack, IconDatabase, IconRobot,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';

export type SystemProvider = {
  name: string;
  detail: string;
  link: string;
  color: string;
  category: string;
  icon: ReactNode;
  status: string;
  healthy: boolean;
  /** Shown in place of the masked link while the viewer reveals it. */
  secret?: string;
};
export type SystemProfile = { name: string; slug: string; timezone: string; product: string };
export type SystemController = { version: string; maxRuns: number | null; timeout: string };
export type SystemSecret = [name: string, type: string, rotatedAt: string];
export type SystemNotificationRule = { event: string; channel: string; recipient: string; label: string };
export type SystemInfo = { title: string; body: string };
type SystemNoteKey = 'integrations' | 'profile' | 'policy' | 'permissions' | 'budget' | 'secrets' | 'controller'
  | 'notifications' | 'audit';

/** Changes a mode can make. Live has none: the control plane persists no settings, so the page disables them. */
export type SystemActions = {
  setConnected: (name: string, connected: boolean) => void;
  addProvider: (name: string) => void;
  setProfile: (change: Partial<SystemProfile>) => void;
  addPolicy: (policy: string) => void;
  removePolicy: (policy: string) => void;
  addSecret: (name: string, type: string) => void;
  rotateSecret: (name: string) => void;
  removeSecret: (name: string) => void;
  setController: (change: Partial<SystemController>) => void;
  setSwitch: (name: string, enabled: boolean) => void;
  addRule: () => void;
  removeRule: (label: string) => void;
  save: () => void;
  discard: () => void;
};

/** Everything the Settings & Integrations layout shows, in the same shape for Mock and Live. */
export type SystemSource = {
  description: string;
  health: string;
  categories: [name: string, count: string][];
  providers: SystemProvider[];
  profile: SystemProfile;
  profileOptions: { timezone: string[]; product: string[] };
  policies: string[];
  addablePolicies: string[];
  roles: [role: string, members: string, access: string][];
  roleInfo: (role: string) => SystemInfo;
  info: { roles: SystemInfo; usage: SystemInfo; secrets: SystemInfo };
  budget: { spent: string; limit: string; share: string; percent: number; rows: [label: string, value: string][] };
  secrets: SystemSecret[];
  controller: SystemController;
  controllerOptions: { version: string[]; timeout: string[] };
  controllerStatus: { label: string; healthy: boolean };
  controllerFacts: [label: string, value: string][];
  switches: Record<string, boolean>;
  notificationRules: SystemNotificationRule[];
  audit: {
    dialogTitle: string;
    range: string;
    rangeTitle: string;
    events: string[][];
    exportFile?: { name: string; content: unknown };
  };
  /** Why a part of the design is empty or disabled. */
  notes: Partial<Record<SystemNoteKey, string>>;
  connectionTest?: SystemInfo;
  /** Appended to labels of changes that stay in the browser tab. */
  localSuffix: string;
  changesPending: boolean;
  notice: string;
  actions?: SystemActions;
};

export interface SystemFacts {
  apiOnline: boolean;
  githubLogin: boolean;
  workerCount: number;
  onlineWorkerCount: number;
  projectCount: number;
  gitHubProjectCount: number;
  /** Online workers per coding CLI that report it installed and signed in. */
  cliReadyWorkers?: Record<string, number>;
}

const unavailable = 'Unavailable';
const liveCategories = ['SCM', 'Work Mgmt', 'Models', 'Infra', 'Storage'];
const onlineWorkers = (count: number) => `${count} online worker${count === 1 ? '' : 's'}`;

// ponytail: status badges sit over the card copy, sized in the design for "Connected"; Live details stay short so
// longer statuses do not cover them. Reflow the card header if statuses or details need to grow.
function notIntegrated(name: string, detail: string, color: string, category: string, icon: ReactNode): SystemProvider {
  return { name, detail, color, category, icon, link: 'Not integrated with the control plane.', status: 'Not connected', healthy: false };
}

function liveProviders(facts: SystemFacts): SystemProvider[] {
  const { apiOnline, githubLogin, workerCount, onlineWorkerCount, projectCount, gitHubProjectCount, cliReadyWorkers = {} } = facts;
  const readyCLIs = Object.entries(cliReadyWorkers).filter(([, count]) => count > 0);
  const cliDetail = readyCLIs.length
    ? ` Coding CLIs ready: ${readyCLIs.map(([id, count]) => `${id} on ${count}`).join(', ')}.`
    : onlineWorkerCount ? ' No online worker reports a signed-in Codex or Claude Code CLI.' : '';
  const codingCLI = (name: string, label: string, color: string, icon: ReactNode, id: string): SystemProvider => {
    const ready = cliReadyWorkers[id] ?? 0;
    return { name, detail: `${label} on workers`, color, category: 'Models', icon, healthy: ready > 0,
      status: ready ? 'CLI ready' : 'Not connected',
      link: ready ? `${label} installed and signed in on ${onlineWorkers(ready)}.` : `No online worker reports a signed-in ${label}.` };
  };
  return [
    { name: 'Control plane API', detail: 'State and worker commands', color: 'cloud', category: 'Infra', icon: <IconActivity />,
      link: githubLogin ? 'Authenticated API for workspace state and worker commands.'
        : 'Loopback HTTP service for workspace state and worker commands.',
      status: apiOnline ? 'Online' : 'Offline', healthy: apiOnline },
    { name: 'Local workers', detail: 'Runs on your machines', color: 'cloud', category: 'Infra', icon: <IconRobot />,
      link: `${onlineWorkerCount} of ${workerCount} workers reporting a recent heartbeat.${cliDetail}`,
      status: onlineWorkerCount ? 'Connected' : unavailable, healthy: onlineWorkerCount > 0 },
    { name: 'GitHub', detail: 'Code, PRs, issues', color: 'github', category: 'SCM', icon: <IconBrandGithub />,
      link: gitHubProjectCount
        ? `${gitHubProjectCount} GitHub ${gitHubProjectCount === 1 ? 'repository' : 'repositories'} detected. PR comments and `
          + 'request-changes use the control-plane token and are submitted as its owner. Merge actions are not available.'
        : `${projectCount} local checkout${projectCount === 1 ? '' : 's'} visible; connect a github.com origin to sync issues and pull requests.`,
      status: gitHubProjectCount ? 'Read-only sync' : 'No GitHub repo', healthy: gitHubProjectCount > 0 },
    codingCLI('OpenAI', 'Codex CLI', 'openai', <IconBrandOpenai />, 'codex-cli'),
    codingCLI('Anthropic', 'Claude Code CLI', 'anthropic', <span>AI</span>, 'claude-code'),
    { name: 'Storage / Evidence', detail: 'Artifacts, logs, evidence', color: 'storage', category: 'Storage', icon: <IconDatabase />,
      link: 'Run artifacts will appear after evidence capture is implemented.', status: 'Not configured', healthy: false },
    notIntegrated('GitLab', 'Source code, MRs, CI', 'gitlab', 'SCM', <IconBrandGitlab />),
    notIntegrated('Slack', 'Alerts, reviews, updates', 'slack', 'Work Mgmt', <IconBrandSlack />),
    notIntegrated('Linear / Jira', 'Issues and roadmap', 'jira', 'Work Mgmt', <IconBrandJira />),
    notIntegrated('Docker / Registry', 'Build and registry', 'docker', 'Infra', <IconBrandDocker />),
    notIntegrated('Google (Vertex AI)', 'Model provider (Gemini)', 'google', 'Models', <IconBrandGoogle />),
  ];
}

/**
 * The Live source. It is built from the shell's existing health, session, worker, and project queries, so the page
 * adds no requests of its own. The control plane stores no organization settings, which is why there are no actions.
 */
export function liveSystemSource(facts: SystemFacts): SystemSource {
  const { apiOnline, githubLogin, workerCount, onlineWorkerCount, projectCount } = facts;
  const providers = liveProviders(facts);
  const notes = {
    integrations: 'Provider setup is not available from the control plane.',
    profile: 'Organization identity and defaults are not configured in the control plane.',
    policy: 'Merge rules, approval gates, and repository policy are not enforced.',
    permissions: githubLogin ? 'GitHub OAuth identifies users; organization roles and permissions are not enforced.'
      : 'Local preview has no sign-in or organization authorization.',
    budget: 'Model spend, worker compute, and storage usage are not measured. Configured workers can run read-only tasks '
      + 'or write on isolated branches; test execution and cost limits are not enabled.',
    secrets: 'Model credentials stay on workers; GitHub credentials stay on the control plane. Secret management is not implemented.',
    controller: (githubLogin ? 'Remote API access requires HTTPS and the configured worker bearer token.'
      : 'Remote access requires GitHub sign-in and worker authentication to be configured.')
      + ' Checkout names are visible; local filesystem paths stay on each worker. Controller version and run limits cannot be set here.',
    notifications: 'Run alerts and review notifications are not configured.',
    audit: 'Audit history is unavailable until audit storage is implemented; run artifacts require agent runs.',
  };
  return {
    description: 'Review connected runtime services and the current control-plane boundary.',
    health: apiOnline ? 'API online' : 'API offline',
    categories: [['All', String(providers.length)], ...liveCategories.map((category): [string, string] =>
      [category, String(providers.filter((provider) => provider.category === category).length)])],
    providers,
    profile: { name: unavailable, slug: unavailable, timezone: unavailable, product: unavailable },
    profileOptions: { timezone: [unavailable], product: [unavailable] },
    policies: [],
    addablePolicies: [],
    roles: [[githubLogin ? 'Allowlisted GitHub users' : 'Local workspace', unavailable, 'Roles and permissions are not enforced']],
    roleInfo: (role) => ({ title: role, body: notes.permissions }),
    info: {
      roles: { title: 'Roles', body: notes.permissions },
      usage: { title: 'Budget usage', body: notes.budget },
      secrets: { title: 'Secrets', body: notes.secrets },
    },
    budget: { spent: unavailable, limit: '', share: '', percent: 0, rows: [
      ['Model Inference', 'Not tracked'], ['Runners & Compute', 'Not tracked'], ['Storage & Evidence', 'Not tracked'], ['Other', 'Not tracked'],
    ] },
    secrets: [],
    controller: { version: unavailable, maxRuns: null, timeout: unavailable },
    controllerOptions: { version: [unavailable], timeout: [unavailable] },
    controllerStatus: { label: apiOnline ? 'Online' : 'Offline', healthy: apiOnline },
    controllerFacts: [
      ['Dashboard auth', githubLogin ? 'GitHub OAuth' : 'Local preview'],
      ['State storage', 'Versioned JSON snapshots'],
      ['Online workers', `${onlineWorkerCount} of ${workerCount}`],
      ['Local checkouts', String(projectCount)],
      ['Coding CLIs ready', Object.entries(facts.cliReadyWorkers ?? {}).filter(([, count]) => count > 0)
        .map(([id, count]) => `${id} on ${count}`).join(' · ') || 'None'],
    ],
    switches: { 'Auto-scale Runners': false, 'Capture Evidence by Default': false },
    notificationRules: [],
    audit: { dialogTitle: 'Activity & audit', range: 'No events', rangeTitle: notes.audit, events: [] },
    notes,
    localSuffix: '',
    changesPending: false,
    notice: '',
  };
}
