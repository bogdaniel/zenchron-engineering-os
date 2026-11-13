import { useState, type ReactNode } from 'react';
import { Badge, Button } from '@mantine/core';
import {
  IconAlertTriangle, IconArrowUp, IconCheck, IconClock, IconDiamond, IconDownload, IconFileText,
  IconLayoutBoard, IconPlayerPlay, IconPlus, IconRepeat, IconSettings, IconUserCheck,
} from '@tabler/icons-react';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import './workflow-sections-preview.css';
import { runDetailTabs, workflowStatusLabels } from './workflowsView';
import type { WorkflowDraft, WorkflowSectionsData } from './workflowsView';

export type WorkflowSection = 'Builder' | 'Runs' | 'Versions' | 'Schedules' | 'Permissions' | 'Settings';
type Section = Exclude<WorkflowSection, 'Builder'>;
const sections = [
  ['Builder', IconLayoutBoard], ['Runs', IconPlayerPlay], ['Versions', IconFileText],
  ['Schedules', IconRepeat], ['Permissions', IconUserCheck], ['Settings', IconSettings],
] as const;
type Definition = Pick<WorkflowDraft, 'name' | 'description' | 'status'>;
/** `onAction` is absent where the tab's controls have no service behind them; they are then off and say why. */
type SectionProps<Name extends keyof WorkflowSectionsData> = {
  data: WorkflowSectionsData[Name]; unavailable?: string; onAction?: (action: string) => void;
};

export function WorkflowSectionTabs({ section, onSelect }: {
  section: WorkflowSection; onSelect: (section: WorkflowSection) => void;
}) {
  return <nav className="workflow-section-tabs" aria-label="Workflow sections">
    {sections.map(([tab, Icon]) => <button className={section === tab ? 'selected' : ''}
      aria-current={section === tab ? 'page' : undefined}
      onClick={() => onSelect(tab)} key={tab}><Icon size={14} />{tab}</button>)}
  </nav>;
}

function SectionTitle({ title, description, action, actionIcon, unavailable, onAction }: {
  title: string; description: string; action: string; actionIcon?: ReactNode; unavailable?: string;
  onAction?: (action: string) => void;
}) {
  return <div className="workflow-section-preview-title">
    <div><h2>{title}</h2><p>{description}</p></div>
    <Button className="workflow-section-primary-action" disabled={!onAction} title={onAction ? undefined : unavailable}
      onClick={() => onAction?.(action)} leftSection={actionIcon}>{action}</Button>
  </div>;
}

function Unavailable({ children }: { children: ReactNode }) {
  return <p className="workflow-section-empty" role="status">{children}</p>;
}

const runMetricCards = [
  ['Running now', <IconPlayerPlay />], ['Succeeded', <IconCheck />], ['Failed', <IconAlertTriangle />],
  ['Avg. duration', <IconClock />],
] as const;
const runFacts = ['Elapsed', 'Agent cost', 'Artifacts'];

function RunSection({ data, unavailable, onAction }: SectionProps<'runs'>) {
  const [detailTab, setDetailTab] = useState<typeof runDetailTabs[number]>('STEPS');
  const { detail } = data;
  const exportLogs = (log: { filename: string; text: string }) => {
    const url = URL.createObjectURL(new Blob([log.text], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url; link.download = log.filename; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <>
    <SectionTitle title="Run History & Execution Monitoring" description="Inspect every execution, trace agent activity, and act on pending reviews." action="Run Workflow" actionIcon={<IconPlayerPlay size={14} />} unavailable={unavailable} onAction={onAction} />
    <div className="workflow-run-metrics">
      {runMetricCards.map(([label, icon], index) => <PanelCard className="workflow-section-card workflow-run-metric" key={label}>
        <span className="workflow-section-icon">{icon}</span><small>{label}</small><b>{data.metrics[index][0]}</b><em>{data.metrics[index][1]}</em>
      </PanelCard>)}
    </div>
    <div className="workflow-run-columns">
      <PanelCard className="workflow-section-card workflow-section-table">
        <PanelHeading title="Execution History" description="Select a run to see stage-by-stage output."
          actions={<button className="workflow-section-link" type="button" disabled={!onAction} title={onAction ? undefined : unavailable}
            onClick={() => onAction?.('Showing all runs')}>View all →</button>} />
        <div className="workflow-runs-table">
          <div className="workflow-table-head"><span>Run ID</span><span>Version</span><span>Started</span><span>Duration</span><span>Status</span></div>
          {data.rows.map(([id, version, started, duration, status], index) => <div className={`workflow-table-row${index === 0 ? ' selected' : ''}`} key={id}>
            <span>{id}</span><span>{version}</span><span>{started}</span><span>{duration}</span><Badge className={`workflow-run-status ${status.toLowerCase()}`}>{status}</Badge>
          </div>)}
        </div>
        {!data.rows.length && <Unavailable>{unavailable}</Unavailable>}
        <footer>{data.footer} {data.pages && <span>{data.pages}</span>}</footer>
      </PanelCard>
      <PanelCard className="workflow-section-card workflow-run-detail">
        <PanelHeading title={detail?.title ?? 'Run detail'} description={detail?.description ?? 'No run selected'} actions={<>
          {detail && <Badge className="workflow-run-status waiting">{detail.status}</Badge>}
          <button className="workflow-section-link" type="button" disabled={!detail} title={detail ? undefined : unavailable}
            onClick={() => detail && exportLogs(detail.log)}><IconDownload size={12} /> Export logs ↗</button>
        </>} />
        <div className="workflow-run-facts">
          {runFacts.map((fact, index) => <span key={fact}>{fact} <b>{detail?.facts[index] ?? 'Unavailable'}</b></span>)}
        </div>
        <nav className="workflow-detail-tabs" aria-label="Run detail views" role="tablist">
          {runDetailTabs.map((tab) => <button type="button" role="tab" key={tab} disabled={!detail}
            aria-selected={detailTab === tab} onClick={() => { setDetailTab(tab); onAction?.(`${tab} view selected`); }}>{tab}</button>)}
        </nav>
        <div className="workflow-run-steps">
          {detail?.views[detailTab].map(([label, detailText, state]) => <div className={`workflow-run-step ${state}`} key={label}>
            <i>{state === 'done' ? '✓' : state === 'waiting' ? 'Ⅱ' : '○'}</i><span>{label}<small>{detailText}</small></span>
          </div>)}
        </div>
        <Button className="workflow-section-bottom-action workflow-section-primary-action" disabled={!onAction}
          title={onAction ? undefined : unavailable} onClick={() => onAction?.('Review Approval')}>Review Approval</Button>
      </PanelCard>
    </div>
  </>;
}

function VersionsSection({ data, unavailable, onAction }: SectionProps<'versions'>) {
  const { compare } = data;
  return <>
    <SectionTitle title="Workflow Versions" description="Review draft changes, compare history, and publish known-good definitions." action="Publish Draft" actionIcon={<IconArrowUp size={14} />} unavailable={unavailable} onAction={onAction} />
    <div className="workflow-version-columns">
      <PanelCard className="workflow-section-card workflow-version-history">
        <PanelHeading title="Version History" description={data.summary} />
        {data.rows.map(([version, state, detail, byline], index) => <div className={`workflow-version-row${index === 0 ? ' selected' : ''}`} key={version}>
          <span className="workflow-section-icon"><IconFileText size={15} /></span><div><b>{version}</b><Badge className={`workflow-version-badge ${state.toLowerCase().replace(' ', '-')}`}>{state}</Badge><small>{detail}</small><small>{byline}</small></div>
        </div>)}
      </PanelCard>
      <PanelCard className="workflow-section-card workflow-version-compare">
        <PanelHeading title={data.compareTitle} description={data.compareDescription}
          actions={compare && <span className="workflow-section-link">{compare.changeCount}</span>} />
        {compare && <div className="workflow-compare-graphs">
          {compare.graphs.map(({ label, version, nodes, foot }) => <div className="workflow-compare-graph" key={label}>
            <small>{label}<Badge>{version}</Badge></small><div>{nodes.map((node, index) => <span key={node}>{index > 0 && '→'}<b>{node}</b></span>)}</div><footer>{foot}</footer>
          </div>)}
        </div>}
        <h3 className="workflow-section-kicker">CHANGE SUMMARY</h3>
        {compare?.changes.map(([state, kind, title, detail]) => <div className={`workflow-change-row ${state}`} key={title}><Badge>{kind}</Badge><span><b>{title}</b><small>{detail}</small></span></div>)}
        {!compare && <Unavailable>{unavailable}</Unavailable>}
        <div className="workflow-section-actions">
          <Button variant="default" disabled={!onAction} title={onAction ? undefined : unavailable} onClick={() => onAction?.('Restore Draft')}>Restore Draft</Button>
          <Button disabled={!onAction} title={onAction ? undefined : unavailable}
            onClick={() => onAction?.(compare?.publishLabel ?? 'Publish')}>{compare?.publishLabel ?? 'Publish'}</Button></div>
      </PanelCard>
    </div>
  </>;
}

const scheduleFields = ['Schedule name', 'Timezone', 'Frequency', 'Run at'];

function SchedulesSection({ data, unavailable, onAction }: SectionProps<'schedules'>) {
  const [enabled, setEnabled] = useState(() => data.rows.map((row) => row.isEnabled));
  return <>
    <SectionTitle title="Schedules & Triggers" description="Control how and when the workflow starts, and preview upcoming runs." action="New Schedule" actionIcon={<IconPlus size={14} />} unavailable={unavailable} onAction={onAction} />
    <div className="workflow-schedule-columns">
      <PanelCard className="workflow-section-card workflow-schedule-list">
        <PanelHeading title="Active Triggers" description={data.summary} />
        {data.rows.map(({ name, timing, next, isEvent }, index) => <div className={`workflow-schedule-row${index === 0 ? ' selected' : ''}`} key={name}>
          <span className="workflow-section-icon">{isEvent ? <IconDiamond size={15} /> : <IconFileText size={15} />}</span>
          <span><b>{name}</b><small>{timing}</small><small>{next}</small></span>
          <button type="button" role="switch" aria-label={`Enable ${name}`} aria-checked={enabled[index]}
            className={`workflow-static-toggle${enabled[index] ? '' : ' off'}`}
            onClick={() => setEnabled((current) => current.map((value, item) => item === index ? !value : value))} />
        </div>)}
        {!data.rows.length && <Unavailable>{unavailable}</Unavailable>}
        <footer>{data.timezone}</footer>
      </PanelCard>
      <PanelCard className="workflow-section-card workflow-schedule-calendar">
        <PanelHeading title="Execution Calendar" description={data.calendarDescription}
          actions={<button className="workflow-section-link" disabled={!onAction} title={onAction ? undefined : unavailable}
            onClick={() => onAction?.('This week')}>‹ This week ›</button>} />
        {data.days.length ? <div className="workflow-calendar-grid">{data.days.map(({ label, events }) => <div className="workflow-calendar-day" key={label}>
          <small>{label}</small>{events.map((event) => <span className={event.tone} key={event.label}>{event.label}</span>)}
        </div>)}</div> : <Unavailable>No runs are scheduled.</Unavailable>}
        <h3 className="workflow-section-kicker">SELECTED SCHEDULE SETTINGS</h3>
        <div className="workflow-static-fields">
          {scheduleFields.map((field, index) => <label key={field}>{field}<output>{data.selected[index]}</output></label>)}
        </div>
        <footer>{data.next} <Button disabled={!onAction} title={onAction ? undefined : unavailable}
          onClick={() => onAction?.('Save Schedule')}>Save Schedule</Button></footer>
      </PanelCard>
    </div>
  </>;
}

const permissionRoles = ['Owner', 'Editor', 'Operator', 'Viewer'];

function PermissionsSection({ data, unavailable, onAction }: SectionProps<'permissions'>) {
  const [protections, setProtections] = useState(() => data.protections.map((protection) => protection.isEnabled));
  return <>
    <SectionTitle title="Workflow Permissions" description="Manage collaborators, roles, and approvals for sensitive operations." action="Invite Member" actionIcon={<IconPlus size={14} />} unavailable={unavailable} onAction={onAction} />
    <div className="workflow-permission-columns">
      <div className="workflow-permission-left">
        <PanelCard className="workflow-section-card">
          <PanelHeading title="Collaborators" description="Members with access to this workflow" actions={<span className="workflow-section-link">{data.membersLabel}</span>} />
          {data.collaborators.map(([initial, name, role, access]) => <div className="workflow-collaborator" key={name}><i>{initial}</i><b>{name}</b><Badge>{role}</Badge><span>{access}</span></div>)}
          {!data.collaborators.length && <Unavailable>{unavailable}</Unavailable>}
        </PanelCard>
        <PanelCard className="workflow-section-card workflow-role-matrix">
          <PanelHeading title="Role Permission Matrix" description="Effective workflow-level grants" />
          {data.matrix.length ? <div className="workflow-matrix"><div><span>Capability</span>{permissionRoles.map((role) => <span key={role}>{role}</span>)}</div>
            {data.matrix.map((row) => <div key={row[0]}>{row.map((cell, index) => <span key={`${row[0]}-${index}`}>{cell}</span>)}</div>)}
          </div> : <Unavailable>No workflow-level grants are stored.</Unavailable>}
        </PanelCard>
      </div>
      <PanelCard className="workflow-section-card workflow-protection">
        <PanelHeading title="Protection & Approvals" description="Safeguards before merge and publication" />
        {data.protections.map(({ name, detail }, index) => <div className="workflow-protection-row" key={name}><span>{name}<small>{detail}</small></span>
          <button type="button" role="switch" aria-label={name} aria-checked={protections[index]}
            className={`workflow-static-toggle${protections[index] ? '' : ' off'}`}
            onClick={() => setProtections((current) => current.map((value, item) => item === index ? !value : value))} />
        </div>)}
        {!data.protections.length && <Unavailable>No protection rules are stored for this workflow.</Unavailable>}
        <label className="workflow-static-field">Minimum reviewers<output>{data.minimumReviewers}</output></label>
        <Button className="workflow-section-bottom-action" disabled={!onAction} title={onAction ? undefined : unavailable}
          onClick={() => onAction?.('Save Permissions')}>Save Permissions</Button>
      </PanelCard>
    </div>
  </>;
}

const contextFields = ['Repository', 'Target branch'];
const executionFields = ['Maximum run duration', 'Concurrent runs', 'Maximum retries', 'Retry backoff'];
type DefinitionEditing = {
  definition: Definition; isSaving: boolean; onDefinitionChange: (change: Partial<Definition>) => void; onSave: () => void;
};

/** Where the data carries no fixture name, the saved name, description, and status are edited and saved here. */
function SettingsSection({ data, unavailable, onAction, definition, isSaving, onDefinitionChange, onSave }: SectionProps<'settings'> & DefinitionEditing) {
  const isEditable = data.name === undefined;
  return <>
    <div className="workflow-section-preview-title">
      <div><h2>Workflow Settings</h2><p>Configure identity, execution budgets, recovery behavior, and integrations.</p></div>
      <Button className="workflow-section-primary-action" loading={isEditable && isSaving} disabled={!isEditable && !onAction}
        onClick={() => isEditable ? onSave() : onAction?.('Save Settings')}>Save Settings</Button>
    </div>
    <div className="workflow-settings-columns">
      <div className="workflow-settings-left">
        <PanelCard className="workflow-section-card"><PanelHeading title="General" description="Identity and default execution context" />
          <div className="workflow-static-fields one"><label>Workflow name{isEditable
            ? <input value={definition.name} maxLength={200} required onChange={(event) => onDefinitionChange({ name: event.currentTarget.value })} />
            : <output>{data.name}</output>}</label></div>
          {isEditable && <div className="workflow-static-fields">
            <label>Description<input value={definition.description} maxLength={1000}
              onChange={(event) => onDefinitionChange({ description: event.currentTarget.value })} /></label>
            <label>Status<select value={definition.status}
              onChange={(event) => onDefinitionChange({ status: event.currentTarget.value === 'active' ? 'active' : 'draft' })}>
              {Object.entries(workflowStatusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select></label>
          </div>}
          <div className="workflow-static-fields">
            {contextFields.map((field, index) => <label key={field}>{field}<output>{data.context[index]}</output></label>)}
          </div>
        </PanelCard>
        <PanelCard className="workflow-section-card"><PanelHeading title="Execution & Recovery" description="Limits and failure handling for each workflow run" />
          <div className="workflow-static-fields">
            {executionFields.map((field, index) => <label key={field}>{field}<output>{data.execution[index]}</output></label>)}
          </div>
          {data.checks.length > 0 && <div className="workflow-settings-checks">{data.checks.map((check) => <span key={check}>{check}</span>)}</div>}
        </PanelCard>
      </div>
      <div className="workflow-settings-right">
        <PanelCard className="workflow-section-card"><PanelHeading title="Connected Services" description="Providers used by this workflow" />
          {data.services.map(([name, detail]) => <div className="workflow-service-row" key={name}><span className="workflow-section-icon"><IconDiamond /></span><span><b>{name}</b><small>{detail}</small></span><Badge>READY</Badge></div>)}
          {!data.services.length && <Unavailable>{unavailable}</Unavailable>}
        </PanelCard>
        <PanelCard className="workflow-section-card"><PanelHeading title="Notifications & Lifecycle" description="Alerts and administrative actions" />
          {data.notifications.map((notification) => <div className="workflow-lifecycle-row" key={notification}>{notification} <span className="workflow-static-toggle" role="img" aria-label="On" /></div>)}
          {!data.notifications.length && <Unavailable>No notification rules are stored for this workflow.</Unavailable>}
          <footer><Button variant="default" disabled={!onAction} title={onAction ? undefined : unavailable} onClick={() => onAction?.('Archive Workflow')}>Archive Workflow</Button>
            <Button variant="default" disabled={!onAction} title={onAction ? undefined : unavailable} onClick={() => onAction?.('View Audit Log')}>View Audit Log</Button></footer>
        </PanelCard>
      </div>
    </div>
  </>;
}

export function WorkflowSectionView({ section, data, onAction, ...editing }: {
  section: Section; data: WorkflowSectionsData; onAction?: (action: string) => void;
} & DefinitionEditing) {
  const shared = { onAction, unavailable: data.unavailable?.[section.toLowerCase() as Lowercase<Section>] };
  return <section className={`workflow-section-preview workflow-section-${section.toLowerCase()}`}>
    {section === 'Runs' ? <RunSection data={data.runs} {...shared} /> : section === 'Versions' ? <VersionsSection data={data.versions} {...shared} />
      : section === 'Schedules' ? <SchedulesSection data={data.schedules} {...shared} />
        : section === 'Permissions' ? <PermissionsSection data={data.permissions} {...shared} />
          : <SettingsSection data={data.settings} {...shared} {...editing} />}
  </section>;
}
