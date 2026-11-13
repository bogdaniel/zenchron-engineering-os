import { Badge, Button, Menu, Modal, Progress, Select, Switch, TextInput } from '@mantine/core';
import {
  IconBell, IconBrandOpenai, IconBuilding, IconChevronDown, IconCloud, IconDatabase, IconDots, IconExternalLink, IconEye,
  IconHistory, IconKey, IconSettings, IconShieldCheck, IconUsers,
} from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { PageHeading } from './PageHeading';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import { useMockSystem } from './system-preview-data';
import { liveSystemSource, type SystemFacts, type SystemInfo, type SystemSource } from './systemView';
import './system.css';
import './system-preview.css';

type SystemSection = 'integrations' | 'settings';

interface SystemPageProps extends SystemFacts {
  section: SystemSection;
  designPreview?: boolean;
}

const noActionsReason = 'Not available from the control plane';
const secretName = (value: string) => value.trim().toUpperCase().replaceAll(' ', '_');

function Toggle({ label, checked = true, onChange }: { label: string; checked?: boolean; onChange?: (checked: boolean) => void }) {
  return <Switch className="system-preview-switch" size="xs" checked={checked} disabled={!onChange}
    wrapperProps={{ title: onChange ? undefined : noActionsReason }}
    onChange={(event) => onChange?.(event.currentTarget.checked)} aria-label={label} />;
}

function Status({ children, healthy = true }: { children: string; healthy?: boolean }) {
  return <Badge className="system-preview-status"
    data-healthy={healthy || undefined}
    leftSection={healthy && <i className="system-preview-status-dot" aria-hidden="true" />}>
    {children}
  </Badge>;
}

function StaticField({ label, value, onChange, options }: { label: string; value: string; onChange?: (value: string) => void; options?: string[] }) {
  return <label className="system-preview-field"><span>{label}</span>{options
    ? <Select aria-label={label} value={value} disabled={!onChange} onChange={(next) => next && onChange?.(next)} data={options} />
    : <TextInput aria-label={label} value={value} disabled={!onChange} onChange={(event) => onChange?.(event.currentTarget.value)} />}</label>;
}

function SettingsHeading({ title, icon }: { title: string; icon: ReactNode }) {
  return <PanelHeading title={<>{title}<span className="system-preview-settings-badge">Settings</span></>} icon={icon} />;
}

function AuditTable({ events, className }: { events: string[][]; className?: string }) {
  return <div className="system-preview-table-scroll"><table className={className}><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead>
    <tbody>{events.map(([time, actor, action, detail]) => <tr key={time}><td>{time}</td><td>{actor}</td><td>{action}</td><td>{detail}</td></tr>)}</tbody></table></div>;
}

export function SystemPage({ section, designPreview = false, ...facts }: SystemPageProps) {
  const mock = useMockSystem();
  const source = designPreview ? mock : liveSystemSource(facts);
  const [auditOpen, setAuditOpen] = useState(false);
  const { audit } = source;
  const hasAudit = audit.events.length > 0;
  const auditReason = hasAudit ? undefined : source.notes.audit;
  const downloadAudit = () => {
    if (!audit.exportFile) return;
    const blob = new Blob([JSON.stringify(audit.exportFile.content, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = audit.exportFile.name; link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  return (
    <section className="system-page">
      <div className="system-heading">
        <div className="system-page-title">
          <IconSettings size={25} aria-hidden="true" />
          <PageHeading title="Settings & Integrations" description={source.description} />
        </div>
        <div className="system-page-actions">
          <Button className="system-quiet-button" variant="default" disabled={!hasAudit} title={auditReason} onClick={() => setAuditOpen(true)}><IconHistory size={14} /> Audit log</Button>
          <Button className="system-quiet-button" variant="default" disabled={!audit.exportFile} title={audit.exportFile ? undefined : auditReason}
            onClick={downloadAudit}><IconDatabase size={14} /> Import / Export</Button>
          <Badge className="system-health" variant="light"><i />{source.health}</Badge>
        </div>
      </div>

      <nav className="system-tabs" aria-label="Settings and integrations">
        <a className={section === 'integrations' ? 'active' : ''} href="#integrations">
          <IconSettings size={16} /> Integrations
        </a>
        <a className={section === 'settings' ? 'active' : ''} href="#settings">
          <IconShieldCheck size={16} /> Settings
        </a>
        <button type="button" disabled={!hasAudit} title={auditReason} onClick={() => setAuditOpen(true)} aria-label="Activity & Audit">
          <IconHistory size={16} /> Activity &amp; audit
        </button>
      </nav>

      <Modal opened={auditOpen} onClose={() => setAuditOpen(false)} title={audit.dialogTitle} centered size="lg">
        <AuditTable events={audit.events} className="system-preview-audit-table" />
      </Modal>

      <SystemWorkspace section={section} source={source} onShowAudit={() => setAuditOpen(true)} />
    </section>
  );
}

function SystemWorkspace({ section, source, onShowAudit }: { section: SystemSection; source: SystemSource; onShowAudit: () => void }) {
  const { actions, profile, controller, audit } = source;
  const [category, setCategory] = useState('All');
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [newProvider, setNewProvider] = useState('');
  const [secretOpen, setSecretOpen] = useState(false);
  const [newSecretName, setNewSecretName] = useState('');
  const [newSecretType, setNewSecretType] = useState('API Key');
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const locked = actions ? undefined : noActionsReason;
  const note = (key: keyof SystemSource['notes']) => source.notes[key] && <p className="system-preview-note">{source.notes[key]}</p>;
  const visibleProviders = source.providers.filter((provider) => category === 'All' || provider.category === category);
  const providerExists = source.providers.some((provider) => provider.name.toLowerCase() === newProvider.trim().toLowerCase());
  const secretExists = source.secrets.some(([name]) => name === secretName(newSecretName));
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
    if (!actions || !name || providerExists) return;
    actions.addProvider(name);
    setCategory('All'); setNewProvider(''); setAddOpen(false);
  };
  const addSecret = () => {
    const name = secretName(newSecretName);
    if (!actions || !name || secretExists) return;
    actions.addSecret(name, newSecretType);
    setNewSecretName(''); setNewSecretType('API Key'); setSecretOpen(false);
  };

  return <div className="system-workspace system-preview-workspace">
    <Modal opened={addOpen} onClose={() => setAddOpen(false)} title="Add integration · preview only" centered>
      <TextInput label="Integration name" value={newProvider} onChange={(event) => setNewProvider(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addProvider(); } }} />
      <Button mt="md" disabled={!newProvider.trim() || providerExists} onClick={addProvider}>Add to preview</Button>
    </Modal>
    <Modal opened={secretOpen} onClose={() => setSecretOpen(false)} title="Add secret · preview only" centered>
      <TextInput label="Secret name" value={newSecretName} onChange={(event) => setNewSecretName(event.currentTarget.value)} />
      <Select mt="sm" label="Secret type" value={newSecretType} onChange={(value) => value && setNewSecretType(value)}
        data={['API Key', 'Service Account']} />
      <Button mt="md" disabled={!newSecretName.trim() || secretExists} onClick={addSecret}>Add secret to preview</Button>
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
          {source.categories.map(([name, count]) => <button className={category === name ? 'active' : ''} key={name} type="button"
            aria-pressed={category === name} onClick={() => setCategory(name)}>
            {name} <b>({count})</b>
          </button>)}
          <Menu position="bottom-end"><Menu.Target><button className="system-preview-category-more" type="button" aria-label="More integration categories"><IconChevronDown size={12} /></button></Menu.Target>
            <Menu.Dropdown><Menu.Item onClick={() => setCategory('Other')}>Other</Menu.Item><Menu.Item onClick={() => setCategory('All')}>Show all integrations</Menu.Item></Menu.Dropdown>
          </Menu>
        </div>
      </div>

      <div className="system-service-grid system-preview-service-grid">
        {visibleProviders.map((provider) => {
          const link = provider.secret && revealed[provider.name] ? provider.secret : provider.link;
          return <PanelCard className="system-service-card system-preview-provider" key={provider.name} withBorder>
            <span className={`system-preview-provider-icon ${provider.color}`}>{provider.icon}</span>
            <div className="system-service-copy">
              <h4>{provider.name}</h4><p>{provider.detail}</p>
              <div className="system-preview-provider-link-row"><small className="system-preview-provider-link" title={link}><IconExternalLink size={10} />{link}</small>
                {provider.secret && <button type="button" aria-label={`${revealed[provider.name] ? 'Hide' : 'Reveal'} ${provider.name} preview key`}
                  onClick={() => setRevealed((current) => ({ ...current, [provider.name]: !current[provider.name] }))}><IconEye size={12} /></button>}
                <Menu position="bottom-end"><Menu.Target><button type="button" aria-label={`${provider.name} options`}><IconDots size={13} /></button></Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item onClick={() => setInfo({ title: `${provider.name} · ${provider.status}`, body: `${provider.detail}. ${link}` })}>View status</Menu.Item>
                    <Menu.Item disabled={!actions} title={locked} onClick={() => actions?.setConnected(provider.name, !provider.healthy)}>
                      {provider.healthy ? 'Disconnect' : 'Connect'}{source.localSuffix}</Menu.Item>
                  </Menu.Dropdown>
                </Menu></div>
            </div>
            <div className="system-preview-provider-control"><Status healthy={provider.healthy}>{provider.status}</Status>
              <Toggle label={`${provider.name} connected`} checked={provider.healthy}
                onChange={actions && ((value) => actions.setConnected(provider.name, value))} /></div>
          </PanelCard>;
        })}
        <button className="shared-panel-surface system-add-integration system-preview-add-integration" type="button"
          disabled={!actions} title={locked} onClick={() => setAddOpen(true)}>
          <span>＋</span><div><b>Add Integration</b><small>{source.notes.integrations ?? 'Connect another tool, model provider, runner, or storage backend.'}</small></div>
        </button>
      </div>
      </>}

      <div className="system-preview-settings-grid">
        <PanelCard id="system-preview-profile" className="system-preview-card system-preview-profile" withBorder>
          <SettingsHeading title="Organization Profile" icon={<IconBuilding size={15} />} />
          <div className="system-preview-profile-fields">
            <StaticField label="Organization Name" value={profile.name} onChange={actions && ((name) => actions.setProfile({ name }))} />
            <StaticField label="Organization Slug" value={profile.slug} onChange={actions && ((slug) => actions.setProfile({ slug }))} />
            <StaticField label="Timezone" value={profile.timezone} options={source.profileOptions.timezone}
              onChange={actions && ((timezone) => actions.setProfile({ timezone }))} />
            <StaticField label="Default Product" value={profile.product} options={source.profileOptions.product}
              onChange={actions && ((product) => actions.setProfile({ product }))} />
          </div>
          {note('profile')}
        </PanelCard>
        <PanelCard id="system-preview-policy" className="system-preview-card system-preview-policy" withBorder>
          <SettingsHeading title="Policies" icon={<IconShieldCheck size={15} />} />
          <div className="system-preview-policies">{source.policies.map((policy) => <span key={policy}>{policy}
            <button type="button" aria-label={`Remove ${policy}`} disabled={!actions} onClick={() => actions?.removePolicy(policy)}>×</button></span>)}</div>
          {note('policy')}
          <button className="system-preview-add-policy" disabled={!actions || !source.addablePolicies.length} title={locked}
            onClick={() => actions?.addPolicy(source.addablePolicies[0])}>＋ Add Policy</button>
        </PanelCard>
        <PanelCard id="system-preview-permissions" className="system-preview-card system-preview-permissions" withBorder>
          <SettingsHeading title="Permissions" icon={<IconUsers size={15} />} />
          <button className="system-preview-card-action" type="button" onClick={() => setInfo(source.info.roles)}>Manage Roles →</button>
          <div className="system-preview-table-scroll"><table><thead><tr><th>Role</th><th>Members</th><th>Access</th><th aria-label="Actions" /></tr></thead><tbody>
            {source.roles.map(([role, members, access]) => <tr key={role}><td>{role}</td><td>{members}</td><td>{access}</td>
              <td><Menu position="bottom-end"><Menu.Target><button type="button" aria-label={`${role} role options`}><IconDots size={13} /></button></Menu.Target>
                <Menu.Dropdown><Menu.Item onClick={() => setInfo(source.roleInfo(role))}>View details</Menu.Item></Menu.Dropdown>
              </Menu></td></tr>)}
          </tbody></table></div>
          {note('permissions')}
        </PanelCard>

        <PanelCard id="system-preview-budget" className="system-preview-card system-preview-budget" withBorder>
          <SettingsHeading title="Budgets" icon={<span className="system-preview-dollar">$</span>} />
          <button className="system-preview-card-action" type="button" onClick={() => setInfo(source.info.usage)}>View Usage →</button>
          <div className="system-preview-budget-value"><strong>{source.budget.spent}</strong><span>{source.budget.limit}</span><b>{source.budget.share}</b></div>
          <Progress value={source.budget.percent} color="violet" />
          <div className="system-preview-budget-rows">
            {source.budget.rows.map(([label, value]) => <span key={label}>{label} <b>{value}</b></span>)}
          </div>
          {note('budget')}
        </PanelCard>
        <PanelCard id="system-preview-secrets" className="system-preview-card system-preview-secrets" withBorder>
          <SettingsHeading title="Secrets" icon={<IconKey size={15} />} />
          <button className="system-preview-card-action" type="button" onClick={() => setInfo(source.info.secrets)}>Manage Secrets →</button>
          <div className="system-preview-table-scroll"><table><thead><tr><th>Name</th><th>Type</th><th>Last Rotated</th><th>Status</th><th aria-label="Actions" /></tr></thead><tbody>
            {source.secrets.map(([name, type, date]) => <tr key={name}><td><IconKey size={11} />{name}</td><td>{type}</td><td>{date}</td><td><Status>Active</Status></td>
              <td><Menu position="bottom-end"><Menu.Target><button type="button" aria-label={`${name} secret options`}><IconDots size={13} /></button></Menu.Target>
                <Menu.Dropdown><Menu.Item disabled={!actions} onClick={() => actions?.rotateSecret(name)}>Rotate preview secret</Menu.Item>
                  <Menu.Item color="red" disabled={!actions} onClick={() => actions?.removeSecret(name)}>Remove from preview</Menu.Item></Menu.Dropdown>
              </Menu></td></tr>)}
          </tbody></table></div>
          {note('secrets')}
          <button className="system-preview-add-policy" disabled={!actions} title={locked} onClick={() => setSecretOpen(true)}>＋ Add Secret</button>
        </PanelCard>
        <PanelCard id="system-preview-controller" className="system-preview-card system-preview-controller" withBorder>
          <SettingsHeading title="Controller Configuration" icon={<IconSettings size={15} />} />
          <div className="system-preview-controller-values"><span>Agent Controller</span><Select aria-label="Agent Controller version" value={controller.version}
            disabled={!actions} onChange={(version) => { if (version) actions?.setController({ version }); }} data={source.controllerOptions.version} />
            <Status healthy={source.controllerStatus.healthy}>{source.controllerStatus.label}</Status></div>
          <div className="system-preview-slider"><label htmlFor="preview-max-runs">Max Concurrent Runs</label><b>{controller.maxRuns ?? '—'}</b>
            <input id="preview-max-runs" aria-label="Max Concurrent Runs" type="range" min="1" max="20" value={controller.maxRuns ?? 1}
              disabled={!actions} title={locked} onChange={(event) => actions?.setController({ maxRuns: Number(event.currentTarget.value) })} /></div>
          <div className="system-preview-controller-values"><span>Default Run Timeout</span><Select aria-label="Default Run Timeout" value={controller.timeout}
            disabled={!actions} onChange={(timeout) => { if (timeout) actions?.setController({ timeout }); }} data={source.controllerOptions.timeout} /></div>
          {source.controllerFacts.map(([label, value]) => <div className="system-preview-controller-values" key={label}><span>{label}</span><b>{value}</b></div>)}
          <div className="system-preview-toggles">{['Auto-scale Runners', 'Capture Evidence by Default'].map((name) => <span key={name}>
            <Toggle label={name} checked={source.switches[name]} onChange={actions && ((value) => actions.setSwitch(name, value))} />{name}</span>)}</div>
          {note('controller')}
        </PanelCard>

        <PanelCard id="system-preview-notifications" className="system-preview-card system-preview-notifications" withBorder>
          <SettingsHeading title="Notification Rules" icon={<IconBell size={15} />} />
          <button className="system-preview-card-action system-preview-add-rule" type="button" disabled={!actions} title={locked}
            onClick={() => actions?.addRule()}>＋ Add Rule</button>
          <div className="system-preview-table-scroll"><table><thead><tr><th>Event</th><th>Channel</th><th>Recipients</th><th>Status</th><th aria-label="Actions" /></tr></thead><tbody>
            {source.notificationRules.map((rule) => <tr key={rule.label}><td>◉ {rule.event}</td><td>{rule.channel === 'Slack' ? '◉' : '✉'} {rule.channel}</td><td>{rule.recipient}</td>
              <td><Toggle label={rule.label} checked={source.switches[rule.label] ?? true} onChange={actions && ((value) => actions.setSwitch(rule.label, value))} /></td>
              <td><Menu position="bottom-end"><Menu.Target><button type="button" aria-label={`${rule.label} options`}><IconDots size={13} /></button></Menu.Target>
                <Menu.Dropdown><Menu.Item onClick={() => setInfo({ title: rule.event, body: `${rule.channel} notifications go to ${rule.recipient}.` })}>View rule</Menu.Item>
                  <Menu.Item color="red" disabled={!actions} onClick={() => actions?.removeRule(rule.label)}>Remove rule</Menu.Item></Menu.Dropdown>
              </Menu></td></tr>)}
          </tbody></table></div>
          {note('notifications')}
        </PanelCard>
        <PanelCard id="system-preview-audit" className="system-preview-card system-preview-audit" withBorder>
          <PanelHeading title="Recent Audit Log" icon={<IconDatabase size={15} />} />
          <button className="system-preview-card-action" type="button" disabled={!audit.events.length} onClick={onShowAudit}>View Full Audit Log →</button>
          <span className="system-preview-audit-range" title={audit.rangeTitle}>{audit.range}</span>
          <AuditTable events={audit.events} />
          {note('audit')}
        </PanelCard>
      </div>
      <div className="system-preview-actions">
        {source.notice && <span role="status">{source.notice}</span>}
        <button type="button" disabled={!source.changesPending} onClick={() => actions?.discard()}>Discard Changes</button>
        <button type="button" disabled={!source.connectionTest} title={source.connectionTest ? undefined : locked}
          onClick={() => setInfo(source.connectionTest ?? null)}>Test Connections</button>
        <button type="button" className="primary" disabled={!source.changesPending} onClick={() => actions?.save()}>✓ Save Changes</button>
      </div>
    </div>
  </div>;
}
