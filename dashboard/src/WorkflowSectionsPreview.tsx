import { Badge, Button } from '@mantine/core';
import {
  IconAlertTriangle, IconCalendar, IconCheck, IconClock, IconCloud, IconDatabase, IconFileText,
  IconGitBranch, IconLayoutBoard, IconPlayerPlay, IconPlus, IconRepeat, IconSettings, IconUserCheck,
} from '@tabler/icons-react';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import './workflow-sections-preview.css';

export type WorkflowSection = 'Builder' | 'Runs' | 'Versions' | 'Schedules' | 'Permissions' | 'Settings';
type Section = Exclude<WorkflowSection, 'Builder'>;
const sections = [
  ['Builder', IconLayoutBoard], ['Runs', IconPlayerPlay], ['Versions', IconFileText],
  ['Schedules', IconRepeat], ['Permissions', IconUserCheck], ['Settings', IconSettings],
] as const;

export function WorkflowSectionTabs({ section, designPreview, onSelect }: {
  section: WorkflowSection; designPreview: boolean; onSelect: (section: WorkflowSection) => void;
}) {
  return <nav className="workflow-section-tabs" aria-label="Workflow sections">
    {sections.map(([tab, Icon]) => <button className={section === tab ? 'selected' : ''}
      aria-current={section === tab ? 'page' : undefined} disabled={!designPreview && tab !== 'Builder'}
      onClick={() => onSelect(tab)} key={tab}><Icon size={14} />{tab}</button>)}
  </nav>;
}

const runs = [
  ['RUN-10428', 'v2.4.0', '09:41 today', '2m 18s', 'Waiting'],
  ['RUN-10427', 'v2.4.0', '09:32 today', '3m 08s', 'Success'],
  ['RUN-10426', 'v2.4.0', '09:15 today', '1m 49s', 'Success'],
  ['RUN-10425', 'v2.3.2', '08:54 today', '2m 02s', 'Running'],
  ['RUN-10424', 'v2.3.2', '08:45 today', '4m 11s', 'Failed'],
];
const versions = [
  ['v2.4.0', 'CURRENT DRAFT', 'Coverage routing + merge gate refinement', 'Alex Chen · Today, 09:26'],
  ['v2.3.2', 'PUBLISHED', 'Review latency optimizations', 'Alex Chen · Nov 7'],
  ['v2.3.1', 'ARCHIVED', 'Test generation retries', 'Alex Chen · Nov 4'],
  ['v2.3.0', 'ARCHIVED', 'Parallel validation branch', 'Alex Chen · Oct 29'],
  ['v2.2.0', 'ARCHIVED', 'Human approval gate added', 'Alex Chen · Oct 24'],
];
const schedules = [
  ['Weekday PR Quality Check', 'Mon–Fri at 09:00', 'Next: Tue, Nov 10 at 09:00'],
  ['Nightly Regression Suite', 'Daily at 02:30', 'Next: Tue, Nov 10 at 02:30'],
  ['Release Candidate Review', 'Every Friday at 15:00', 'Next: Fri, Nov 13 at 15:00'],
  ['GitHub PR Webhook', 'On pull_request event', 'Event-driven, enabled'],
];

function SectionTitle({ title, description, action }: { title: string; description: string; action: string }) {
  return <div className="workflow-section-preview-title">
    <div><h2>{title}</h2><p>{description}</p></div>
    <Button disabled leftSection={<IconPlus size={14} />}>{action}</Button>
  </div>;
}

function RunSection() {
  return <>
    <SectionTitle title="Run History & Execution Monitoring" description="Inspect every execution, trace agent activity, and act on pending reviews." action="Run Workflow" />
    <div className="workflow-run-metrics">
      {[
        ['Running now', '3', '● Live', <IconPlayerPlay />], ['Succeeded', '128', '+8% this month', <IconCheck />],
        ['Failed', '6', 'Last 30 days', <IconAlertTriangle />], ['Avg. duration', '2m 14s', '−18%', <IconClock />],
      ].map(([label, value, note, icon]) => <PanelCard className="workflow-section-card workflow-run-metric" key={String(label)}>
        <span className="workflow-section-icon">{icon}</span><small>{label}</small><b>{value}</b><em>{note}</em>
      </PanelCard>)}
    </div>
    <div className="workflow-run-columns">
      <PanelCard className="workflow-section-card workflow-section-table">
        <PanelHeading title="Execution History" description="Select a run to see stage-by-stage output." actions={<span className="workflow-section-link">View all →</span>} />
        <div className="workflow-runs-table">
          <div className="workflow-table-head"><span>Run ID</span><span>Version</span><span>Started</span><span>Duration</span><span>Status</span></div>
          {runs.map(([id, version, started, duration, status], index) => <div className={`workflow-table-row${index === 0 ? ' selected' : ''}`} key={id}>
            <span>{id}</span><span>{version}</span><span>{started}</span><span>{duration}</span><Badge className={`workflow-run-status ${status.toLowerCase()}`}>{status}</Badge>
          </div>)}
        </div>
        <footer>Showing 1–5 of 137 runs <span>‹　1　2　3　…　28　›</span></footer>
      </PanelCard>
      <PanelCard className="workflow-section-card workflow-run-detail">
        <PanelHeading title="RUN-10428　/　PR #4827" description="Current execution · workflow v2.4.0" actions={<Badge className="workflow-run-status waiting">WAITING</Badge>} />
        <div className="workflow-run-facts"><span>Elapsed <b>2m 18s</b></span><span>Agent cost <b>$0.38 USD</b></span><span>Artifacts <b>7 verified</b></span></div>
        <nav className="workflow-detail-tabs"><b>STEPS</b><span>LOGS</span><span>ARTIFACTS</span><span>EVENTS</span></nav>
        <div className="workflow-run-steps">
          {[
            ['Trigger & Plan', 'Completed in 8s', 'done'], ['Agent Router', '3 profiles assigned', 'done'],
            ['Code Review + Tests', 'Parallel steps passed', 'done'], ['Human Approval', '1 of 2 approvals received', 'waiting'],
            ['Merge Gate & Publish', 'Waiting on approval', 'pending'],
          ].map(([label, detail, state]) => <div className={`workflow-run-step ${state}`} key={label}>
            <i>{state === 'done' ? '✓' : state === 'waiting' ? 'Ⅱ' : '○'}</i><span>{label}<small>{detail}</small></span>
          </div>)}
        </div>
        <Button disabled className="workflow-section-bottom-action">Review Approval</Button>
      </PanelCard>
    </div>
  </>;
}

function VersionsSection() {
  return <>
    <SectionTitle title="Workflow Versions" description="Review draft changes, compare history, and publish known-good definitions." action="Publish Draft" />
    <div className="workflow-version-columns">
      <PanelCard className="workflow-section-card workflow-version-history">
        <PanelHeading title="Version History" description="6 saved versions · newest first" />
        {versions.map(([version, state, detail, byline], index) => <div className={`workflow-version-row${index === 0 ? ' selected' : ''}`} key={version}>
          <span className="workflow-section-icon"><IconFileText size={15} /></span><div><b>{version}</b><Badge className={`workflow-version-badge ${state.toLowerCase().replace(' ', '-')}`}>{state}</Badge><small>{detail}</small><small>{byline}</small></div>
        </div>)}
      </PanelCard>
      <PanelCard className="workflow-section-card workflow-version-compare">
        <PanelHeading title="Compare v2.3.2 → v2.4.0" description="Current draft · 8 nodes · 11 edges" actions={<span className="workflow-section-link">3 changes</span>} />
        <div className="workflow-compare-graphs">
          {[
            ['BASELINE', 'v2.3.2', ['Trigger', 'Review', 'Approval'], '7 nodes　•　9 edges　•　Published Nov 7'],
            ['CURRENT DRAFT', 'v2.4.0', ['Trigger', 'Review + Test', 'Merge Gate'], '8 nodes　•　11 edges　•　Saved today'],
          ].map(([label, version, nodes, foot]) => <div className="workflow-compare-graph" key={label as string}>
            <small>{label}<Badge>{version}</Badge></small><div>{(nodes as string[]).map((node, index) => <span key={node}>{index > 0 && '→'}<b>{node}</b></span>)}</div><footer>{foot}</footer>
          </div>)}
        </div>
        <h3 className="workflow-section-kicker">CHANGE SUMMARY</h3>
        {[
          ['+ ADDED', 'Coverage Analyzer node', 'Parallel coverage threshold validation'],
          ['~ UPDATED', 'Merge Gate condition', 'Requires 80% coverage and approval'],
          ['→ ROUTED', 'Agent Router outputs', 'Additional test-generation fallback paths'],
        ].map(([kind, title, detail]) => <div className="workflow-change-row" key={title}><Badge>{kind}</Badge><span><b>{title}</b><small>{detail}</small></span></div>)}
        <div className="workflow-section-actions"><Button disabled variant="default">Restore Draft</Button><Button disabled>Publish v2.4.0</Button></div>
      </PanelCard>
    </div>
  </>;
}

function SchedulesSection() {
  const days = ['MON 9', 'TUE 10', 'WED 11', 'THU 12', 'FRI 13', 'SAT 14', 'SUN 15'];
  return <>
    <SectionTitle title="Schedules & Triggers" description="Control how and when the workflow starts, and preview upcoming runs." action="New Schedule" />
    <div className="workflow-schedule-columns">
      <PanelCard className="workflow-section-card workflow-schedule-list">
        <PanelHeading title="Active Triggers" description="4 schedules configured" />
        {schedules.map(([name, timing, next], index) => <div className={`workflow-schedule-row${index === 0 ? ' selected' : ''}`} key={name}>
          <span className="workflow-section-icon"><IconCalendar size={15} /></span><span><b>{name}</b><small>{timing}</small><small>{next}</small></span><i className="workflow-static-toggle" />
        </div>)}
        <footer>Timezone: Europe/Bucharest (EET/EEST)</footer>
      </PanelCard>
      <PanelCard className="workflow-section-card workflow-schedule-calendar">
        <PanelHeading title="Execution Calendar" description="Week of November 9–15, 2026" actions={<span className="workflow-section-link">‹ This week ›</span>} />
        <div className="workflow-calendar-grid">{days.map((day, index) => <div className="workflow-calendar-day" key={day}>
          <small>{day}</small>{index < 5 && <span>09:00 PR review</span>}{[1, 3, 5].includes(index) && <span className="test">02:30 Tests</span>}{index === 4 && <span className="release">15:00 Release</span>}
        </div>)}</div>
        <h3 className="workflow-section-kicker">SELECTED SCHEDULE SETTINGS</h3>
        <div className="workflow-static-fields">
          <label>Schedule name<output>Weekday PR Quality Check</output></label><label>Timezone<output>Europe/Bucharest</output></label>
          <label>Frequency<output>Weekdays (Monday–Friday)</output></label><label>Run at<output>09:00 local time</output></label>
        </div>
        <footer>Next: Tue, November 10 at 09:00 <Button disabled>Save Schedule</Button></footer>
      </PanelCard>
    </div>
  </>;
}

function PermissionsSection() {
  const roles = [
    ['A', 'Alex Chen', 'Owner', 'All permissions'], ['P', 'Priya Shah', 'Editor', 'Edit & submit reviews'],
    ['M', 'Marco Lee', 'Operator', 'Execute and monitor runs'], ['S', 'Sarah Kim', 'Viewer', 'Read-only access and audit logs'],
  ];
  const matrix = [
    ['View workflow', '✓', '✓', '✓', '✓'], ['Edit workflow', '✓', '✓', '–', '–'],
    ['Start execution', '✓', '✓', '✓', '–'], ['Approve protected steps', '✓', '–', '–', '–'], ['Publish a version', '✓', '–', '–', '–'],
  ];
  return <>
    <SectionTitle title="Workflow Permissions" description="Manage collaborators, roles, and approvals for sensitive operations." action="Invite Member" />
    <div className="workflow-permission-columns">
      <div className="workflow-permission-left">
        <PanelCard className="workflow-section-card">
          <PanelHeading title="Collaborators" description="Members with access to this workflow" actions={<span className="workflow-section-link">4 members</span>} />
          {roles.map(([initial, name, role, access]) => <div className="workflow-collaborator" key={name}><i>{initial}</i><b>{name}</b><Badge>{role}</Badge><span>{access}</span></div>)}
        </PanelCard>
        <PanelCard className="workflow-section-card workflow-role-matrix">
          <PanelHeading title="Role Permission Matrix" description="Effective workflow-level grants" />
          <div className="workflow-matrix"><div><span>Capability</span><span>Owner</span><span>Editor</span><span>Operator</span><span>Viewer</span></div>
            {matrix.map((row) => <div key={row[0]}>{row.map((cell, index) => <span key={`${row[0]}-${index}`}>{cell}</span>)}</div>)}
          </div>
        </PanelCard>
      </div>
      <PanelCard className="workflow-section-card workflow-protection">
        <PanelHeading title="Protection & Approvals" description="Safeguards before merge and publication" />
        {[
          ['Require approval before merge', 'Paused at Human Approval gate', true], ['Restrict version publishing', 'Owners only', true],
          ['Allow public sharing', 'Disabled for this workflow', false], ['Signed audit trail', 'Immutable event history', true],
        ].map(([name, detail, on]) => <div className="workflow-protection-row" key={name as string}><span>{name}<small>{detail}</small></span><i className={`workflow-static-toggle${on ? '' : ' off'}`} /></div>)}
        <label className="workflow-static-field">Minimum reviewers<output>2 distinct reviewers</output></label>
        <Button disabled className="workflow-section-bottom-action">Save Permissions</Button>
      </PanelCard>
    </div>
  </>;
}

function SettingsSection() {
  return <>
    <SectionTitle title="Workflow Settings" description="Configure identity, execution budgets, recovery behavior, and integrations." action="Save Settings" />
    <div className="workflow-settings-columns">
      <div className="workflow-settings-left">
        <PanelCard className="workflow-section-card"><PanelHeading title="General" description="Identity and default execution context" />
          <div className="workflow-static-fields one"><label>Workflow name<output>PR Review &amp; Release Orchestration</output></label></div>
          <div className="workflow-static-fields"><label>Repository<output>zenchron/engineering-os</output></label><label>Target branch<output>main</output></label></div>
        </PanelCard>
        <PanelCard className="workflow-section-card"><PanelHeading title="Execution & Recovery" description="Limits and failure handling for each workflow run" />
          <div className="workflow-static-fields"><label>Maximum run duration<output>45 minutes</output></label><label>Concurrent runs<output>4</output></label>
            <label>Maximum retries<output>2</output></label><label>Retry backoff<output>Exponential (5s–30s)</output></label></div>
          <div className="workflow-settings-checks"><span>● Stop on critical failure</span><span>● Capture run artifacts</span></div>
        </PanelCard>
      </div>
      <div className="workflow-settings-right">
        <PanelCard className="workflow-section-card"><PanelHeading title="Connected Services" description="Providers used by this workflow" />
          {[
            ['GitHub', 'Pull requests and branch events', <IconGitBranch />], ['LLM provider', 'Review and test agents', <IconCloud />], ['Evidence storage', 'Artifacts and logs', <IconDatabase />],
          ].map(([name, detail, icon]) => <div className="workflow-service-row" key={name as string}><span className="workflow-section-icon">{icon}</span><span><b>{name}</b><small>{detail}</small></span><Badge>READY</Badge></div>)}
        </PanelCard>
        <PanelCard className="workflow-section-card"><PanelHeading title="Notifications & Lifecycle" description="Alerts and administrative actions" />
          <div className="workflow-lifecycle-row">Notify on failed execution <i className="workflow-static-toggle" /></div>
          <div className="workflow-lifecycle-row">Notify assigned approvers <i className="workflow-static-toggle" /></div>
          <footer><Button disabled variant="default">Archive Workflow</Button><Button disabled variant="default">View Audit Log</Button></footer>
        </PanelCard>
      </div>
    </div>
  </>;
}

export function WorkflowSectionPreview({ section }: { section: Section }) {
  return <section className={`workflow-section-preview workflow-section-${section.toLowerCase()}`}>
    {section === 'Runs' ? <RunSection /> : section === 'Versions' ? <VersionsSection />
      : section === 'Schedules' ? <SchedulesSection /> : section === 'Permissions' ? <PermissionsSection /> : <SettingsSection />}
    <div className="workflow-section-concept">CONCEPT · ILLUSTRATIVE DATA</div>
  </section>;
}
