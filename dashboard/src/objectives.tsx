import React, { useEffect, useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, colorSchemeDark, themeQuartz } from 'ag-grid-community';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { AreaChart, Sparkline } from '@mantine/charts';
import { useForm } from '@mantine/form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Menu, Modal, NumberInput, Progress, Select, Text, Textarea, TextInput } from '@mantine/core';
import { IconActivity, IconAlertTriangle, IconCalendar, IconChecklist, IconCircleCheck, IconCube,
  IconDots, IconFileText, IconGitPullRequest, IconHierarchy, IconLink, IconListCheck, IconPlus, IconShieldCheck, IconStar, IconTarget,
  IconTargetArrow, IconUser } from '@tabler/icons-react';
import { z } from 'zod';
import { loadProducts } from './productEditor';
import { MetricCard } from './MetricCard';
import { PanelCard } from './PanelCard';
import { PageHeading } from './PageHeading';
import { PanelHeading } from './PanelHeading';
import { objectivePreviewCapacity, objectivePreviewDetails, objectivePreviewRecords } from './objective-preview';
import './objectives.css';

ModuleRegistry.registerModules([AllCommunityModule]);

const objectiveSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  owner: z.string(),
  product: z.string(),
  product_id: z.string().default(''),
  status: z.enum(['on_track', 'at_risk', 'blocked', 'in_progress', 'completed']),
  progress: z.number().int().min(0).max(100),
  due_date: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  approval: z.string().optional(),
  workflow_count: z.number().int().nonnegative().optional(),
});
export const objectivesSchema = z.array(objectiveSchema);
const createSchema = z.object({
  title: z.string().trim().min(1, 'Add an objective title').max(200),
  description: z.string().max(5000),
  owner: z.string().max(128),
  product_id: z.string().max(32),
  due_date: z.string().max(10),
});
export type Objective = z.infer<typeof objectiveSchema>;
type NewObjective = z.infer<typeof createSchema>;
function productName(item: Objective) {
  return item.product || 'Unassigned';
}
const objectiveDateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
function formatObjectiveDate(value: string) {
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : objectiveDateFormat.format(date);
}

const objectiveTheme = themeQuartz.withPart(colorSchemeDark).withParams({
  accentColor: '#a36bff',
  backgroundColor: '#11121b',
  foregroundColor: '#e4dfef',
  borderColor: '#2c293d',
  headerBackgroundColor: '#171622',
  headerTextColor: '#a7a1b8',
  fontSize: 11,
  rowHoverColor: '#201b2c',
  selectedRowBackgroundColor: '#292039',
});
const statusOptions = [
  { value: 'in_progress', label: 'In Progress' },
  { value: 'on_track', label: 'On Track' },
  { value: 'at_risk', label: 'At Risk' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'completed', label: 'Completed' },
];

async function loadObjectives(): Promise<Objective[]> {
  const response = await fetch('/api/v1/objectives');
  if (!response.ok) throw new Error(`Could not load objectives (${response.status})`);
  return objectivesSchema.parse(await response.json());
}

function statusBadge(status: Objective['status']) {
  return <Badge className={`objective-status ${status}`} variant="light">{status.replace('_', ' ')}</Badge>;
}

function ObjectivePreviewHeading({ icon: Icon, children }: { icon: typeof IconTarget; children: React.ReactNode }) {
  return <b><Icon size={13} aria-hidden="true" />{children}</b>;
}

function ObjectiveItemCard({ item, selected, productName, onSelect }: {
  item: Objective;
  selected: boolean;
  productName: string;
  onSelect: (item: Objective) => void;
}) {
  return <button type="button" className={`objective-item-card${selected ? ' selected' : ''}`}
    aria-pressed={selected} onClick={() => onSelect(item)}>
    <span className="objective-item-card-title">{item.title}{statusBadge(item.status)}</span>
    <span className="objective-item-card-meta"><span>{item.owner || 'Unassigned'}</span><span>{productName}</span></span>
    <span className="objective-item-card-progress"><Progress value={item.progress} size="xs" /><b>{item.progress}%</b></span>
    {item.due_date && <small>Due {formatObjectiveDate(item.due_date)}</small>}
  </button>;
}

function dueDateIsInQuarter(dueDate: string, quarterOffset: number, now: Date) {
  if (!dueDate) return false;
  const due = new Date(`${dueDate}T00:00:00`);
  if (Number.isNaN(due.getTime())) return false;
  const monthsPerQuarter = 3;
  const startMonth = Math.floor(now.getMonth() / monthsPerQuarter) * monthsPerQuarter + quarterOffset * monthsPerQuarter;
  const start = new Date(now.getFullYear(), startMonth, 1);
  const end = new Date(start.getFullYear(), start.getMonth() + monthsPerQuarter, 1);
  return due >= start && due < end;
}

function groupObjectivesByQuarter(items: Objective[]) {
  const groups = new Map<string, { order: number; items: Objective[] }>();
  for (const item of items) {
    const due = item.due_date ? new Date(`${item.due_date}T00:00:00`) : undefined;
    const quarter = due && !Number.isNaN(due.getTime()) ? Math.floor(due.getMonth() / 3) + 1 : undefined;
    const key = quarter ? `${due!.getFullYear()} Q${quarter}` : 'Unscheduled';
    const order = quarter ? due!.getFullYear() * 4 + quarter : Number.MAX_SAFE_INTEGER;
    const group = groups.get(key) ?? { order, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups].sort((left, right) => left[1].order - right[1].order);
}

export function ObjectivesPage({ sampleData = false }: { sampleData?: boolean }) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [detailTab, setDetailTab] = useState<'overview' | 'milestones' | 'pull-requests' | 'activity'>('overview');
  const [selectedID, setSelectedID] = useState<string | null>(() => new URLSearchParams(window.location.search).get('objective'));
  const [favoriteIDs, setFavoriteIDs] = useState<string[]>([]);
  const [actionNotice, setActionNotice] = useState('');
  const [progressValue, setProgressValue] = useState<number>(0);
  const [statusValue, setStatusValue] = useState<Objective['status']>('in_progress');
  const [productIDValue, setProductIDValue] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [search, setSearch] = useState('');
  const [productFilter, setProductFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dueQuarter, setDueQuarter] = useState<'this' | 'last' | 'all'>('this');
  const [section, setSection] = useState<'objectives' | 'planning' | 'roadmap'>('objectives');
  const [view, setView] = useState<'kanban' | 'table' | 'cards'>('table');
  const objectives = useQuery({ queryKey: ['objectives'], queryFn: loadObjectives, enabled: !sampleData,
    initialData: sampleData ? objectivePreviewRecords : undefined, retry: false });
  const products = useQuery({ queryKey: ['products'], queryFn: loadProducts, enabled: !sampleData, retry: false });
  const items = objectives.data ?? [];
  const selected = items.find((item) => item.id === selectedID) ?? items[0];
  const editForm = useForm<NewObjective>({
    initialValues: { title: '', description: '', owner: '', product_id: '', due_date: '' },
    validate: (values) => {
      const result = createSchema.safeParse(values);
      if (result.success) return {};
      return Object.fromEntries(result.error.issues.map((issue) => [String(issue.path[0]), issue.message]));
    },
  });
  useEffect(() => {
    if (!selected) return;
    setProgressValue(selected.progress);
    setStatusValue(selected.status);
    setProductIDValue(selected.product_id);
    editForm.setValues({ title: selected.title, description: selected.description, owner: selected.owner,
      product_id: selected.product_id, due_date: selected.due_date });
  }, [selected?.id, selected?.progress, selected?.status, selected?.product_id]);
  const createForm = useForm<NewObjective>({
    initialValues: { title: '', description: '', owner: '', product_id: '', due_date: '' },
    validate: (values) => {
      const result = createSchema.safeParse(values);
      if (result.success) return {};
      return Object.fromEntries(result.error.issues.map((issue) => [String(issue.path[0]), issue.message]));
    },
  });
  const createMutation = useMutation({
    mutationFn: async (input: NewObjective) => {
      const response = await fetch('/api/v1/objectives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(await response.text());
      return objectiveSchema.parse(await response.json());
    },
    onSuccess: async (item) => {
      await queryClient.invalidateQueries({ queryKey: ['objectives'] });
      setSelectedID(item.id);
      setEditing(false);
      setDetailTab('overview');
      setProgressValue(item.progress);
      setStatusValue(item.status);
      setProductIDValue(item.product_id);
      createForm.reset();
      setSubmitError('');
      setCreateOpen(false);
    },
    onError: (error) => setSubmitError(error.message),
  });
  const updateMutation = useMutation({
    mutationFn: async (input: {
      id: string;
      title: string;
      description: string;
      owner: string;
      due_date: string;
      status: Objective['status'];
      progress: number;
      product_id: string;
    }) => {
      const response = await fetch(`/api/v1/objectives/${input.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: input.title,
          description: input.description,
          owner: input.owner,
          due_date: input.due_date,
          status: input.status,
          progress: input.progress,
          product_id: input.product_id,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      return objectiveSchema.parse(await response.json());
    },
    onSuccess: async (item) => {
      await queryClient.invalidateQueries({ queryKey: ['objectives'] });
      setSelectedID(item.id);
      setProgressValue(item.progress);
      setStatusValue(item.status);
      setProductIDValue(item.product_id);
    },
  });
  const columns = useMemo<ColDef<Objective>[]>(() => [
    { field: 'title', headerName: 'Objective', flex: 1.8, minWidth: sampleData ? 138 : 130 },
    { field: 'owner', headerName: 'Owner', flex: .8, minWidth: sampleData ? 64 : 72, valueFormatter: ({ value }) => sampleData ? value?.replace(/\s+(\S).*$/, ' $1.') : value,
      cellRenderer: ({ value, valueFormatted }: ICellRendererParams<Objective, string>) => sampleData
        ? <span className="objective-owner-cell"><span className="objective-owner-avatar" aria-hidden="true">{value?.split(/\s+/).map((part) => part[0]).join('')}</span>{valueFormatted}</span>
        : value },
    { field: 'status', headerName: 'Status', flex: .9, minWidth: sampleData ? 76 : 78, cellRenderer: ({ value }: ICellRendererParams<Objective, Objective['status']>) => statusBadge(value ?? 'in_progress') },
    { field: 'progress', headerName: 'Progress', flex: 1, minWidth: sampleData ? 60 : 70, cellRenderer: ({ value, data }: ICellRendererParams<Objective, number>) => <div className="grid-progress"><span>{value ?? 0}%</span><Progress value={value ?? 0} size="xs" color={data?.status === 'on_track' ? 'teal' : data?.status === 'at_risk' ? 'yellow' : data?.status === 'blocked' ? 'red' : 'violet'} /></div> },
    {
      field: 'product', headerName: 'Product', flex: .9, minWidth: sampleData ? 86 : 85,
      valueGetter: ({ data }) => data ? productName(data) : 'Unassigned',
    },
    { field: 'approval', headerName: 'Approval', flex: .95, minWidth: sampleData ? 78 : 90, cellRenderer: ({ value }: ICellRendererParams<Objective, string>) => value ? <Badge className={`objective-approval-status ${value.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}`}>{value}</Badge> : '—' },
    { field: 'due_date', headerName: 'Due Date', flex: .85, minWidth: sampleData ? 75 : 86, valueFormatter: ({ value }) => value ? formatObjectiveDate(value) : '' },
    { field: 'workflow_count', headerName: 'Workflows', flex: .65, minWidth: sampleData ? 66 : 65, cellRenderer: ({ value }: ICellRendererParams<Objective, number>) => value === undefined ? '—' : <span className="objective-workflow-count"><IconHierarchy size={11} />{value}</span> },
  ], [sampleData]);
  const legacyProducts = Array.from(new Set(items.filter((item) => !item.product_id).map((item) => item.product)
    .filter((product) => product && !products.data?.some((known) => known.name === product))));
  const linkedProductOptions = items.filter((item) => item.product_id)
    .map((item) => ({ value: item.product_id, label: productName(item) }));
  const productOptions = [
    { value: 'all', label: 'All products' },
    ...new Map([...(products.data?.map((product) => ({ value: product.id, label: product.name })) ?? []),
      ...linkedProductOptions].map((option) => [option.value, option])).values(),
    ...legacyProducts.map((product) => ({ value: `legacy:${product}`, label: product })),
  ];
  const quarterReferenceDate = sampleData ? new Date(2025, 0, 20) : new Date();
  const filteredItems = items.filter((item) =>
    `${item.title} ${item.description} ${item.owner} ${productName(item)}`.toLowerCase().includes(search.toLowerCase()) &&
    (productFilter === 'all' || (item.product_id
      ? item.product_id === productFilter
      : `legacy:${item.product}` === productFilter)) &&
    (ownerFilter === 'all' || item.owner === ownerFilter) &&
    (statusFilter === 'all' || item.status === statusFilter) &&
    (dueQuarter === 'all' || dueDateIsInQuarter(item.due_date, dueQuarter === 'this' ? 0 : -1, quarterReferenceDate)),
  );
  const plannedItems = [...filteredItems].sort((left, right) =>
    (left.due_date || '9999-12-31').localeCompare(right.due_date || '9999-12-31'));
  const gridEmptyMessage = items.length
    ? 'No objectives match these filters.' : 'No objectives yet. Create one to begin.';
  const gridHint = !filteredItems.length ? (items.length ? 'No objectives match these filters.' : '')
    : section === 'planning' ? 'Sorted by due date' : 'Select an objective to inspect details';
  const roadmapGroups = groupObjectivesByQuarter(filteredItems);
  const completed = items.filter((item) => item.status === 'completed').length;
  const onTrack = items.filter((item) => item.status === 'on_track').length;
  const atRisk = items.filter((item) => item.status === 'at_risk').length;
  const blocked = items.filter((item) => item.status === 'blocked').length;

  function selectObjective(item: Objective) {
    setSelectedID(item.id);
    setEditing(false);
    setDetailTab('overview');
    setProgressValue(item.progress);
    setStatusValue(item.status);
    setProductIDValue(item.product_id);
  }

  function cancelEdit() {
    if (!selected) return;
    editForm.setValues({ title: selected.title, description: selected.description, owner: selected.owner,
      product_id: selected.product_id, due_date: selected.due_date });
    setProgressValue(selected.progress);
    setStatusValue(selected.status);
    setProductIDValue(selected.product_id);
    updateMutation.reset();
    setEditing(false);
  }

  return (
    <div className="objectives-page">
      <div className="objectives-title-row">
        <div className="objectives-title-copy">
          <span className="objectives-title-icon"><IconTarget size={25} /></span>
          <PageHeading title="Objectives" description="Plan, manage, and track engineering objectives across products, workflows, and delivery." />
        </div>
        <div className="objectives-title-actions">
          <div className="objective-filters">
            <Select aria-label="Filter by product" data={productOptions} value={productFilter}
              onChange={(value) => setProductFilter(value ?? 'all')} />
            <Select aria-label="Filter by owner" data={[{ value: 'all', label: 'All owners' }, ...Array.from(new Set(items.map((item) => item.owner).filter(Boolean))).map((owner) => ({ value: owner, label: owner }))]} value={ownerFilter} onChange={(value) => setOwnerFilter(value ?? 'all')} />
            <Select aria-label="Filter by status" data={[{ value: 'all', label: 'All statuses' }, ...statusOptions]} value={statusFilter} onChange={(value) => setStatusFilter(value ?? 'all')} />
            <Select aria-label="Filter by due quarter" data={[
              { value: 'this', label: 'This Quarter' }, { value: 'last', label: 'Last Quarter' },
              { value: 'all', label: 'All due dates' },
            ]} value={dueQuarter} onChange={(value) => setDueQuarter(value ?? 'this')} />
          </div>
          <Button className="new-objective-button" leftSection={<IconPlus size={16} />} onClick={() => { setSubmitError(''); setCreateOpen(true); }}>New Objective</Button>
        </div>
      </div>

      <section className={`objective-metrics${sampleData ? ' objective-metrics-preview' : ''}`}
        aria-label="Objective metrics">
        <MetricCard className="objective-metric purple" label={sampleData ? 'Objective Throughput' : 'Completed objectives'}
          value={sampleData ? '28' : completed} detail={sampleData ? 'Completed this quarter' : 'In workspace'} icon={<IconTarget size={18} />}
          trend={sampleData && <span className="objective-metric-trend"><Badge>↑ +40%</Badge><span className="objective-throughput-bars" aria-hidden="true">
            {[10, 14, 18, 16, 22, 27, 31].map((height, index) => <i key={index} style={{ height }} />)}
          </span></span>} />
        <MetricCard className="objective-metric teal" label={sampleData ? 'Objective Success Rate' : 'Completion rate'}
          value={sampleData ? '86.7%' : items.length ? `${Math.round(completed / items.length * 100)}%` : '—'}
          detail={sampleData ? undefined : 'Completed objectives / total'} icon={<IconTargetArrow size={18} />}
          trend={sampleData && <span className="objective-metric-trend"><Badge>↑ +6.9 pp</Badge>
            <Sparkline data={[3, 4, 3, 6, 5, 7, 8]} color="teal.4" w={54} h={24} withGradient={false} /></span>} />
        <MetricCard className="objective-metric" label="Total objectives" value={sampleData ? '42' : items.length} detail="Across this workspace" icon={<IconTarget size={18} />} />
        <MetricCard className="objective-metric green" label="On track" value={sampleData ? '28' : onTrack} detail="Objectives" icon={<IconCircleCheck size={18} />} />
        <MetricCard className="objective-metric amber" label="At risk" value={sampleData ? '7' : atRisk} detail="Objectives" icon={<IconAlertTriangle size={18} />} />
        <MetricCard className="objective-metric red" label="Blocked" value={sampleData ? '3' : blocked} detail="Objectives" icon={<IconAlertTriangle size={18} />} />
      </section>

      <div className={`objective-content-grid${sampleData ? ' objective-preview-layout' : ''}`}>
        <div className="objective-table-stack">
          <PanelCard className="objective-table-panel" withBorder>
            <div className="objectives-tabs" role="tablist" aria-label="Objective views">
              {(['objectives', 'planning', 'roadmap'] as const).map((tab) => (
                <button key={tab} type="button" role="tab" aria-selected={section === tab}
                  className={section === tab ? 'objective-section-active' : ''} onClick={() => setSection(tab)}>
                  {tab[0].toUpperCase() + tab.slice(1)}
                </button>
              ))}
              <span />
              {section === 'objectives' && (['kanban', 'table', 'cards'] as const).map((mode) => (
                <button key={mode} type="button" aria-pressed={view === mode}
                  className={view === mode ? 'view-active' : ''} onClick={() => setView(mode)}>
                  {mode === 'kanban' ? 'Kanban' : mode[0].toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
            <div className="objective-grid-toolbar"><span>{objectives.isLoading ? 'Loading objectives…' : `${filteredItems.length} objectives`}</span><TextInput aria-label="Search objectives" placeholder="Search objectives…" value={search} onChange={(event) => setSearch(event.currentTarget.value)} /><span>{gridHint}</span>
              {objectives.isError && objectives.data && <Button variant="subtle" onClick={() => void objectives.refetch()}>Retry</Button>}
            </div>
            <div className={`objective-grid-wrap objective-view-${view}`}>
              {objectives.isLoading && !objectives.data
                ? <div className="objective-load-error" role="status">Loading objectives…</div>
                : objectives.isError && !objectives.data ? <div className="objective-load-error" role="alert">
                  <span>Could not load objectives.</span>
                  <Button variant="subtle" onClick={() => void objectives.refetch()}>Retry loading objectives</Button>
                </div> : section === 'planning' ? <div className="objective-planning-view" aria-label="Objective planning">
                  {plannedItems.length ? plannedItems.map((item) => (
                    <ObjectiveItemCard key={item.id} item={item} selected={selected?.id === item.id}
                      productName={productName(item)} onSelect={selectObjective} />
                  )) : <div className="objective-view-empty">No objectives match the selected planning scope.</div>}
                </div> : section === 'roadmap' ? <div className="objective-roadmap-view" aria-label="Objective roadmap">
                  {roadmapGroups.length ? roadmapGroups.map(([label, group]) => (
                    <section className="objective-roadmap-group" aria-label={label} key={label}>
                      <h4>{label}<span>{group.items.length}</span></h4>
                      <div>{group.items.map((item) => <ObjectiveItemCard key={item.id} item={item}
                        selected={selected?.id === item.id} productName={productName(item)} onSelect={selectObjective} />)}</div>
                    </section>
                  )) : <div className="objective-view-empty">No objectives match these filters.</div>}
                </div> : view === 'table' ? (
                <AgGridReact<Objective>
                  key={items.length ? 'has-objectives' : 'empty-objectives'}
                  theme={objectiveTheme}
                  rowData={filteredItems}
                  columnDefs={columns}
                  getRowId={({ data }) => data.id}
                  rowHeight={42}
                  headerHeight={38}
                  pagination
                  paginationPageSize={6}
                  rowSelection={{ mode: 'multiRow', checkboxes: true, headerCheckbox: true, selectAll: 'filtered', enableClickSelection: 'enableSelection' }}
                  selectionColumnDef={{ width: 32, minWidth: 32, maxWidth: 32, pinned: 'left', resizable: false, sortable: false, suppressMovable: true }}
                  onRowDataUpdated={({ api }) => {
                    if (!api.getSelectedRows().length) {
                      const linkedObjective = selectedID ? api.getRowNode(selectedID) : null;
                      (linkedObjective ?? api.getDisplayedRowAtIndex(0))?.setSelected(true);
                    }
                  }}
                  onSelectionChanged={({ api }) => {
                    const item = api.getSelectedRows()[0];
                    if (item) selectObjective(item);
                  }}
                  overlayNoRowsTemplate={`<span class="ag-overlay-no-rows-center">${gridEmptyMessage}</span>`}
                />
              ) : view === 'cards' ? (
                <div className="objective-card-grid">
                  {filteredItems.length ? filteredItems.map((item) => (
                    <ObjectiveItemCard key={item.id} item={item} selected={selected?.id === item.id}
                      productName={productName(item)} onSelect={selectObjective} />
                  )) : <div className="objective-view-empty">No objectives match these filters.</div>}
                </div>
              ) : (
                <div className="objective-kanban">
                  {statusOptions.map(({ value, label }) => {
                    const statusItems = filteredItems.filter((item) => item.status === value);
                    return <section className="objective-kanban-column" aria-label={label} key={value}>
                      <h4>{label}<span>{statusItems.length}</span></h4>
                      {statusItems.length ? statusItems.map((item) => (
                        <ObjectiveItemCard key={item.id} item={item} selected={selected?.id === item.id}
                          productName={productName(item)} onSelect={selectObjective} />
                      )) : <div className="objective-view-empty">No objectives</div>}
                    </section>;
                  })}
                </div>
              )}
            </div>
            <div className="objective-grid-footer-placeholder" />
          </PanelCard>
          <PanelCard className="objective-capacity" withBorder>
            <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconCalendar size={18} /></span>}
              title={sampleData ? 'Objective Planning & Capacity' : 'Objective progress'}
              description={sampleData ? 'Planned vs. actual objective delivery (This Quarter)' : 'Current completion across objectives'}
              actions={sampleData && <div className="objective-capacity-legend"><span><i />Planned (cumulative)</span><span><i />Completed (cumulative)</span></div>} />
            {sampleData ? <AreaChart className="objective-capacity-chart" h={111} data={objectivePreviewCapacity} dataKey="week"
              series={[{ name: 'planned', color: '#bd70f2', label: 'Planned' }, { name: 'completed', color: '#23d9a0', label: 'Completed' }]}
              withXAxis withYAxis withDots withTooltip gridAxis="xy" xAxisProps={{ tickLine: false, axisLine: false }}
              yAxisProps={{ width: 25, domain: [0, 40], ticks: [0, 10, 20, 30, 40], interval: 0 }} />
              : items.length ? <div className="capacity-bars">{items.slice(0, 6).map((item) => <div key={item.id}><span>{item.title}</span><Progress value={item.progress} color={item.status === 'blocked' ? 'red' : 'violet'} /><b>{item.progress}%</b></div>)}</div> : <div className="capacity-empty">Create objectives to build a delivery plan.</div>}
          </PanelCard>
        </div>
        <div className="objective-detail-stack">
        <PanelCard className="objective-detail-panel" withBorder>
          {selected ? (
            <div className="objective-detail-content">
            <>
              <PanelHeading className="objective-detail-head entity-detail-heading" title={selected.title}
                description={<small>{selected.id.startsWith('OBJ-') ? selected.id : selected.id.slice(0, 8).toUpperCase()}</small>}
                icon={<span className="detail-objective-icon"><IconTarget size={19} /></span>}
                actions={sampleData ? <div className="objective-preview-actions">
                  <button type="button" aria-label={favoriteIDs.includes(selected.id) ? 'Remove objective favorite' : 'Favorite objective'}
                    aria-pressed={favoriteIDs.includes(selected.id)} onClick={() => setFavoriteIDs((current) => current.includes(selected.id)
                      ? current.filter((id) => id !== selected.id) : [...current, selected.id])}><IconStar size={15} /></button>
                  <button type="button" aria-label="Copy objective link" onClick={async () => {
                    const url = new URL(window.location.href);
                    url.searchParams.set('objective', selected.id);
                    url.hash = 'objectives';
                    try { await navigator.clipboard.writeText(url.toString()); setActionNotice('Objective link copied'); }
                    catch { setActionNotice('Could not copy objective link'); }
                  }}><IconLink size={15} /></button>
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target><button type="button" aria-label="More objective actions"><IconDots size={16} /></button></Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item onClick={() => setDetailTab('pull-requests')}>View related PRs</Menu.Item>
                      <Menu.Item onClick={() => setDetailTab('activity')}>View activity</Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </div> : <Button className="edit-objective-button" onClick={() => {
                  if (editing) cancelEdit();
                  else { setDetailTab('overview'); setEditing(true); }
                }}>{editing ? 'Cancel edit' : 'Edit objective'}</Button>} />
              {sampleData && actionNotice && <Text className="objective-action-notice" role="status">{actionNotice}</Text>}
              <div className="detail-summary">{statusBadge(statusValue)}<span>{progressValue}% complete</span><Progress value={progressValue} size="sm" /></div>
              <div className="detail-meta-grid">{sampleData ? <>
                <div><small>Owner</small><b><IconUser size={13} aria-hidden="true" />{selected.owner}</b></div>
                <div><small>Product</small><b><IconCube size={13} aria-hidden="true" />{productName(selected)}</b></div>
                <div><small>Approval</small><b><IconShieldCheck size={13} aria-hidden="true" />{selected.approval}</b></div>
                <div><small>Workflows</small><b><IconHierarchy size={13} aria-hidden="true" />{selected.workflow_count} linked</b></div>
              </> : <>
                <div><small>Owner</small><b>{selected.owner || 'Unassigned'}</b></div><div><small>Product</small><b>{productName(selected)}</b></div>
                <div><small>Due date</small><b>{selected.due_date ? formatObjectiveDate(selected.due_date) : 'No date'}</b></div><div><small>Created</small><b>{formatObjectiveDate(selected.created_at)}</b></div>
              </>}</div>
              <div className="objective-detail-tabs" role="tablist" aria-label="Objective details">
                {([
                  ['overview', 'Overview', IconTarget], ['milestones', 'Milestones', IconCalendar],
                  ['pull-requests', 'Related PRs', IconGitPullRequest], ['activity', 'Activity', IconActivity],
                ] as const).map(([id, label, Icon]) => <button key={id} type="button" role="tab"
                  aria-selected={detailTab === id} className={detailTab === id ? 'active' : ''}
                  onClick={() => { if (editing) cancelEdit(); setDetailTab(id); }}><Icon size={13} aria-hidden="true" />{label}</button>)}
              </div>
              {!editing && sampleData && detailTab === 'overview' ? <div className="objective-overview-grid objective-preview-overview">
                <section className="objective-overview-card"><ObjectivePreviewHeading icon={IconFileText}>Description</ObjectivePreviewHeading><p>{selected.description}</p></section>
                <section className="objective-overview-card objective-preview-blocker"><ObjectivePreviewHeading icon={IconAlertTriangle}>Blockers (1)</ObjectivePreviewHeading><p>{objectivePreviewDetails.blocker}</p></section>
                <section className="objective-overview-card"><ObjectivePreviewHeading icon={IconChecklist}>Acceptance Criteria</ObjectivePreviewHeading><ul>{objectivePreviewDetails.acceptanceCriteria.map((item) => <li key={item}><span>{item}</span></li>)}</ul></section>
                <section className="objective-overview-card"><ObjectivePreviewHeading icon={IconGitPullRequest}>Related PRs (4)</ObjectivePreviewHeading><ul>{objectivePreviewDetails.relatedPullRequests.map((item) => <li key={item.id}><span>{item.id} {item.title}</span><em>{item.status}</em></li>)}</ul></section>
                <section className="objective-overview-card"><ObjectivePreviewHeading icon={IconListCheck}>Plan Summary</ObjectivePreviewHeading><ul>{objectivePreviewDetails.planSummary.map((item) => <li key={item}><span>{item}</span></li>)}</ul></section>
                <section className="objective-overview-card"><ObjectivePreviewHeading icon={IconActivity}>Activity Feed</ObjectivePreviewHeading><ul>{objectivePreviewDetails.activity.map((item) => <li key={item.text}><span>{item.text}</span><em>{item.time}</em></li>)}</ul></section>
              </div> : !editing && detailTab === 'overview' ? <>
                <div className="objective-overview-grid">
                  <section className="objective-overview-card"><b>Description</b><p>{selected.description || 'No description provided.'}</p></section>
                  <section className="objective-overview-card"><b>Blockers</b><p>Not included in the available objective data.</p></section>
                  <section className="objective-overview-card"><b>Acceptance criteria</b><p>Not included in the available objective data.</p></section>
                  <section className="objective-overview-card"><b>Related pull requests</b><p>Not included in the available objective data.</p></section>
                  <section className="objective-overview-card"><b>Plan summary</b><p>{selected.due_date ? `Target date: ${formatObjectiveDate(selected.due_date)}` : 'No target date provided.'}</p></section>
                  <section className="objective-overview-card"><b>Activity feed</b><p>Not included in the available objective data.</p></section>
                  <section className="objective-overview-card objective-overview-wide objective-progress-card"><b>Objective progress</b><Progress value={selected.progress} /><span>{selected.progress}%</span></section>
                </div>
              </> : sampleData && detailTab === 'milestones' ? <div className="objective-detail-milestones">{objectivePreviewDetails.milestones.map((item) => <div key={item.title}><span>{item.title}</span><Progress value={item.progress} /><b>{item.progress}%</b><em>{item.status}</em></div>)}</div>
                : sampleData && detailTab === 'pull-requests' ? <div className="objective-detail-prs">{objectivePreviewDetails.relatedPullRequests.map((item) => <div key={item.id}><span>{item.id}</span><b>{item.title}</b><em>{item.status}</em></div>)}</div>
                  : sampleData && detailTab === 'activity' ? <div className="objective-detail-activity">{objectivePreviewDetails.activity.map((item) => <div key={item.text}><span>{item.text}</span><time>{item.time}</time></div>)}</div>
              : editing ? <>
                <form className="detail-edit-grid" onSubmit={editForm.onSubmit((values) => updateMutation.mutate({
                  id: selected.id, ...values, product_id: productIDValue, status: statusValue, progress: progressValue,
                }, { onSuccess: () => { setDetailTab('overview'); setEditing(false); } }))}>
                  <TextInput label="Objective title" required {...editForm.getInputProps('title')} />
                  <Textarea label="Description" minRows={2} {...editForm.getInputProps('description')} />
                  <TextInput label="Owner" {...editForm.getInputProps('owner')} />
                  <TextInput label="Due date" type="date" {...editForm.getInputProps('due_date')} />
                  <Select label="Status" value={statusValue} data={statusOptions}
                    onChange={(value) => { if (value) setStatusValue(value as Objective['status']); }} />
                  <NumberInput label="Progress" min={0} max={100} decimalScale={0} suffix="%"
                    value={progressValue} onChange={(value) => setProgressValue(Number(value) || 0)} />
                  <Select label="Product" data={products.data?.map((product) => ({ value: product.id, label: product.name })) ?? []}
                    value={productIDValue || null} onChange={(value) => setProductIDValue(value ?? '')}
                    disabled={products.isLoading || products.isError} clearable />
                  {products.isError && <Text className="form-error" role="alert">Product choices are unavailable; the current assignment is unchanged.</Text>}
                  <Button className="save-objective-button" type="submit" loading={updateMutation.isPending}>Save updates</Button>
                  {updateMutation.isError && <Text className="form-error" role="alert">{updateMutation.error.message}</Text>}
                </form>
              </> : <section className="objective-detail-unavailable" role="tabpanel">
                <b>{detailTab === 'pull-requests' ? 'Related pull requests' : detailTab[0].toUpperCase() + detailTab.slice(1)}</b>
                <p>This information is not included in the available objective data.</p>
              </section>}
            </>
            </div>
          ) : (
            <div className="objective-detail-empty"><span className="detail-objective-icon"><IconTarget size={19} /></span><h3>Objective details</h3><p>Select an objective to see its plan and progress, or create the first objective for this workspace.</p><Button className="new-objective-button" onClick={() => setCreateOpen(true)}>Create objective</Button></div>
          )}
          {sampleData && <PanelCard className="objective-milestones-card" withBorder>
          <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon">⚑</span>} title="Milestone Progress"
            actions={<span>3 of 4 complete (75%)</span>} />
          <div className="objective-milestones-list">{objectivePreviewDetails.milestones.map((item) => <div key={item.title}>
            <span className="objective-milestone-flag">⚑</span><span className="objective-milestone-name">{item.title}</span>
            <Progress value={item.progress} color={item.progress === 100 ? 'teal' : 'violet'} />
            <Badge className={`objective-milestone-status ${item.status.toLowerCase().replace(' ', '-')}`}>{item.status}</Badge><time>{item.date}</time>
          </div>)}</div>
          </PanelCard>}
        </PanelCard>
        </div>
      </div>

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="New objective" centered className="objective-modal">
        <form onSubmit={createForm.onSubmit((values) => sampleData ? setSubmitError('The mock preview is read-only.') : createMutation.mutate(createSchema.parse(values)))}>
          <TextInput label="Objective title" placeholder="e.g. Improve review velocity" required {...createForm.getInputProps('title')} />
          <Textarea label="Description" placeholder="Describe the outcome and why it matters" minRows={3} {...createForm.getInputProps('description')} />
          <div className="objective-form-row">
            <TextInput label="Owner" placeholder="Name" {...createForm.getInputProps('owner')} />
            <Select label="Product" data={products.data?.map((product) => ({ value: product.id, label: product.name })) ?? []}
              disabled={products.isLoading || products.isError} clearable {...createForm.getInputProps('product_id')} />
          </div>
          {products.isError && <Text className="form-error" role="alert">Product choices are unavailable. You can create this objective without a product.</Text>}
          <TextInput label="Due date" type="date" {...createForm.getInputProps('due_date')} />
          {submitError && <Text className="form-error" role="alert">{submitError}</Text>}
          <div className="objective-form-actions"><Button variant="subtle" type="button" onClick={() => setCreateOpen(false)}>Cancel</Button><Button className="new-objective-button" type="submit" loading={createMutation.isPending}>Create objective</Button></div>
        </form>
      </Modal>
    </div>
  );
}
