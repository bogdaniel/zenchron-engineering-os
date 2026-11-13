import React, { useState } from 'react';
import { useForm } from '@mantine/form';
import { Badge, Button, Menu, NumberInput, Progress, Select, Text, Textarea, TextInput } from '@mantine/core';
import { IconActivity, IconAlertTriangle, IconCalendar, IconChecklist, IconCube, IconDots, IconFileText,
  IconGitPullRequest, IconHierarchy, IconLink, IconListCheck, IconShieldCheck, IconStar, IconTarget,
  IconUser } from '@tabler/icons-react';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import { formatObjectiveDate, objectiveEditSchema, objectiveFormErrors } from './objectivesView';
import type { Objective, ObjectiveDetails, ObjectiveEdit, ObjectivesSource } from './objectivesView';

export type ObjectiveDetailTab = 'overview' | 'milestones' | 'pull-requests' | 'activity';

export const objectiveStatusOptions = [
  { value: 'in_progress', label: 'In Progress' },
  { value: 'on_track', label: 'On Track' },
  { value: 'at_risk', label: 'At Risk' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'completed', label: 'Completed' },
];
const detailTabs = [
  ['overview', 'Overview', IconTarget], ['milestones', 'Milestones', IconCalendar],
  ['pull-requests', 'Related PRs', IconGitPullRequest], ['activity', 'Activity', IconActivity],
] as const;
const unavailable = 'Unavailable';

export function objectiveProductName(item: Objective) {
  return item.product || 'Unassigned';
}

/** Fixture objectives carry a readable ID; control-plane IDs are 32 hex characters, shown by their first eight. */
export function objectiveDisplayID(id: string) {
  return id.startsWith('OBJ-') ? id : id.slice(0, 8).toUpperCase();
}

export function objectiveStatusBadge(status: Objective['status']) {
  return <Badge className={`objective-status ${status}`} variant="light">{status.replace('_', ' ')}</Badge>;
}

function notRecorded(what: string) {
  return `${unavailable}: the control plane does not record ${what} for objectives.`;
}

function ObjectivePreviewHeading({ icon: Icon, children, action }: {
  icon: typeof IconTarget; children: React.ReactNode; action?: React.ReactNode;
}) {
  return <b className="objective-preview-heading"><span><Icon size={13} aria-hidden="true" />{children}</span>{action}</b>;
}

function UnavailablePanel({ title, what }: { title: string; what: string }) {
  return <section className="objective-detail-unavailable" role="tabpanel"><b>{title}</b><p>{notRecorded(what)}</p></section>;
}

function ObjectiveEditForm({ item, source, onSaved, onCancel }: {
  item: Objective; source: ObjectivesSource; onSaved: () => void; onCancel: () => void;
}) {
  // Seeded once from the saved record when editing starts; the rest of the panel keeps reading the record itself.
  const form = useForm<ObjectiveEdit>({
    initialValues: { title: item.title, description: item.description, owner: item.owner, product_id: item.product_id,
      due_date: item.due_date, status: item.status, progress: item.progress },
    validate: (values) => objectiveFormErrors(objectiveEditSchema, values),
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  async function save(values: ObjectiveEdit) {
    setSaving(true);
    setSaveError('');
    try {
      await source.update(item.id, objectiveEditSchema.parse(values));
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save the objective.');
      setSaving(false);
      return;
    }
    onSaved();
  }

  return <form className="detail-edit-grid" onSubmit={form.onSubmit((values) => void save(values))}>
    <TextInput label="Objective title" required {...form.getInputProps('title')} />
    <Textarea label="Description" minRows={2} {...form.getInputProps('description')} />
    <TextInput label="Owner" {...form.getInputProps('owner')} />
    <TextInput label="Due date" type="date" {...form.getInputProps('due_date')} />
    <Select label="Status" data={objectiveStatusOptions} value={form.values.status}
      onChange={(value) => { if (value) form.setFieldValue('status', value as Objective['status']); }} />
    <NumberInput label="Progress" min={0} max={100} decimalScale={0} suffix="%" value={form.values.progress}
      error={form.errors.progress} onChange={(value) => form.setFieldValue('progress', Number(value) || 0)} />
    <Select label="Product" data={source.products} value={form.values.product_id || null}
      onChange={(value) => form.setFieldValue('product_id', value ?? '')}
      disabled={source.productsLoading || source.productsFailed} clearable />
    {source.productsFailed && <Text className="form-error" role="alert">
      Product choices are unavailable; the current assignment is unchanged.</Text>}
    {saveError && <Text className="form-error" role="alert">{saveError}</Text>}
    <div className="objective-form-actions">
      <Button variant="subtle" type="button" onClick={onCancel}>Cancel edit</Button>
      <Button className="save-objective-button" type="submit" loading={saving}>Save updates</Button>
    </div>
  </form>;
}

function ObjectiveOverview({ item, details, onTab }: {
  item: Objective; details: ObjectiveDetails; onTab: (tab: ObjectiveDetailTab) => void;
}) {
  const { blocker, acceptanceCriteria, relatedPullRequests, planSummary, activity } = details;
  return <div className="objective-overview-grid objective-preview-overview" role="tabpanel">
    <section className="objective-overview-card">
      <ObjectivePreviewHeading icon={IconFileText}>Description</ObjectivePreviewHeading>
      <p>{item.description || 'No description provided.'}</p>
    </section>
    <section className={`objective-overview-card${blocker ? ' objective-preview-blocker' : ''}`}>
      <ObjectivePreviewHeading icon={IconAlertTriangle} action={blocker && <button type="button"
        aria-label="View blocker details" onClick={() => onTab('pull-requests')}>View →</button>}>
        Blockers{blocker && ' (1)'}</ObjectivePreviewHeading>
      <p>{blocker ?? notRecorded('blockers')}</p>
    </section>
    <section className="objective-overview-card">
      <ObjectivePreviewHeading icon={IconChecklist}>Acceptance Criteria</ObjectivePreviewHeading>
      {acceptanceCriteria ? <ul>{acceptanceCriteria.map((line) => <li key={line}><span>{line}</span></li>)}</ul>
        : <p>{notRecorded('acceptance criteria')}</p>}
    </section>
    <section className="objective-overview-card">
      <ObjectivePreviewHeading icon={IconGitPullRequest} action={relatedPullRequests && <button type="button"
        aria-label="View all related pull requests" onClick={() => onTab('pull-requests')}>View All ↗</button>}>
        Related PRs{relatedPullRequests && ` (${relatedPullRequests.length})`}</ObjectivePreviewHeading>
      {relatedPullRequests ? <ul className="objective-preview-related-prs">{relatedPullRequests.map((pullRequest) =>
        <li key={pullRequest.id} className={pullRequest.status.toLowerCase()}>
          <IconGitPullRequest size={12} aria-hidden="true" /><span>{pullRequest.id} {pullRequest.title}</span>
          <em className={`objective-preview-pr-status ${pullRequest.status.toLowerCase()}`}>{pullRequest.status}</em>
        </li>)}</ul> : <p>{notRecorded('linked pull requests')}</p>}
    </section>
    <section className="objective-overview-card">
      <ObjectivePreviewHeading icon={IconListCheck}>Plan Summary</ObjectivePreviewHeading>
      {planSummary ? <ul>{planSummary.map((line) => <li key={line}><span>{line}</span></li>)}</ul>
        : <p>{notRecorded('a plan')}</p>}
    </section>
    <section className="objective-overview-card">
      <ObjectivePreviewHeading icon={IconActivity} action={activity && <button type="button"
        aria-label="View all objective activity" onClick={() => onTab('activity')}>View All ↗</button>}>
        Activity Feed</ObjectivePreviewHeading>
      {activity ? <ul>{activity.map((entry) => <li key={entry.text}><span>{entry.text}</span><em>{entry.time}</em></li>)}</ul>
        : <p>{notRecorded('activity')}</p>}
    </section>
  </div>;
}

function ObjectiveTabPanel({ tab, details }: { tab: Exclude<ObjectiveDetailTab, 'overview'>; details: ObjectiveDetails }) {
  if (tab === 'milestones') {
    if (!details.milestones) return <UnavailablePanel title="Milestones" what="milestones" />;
    return <div className="objective-detail-milestones" role="tabpanel">{details.milestones.map((milestone) =>
      <div key={milestone.title}><span>{milestone.title}</span><Progress value={milestone.progress} />
        <b>{milestone.progress}%</b><em>{milestone.status}</em></div>)}</div>;
  }
  if (tab === 'pull-requests') {
    if (!details.relatedPullRequests) return <UnavailablePanel title="Related pull requests" what="linked pull requests" />;
    return <div className="objective-detail-prs" role="tabpanel">{details.relatedPullRequests.map((pullRequest) =>
      <div key={pullRequest.id}><span>{pullRequest.id}</span><b>{pullRequest.title}</b><em>{pullRequest.status}</em></div>)}</div>;
  }
  if (!details.activity) return <UnavailablePanel title="Activity" what="activity" />;
  return <div className="objective-detail-activity" role="tabpanel">{details.activity.map((entry) =>
    <div key={entry.text}><span>{entry.text}</span><time>{entry.time}</time></div>)}</div>;
}

/** The selected objective: header actions, summary, tabs, and the editor that replaces the tab body while editing. */
export function ObjectiveDetail({ item, source, tab, editing, notice, onTab, onEditing, onNotice }: {
  item: Objective;
  source: ObjectivesSource;
  tab: ObjectiveDetailTab;
  editing: boolean;
  notice: string;
  onTab: (tab: ObjectiveDetailTab) => void;
  onEditing: (editing: boolean) => void;
  onNotice: (notice: string) => void;
}) {
  const details = source.view.details(item);
  const favorite = source.favorites?.ids.includes(item.id) ?? false;

  async function copyLink() {
    const url = new URL(window.location.href);
    url.searchParams.set('objective', item.id);
    url.hash = 'objectives';
    try {
      await navigator.clipboard.writeText(url.toString());
    } catch {
      // The browser refused clipboard access; the notice is the report.
      onNotice('Could not copy objective link');
      return;
    }
    onNotice('Objective link copied');
  }

  return <div className="objective-detail-content">
    <PanelHeading className="objective-detail-head entity-detail-heading"
      title={<>{item.title}<span className="objective-preview-id">{objectiveDisplayID(item.id)}</span></>}
      icon={<span className="detail-objective-icon"><IconTarget size={19} /></span>}
      actions={<div className="objective-preview-actions">
        <button type="button" aria-label={favorite ? 'Remove objective favorite' : 'Favorite objective'}
          aria-pressed={favorite} disabled={!source.favorites}
          title={source.favorites ? undefined : 'Unavailable: the control plane does not store favorites.'}
          onClick={() => source.favorites?.toggle(item.id)}><IconStar size={15} /></button>
        <button type="button" aria-label="Copy objective link" onClick={() => void copyLink()}><IconLink size={15} /></button>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><button type="button" aria-label="More objective actions"><IconDots size={16} /></button></Menu.Target>
          <Menu.Dropdown>
            <Menu.Item disabled={editing} onClick={() => { onTab('overview'); onEditing(true); }}>Edit objective</Menu.Item>
            <Menu.Item onClick={() => onTab('pull-requests')}>View related PRs</Menu.Item>
            <Menu.Item onClick={() => onTab('activity')}>View activity</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </div>} />
    {notice && <Text className="objective-action-notice" role="status">{notice}</Text>}
    <div className="detail-summary">{objectiveStatusBadge(item.status)}<span>{item.progress}% complete</span>
      <Progress value={item.progress} size="sm" />
      {item.due_date ? <time className="objective-detail-due-date" dateTime={item.due_date}>
        <IconCalendar size={13} aria-hidden="true" />Due {formatObjectiveDate(item.due_date)}</time>
        : <span className="objective-detail-due-date"><IconCalendar size={13} aria-hidden="true" />No due date</span>}
    </div>
    <div className="detail-meta-grid">
      <div><small>Owner</small><b><IconUser size={13} aria-hidden="true" />{item.owner || 'Unassigned'}</b></div>
      <div><small>Product</small><b><IconCube size={13} aria-hidden="true" />{objectiveProductName(item)}</b></div>
      <div><small>Approval</small><b><IconShieldCheck size={13} aria-hidden="true" />{item.approval ?? unavailable}</b></div>
      <div><small>Workflows</small><b><IconHierarchy size={13} aria-hidden="true" />
        {item.workflow_count === undefined ? unavailable : `${item.workflow_count} linked`}</b></div>
    </div>
    <div className="objective-detail-tabs" role="tablist" aria-label="Objective details">
      {detailTabs.map(([id, label, Icon]) => <button key={id} type="button" role="tab" aria-selected={tab === id}
        className={tab === id ? 'active' : ''} onClick={() => { onEditing(false); onTab(id); }}>
        <Icon size={13} aria-hidden="true" />{label}</button>)}
    </div>
    {editing ? <ObjectiveEditForm item={item} source={source} onCancel={() => onEditing(false)} onSaved={() => {
      onEditing(false);
      onNotice(`Objective updated${source.savedSuffix}`);
    }} /> : tab === 'overview' ? <ObjectiveOverview item={item} details={details} onTab={onTab} />
      : <ObjectiveTabPanel tab={tab} details={details} />}
  </div>;
}

/** Sits under the detail panel whether or not an objective is selected. */
export function ObjectiveMilestones({ details }: { details: ObjectiveDetails | undefined }) {
  const milestones = details?.milestones;
  return <PanelCard className="objective-milestones-card" withBorder>
    <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon">⚑</span>} title="Milestone Progress"
      actions={<span>{details?.milestoneSummary ?? unavailable}</span>} />
    {milestones ? <div className="objective-milestones-list">{milestones.map((milestone) => <div key={milestone.title}>
      <span className="objective-milestone-flag">⚑</span><span className="objective-milestone-name">{milestone.title}</span>
      <span className="objective-milestone-progress">
        <Progress value={milestone.progress} color={milestone.progress === 100 ? 'teal' : 'violet'} />
        <b>{milestone.progress}%</b></span>
      <Badge className={`objective-milestone-status ${milestone.status.toLowerCase().replace(' ', '-')}`}>{milestone.status}</Badge>
      <time>{milestone.date}</time>
    </div>)}</div> : <p className="objective-unavailable-note">The control plane does not record milestones for objectives.</p>}
  </PanelCard>;
}
