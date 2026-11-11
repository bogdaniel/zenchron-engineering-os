import { Badge, Button, Menu, Modal, Progress, Select, Switch, TextInput } from '@mantine/core';
import {
  IconBrandDocker, IconBrandGithub, IconBrandGitlab, IconBrandGoogle, IconBrandJira, IconBrandOpenai,
  IconBrandSlack, IconBell, IconBuilding, IconChevronDown, IconCloud, IconDatabase, IconDots,
  IconExternalLink, IconEye, IconKey, IconSettings, IconShieldCheck, IconUsers,
} from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';

const providers = [
  { name: 'GitHub', detail: 'Source code, PRs, issues', link: 'org/zenchron-engineering', color: 'github', category: 'SCM', icon: <IconBrandGithub /> },
  { name: 'GitLab', detail: 'Source code, MRs, CI', link: 'gitlab.com/zenchron', color: 'gitlab', category: 'SCM', icon: <IconBrandGitlab /> },
  { name: 'Slack', detail: 'Alerts, reviews, updates', link: '#eng-agents, #run-alerts', color: 'slack', category: 'Work Mgmt', icon: <IconBrandSlack /> },
  { name: 'Linear / Jira', detail: 'Issues, roadmap, work tracking', link: 'zenchron.linear.app', color: 'jira', category: 'Work Mgmt', icon: <IconBrandJira /> },
  { name: 'Docker / Registry', detail: 'Build, run, and artifact registry', link: 'registry.zenchron.io', color: 'docker', category: 'Infra', icon: <IconBrandDocker /> },
  { name: 'OpenAI', detail: 'Model provider (GPT, o-series)', link: 'sk-••••••••••a9f2', color: 'openai', category: 'Models', icon: <IconBrandOpenai />, secret: true },
  { name: 'Anthropic', detail: 'Model provider (Claude)', link: 'sk-ant-••••••••d3e8', color: 'anthropic', category: 'Models', icon: <span>AI</span>, secret: true },
  { name: 'Google (Vertex AI)', detail: 'Model provider (Gemini)', link: '••••••••••9b2e', color: 'google', category: 'Models', icon: <IconBrandGoogle />, secret: true },
  { name: 'Cloud Runners', detail: 'Scalable, isolated execution', link: 'aws (us-east-1) · 32 max', color: 'cloud', category: 'Infra', icon: <IconCloud /> },
  { name: 'Storage / Evidence', detail: 'Artifacts, logs, evidence, reviews', link: 's3://zenchron-evidence-prod', color: 'storage', category: 'Storage', icon: <IconDatabase /> },
];

const categories = [['All', '12'], ['SCM', '2'], ['Work Mgmt', '2'], ['Models', '3'], ['Infra', '2'], ['Storage', '2']];
const initialPolicies = ['PR Review Required', 'Evidence Capture', 'SAST Scan', 'No Secrets in Logs', 'Max Run Time: 2h', 'Human Approval (Prod)'];
const availablePolicies = ['Signed commits required', 'Branch protection', 'Dependency review'];
type PreviewSecret = [name: string, type: string, rotatedAt: string];
type SavedPreview = {
  profile: typeof initialProfile;
  controller: typeof initialController;
  policies: string[];
  secrets: PreviewSecret[];
  notificationRules: typeof initialNotificationRules;
  providers: typeof providers;
  connected: Record<string, boolean>;
  settingsEnabled: Record<string, boolean>;
};
const initialSecrets: PreviewSecret[] = [
  ['OPENAI_API_KEY', 'API Key', 'Jan 20, 2025'],
  ['ANTHROPIC_API_KEY', 'API Key', 'Jan 18, 2025'],
  ['GCP_SERVICE_ACCOUNT', 'Service Account', 'Jan 10, 2025'],
];
const initialProfile = { name: 'Zenchron Engineering', slug: 'zenchron-eng', timezone: 'UTC-08:00 (Pacific Time)', product: 'Core Product' };
const initialController = { version: 'v2.4.0 (Stable)', maxRuns: 12, timeout: '2 hours' };
const initialNotificationRules = [
  { event: 'Run Failed', channel: 'Slack', recipient: '#eng-alerts', label: 'Run failed notification' },
  { event: 'Awaiting Review', channel: 'Slack', recipient: '#eng-reviews', label: 'Awaiting review notification' },
  { event: 'Budget Threshold (≥ 80%)', channel: 'Email', recipient: 'platform@zenchron.dev', label: 'Budget threshold notification' },
];
const initialSettingsEnabled = {
  'Auto-scale Runners': true, 'Capture Evidence by Default': true, 'Run failed notification': true,
  'Awaiting review notification': true, 'Budget threshold notification': true,
};
export const systemPreviewAuditEvents = [
  ['Jan 21, 10:24 AM', 'alex.chen@zenchron.dev', 'integration.update', 'Updated GitHub integration (org: zenchron-engineering)'],
  ['Jan 21, 09:18 AM', 'system', 'policy.update', 'Enabled “Evidence Capture” policy (v1.3)'],
  ['Jan 21, 08:47 AM', 'maria@zenchron.dev', 'secret.rotate', 'Rotated OPENAI_API_KEY (success)'],
];

function Toggle({ label, checked = true, onChange }: { label: string; checked?: boolean; onChange: (checked: boolean) => void }) {
  return <Switch className="system-preview-switch" size="xs" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} aria-label={label} />;
}

function Status({ children, healthy = true }: { children: string; healthy?: boolean }) {
  return <Badge className="system-preview-status"
    data-healthy={healthy || undefined}
    leftSection={healthy && <i className="system-preview-status-dot" aria-hidden="true" />}>
    {children}
  </Badge>;
}

function StaticField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options?: string[] }) {
  return <label className="system-preview-field"><span>{label}</span>{options
    ? <Select aria-label={label} value={value} onChange={(next) => next && onChange(next)} data={options} />
    : <TextInput aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)} />}</label>;
}

function SettingsHeading({ title, icon }: { title: string; icon: ReactNode }) {
  return <PanelHeading title={<>{title}<span className="system-preview-settings-badge">Settings</span></>} icon={icon} />;
}

export function SystemIntegrationsPreview({ section, onShowAudit }: { section: 'integrations' | 'settings'; onShowAudit: () => void }) {
  const [category, setCategory] = useState('All');
  const [connected, setConnected] = useState<Record<string, boolean>>(() => Object.fromEntries(providers.map(({ name }) => [name, true])));
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [newProvider, setNewProvider] = useState('');
  const [localProviders, setLocalProviders] = useState(providers);
  const [settingsEnabled, setSettingsEnabled] = useState<Record<string, boolean>>(initialSettingsEnabled);
  const [profile, setProfile] = useState(initialProfile);
  const [controller, setController] = useState(initialController);
  const [localPolicies, setLocalPolicies] = useState(initialPolicies);
  const [localSecrets, setLocalSecrets] = useState<PreviewSecret[]>([...initialSecrets]);
  const [notificationRules, setNotificationRules] = useState(initialNotificationRules);
  const [changesPending, setChangesPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [testOpen, setTestOpen] = useState(false);
  const [secretOpen, setSecretOpen] = useState(false);
  const [newSecretName, setNewSecretName] = useState('');
  const [newSecretType, setNewSecretType] = useState('API Key');
  const [info, setInfo] = useState<{ title: string; body: string } | null>(null);
  const [savedPreview, setSavedPreview] = useState<SavedPreview>(() => ({ profile: initialProfile, policies: initialPolicies,
    secrets: [...initialSecrets], notificationRules: initialNotificationRules, providers,
    connected: Object.fromEntries(providers.map(({ name }) => [name, true])), settingsEnabled: initialSettingsEnabled, controller: initialController }));
  const markChanged = () => { setChangesPending(true); setNotice(''); };
  const setSetting = (name: string, value: boolean) => { setSettingsEnabled((current) => ({ ...current, [name]: value })); markChanged(); };
  const visibleProviders = localProviders.filter((provider) => category === 'All' || provider.category === category);
  const showCategory = (value: string) => {
    setCategory(value);
    window.location.hash = '#integrations';
    document.querySelector('.system-preview-service-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const showSettingsPanel = (id: string) => {
    window.location.hash = '#settings';
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };

  const addProvider = () => {
    const name = newProvider.trim();
    if (!name || localProviders.some((provider) => provider.name.toLowerCase() === name.toLowerCase())) return;
    setLocalProviders((current) => [...current, { name, detail: 'Added to this local preview', link: 'Preview only', color: 'github', category: 'Other', icon: <IconExternalLink /> }]);
    setConnected((current) => ({ ...current, [name]: true }));
    markChanged();
    setCategory('All'); setNewProvider(''); setAddOpen(false);
  };
  const addSecret = () => {
    const name = newSecretName.trim().toUpperCase().replaceAll(' ', '_');
    if (!name || localSecrets.some(([existing]) => existing === name)) return;
    setLocalSecrets((current) => [...current, [name, newSecretType, 'Just now']]);
    setNewSecretName(''); setNewSecretType('API Key'); setSecretOpen(false); markChanged();
  };
  const discardChanges = () => {
    setProfile(savedPreview.profile); setController(savedPreview.controller); setLocalPolicies(savedPreview.policies); setLocalSecrets(savedPreview.secrets);
    setNotificationRules(savedPreview.notificationRules); setLocalProviders(savedPreview.providers);
    setConnected(savedPreview.connected); setSettingsEnabled(savedPreview.settingsEnabled);
    setChangesPending(false); setNotice('Preview changes discarded');
  };
  const showInfo = (title: string, body: string) => setInfo({ title, body });

  return <div className="system-workspace system-preview-workspace">
    <Modal opened={addOpen} onClose={() => setAddOpen(false)} title="Add integration · preview only" centered>
      <TextInput label="Integration name" value={newProvider} onChange={(event) => setNewProvider(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addProvider(); } }} />
      <Button mt="md" disabled={!newProvider.trim() || localProviders.some((provider) => provider.name.toLowerCase() === newProvider.trim().toLowerCase())}
        onClick={addProvider}>Add to preview</Button>
    </Modal>
    <Modal opened={secretOpen} onClose={() => setSecretOpen(false)} title="Add secret · preview only" centered>
      <TextInput label="Secret name" value={newSecretName} onChange={(event) => setNewSecretName(event.currentTarget.value)} />
      <Select mt="sm" label="Secret type" value={newSecretType} onChange={(value) => value && setNewSecretType(value)}
        data={['API Key', 'Service Account']} />
      <Button mt="md" disabled={!newSecretName.trim() || localSecrets.some(([name]) => name === newSecretName.trim().toUpperCase().replaceAll(' ', '_'))}
        onClick={addSecret}>Add secret to preview</Button>
    </Modal>
    <Modal opened={testOpen} onClose={() => setTestOpen(false)} title="Connection test · preview only" centered>
      <p role="status">All {localProviders.length} sample integrations responded in this local simulation.</p>
    </Modal>
    <Modal opened={info !== null} onClose={() => setInfo(null)} title={info?.title} centered>
      <p>{info?.body}</p>
    </Modal>
    <nav className="system-config-nav" aria-label="Configuration categories">
      <b>Configuration</b><small>INTEGRATIONS</small>
      <a className={section === 'integrations' ? 'active' : ''} href="#integrations" onClick={() => setCategory('All')} aria-current={section === 'integrations' ? 'page' : undefined}>
        <IconDatabase size={12} />Connected Integrations</a>
      <button type="button" onClick={() => showCategory('Models')}><IconBrandOpenai size={12} />Model Providers</button>
      <button type="button" onClick={() => showCategory('Infra')}><IconCloud size={12} />Runners &amp; Infrastructure</button>
      <button type="button" onClick={() => showCategory('Storage')}><IconDatabase size={12} />Storage &amp; Evidence</button>
      <small>SETTINGS</small>
      <a className={section === 'settings' ? 'active' : ''} href="#settings" onClick={() => showSettingsPanel('system-preview-profile')} aria-current={section === 'settings' ? 'page' : undefined}>
        <IconBuilding size={12} />Organization Profile</a>
      <button type="button" onClick={() => showSettingsPanel('system-preview-policy')}><IconShieldCheck size={12} />Policies</button>
      <button type="button" onClick={() => showSettingsPanel('system-preview-permissions')}><IconUsers size={12} />Permissions</button>
      <button type="button" onClick={() => showSettingsPanel('system-preview-budget')}><span className="system-preview-dollar">$</span>Budgets</button>
      <button type="button" onClick={() => showSettingsPanel('system-preview-secrets')}><IconKey size={12} />Secrets</button>
      <button type="button" onClick={() => showSettingsPanel('system-preview-controller')}><IconSettings size={12} />Controller Configuration</button>
      <button type="button" onClick={() => showSettingsPanel('system-preview-notifications')}><IconBell size={12} />Notification Rules</button>
    </nav>

    <div className="system-workspace-main">
      {section === 'integrations' && <>
      <div className="system-integration-header system-preview-integration-header">
        <PanelHeading className="system-section-heading" title="Integrations Overview"
          description="Connect your engineering tools, model providers, infrastructure, and data backends." />
        <div className="system-integration-filters" aria-label="Integration categories">
          {categories.map(([name, count]) => <button className={category === name ? 'active' : ''} key={name} type="button"
            aria-pressed={category === name} onClick={() => setCategory(name)}>
            {name} <b>({count})</b>
          </button>)}
          <Menu position="bottom-end"><Menu.Target><button className="system-preview-category-more" type="button" aria-label="More integration categories"><IconChevronDown size={12} /></button></Menu.Target>
            <Menu.Dropdown><Menu.Item onClick={() => setCategory('Other')}>Other</Menu.Item><Menu.Item onClick={() => setCategory('All')}>Show all integrations</Menu.Item></Menu.Dropdown>
          </Menu>
        </div>
      </div>

      <div className="system-service-grid system-preview-service-grid">
        {visibleProviders.map((provider) => <PanelCard className="system-service-card system-preview-provider" key={provider.name} withBorder>
          <span className={`system-preview-provider-icon ${provider.color}`}>{provider.icon}</span>
          <div className="system-service-copy">
            <h4>{provider.name}</h4><p>{provider.detail}</p>
            <div className="system-preview-provider-link-row"><small className="system-preview-provider-link"><IconExternalLink size={10} />{provider.secret && revealed[provider.name] ? `Preview key · ${provider.name}` : provider.link}</small>
              {provider.secret && <button type="button" aria-label={`${revealed[provider.name] ? 'Hide' : 'Reveal'} ${provider.name} preview key`}
                onClick={() => setRevealed((current) => ({ ...current, [provider.name]: !current[provider.name] }))}><IconEye size={12} /></button>}
              <Menu position="bottom-end"><Menu.Target><button type="button" aria-label={`${provider.name} options`}><IconDots size={13} /></button></Menu.Target>
                <Menu.Dropdown><Menu.Item onClick={() => { setConnected((current) => ({ ...current, [provider.name]: !current[provider.name] })); markChanged(); }}>
                  {connected[provider.name] ? 'Disconnect in preview' : 'Connect in preview'}</Menu.Item></Menu.Dropdown>
              </Menu></div>
          </div>
          <div className="system-preview-provider-control"><Status healthy={connected[provider.name]}>{connected[provider.name] ? 'Connected' : 'Disconnected'}</Status>
            <Toggle label={`${provider.name} connected`} checked={connected[provider.name]}
              onChange={(value) => { setConnected((current) => ({ ...current, [provider.name]: value })); markChanged(); }} /></div>
        </PanelCard>)}
        <button className="shared-panel-surface system-add-integration system-preview-add-integration" type="button" onClick={() => setAddOpen(true)}>
          <span>＋</span><div><b>Add Integration</b><small>Connect another tool, model provider, runner, or storage backend.</small></div>
        </button>
      </div>
      </>}

      <div className="system-preview-settings-grid">
        <PanelCard id="system-preview-profile" className="system-preview-card system-preview-profile" withBorder>
          <SettingsHeading title="Organization Profile" icon={<IconBuilding size={15} />} />
          <div className="system-preview-profile-fields">
            <StaticField label="Organization Name" value={profile.name} onChange={(name) => { setProfile((current) => ({ ...current, name })); markChanged(); }} />
            <StaticField label="Organization Slug" value={profile.slug} onChange={(slug) => { setProfile((current) => ({ ...current, slug })); markChanged(); }} />
            <StaticField label="Timezone" value={profile.timezone} options={['UTC-08:00 (Pacific Time)', 'UTC+00:00 (UTC)', 'UTC+01:00 (Europe/Bucharest)']}
              onChange={(timezone) => { setProfile((current) => ({ ...current, timezone })); markChanged(); }} />
            <StaticField label="Default Product" value={profile.product} options={['Core Product', 'Nova Platform', 'Orion Analytics']}
              onChange={(product) => { setProfile((current) => ({ ...current, product })); markChanged(); }} />
          </div>
        </PanelCard>
        <PanelCard id="system-preview-policy" className="system-preview-card system-preview-policy" withBorder>
          <SettingsHeading title="Policies" icon={<IconShieldCheck size={15} />} />
          <div className="system-preview-policies">{localPolicies.map((policy) => <span key={policy}>{policy}
            <button type="button" aria-label={`Remove ${policy}`} onClick={() => { setLocalPolicies((current) => current.filter((item) => item !== policy)); markChanged(); }}>×</button></span>)}</div>
          <button className="system-preview-add-policy" disabled={!availablePolicies.some((policy) => !localPolicies.includes(policy))}
            onClick={() => { const next = availablePolicies.find((policy) => !localPolicies.includes(policy)); if (next) { setLocalPolicies((current) => [...current, next]); markChanged(); } }}>＋ Add Policy</button>
        </PanelCard>
        <PanelCard id="system-preview-permissions" className="system-preview-card system-preview-permissions" withBorder>
          <SettingsHeading title="Permissions" icon={<IconUsers size={15} />} />
          <button className="system-preview-card-action" type="button" onClick={() => showInfo('Roles · preview only', 'Role membership and access are illustrative and cannot be changed in this preview.')}>Manage Roles →</button>
          <div className="system-preview-table-scroll"><table><thead><tr><th>Role</th><th>Members</th><th>Access</th><th aria-label="Actions" /></tr></thead><tbody>
            {['Admin', 'Maintainer', 'Viewer'].map((role, index) => <tr key={role}><td>{role}</td><td>{[3, 12, 27][index]}</td><td>{['Full platform access', 'Configure, run, manage agents', 'Read-only access and audit logs'][index]}</td>
              <td><Menu position="bottom-end"><Menu.Target><button type="button" aria-label={`${role} role options`}><IconDots size={13} /></button></Menu.Target>
                <Menu.Dropdown><Menu.Item onClick={() => showInfo(`${role} role`, 'Role access and membership are sample data in this preview.')}>View details</Menu.Item></Menu.Dropdown>
              </Menu></td></tr>)}
          </tbody></table></div>
        </PanelCard>

        <PanelCard id="system-preview-budget" className="system-preview-card system-preview-budget" withBorder>
          <SettingsHeading title="Budgets" icon={<span className="system-preview-dollar">$</span>} />
          <button className="system-preview-card-action" type="button" onClick={() => showInfo('Budget usage · preview', 'The $13.6k of $20k spend is illustrative sample data.')}>View Usage →</button>
          <div className="system-preview-budget-value"><strong>$13.6k</strong><span> / $20k</span><b>68%</b></div>
          <Progress value={68} color="violet" />
          <div className="system-preview-budget-rows">
            <span>Model Inference <b>$7.9k (58%)</b></span><span>Runners &amp; Compute <b>$3.8k (28%)</b></span>
            <span>Storage &amp; Evidence <b>$1.2k (9%)</b></span><span>Other <b>$0.7k (5%)</b></span>
          </div>
        </PanelCard>
        <PanelCard id="system-preview-secrets" className="system-preview-card system-preview-secrets" withBorder>
          <SettingsHeading title="Secrets" icon={<IconKey size={15} />} />
          <button className="system-preview-card-action" type="button" onClick={() => showInfo('Secrets · preview only', 'Only placeholder secret names and types are shown. Secret values are never stored in this preview.')}>Manage Secrets →</button>
          <div className="system-preview-table-scroll"><table><thead><tr><th>Name</th><th>Type</th><th>Last Rotated</th><th>Status</th><th aria-label="Actions" /></tr></thead><tbody>
            {localSecrets.map(([name, type, date]) => <tr key={name}><td><IconKey size={11} />{name}</td><td>{type}</td><td>{date}</td><td><Status>Active</Status></td>
              <td><Menu position="bottom-end"><Menu.Target><button type="button" aria-label={`${name} secret options`}><IconDots size={13} /></button></Menu.Target>
                <Menu.Dropdown><Menu.Item onClick={() => { setLocalSecrets((current) => current.map((secret) => secret[0] === name ? [secret[0], secret[1], 'Just now'] : secret)); markChanged(); }}>Rotate preview secret</Menu.Item>
                  <Menu.Item color="red" onClick={() => { setLocalSecrets((current) => current.filter(([secret]) => secret !== name)); markChanged(); }}>Remove from preview</Menu.Item></Menu.Dropdown>
              </Menu></td></tr>)}
          </tbody></table></div>
          <button className="system-preview-add-policy" onClick={() => setSecretOpen(true)}>＋ Add Secret</button>
        </PanelCard>
        <PanelCard id="system-preview-controller" className="system-preview-card system-preview-controller" withBorder>
          <SettingsHeading title="Controller Configuration" icon={<IconSettings size={15} />} />
          <div className="system-preview-controller-values"><span>Agent Controller</span><Select aria-label="Agent Controller version" value={controller.version}
            onChange={(version) => { if (version) { setController((current) => ({ ...current, version })); markChanged(); } }} data={['v2.4.0 (Stable)', 'v2.3.1 (Stable)']} /><Status>Healthy</Status></div>
          <div className="system-preview-slider"><label htmlFor="preview-max-runs">Max Concurrent Runs</label><b>{controller.maxRuns}</b>
            <input id="preview-max-runs" aria-label="Max Concurrent Runs" type="range" min="1" max="20" value={controller.maxRuns}
              onChange={(event) => { const maxRuns = Number(event.currentTarget.value); setController((current) => ({ ...current, maxRuns })); markChanged(); }} /></div>
          <div className="system-preview-controller-values"><span>Default Run Timeout</span><Select aria-label="Default Run Timeout" value={controller.timeout}
            onChange={(timeout) => { if (timeout) { setController((current) => ({ ...current, timeout })); markChanged(); } }} data={['1 hour', '2 hours', '4 hours', '8 hours']} /></div>
        <div className="system-preview-toggles"><span><Toggle label="Auto-scale Runners" checked={settingsEnabled['Auto-scale Runners']} onChange={(value) => setSetting('Auto-scale Runners', value)} />Auto-scale Runners</span>
            <span><Toggle label="Capture Evidence by Default" checked={settingsEnabled['Capture Evidence by Default']} onChange={(value) => setSetting('Capture Evidence by Default', value)} />Capture Evidence by Default</span></div>
        </PanelCard>

        <PanelCard id="system-preview-notifications" className="system-preview-card system-preview-notifications" withBorder>
          <SettingsHeading title="Notification Rules" icon={<IconBell size={15} />} />
          <button className="system-preview-card-action system-preview-add-rule" type="button" onClick={() => {
            const label = `Preview notification ${notificationRules.length + 1}`;
            setNotificationRules((current) => [...current, { event: 'Custom Event', channel: 'Slack', recipient: '#eng-alerts', label }]);
            setSetting(label, true);
          }}>＋ Add Rule</button>
          <div className="system-preview-table-scroll"><table><thead><tr><th>Event</th><th>Channel</th><th>Recipients</th><th>Status</th><th aria-label="Actions" /></tr></thead><tbody>
            {notificationRules.map((rule) => <tr key={rule.label}><td>◉ {rule.event}</td><td>{rule.channel === 'Slack' ? '◉' : '✉'} {rule.channel}</td><td>{rule.recipient}</td>
              <td><Toggle label={rule.label} checked={settingsEnabled[rule.label] ?? true} onChange={(value) => setSetting(rule.label, value)} /></td>
              <td><Menu position="bottom-end"><Menu.Target><button type="button" aria-label={`${rule.label} options`}><IconDots size={13} /></button></Menu.Target>
                <Menu.Dropdown><Menu.Item onClick={() => showInfo(rule.event, `${rule.channel} notifications go to ${rule.recipient}.`)}>View rule</Menu.Item>
                  <Menu.Item color="red" onClick={() => { setNotificationRules((current) => current.filter((item) => item.label !== rule.label)); markChanged(); }}>Remove rule</Menu.Item></Menu.Dropdown>
              </Menu></td></tr>)}
          </tbody></table></div>
        </PanelCard>
        <PanelCard id="system-preview-audit" className="system-preview-card system-preview-audit" withBorder>
          <PanelHeading title="Recent Audit Log" icon={<IconDatabase size={15} />} />
          <button className="system-preview-card-action" type="button" onClick={onShowAudit}>View Full Audit Log →</button>
          <span className="system-preview-audit-range" title="The local audit fixture has a fixed sample time range">Last 24 hours</span>
          <div className="system-preview-table-scroll"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead><tbody>
            {systemPreviewAuditEvents.map(([time, actor, action, detail]) => <tr key={time}><td>{time}</td><td>{actor}</td><td>{action}</td><td>{detail}</td></tr>)}
          </tbody></table></div>
        </PanelCard>
      </div>
      <div className="system-preview-actions">
        {notice && <span role="status">{notice}</span>}
        <button type="button" disabled={!changesPending} onClick={discardChanges}>Discard Changes</button>
        <button type="button" onClick={() => setTestOpen(true)}>Test Connections</button>
        <button type="button" className="primary" disabled={!changesPending} onClick={() => {
          setSavedPreview({ profile, controller, policies: localPolicies, secrets: localSecrets, notificationRules,
            providers: localProviders, connected, settingsEnabled });
          setChangesPending(false); setNotice('Changes saved in this preview only');
        }}>✓ Save Changes</button>
      </div>
    </div>
  </div>;
}
