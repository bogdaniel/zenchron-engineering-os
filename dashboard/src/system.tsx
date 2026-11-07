import { Badge, Button, Card } from '@mantine/core';
import { PageHeading } from './PageHeading';
import { PanelHeading } from './PanelHeading';
import { PanelCard } from './PanelCard';
import { SystemIntegrationsPreview } from './SystemIntegrationsPreview';
import {
  IconActivity,
  IconBell,
  IconBuilding,
  IconChecklist,
  IconGitBranch,
  IconCloud,
  IconCurrencyDollar,
  IconDatabase,
  IconHistory,
  IconKey,
  IconRobot,
  IconSettings,
  IconShieldCheck,
  IconUsers,
} from '@tabler/icons-react';
import './system.css';
import './system-preview.css';

type SystemSection = 'integrations' | 'settings';

interface SystemPageProps {
  section: SystemSection;
  designPreview?: boolean;
  apiOnline: boolean;
  githubLogin: boolean;
  workerCount: number;
  onlineWorkerCount: number;
  modelRuntimeWorkerCount: number;
  modelRuntimeUnknownWorkerCount: number;
  projectCount: number;
  gitHubProjectCount: number;
}

export function SystemPage({
  section, designPreview = false, apiOnline, githubLogin, workerCount, onlineWorkerCount, modelRuntimeWorkerCount, modelRuntimeUnknownWorkerCount,
  projectCount, gitHubProjectCount,
}: SystemPageProps) {
  const modelEndpointDetail = modelRuntimeWorkerCount
    ? `OpenAI-compatible endpoint configured on ${modelRuntimeWorkerCount} online worker${modelRuntimeWorkerCount === 1 ? '' : 's'}.` +
      (modelRuntimeUnknownWorkerCount
        ? ` Status is unreported by ${modelRuntimeUnknownWorkerCount} other online worker${modelRuntimeUnknownWorkerCount === 1 ? '' : 's'}.`
        : '')
    : modelRuntimeUnknownWorkerCount
      ? `${modelRuntimeUnknownWorkerCount} online worker${modelRuntimeUnknownWorkerCount === 1 ? ' has' : 's have'} not reported endpoint status; restart ${modelRuntimeUnknownWorkerCount === 1 ? 'it' : 'them'} to refresh.`
      : onlineWorkerCount ? 'Configure an OpenAI-compatible endpoint on a worker to execute queued runs.'
        : 'No online worker is available to execute queued runs.';
  const modelEndpointStatus = modelRuntimeWorkerCount ? 'Configured'
    : modelRuntimeUnknownWorkerCount ? 'Update worker'
      : onlineWorkerCount ? 'Not configured' : 'Unavailable';
  const services = [
    {
      title: 'Control plane API',
      category: 'Runtime',
      detail: githubLogin
        ? 'Authenticated API for workspace state and worker commands.'
        : 'Loopback HTTP service for workspace state and worker commands.',
      status: apiOnline ? 'Online' : 'Offline',
      icon: <IconActivity size={19} />,
      healthy: apiOnline,
    },
    {
      title: 'Local workers',
      category: 'Execution',
      detail: `${onlineWorkerCount} of ${workerCount} workers reporting a recent heartbeat.`,
      status: onlineWorkerCount ? 'Connected' : 'Unavailable',
      icon: <IconRobot size={19} />,
      healthy: onlineWorkerCount > 0,
    },
    {
      title: 'Git provider',
      category: 'Source control',
      detail: gitHubProjectCount
        ? `${gitHubProjectCount} GitHub ${gitHubProjectCount === 1 ? 'repository' : 'repositories'} detected. PR comments and request-changes use the control-plane token.`
        : `${projectCount} local checkout${projectCount === 1 ? '' : 's'} visible; connect a github.com origin to sync issues and pull requests.`,
      status: gitHubProjectCount ? 'Read-only sync' : 'No GitHub repo',
      icon: <IconGitBranch size={19} />,
      healthy: gitHubProjectCount > 0,
    },
    {
      title: 'Model endpoint',
      category: 'AI models',
      detail: modelEndpointDetail,
      status: modelEndpointStatus,
      icon: <IconCloud size={19} />,
      healthy: modelRuntimeWorkerCount > 0,
    },
    {
      title: 'Evidence storage',
      category: 'Storage',
      detail: 'Run artifacts will appear after evidence capture is implemented.',
      status: 'Not configured',
      icon: <IconDatabase size={19} />,
      healthy: false,
    },
  ];
  const integrationCategories = ['Source control', 'Runtime', 'AI models', 'Execution', 'Storage'];

  return (
    <section className="system-page">
      <div className="system-heading">
        <div className="system-page-title">
          <IconSettings size={25} aria-hidden="true" />
          <PageHeading title="Settings & Integrations" description={designPreview
            ? 'Manage your organization, connect integrations, set policies, and control platform behavior.'
            : 'Review connected runtime services and the current control-plane boundary.'} />
        </div>
        <div className="system-page-actions">
          <Button className="system-quiet-button" variant="default" disabled><IconHistory size={14} /> Audit log</Button>
          <Button className="system-quiet-button" variant="default" disabled><IconDatabase size={14} /> Import / Export</Button>
          <Badge className="system-health" variant="light">
            <i />{designPreview ? 'All Systems Operational' : apiOnline ? 'API online' : 'API offline'}
          </Badge>
        </div>
      </div>

      <nav className="system-tabs" aria-label="Settings and integrations">
        <a className={section === 'integrations' ? 'active' : ''} href="#integrations">
          <IconSettings size={16} /> Integrations
        </a>
        <a className={section === 'settings' ? 'active' : ''} href="#settings">
          <IconShieldCheck size={16} /> Settings
        </a>
        <button type="button" disabled aria-label="Activity and audit history unavailable">
          <IconHistory size={16} /> Activity &amp; audit
        </button>
      </nav>

      {section === 'integrations' && designPreview ? <SystemIntegrationsPreview /> : section === 'integrations' ? (
        <div className="system-workspace">
          <nav className="system-config-nav" aria-label="Configuration categories">
            <b>Configuration</b>
            <small>INTEGRATIONS</small>
            <a className="active" href="#integrations"><IconActivity size={12} />Connected integrations</a>
            <span><IconRobot size={12} />Model providers</span>
            <span><IconCloud size={12} />Runners &amp; infrastructure</span>
            <span><IconDatabase size={12} />Storage &amp; evidence</span>
            <small>SETTINGS</small>
            <span><IconBuilding size={12} />Organization profile</span>
            <span><IconChecklist size={12} />Policies</span>
            <span><IconUsers size={12} />Permissions</span>
            <span><IconCurrencyDollar size={12} />Budgets</span>
            <span><IconKey size={12} />Secrets</span>
            <span><IconSettings size={12} />Controller configuration</span>
            <span><IconBell size={12} />Notification rules</span>
          </nav>

          <div className="system-workspace-main">
            <div className="system-integration-header">
              <PanelHeading className="system-section-heading" title="Integrations overview"
                description="Live runtime connections and provider availability." />
              <div className="system-integration-filters" aria-label="Integration categories">
                <span className="active">All <b>{services.length}</b></span>
                {integrationCategories.map((category) => (
                  <span key={category}>{category}<b>{services.filter((service) => service.category === category).length}</b></span>
                ))}
              </div>
            </div>
            <div className="system-service-grid">
              {services.map((service) => (
                <PanelCard className="system-service-card" key={service.title} withBorder>
                  <span className="system-service-icon">{service.icon}</span>
                  <div className="system-service-copy">
                    <small>{service.category}</small>
                    <h4>{service.title}</h4>
                  <p title={service.detail}>{service.detail}</p>
                  </div>
                  <Badge
                    className={service.healthy ? 'system-status healthy' : 'system-status unavailable'}
                    variant="light"
                  >
                    {service.status}
                  </Badge>
                </PanelCard>
              ))}
              <PanelCard className="system-add-integration" withBorder>
                <span>＋</span>
                <div><b>Add integration</b><small>Provider setup is not available in this local preview.</small></div>
              </PanelCard>
            </div>

            <div className="system-operations-grid">
              <PanelCard className="system-operation-card" withBorder>
                <PanelHeading title="Organization profile" icon={<IconBuilding size={16} />} />
                <p>Organization identity and defaults are not configured in this local preview.</p>
                <Badge className="system-status unavailable" variant="light">Unavailable</Badge>
              </PanelCard>
              <PanelCard className="system-operation-card" withBorder>
                <PanelHeading title="Policies" icon={<IconChecklist size={16} />} />
                <p>Merge rules, approval gates, and repository policy are not enforced.</p>
                <Badge className="system-status unavailable" variant="light">Not configured</Badge>
              </PanelCard>
              <PanelCard className="system-operation-card" withBorder>
                <PanelHeading title="Permissions" icon={<IconUsers size={16} />} />
                <p>User accounts, roles, and dashboard authorization are unavailable.</p>
                <Badge className="system-status unavailable" variant="light">Unavailable</Badge>
              </PanelCard>
              <PanelCard className="system-operation-card" withBorder>
                <PanelHeading title="Budgets" icon={<IconCurrencyDollar size={16} />} />
                <p>Model spend, worker compute, and storage usage are not measured.</p>
                <Badge className="system-status unavailable" variant="light">Not tracked</Badge>
              </PanelCard>
              <PanelCard className="system-operation-card" withBorder>
                <PanelHeading title="Secrets" icon={<IconKey size={16} />} />
                <p>Model credentials stay on workers; GitHub credentials stay on the control plane.</p>
                <Badge className="system-status healthy" variant="light">Boundary enforced</Badge>
              </PanelCard>
              <PanelCard className="system-operation-card" withBorder>
                <PanelHeading title="Controller configuration" icon={<IconSettings size={16} />} />
                <div className="system-setting-values">
                  <span>Dashboard auth<b>{githubLogin ? 'GitHub OAuth' : 'Local preview'}</b></span>
                  <span>Online workers<b>{onlineWorkerCount} of {workerCount}</b></span>
                  <span>Local checkouts<b>{projectCount}</b></span>
                </div>
              </PanelCard>
              <PanelCard className="system-operation-card" withBorder>
                <PanelHeading title="Notification rules" icon={<IconBell size={16} />} />
                <p>Run alerts and review notifications are not configured.</p>
                <Badge className="system-status unavailable" variant="light">Unavailable</Badge>
              </PanelCard>
              <PanelCard className="system-operation-card system-audit-card" withBorder>
                <PanelHeading title="Recent audit log" icon={<IconHistory size={16} />} />
                <p>Audit history is unavailable until audit storage is implemented.</p>
                <Badge className="system-status unavailable" variant="light">Unavailable</Badge>
              </PanelCard>
            </div>
            <p className="system-notice" id="integration-notice">
              GitHub reviews are submitted as the control-plane token owner. Merge actions and provider setup are not available here.
            </p>
          </div>
        </div>
      ) : (
        <div className="system-settings-grid">
          <PanelCard className="system-setting-card" withBorder>
            <PanelHeading
              className="system-setting-heading"
              eyebrow="Controller configuration"
              title="Local control plane"
              icon={<span className="system-setting-icon"><IconActivity size={19} /></span>} />
            <dl>
              <div><dt>Dashboard auth</dt><dd>{githubLogin ? 'GitHub OAuth' : 'Local preview'}</dd></div>
              <div><dt>State storage</dt><dd>Versioned JSON snapshots</dd></div>
            </dl>
            <p>{githubLogin
              ? 'Remote API access requires HTTPS and the configured worker bearer token.'
              : 'Remote access requires GitHub sign-in and worker authentication to be configured.'}</p>
          </PanelCard>
          <PanelCard className="system-setting-card" withBorder>
            <PanelHeading className="system-setting-heading" eyebrow="Workers & projects" title="Live inventory"
              icon={<span className="system-setting-icon"><IconRobot size={19} /></span>} />
            <dl>
              <div><dt>Online workers</dt><dd>{onlineWorkerCount} of {workerCount}</dd></div>
              <div><dt>Local checkouts</dt><dd>{projectCount}</dd></div>
            </dl>
            <p>Checkout names are visible; local filesystem paths stay on each worker.</p>
          </PanelCard>
          <PanelCard className="system-setting-card" withBorder>
            <PanelHeading className="system-setting-heading" eyebrow="Access & policy" title={githubLogin ? 'GitHub sign-in' : 'Local preview'}
              icon={<span className="system-setting-icon"><IconShieldCheck size={19} /></span>} />
            <dl>
              <div><dt>User accounts</dt><dd>{githubLogin ? 'Allowlisted GitHub users' : 'Local workspace'}</dd></div>
              <div><dt>Roles and permissions</dt><dd>Unavailable</dd></div>
            </dl>
            <p>{githubLogin
              ? 'GitHub OAuth identifies users; organization roles and permissions are not enforced.'
              : 'Local preview has no sign-in or organization authorization.'}</p>
          </PanelCard>
          <PanelCard className="system-setting-card" withBorder>
            <PanelHeading className="system-setting-heading" eyebrow="Secrets" title="No provider secrets"
              icon={<span className="system-setting-icon"><IconKey size={19} /></span>} />
            <dl>
              <div><dt>Model credentials</dt><dd>None stored</dd></div>
              <div><dt>Secret rotation</dt><dd>Unavailable</dd></div>
            </dl>
            <p>Secret management is not implemented in this preview.</p>
          </PanelCard>
          <PanelCard className="system-setting-card" withBorder>
            <PanelHeading className="system-setting-heading" eyebrow="Budgets & execution" title="Not applicable"
              icon={<span className="system-setting-icon"><IconCloud size={19} /></span>} />
            <dl>
              <div><dt>Model endpoints</dt><dd>{modelRuntimeWorkerCount} configured
                {modelRuntimeUnknownWorkerCount ? ` · ${modelRuntimeUnknownWorkerCount} unknown` : ''}</dd></div>
              <div><dt>Run budgets</dt><dd>Not enforced</dd></div>
            </dl>
            <p>
              Configured workers can run read-only tasks or write on isolated branches; test execution and cost limits
              are not enabled.
            </p>
          </PanelCard>
          <PanelCard className="system-setting-card" withBorder>
            <PanelHeading className="system-setting-heading" eyebrow="Audit & evidence" title="Not available"
              icon={<span className="system-setting-icon"><IconDatabase size={19} /></span>} />
            <dl>
              <div><dt>Actor history</dt><dd>Unavailable</dd></div>
              <div><dt>Run artifacts</dt><dd>Unavailable</dd></div>
            </dl>
            <p>Audit events require audit storage; artifacts require agent runs.</p>
          </PanelCard>
        </div>
      )}
    </section>
  );
}
