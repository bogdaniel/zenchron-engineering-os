import { Badge, Progress, Switch, TextInput } from '@mantine/core';
import {
  IconBrandDocker, IconBrandGithub, IconBrandGitlab, IconBrandGoogle, IconBrandJira, IconBrandOpenai,
  IconBrandSlack, IconBell, IconBuilding, IconCloud, IconDatabase, IconKey, IconSettings, IconShieldCheck, IconUsers,
} from '@tabler/icons-react';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';

const providers = [
  { name: 'GitHub', detail: 'Source code, PRs, issues', link: 'org/zenchron-engineering', color: 'github', icon: <IconBrandGithub /> },
  { name: 'GitLab', detail: 'Source code, MRs, CI', link: 'gitlab.com/zenchron', color: 'gitlab', icon: <IconBrandGitlab /> },
  { name: 'Slack', detail: 'Alerts, reviews, updates', link: '#eng-agents, #run-alerts', color: 'slack', icon: <IconBrandSlack /> },
  { name: 'Linear / Jira', detail: 'Issues, roadmap, work tracking', link: 'zenchron.linear.app', color: 'jira', icon: <IconBrandJira /> },
  { name: 'Docker / Registry', detail: 'Build, run, and artifact registry', link: 'registry.zenchron.io', color: 'docker', icon: <IconBrandDocker /> },
  { name: 'OpenAI', detail: 'Model provider (GPT, o-series)', link: 'sk-••••••••••a9f2', color: 'openai', icon: <IconBrandOpenai /> },
  { name: 'Anthropic', detail: 'Model provider (Claude)', link: 'sk-ant-••••••••d3e8', color: 'anthropic', icon: <span>AI</span> },
  { name: 'Google (Vertex AI)', detail: 'Model provider (Gemini)', link: '••••••••••9b2e', color: 'google', icon: <IconBrandGoogle /> },
  { name: 'Cloud Runners', detail: 'Scalable, isolated execution', link: 'aws (us-east-1) · 32 max', color: 'cloud', icon: <IconCloud /> },
  { name: 'Storage / Evidence', detail: 'Artifacts, logs, evidence, reviews', link: 's3://zenchron-evidence-prod', color: 'storage', icon: <IconDatabase /> },
];

const categories = [['All', '12'], ['SCM', '2'], ['Work Mgmt', '2'], ['Models', '3'], ['Infra', '2'], ['Storage', '2']];
const policies = ['PR Review Required', 'Evidence Capture', 'SAST Scan', 'No Secrets in Logs', 'Max Run Time: 2h', 'Human Approval (Prod)'];
const secrets = [
  ['OPENAI_API_KEY', 'API Key', 'Jan 20, 2025'],
  ['ANTHROPIC_API_KEY', 'API Key', 'Jan 18, 2025'],
  ['GCP_SERVICE_ACCOUNT', 'Service Account', 'Jan 10, 2025'],
];
const auditEvents = [
  ['Jan 21, 10:24 AM', 'alex.chen@zenchron.dev', 'integration.update', 'Updated GitHub integration (org: zenchron-engineering)'],
  ['Jan 21, 09:18 AM', 'system', 'policy.update', 'Enabled “Evidence Capture” policy (v1.3)'],
  ['Jan 21, 08:47 AM', 'maria@zenchron.dev', 'secret.rotate', 'Rotated OPENAI_API_KEY (success)'],
];

function Toggle({ label, checked = true }: { label: string; checked?: boolean }) {
  return <Switch className="system-preview-switch" size="xs" checked={checked} disabled aria-label={label} />;
}

function Status({ children, healthy = true }: { children: string; healthy?: boolean }) {
  return <Badge className={healthy ? 'system-preview-status connected' : 'system-preview-status'}>{children}</Badge>;
}

function StaticField({ label, value, select = false }: { label: string; value: string; select?: boolean }) {
  return <label className="system-preview-field"><span>{label}</span><TextInput aria-label={label} value={value} readOnly
    rightSection={select ? <span className="system-preview-chevron">⌄</span> : undefined} /></label>;
}

export function SystemIntegrationsPreview({ section }: { section: 'integrations' | 'settings' }) {
  return <div className="system-workspace system-preview-workspace">
    <nav className="system-config-nav" aria-label="Configuration categories">
      <b>Configuration</b><small>INTEGRATIONS</small>
      <a className={section === 'integrations' ? 'active' : ''} href="#integrations" aria-current={section === 'integrations' ? 'page' : undefined}>
        <IconDatabase size={12} />Connected Integrations</a>
      <span><IconBrandOpenai size={12} />Model Providers</span>
      <span><IconCloud size={12} />Runners &amp; Infrastructure</span>
      <span><IconDatabase size={12} />Storage &amp; Evidence</span>
      <small>SETTINGS</small>
      <a className={section === 'settings' ? 'active' : ''} href="#settings" aria-current={section === 'settings' ? 'page' : undefined}>
        <IconBuilding size={12} />Organization Profile</a>
      <span><IconShieldCheck size={12} />Policies</span>
      <span><IconUsers size={12} />Permissions</span>
      <span><span className="system-preview-dollar">$</span>Budgets</span>
      <span><IconKey size={12} />Secrets</span>
      <span><IconSettings size={12} />Controller Configuration</span>
      <span><IconBell size={12} />Notification Rules</span>
    </nav>

    <div className="system-workspace-main">
      {section === 'integrations' && <>
      <div className="system-integration-header system-preview-integration-header">
        <PanelHeading className="system-section-heading" title="Integrations Overview"
          description="Connect your engineering tools, model providers, infrastructure, and data backends." />
        <div className="system-integration-filters" aria-label="Integration categories">
          {categories.map(([name, count], index) => <span className={index === 0 ? 'active' : ''} key={name}>
            {name} <b>{count}</b>
          </span>)}
        </div>
      </div>

      <div className="system-service-grid system-preview-service-grid">
        {providers.map((provider) => <PanelCard className="system-service-card system-preview-provider" key={provider.name} withBorder>
          <span className={`system-preview-provider-icon ${provider.color}`}>{provider.icon}</span>
          <div className="system-service-copy">
            <h4>{provider.name}</h4><p>{provider.detail}</p>
            <small className="system-preview-provider-link">{provider.link}</small>
          </div>
          <div className="system-preview-provider-control"><Status>Connected</Status><Toggle label={`${provider.name} connected`} /></div>
        </PanelCard>)}
        <PanelCard className="system-add-integration system-preview-add-integration" withBorder>
          <span>＋</span><div><b>Add Integration</b><small>Connect another tool, model provider, runner, or storage backend.</small></div>
        </PanelCard>
      </div>
      </>}

      <div className="system-preview-settings-grid">
        <PanelCard className="system-preview-card system-preview-profile" withBorder>
          <PanelHeading title="Organization Profile" icon={<IconBuilding size={15} />} />
          <div className="system-preview-profile-fields">
            <StaticField label="Organization Name" value="Zenchron Engineering" />
            <StaticField label="Organization Slug" value="zenchron-eng" />
            <StaticField label="Timezone" value="UTC-08:00 (Pacific Time)" select />
            <StaticField label="Default Product" value="Core Product" select />
          </div>
        </PanelCard>
        <PanelCard className="system-preview-card system-preview-policy" withBorder>
          <PanelHeading title="Policies" icon={<IconShieldCheck size={15} />} />
          <div className="system-preview-policies">{policies.map((policy) => <span key={policy}>{policy}<b>×</b></span>)}</div>
          <button className="system-preview-add-policy" disabled>＋ Add Policy</button>
        </PanelCard>
        <PanelCard className="system-preview-card system-preview-permissions" withBorder>
          <PanelHeading title="Permissions" icon={<IconUsers size={15} />} />
          <div className="system-preview-card-action">Manage Roles →</div>
          <table><thead><tr><th>Role</th><th>Members</th><th>Access</th></tr></thead><tbody>
            <tr><td>Admin</td><td>3</td><td>Full platform access</td></tr>
            <tr><td>Maintainer</td><td>12</td><td>Configure, run, manage agents</td></tr>
            <tr><td>Viewer</td><td>27</td><td>Read-only access and audit logs</td></tr>
          </tbody></table>
        </PanelCard>

        <PanelCard className="system-preview-card system-preview-budget" withBorder>
          <PanelHeading title="Budgets" icon={<span className="system-preview-dollar">$</span>} />
          <div className="system-preview-card-action">View Usage →</div>
          <div className="system-preview-budget-value"><strong>$13.6k</strong><span> / $20k</span><b>68%</b></div>
          <Progress value={68} color="violet" />
          <div className="system-preview-budget-rows">
            <span>Model Inference <b>$7.9k (58%)</b></span><span>Runners &amp; Compute <b>$3.8k (28%)</b></span>
            <span>Storage &amp; Evidence <b>$1.2k (9%)</b></span><span>Other <b>$0.7k (5%)</b></span>
          </div>
        </PanelCard>
        <PanelCard className="system-preview-card system-preview-secrets" withBorder>
          <PanelHeading title="Secrets" icon={<IconKey size={15} />} />
          <div className="system-preview-card-action">Manage Secrets →</div>
          <table><thead><tr><th>Name</th><th>Type</th><th>Last Rotated</th><th>Status</th></tr></thead><tbody>
            {secrets.map(([name, type, date]) => <tr key={name}><td><IconKey size={11} />{name}</td><td>{type}</td><td>{date}</td><td><Status>Active</Status></td></tr>)}
          </tbody></table>
          <button className="system-preview-add-policy" disabled>＋ Add Secret</button>
        </PanelCard>
        <PanelCard className="system-preview-card system-preview-controller" withBorder>
          <PanelHeading title="Controller Configuration" icon={<IconSettings size={15} />} />
          <div className="system-preview-controller-values"><span>Agent Controller</span><b>v2.4.0 (Stable)</b><Status>Healthy</Status></div>
          <div className="system-preview-slider"><span>Max Concurrent Runs</span><b>12</b><i><em /></i></div>
          <div className="system-preview-controller-values"><span>Default Run Timeout</span><b>2 hours</b></div>
          <div className="system-preview-toggles"><span><Toggle label="Auto-scale Runners" />Auto-scale Runners</span>
            <span><Toggle label="Capture Evidence by Default" />Capture Evidence by Default</span></div>
        </PanelCard>

        <PanelCard className="system-preview-card system-preview-notifications" withBorder>
          <PanelHeading title="Notification Rules" icon={<IconBell size={15} />} />
          <button className="system-preview-card-action system-preview-add-rule" disabled>＋ Add Rule</button>
          <table><thead><tr><th>Event</th><th>Channel</th><th>Recipients</th><th>Status</th></tr></thead><tbody>
            <tr><td>◉ Run Failed</td><td>◉ Slack</td><td>#eng-alerts</td><td><Toggle label="Run failed notification" /></td></tr>
            <tr><td>◉ Awaiting Review</td><td>◉ Slack</td><td>#eng-reviews</td><td><Toggle label="Awaiting review notification" /></td></tr>
            <tr><td>◉ Budget Threshold (≥ 80%)</td><td>✉ Email</td><td>platform@zenchron.dev</td><td><Toggle label="Budget threshold notification" /></td></tr>
          </tbody></table>
        </PanelCard>
        <PanelCard className="system-preview-card system-preview-audit" withBorder>
          <PanelHeading title="Recent Audit Log" icon={<IconDatabase size={15} />} />
          <div className="system-preview-card-action">View Full Audit Log →</div>
          <table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead><tbody>
            {auditEvents.map(([time, actor, action, detail]) => <tr key={time}><td>{time}</td><td>{actor}</td><td>{action}</td><td>{detail}</td></tr>)}
          </tbody></table>
        </PanelCard>
      </div>
      <div className="system-preview-actions">
        <button disabled>Discard Changes</button><button disabled>Test Connections</button><button className="primary" disabled>✓ Save Changes</button>
      </div>
    </div>
  </div>;
}
