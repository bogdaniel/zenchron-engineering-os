import { Badge, Button, Menu, Modal, Progress, Switch, TextInput } from '@mantine/core';
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
const policies = ['PR Review Required', 'Evidence Capture', 'SAST Scan', 'No Secrets in Logs', 'Max Run Time: 2h', 'Human Approval (Prod)'];
const secrets = [
  ['OPENAI_API_KEY', 'API Key', 'Jan 20, 2025'],
  ['ANTHROPIC_API_KEY', 'API Key', 'Jan 18, 2025'],
  ['GCP_SERVICE_ACCOUNT', 'Service Account', 'Jan 10, 2025'],
];
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

function StaticField({ label, value, select = false }: { label: string; value: string; select?: boolean }) {
  return <label className="system-preview-field"><span>{label}</span><TextInput aria-label={label} value={value} readOnly
    rightSection={select ? <span className="system-preview-chevron">⌄</span> : undefined} /></label>;
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
  const [settingsEnabled, setSettingsEnabled] = useState<Record<string, boolean>>({
    'Auto-scale Runners': true, 'Capture Evidence by Default': true, 'Run failed notification': true,
    'Awaiting review notification': true, 'Budget threshold notification': true,
  });
  const setSetting = (name: string, value: boolean) => setSettingsEnabled((current) => ({ ...current, [name]: value }));
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
    setCategory('All'); setNewProvider(''); setAddOpen(false);
  };

  return <div className="system-workspace system-preview-workspace">
    <Modal opened={addOpen} onClose={() => setAddOpen(false)} title="Add integration · preview only" centered>
      <TextInput label="Integration name" value={newProvider} onChange={(event) => setNewProvider(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addProvider(); } }} />
      <Button mt="md" disabled={!newProvider.trim() || localProviders.some((provider) => provider.name.toLowerCase() === newProvider.trim().toLowerCase())}
        onClick={addProvider}>Add to preview</Button>
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
            {name} <b>{count}</b>
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
                <Menu.Dropdown><Menu.Item onClick={() => setConnected((current) => ({ ...current, [provider.name]: !current[provider.name] }))}>
                  {connected[provider.name] ? 'Disconnect in preview' : 'Connect in preview'}</Menu.Item></Menu.Dropdown>
              </Menu></div>
          </div>
          <div className="system-preview-provider-control"><Status healthy={connected[provider.name]}>{connected[provider.name] ? 'Connected' : 'Disconnected'}</Status>
            <Toggle label={`${provider.name} connected`} checked={connected[provider.name]}
              onChange={(value) => setConnected((current) => ({ ...current, [provider.name]: value }))} /></div>
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
            <StaticField label="Organization Name" value="Zenchron Engineering" />
            <StaticField label="Organization Slug" value="zenchron-eng" />
            <StaticField label="Timezone" value="UTC-08:00 (Pacific Time)" select />
            <StaticField label="Default Product" value="Core Product" select />
          </div>
        </PanelCard>
        <PanelCard id="system-preview-policy" className="system-preview-card system-preview-policy" withBorder>
          <SettingsHeading title="Policies" icon={<IconShieldCheck size={15} />} />
          <div className="system-preview-policies">{policies.map((policy) => <span key={policy}>{policy}<b>×</b></span>)}</div>
          <button className="system-preview-add-policy" disabled>＋ Add Policy</button>
        </PanelCard>
        <PanelCard id="system-preview-permissions" className="system-preview-card system-preview-permissions" withBorder>
          <SettingsHeading title="Permissions" icon={<IconUsers size={15} />} />
          <div className="system-preview-card-action">Manage Roles →</div>
          <div className="system-preview-table-scroll"><table><thead><tr><th>Role</th><th>Members</th><th>Access</th><th aria-label="Actions" /></tr></thead><tbody>
            <tr><td>Admin</td><td>3</td><td>Full platform access</td><td><button disabled aria-label="Admin role options unavailable"><IconDots size={13} /></button></td></tr>
            <tr><td>Maintainer</td><td>12</td><td>Configure, run, manage agents</td><td><button disabled aria-label="Maintainer role options unavailable"><IconDots size={13} /></button></td></tr>
            <tr><td>Viewer</td><td>27</td><td>Read-only access and audit logs</td><td><button disabled aria-label="Viewer role options unavailable"><IconDots size={13} /></button></td></tr>
          </tbody></table></div>
        </PanelCard>

        <PanelCard id="system-preview-budget" className="system-preview-card system-preview-budget" withBorder>
          <SettingsHeading title="Budgets" icon={<span className="system-preview-dollar">$</span>} />
          <div className="system-preview-card-action">View Usage →</div>
          <div className="system-preview-budget-value"><strong>$13.6k</strong><span> / $20k</span><b>68%</b></div>
          <Progress value={68} color="violet" />
          <div className="system-preview-budget-rows">
            <span>Model Inference <b>$7.9k (58%)</b></span><span>Runners &amp; Compute <b>$3.8k (28%)</b></span>
            <span>Storage &amp; Evidence <b>$1.2k (9%)</b></span><span>Other <b>$0.7k (5%)</b></span>
          </div>
        </PanelCard>
        <PanelCard id="system-preview-secrets" className="system-preview-card system-preview-secrets" withBorder>
          <SettingsHeading title="Secrets" icon={<IconKey size={15} />} />
          <div className="system-preview-card-action">Manage Secrets →</div>
          <div className="system-preview-table-scroll"><table><thead><tr><th>Name</th><th>Type</th><th>Last Rotated</th><th>Status</th><th aria-label="Actions" /></tr></thead><tbody>
            {secrets.map(([name, type, date]) => <tr key={name}><td><IconKey size={11} />{name}</td><td>{type}</td><td>{date}</td><td><Status>Active</Status></td><td><button disabled aria-label={`${name} options unavailable`}><IconDots size={13} /></button></td></tr>)}
          </tbody></table></div>
          <button className="system-preview-add-policy" disabled>＋ Add Secret</button>
        </PanelCard>
        <PanelCard id="system-preview-controller" className="system-preview-card system-preview-controller" withBorder>
          <SettingsHeading title="Controller Configuration" icon={<IconSettings size={15} />} />
          <div className="system-preview-controller-values"><span>Agent Controller</span><b>v2.4.0 (Stable)</b><Status>Healthy</Status></div>
          <div className="system-preview-slider"><span>Max Concurrent Runs</span><b>12</b><i><em /></i></div>
          <div className="system-preview-controller-values"><span>Default Run Timeout</span><b>2 hours</b></div>
        <div className="system-preview-toggles"><span><Toggle label="Auto-scale Runners" checked={settingsEnabled['Auto-scale Runners']} onChange={(value) => setSetting('Auto-scale Runners', value)} />Auto-scale Runners</span>
            <span><Toggle label="Capture Evidence by Default" checked={settingsEnabled['Capture Evidence by Default']} onChange={(value) => setSetting('Capture Evidence by Default', value)} />Capture Evidence by Default</span></div>
        </PanelCard>

        <PanelCard id="system-preview-notifications" className="system-preview-card system-preview-notifications" withBorder>
          <SettingsHeading title="Notification Rules" icon={<IconBell size={15} />} />
          <button className="system-preview-card-action system-preview-add-rule" disabled>＋ Add Rule</button>
          <div className="system-preview-table-scroll"><table><thead><tr><th>Event</th><th>Channel</th><th>Recipients</th><th>Status</th><th aria-label="Actions" /></tr></thead><tbody>
            <tr><td>◉ Run Failed</td><td>◉ Slack</td><td>#eng-alerts</td><td><Toggle label="Run failed notification" checked={settingsEnabled['Run failed notification']} onChange={(value) => setSetting('Run failed notification', value)} /></td><td><button disabled aria-label="Run failed rule options unavailable"><IconDots size={13} /></button></td></tr>
            <tr><td>◉ Awaiting Review</td><td>◉ Slack</td><td>#eng-reviews</td><td><Toggle label="Awaiting review notification" checked={settingsEnabled['Awaiting review notification']} onChange={(value) => setSetting('Awaiting review notification', value)} /></td><td><button disabled aria-label="Awaiting review rule options unavailable"><IconDots size={13} /></button></td></tr>
            <tr><td>◉ Budget Threshold (≥ 80%)</td><td>✉ Email</td><td>platform@zenchron.dev</td><td><Toggle label="Budget threshold notification" checked={settingsEnabled['Budget threshold notification']} onChange={(value) => setSetting('Budget threshold notification', value)} /></td><td><button disabled aria-label="Budget threshold rule options unavailable"><IconDots size={13} /></button></td></tr>
          </tbody></table></div>
        </PanelCard>
        <PanelCard id="system-preview-audit" className="system-preview-card system-preview-audit" withBorder>
          <PanelHeading title="Recent Audit Log" icon={<IconDatabase size={15} />} />
          <button className="system-preview-card-action" type="button" onClick={onShowAudit}>View Full Audit Log →</button>
          <button className="system-preview-audit-range" disabled>Last 24 hours <IconChevronDown size={10} /></button>
          <div className="system-preview-table-scroll"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead><tbody>
            {systemPreviewAuditEvents.map(([time, actor, action, detail]) => <tr key={time}><td>{time}</td><td>{actor}</td><td>{action}</td><td>{detail}</td></tr>)}
          </tbody></table></div>
        </PanelCard>
      </div>
      <div className="system-preview-actions">
        <button disabled>Discard Changes</button><button disabled>Test Connections</button><button className="primary" disabled>✓ Save Changes</button>
      </div>
    </div>
  </div>;
}
