import React, { useEffect, useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, colorSchemeDark, themeQuartz } from 'ag-grid-community';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { useForm } from '@mantine/form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Modal, NumberInput, Progress, Select, Text, Textarea, TextInput } from '@mantine/core';
import { IconAlertTriangle, IconCalendar, IconCircleCheck, IconPlus, IconTarget } from '@tabler/icons-react';
import { z } from 'zod';
import { loadProducts } from './productEditor';
import { MetricCard } from './MetricCard';
import { PanelCard } from './PanelCard';
import { PageHeading } from './PageHeading';
import { PanelHeading } from './PanelHeading';
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
    {item.due_date && <small>Due {item.due_date}</small>}
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

export function ObjectivesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [progressValue, setProgressValue] = useState<number>(0);
  const [statusValue, setStatusValue] = useState<Objective['status']>('in_progress');
  const [productIDValue, setProductIDValue] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [search, setSearch] = useState('');
  const [productFilter, setProductFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dueQuarter, setDueQuarter] = useState('this');
  const [view, setView] = useState<'kanban' | 'table' | 'cards'>('table');
  const objectives = useQuery({ queryKey: ['objectives'], queryFn: loadObjectives });
  const products = useQuery({ queryKey: ['products'], queryFn: loadProducts });
  const items = objectives.data ?? [];
  const selected = items.find((item) => item.id === selectedID) ?? items[0];
  useEffect(() => {
    if (!selected) return;
    setProgressValue(selected.progress);
    setStatusValue(selected.status);
    setProductIDValue(selected.product_id);
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
      status: Objective['status'];
      progress: number;
      product_id?: string;
    }) => {
      const response = await fetch(`/api/v1/objectives/${input.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: input.status,
          progress: input.progress,
          ...(input.product_id !== undefined ? { product_id: input.product_id } : {}),
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
    { field: 'title', headerName: 'Objective', flex: 2, minWidth: 150 },
    { field: 'owner', headerName: 'Owner', flex: 1, minWidth: 80 },
    { field: 'status', headerName: 'Status', flex: 1, minWidth: 85, cellRenderer: ({ value }: ICellRendererParams<Objective, Objective['status']>) => statusBadge(value ?? 'in_progress') },
    { field: 'progress', headerName: 'Progress', flex: 1, minWidth: 90, cellRenderer: ({ value }: ICellRendererParams<Objective, number>) => <div className="grid-progress"><Progress value={value ?? 0} size="xs" /><span>{value ?? 0}%</span></div> },
    {
      field: 'product', headerName: 'Product', flex: 1, minWidth: 85,
      valueGetter: ({ data }) => data ? productName(data) : 'Unassigned',
    },
    { field: 'due_date', headerName: 'Due date', flex: 1, minWidth: 85 },
  ], []);
  const legacyProducts = Array.from(new Set(items.filter((item) => !item.product_id).map((item) => item.product)
    .filter((product) => product && !products.data?.some((known) => known.name === product))));
  const productOptions = [
    { value: 'all', label: 'All products' },
    ...(products.data?.map((product) => ({ value: product.id, label: product.name })) ?? []),
    ...legacyProducts.map((product) => ({ value: `legacy:${product}`, label: product })),
  ];
  const filteredItems = items.filter((item) =>
    `${item.title} ${item.owner} ${productName(item)}`.toLowerCase().includes(search.toLowerCase()) &&
    (productFilter === 'all' || (item.product_id
      ? item.product_id === productFilter
      : `legacy:${item.product}` === productFilter)) &&
    (ownerFilter === 'all' || item.owner === ownerFilter) &&
    (statusFilter === 'all' || item.status === statusFilter) &&
    (dueQuarter === 'all' || dueDateIsInQuarter(item.due_date, dueQuarter === 'this' ? 0 : -1, new Date())),
  );
  const completed = items.filter((item) => item.status === 'completed').length;
  const onTrack = items.filter((item) => item.status === 'on_track').length;
  const atRisk = items.filter((item) => item.status === 'at_risk').length;
  const blocked = items.filter((item) => item.status === 'blocked').length;

  function selectObjective(item: Objective) {
    setSelectedID(item.id);
    setProgressValue(item.progress);
    setStatusValue(item.status);
    setProductIDValue(item.product_id);
  }

  return (
    <div className="objectives-page">
      <div className="objectives-title-row">
        <div className="objectives-title-copy">
          <span className="objectives-title-icon"><IconTarget size={25} /></span>
          <PageHeading title="Objectives" description="Plan, manage, and track engineering outcomes across your products and delivery." />
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

      <section className="objective-metrics" aria-label="Objective metrics">
        <MetricCard className="objective-metric purple" label="Completed objectives" value={completed} detail="In workspace" icon={<IconTarget size={18} />} />
        <MetricCard className="objective-metric teal" label="Objective success rate" value={items.length ? `${Math.round(completed / items.length * 100)}%` : '—'} detail="Completed / total objectives" icon={<IconCircleCheck size={18} />} />
        <MetricCard className="objective-metric" label="Total objectives" value={items.length} detail="Across this workspace" icon={<IconTarget size={18} />} />
        <MetricCard className="objective-metric green" label="On track" value={onTrack} detail="Objectives" icon={<IconCircleCheck size={18} />} />
        <MetricCard className="objective-metric amber" label="At risk" value={atRisk} detail="Objectives" icon={<IconAlertTriangle size={18} />} />
        <MetricCard className="objective-metric red" label="Blocked" value={blocked} detail="Objectives" icon={<IconAlertTriangle size={18} />} />
      </section>

      <div className="objective-content-grid">
        <div className="objective-table-stack">
          <PanelCard className="objective-table-panel" withBorder>
            <div className="objectives-tabs">
              <b>Objectives</b><button disabled>Planning</button><button disabled>Roadmap</button><span />
              {(['kanban', 'table', 'cards'] as const).map((mode) => (
                <button key={mode} type="button" aria-pressed={view === mode}
                  className={view === mode ? 'view-active' : ''} onClick={() => setView(mode)}>
                  {mode === 'kanban' ? 'Kanban' : mode[0].toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
            <div className="objective-grid-toolbar"><span>{objectives.isLoading ? 'Loading objectives…' : `${filteredItems.length} objectives`}</span><TextInput aria-label="Search objectives" placeholder="Search objectives…" value={search} onChange={(event) => setSearch(event.currentTarget.value)} /><span>Select an objective to inspect details</span></div>
            <div className={`objective-grid-wrap objective-view-${view}`}>
              {objectives.isError ? <div className="objective-load-error">Could not load objectives. Refresh to try again.</div> : view === 'table' ? (
                <AgGridReact<Objective>
                  theme={objectiveTheme}
                  rowData={filteredItems}
                  columnDefs={columns}
                  getRowId={({ data }) => data.id}
                  rowHeight={42}
                  headerHeight={38}
                  pagination
                  paginationPageSize={6}
                  onRowClicked={({ data }) => { if (data) selectObjective(data); }}
                  overlayNoRowsTemplate={'<span class="ag-overlay-no-rows-center">No objectives yet. Create one to begin.</span>'}
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
              title="Objective progress" description="Current completion across objectives" />
            {items.length ? <div className="capacity-bars">{items.slice(0, 6).map((item) => <div key={item.id}><span>{item.title}</span><Progress value={item.progress} color={item.status === 'blocked' ? 'red' : 'violet'} /><b>{item.progress}%</b></div>)}</div> : <div className="capacity-empty">Create objectives to build a delivery plan.</div>}
          </PanelCard>
        </div>
        <PanelCard className="objective-detail-panel" withBorder>
          {selected ? (
            <>
              <PanelHeading className="objective-detail-head entity-detail-heading" title={selected.title}
                description={<small>{selected.id.slice(0, 8).toUpperCase()}</small>}
                icon={<span className="detail-objective-icon"><IconTarget size={19} /></span>}
                actions={<button aria-label="Objective options" disabled>•••</button>} />
              <div className="detail-summary">{statusBadge(statusValue)}<span>{progressValue}% complete</span><Progress value={progressValue} size="sm" /></div>
              <div className="detail-meta-grid"><div><small>Owner</small><b>{selected.owner || 'Unassigned'}</b></div><div><small>Product</small><b>{productName(selected)}</b></div><div><small>Due date</small><b>{selected.due_date || 'No date'}</b></div><div><small>Created</small><b>{new Date(selected.created_at).toLocaleDateString()}</b></div></div>
              <div className="detail-description"><b>Description</b><p>{selected.description || 'Add a description to make the outcome clear to your team.'}</p></div>
              <div className="detail-edit-grid">
                <Select label="Status" value={statusValue} data={statusOptions}
                  onChange={(value) => { if (value) setStatusValue(value as Objective['status']); }} />
                <NumberInput label="Progress" min={0} max={100} decimalScale={0} suffix="%"
                  value={progressValue} onChange={(value) => setProgressValue(Number(value) || 0)} />
                <Select label="Product" data={products.data?.map((product) => ({ value: product.id, label: product.name })) ?? []}
                  value={productIDValue || null} onChange={(value) => setProductIDValue(value ?? '')} clearable />
              </div>
              <Button className="save-objective-button" loading={updateMutation.isPending} onClick={() => updateMutation.mutate({
                id: selected.id,
                status: statusValue,
                progress: progressValue,
                ...(productIDValue !== selected.product_id ? { product_id: productIDValue } : {}),
              })}>Save updates</Button>
              {updateMutation.isError && <Text className="form-error">{updateMutation.error.message}</Text>}
            </>
          ) : (
            <div className="objective-detail-empty"><span className="detail-objective-icon"><IconTarget size={19} /></span><h3>Objective details</h3><p>Select an objective to see its plan and progress, or create the first objective for this workspace.</p><Button className="new-objective-button" onClick={() => setCreateOpen(true)}>Create objective</Button></div>
          )}
        </PanelCard>
      </div>

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="New objective" centered className="objective-modal">
        <form onSubmit={createForm.onSubmit((values) => createMutation.mutate(createSchema.parse(values)))}>
          <TextInput label="Objective title" placeholder="e.g. Improve review velocity" required {...createForm.getInputProps('title')} />
          <Textarea label="Description" placeholder="Describe the outcome and why it matters" minRows={3} {...createForm.getInputProps('description')} />
          <div className="objective-form-row">
            <TextInput label="Owner" placeholder="Name" {...createForm.getInputProps('owner')} />
            <Select label="Product" data={products.data?.map((product) => ({ value: product.id, label: product.name })) ?? []}
              clearable {...createForm.getInputProps('product_id')} />
          </div>
          <TextInput label="Due date" type="date" {...createForm.getInputProps('due_date')} />
          {submitError && <Text className="form-error">{submitError}</Text>}
          <div className="objective-form-actions"><Button variant="subtle" type="button" onClick={() => setCreateOpen(false)}>Cancel</Button><Button className="new-objective-button" type="submit" loading={createMutation.isPending}>Create objective</Button></div>
        </form>
      </Modal>
    </div>
  );
}
