import {
  IconBrandDocker, IconBrandGithub, IconBrandGitlab, IconBrandGoogle, IconBrandJira, IconBrandOpenai,
  IconBrandSlack, IconCloud, IconDatabase, IconExternalLink,
} from '@tabler/icons-react';
import { useState } from 'react';
import type {
  SystemController, SystemNotificationRule, SystemProfile, SystemProvider, SystemSecret, SystemSource,
} from './systemView';

const connected = { status: 'Connected', healthy: true };
const providers: SystemProvider[] = [
  { name: 'GitHub', detail: 'Source code, PRs, issues', link: 'org/zenchron-engineering', color: 'github', category: 'SCM', icon: <IconBrandGithub />, ...connected },
  { name: 'GitLab', detail: 'Source code, MRs, CI', link: 'gitlab.com/zenchron', color: 'gitlab', category: 'SCM', icon: <IconBrandGitlab />, ...connected },
  { name: 'Slack', detail: 'Alerts, reviews, updates', link: '#eng-agents, #run-alerts', color: 'slack', category: 'Work Mgmt', icon: <IconBrandSlack />, ...connected },
  { name: 'Linear / Jira', detail: 'Issues, roadmap, work tracking', link: 'zenchron.linear.app', color: 'jira', category: 'Work Mgmt', icon: <IconBrandJira />, ...connected },
  { name: 'Docker / Registry', detail: 'Build, run, and artifact registry', link: 'registry.zenchron.io', color: 'docker', category: 'Infra', icon: <IconBrandDocker />, ...connected },
  { name: 'OpenAI', detail: 'Model provider (GPT, o-series)', link: 'sk-••••••••••a9f2', color: 'openai', category: 'Models', icon: <IconBrandOpenai />, secret: 'Preview key · OpenAI', ...connected },
  { name: 'Anthropic', detail: 'Model provider (Claude)', link: 'sk-ant-••••••••d3e8', color: 'anthropic', category: 'Models', icon: <span>AI</span>, secret: 'Preview key · Anthropic', ...connected },
  { name: 'Google (Vertex AI)', detail: 'Model provider (Gemini)', link: '••••••••••9b2e', color: 'google', category: 'Models', icon: <IconBrandGoogle />, secret: 'Preview key · Google (Vertex AI)', ...connected },
  { name: 'Cloud Runners', detail: 'Scalable, isolated execution', link: 'aws (us-east-1) · 32 max', color: 'cloud', category: 'Infra', icon: <IconCloud />, ...connected },
  { name: 'Storage / Evidence', detail: 'Artifacts, logs, evidence, reviews', link: 's3://zenchron-evidence-prod', color: 'storage', category: 'Storage', icon: <IconDatabase />, ...connected },
];
const availablePolicies = ['Signed commits required', 'Branch protection', 'Dependency review'];
const auditEvents = [
  ['Jan 21, 10:24 AM', 'alex.chen@zenchron.dev', 'integration.update', 'Updated GitHub integration (org: zenchron-engineering)'],
  ['Jan 21, 09:18 AM', 'system', 'policy.update', 'Enabled “Evidence Capture” policy (v1.3)'],
  ['Jan 21, 08:47 AM', 'maria@zenchron.dev', 'secret.rotate', 'Rotated OPENAI_API_KEY (success)'],
];

type MockSettings = {
  providers: SystemProvider[];
  profile: SystemProfile;
  controller: SystemController;
  policies: string[];
  secrets: SystemSecret[];
  notificationRules: SystemNotificationRule[];
  switches: Record<string, boolean>;
};
const initialSettings: MockSettings = {
  providers,
  profile: { name: 'Zenchron Engineering', slug: 'zenchron-eng', timezone: 'UTC-08:00 (Pacific Time)', product: 'Core Product' },
  controller: { version: 'v2.4.0 (Stable)', maxRuns: 12, timeout: '2 hours' },
  policies: ['PR Review Required', 'Evidence Capture', 'SAST Scan', 'No Secrets in Logs', 'Max Run Time: 2h', 'Human Approval (Prod)'],
  secrets: [
    ['OPENAI_API_KEY', 'API Key', 'Jan 20, 2025'],
    ['ANTHROPIC_API_KEY', 'API Key', 'Jan 18, 2025'],
    ['GCP_SERVICE_ACCOUNT', 'Service Account', 'Jan 10, 2025'],
  ],
  notificationRules: [
    { event: 'Run Failed', channel: 'Slack', recipient: '#eng-alerts', label: 'Run failed notification' },
    { event: 'Awaiting Review', channel: 'Slack', recipient: '#eng-reviews', label: 'Awaiting review notification' },
    { event: 'Budget Threshold (≥ 80%)', channel: 'Email', recipient: 'platform@zenchron.dev', label: 'Budget threshold notification' },
  ],
  switches: {
    'Auto-scale Runners': true, 'Capture Evidence by Default': true, 'Run failed notification': true,
    'Awaiting review notification': true, 'Budget threshold notification': true,
  },
};

/** The Mock source: the approved fixtures, changed only in this browser tab. Discard restores the last local save. */
export function useMockSystem(): SystemSource {
  const [settings, setSettings] = useState(initialSettings);
  const [saved, setSaved] = useState(initialSettings);
  const [changesPending, setChangesPending] = useState(false);
  const [notice, setNotice] = useState('');
  const change = (update: (current: MockSettings) => MockSettings) => {
    setSettings(update);
    setChangesPending(true);
    setNotice('');
  };
  return {
    ...settings,
    description: 'Manage your organization, connect integrations, set policies, and control platform behavior.',
    health: 'All Systems Operational',
    categories: [['All', '12'], ['SCM', '2'], ['Work Mgmt', '2'], ['Models', '3'], ['Infra', '2'], ['Storage', '2']],
    profileOptions: {
      timezone: ['UTC-08:00 (Pacific Time)', 'UTC+00:00 (UTC)', 'UTC+01:00 (Europe/Bucharest)'],
      product: ['Core Product', 'Nova Platform', 'Orion Analytics'],
    },
    addablePolicies: availablePolicies.filter((policy) => !settings.policies.includes(policy)),
    roles: [
      ['Admin', '3', 'Full platform access'],
      ['Maintainer', '12', 'Configure, run, manage agents'],
      ['Viewer', '27', 'Read-only access and audit logs'],
    ],
    roleInfo: (role) => ({ title: `${role} role`, body: 'Role access and membership are sample data in this preview.' }),
    info: {
      roles: { title: 'Roles · preview only', body: 'Role membership and access are illustrative and cannot be changed in this preview.' },
      usage: { title: 'Budget usage · preview', body: 'The $13.6k of $20k spend is illustrative sample data.' },
      secrets: { title: 'Secrets · preview only', body: 'Only placeholder secret names and types are shown. Secret values are never stored in this preview.' },
    },
    budget: { spent: '$13.6k', limit: ' / $20k', share: '68%', percent: 68, rows: [
      ['Model Inference', '$7.9k (58%)'], ['Runners & Compute', '$3.8k (28%)'], ['Storage & Evidence', '$1.2k (9%)'], ['Other', '$0.7k (5%)'],
    ] },
    controllerOptions: { version: ['v2.4.0 (Stable)', 'v2.3.1 (Stable)'], timeout: ['1 hour', '2 hours', '4 hours', '8 hours'] },
    controllerStatus: { label: 'Healthy', healthy: true },
    controllerFacts: [],
    audit: {
      dialogTitle: 'Activity & audit · preview',
      range: 'Last 24 hours',
      rangeTitle: 'The local audit fixture has a fixed sample time range',
      events: auditEvents,
      exportFile: { name: 'zenchron-preview-audit.json', content: { preview: true, auditEvents } },
    },
    notes: {},
    connectionTest: {
      title: 'Connection test · preview only',
      body: `All ${settings.providers.length} sample integrations responded in this local simulation.`,
    },
    localSuffix: ' in preview',
    changesPending,
    notice,
    actions: {
      setConnected: (name, isConnected) => change((current) => ({ ...current, providers: current.providers.map((provider) =>
        provider.name === name ? { ...provider, healthy: isConnected, status: isConnected ? 'Connected' : 'Disconnected' } : provider) })),
      addProvider: (name) => change((current) => ({ ...current, providers: [...current.providers, {
        name, detail: 'Added to this local preview', link: 'Preview only', color: 'github', category: 'Other', icon: <IconExternalLink />, ...connected,
      }] })),
      setProfile: (profile) => change((current) => ({ ...current, profile: { ...current.profile, ...profile } })),
      addPolicy: (policy) => change((current) => ({ ...current, policies: [...current.policies, policy] })),
      removePolicy: (policy) => change((current) => ({ ...current, policies: current.policies.filter((item) => item !== policy) })),
      addSecret: (name, type) => change((current) => ({ ...current, secrets: [...current.secrets, [name, type, 'Just now']] })),
      rotateSecret: (name) => change((current) => ({ ...current, secrets: current.secrets.map((secret): SystemSecret =>
        secret[0] === name ? [secret[0], secret[1], 'Just now'] : secret) })),
      removeSecret: (name) => change((current) => ({ ...current, secrets: current.secrets.filter(([secret]) => secret !== name) })),
      setController: (controller) => change((current) => ({ ...current, controller: { ...current.controller, ...controller } })),
      setSwitch: (name, enabled) => change((current) => ({ ...current, switches: { ...current.switches, [name]: enabled } })),
      addRule: () => change((current) => {
        const label = `Preview notification ${current.notificationRules.length + 1}`;
        return { ...current, switches: { ...current.switches, [label]: true },
          notificationRules: [...current.notificationRules, { event: 'Custom Event', channel: 'Slack', recipient: '#eng-alerts', label }] };
      }),
      removeRule: (label) => change((current) => ({ ...current, notificationRules: current.notificationRules.filter((rule) => rule.label !== label) })),
      save: () => { setSaved(settings); setChangesPending(false); setNotice('Changes saved in this preview only'); },
      discard: () => { setSettings(saved); setChangesPending(false); setNotice('Preview changes discarded'); },
    },
  };
}
