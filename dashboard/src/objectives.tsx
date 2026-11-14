import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, colorSchemeDark, themeQuartz } from 'ag-grid-community';
import type { ColDef, GridApi, ICellRendererParams } from 'ag-grid-community';
import { AreaChart, Sparkline } from '@mantine/charts';
import { useForm } from '@mantine/form';
import { Badge, Button, Menu, Modal, Progress, Select, Text, Textarea, TextInput } from '@mantine/core';
import { IconActivity, IconAlertTriangle, IconCalendar, IconChevronDown, IconCircleCheck, IconCircleMinus, IconCube,
  IconDots, IconHierarchy, IconPlus, IconTarget, IconTargetArrow, IconUser } from '@tabler/icons-react';
import { MetricCard } from './MetricCard';
import { PanelCard } from './PanelCard';
import { PageHeading } from './PageHeading';
import { PanelHeading } from './PanelHeading';
import { ObjectiveDetail, ObjectiveMilestones, objectiveDisplayID, objectiveProductName, objectiveStatusBadge,
  objectiveStatusOptions } from './ObjectiveDetail';
import type { ObjectiveDetailTab } from './ObjectiveDetail';
import { useMockObjectives } from './objective-preview';
import { formatObjectiveDate, objectiveFormErrors, objectiveInputSchema, useLiveObjectives } from './objectivesView';
import type { Objective, ObjectiveInput } from './objectivesView';
import './objectives.css';

export { objectivesSchema } from './objectivesView';
export type { Objective } from './objectivesView';

ModuleRegistry.registerModules([AllCommunityModule]);

const pageSize = 6;
const selectChevron = <IconChevronDown size={12} aria-hidden="true" />;
const notProvided = <span title="Unavailable: not provided by the control plane" aria-label="Unavailable">—</span>;

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

function ObjectiveItemCard({ item, selected, onSelect }: {
  item: Objective;
  selected: boolean;
  onSelect: (item: Objective) => void;
}) {
  return <button type="button" className={`objective-item-card${selected ? ' selected' : ''}`}
    aria-pressed={selected} onClick={() => onSelect(item)}>
    <span className="objective-item-card-title">{item.title}{objectiveStatusBadge(item.status)}</span>
    <span className="objective-item-card-meta"><span>{item.owner || 'Unassigned'}</span><span>{objectiveProductName(item)}</span></span>
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

function objectivePageNumbers(current: number, total: number) {
  if (total <= 6) return Array.from({ length: total }, (_, page) => page);
  const start = current <= 2 ? 0 : Math.min(current - 2, total - 5);
  return [...new Set([0, ...Array.from({ length: 5 }, (_, index) => start + index)
    .filter((page) => page > 0 && page < total - 1), total - 1])];
}

export function ObjectivesPage({ sampleData = false }: { sampleData?: boolean }) {
  const mock = useMockObjectives();
  const live = useLiveObjectives(!sampleData);
  const source = sampleData ? mock : live;
  const { items, view: sourceView } = source;
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [detailTab, setDetailTab] = useState<ObjectiveDetailTab>('overview');
  const [selectedID, setSelectedID] = useState<string | null>(() => new URLSearchParams(window.location.search).get('objective'));
  const selectedIDRef = useRef(selectedID);
  selectedIDRef.current = selectedID;
  const [actionNotice, setActionNotice] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [search, setSearch] = useState('');
  const [productFilter, setProductFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dueQuarter, setDueQuarter] = useState<'this' | 'last' | 'all'>('this');
  const [section, setSection] = useState<'objectives' | 'planning' | 'roadmap'>('objectives');
  const [view, setView] = useState<'kanban' | 'table' | 'cards'>('table');
  const [objectiveGridApi, setObjectiveGridApi] = useState<GridApi<Objective> | null>(null);
  const [pagination, setPagination] = useState({ page: 0, pages: 1, count: 0 });
  const selected = items.find((item) => item.id === selectedID) ?? items[0];
  useEffect(() => {
    const activeRow = selectedID ? objectiveGridApi?.getRowNode(selectedID) : null;
    if (!activeRow || activeRow.isSelected()) return;
    objectiveGridApi?.deselectAll();
    activeRow.setSelected(true);
  }, [items, objectiveGridApi, selectedID]);
  const createForm = useForm<ObjectiveInput>({
    initialValues: { title: '', description: '', owner: '', product_id: '', due_date: '' },
    validate: (values) => objectiveFormErrors(objectiveInputSchema, values),
  });

  function selectObjective(item: Objective) {
    selectedIDRef.current = item.id;
    setSelectedID(item.id);
    setEditing(false);
    setDetailTab('overview');
  }

  async function createObjective(values: ObjectiveInput) {
    setCreating(true);
    setSubmitError('');
    try {
      selectObjective(await source.create(objectiveInputSchema.parse(values)));
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Could not create the objective.');
      return;
    } finally {
      setCreating(false);
    }
    setActionNotice(`Objective created${source.savedSuffix}`);
    createForm.reset();
    setCreateOpen(false);
  }

  const columns = useMemo<ColDef<Objective>[]>(() => [
    { field: 'title', headerName: 'Objective', flex: 1.8, minWidth: 156,
      cellRenderer: ({ value, data }: ICellRendererParams<Objective, string>) => <span className="objective-title-cell">
        <IconTarget className="objective-title-icon" size={14} aria-hidden="true" /><span>{value}</span>
        <small>{data && objectiveDisplayID(data.id)}</small></span> },
    { field: 'owner', headerName: 'Owner', flex: .8, minWidth: 64, valueFormatter: ({ value }) => value?.replace(/\s+(\S).*$/, ' $1.'),
      cellRenderer: ({ value, valueFormatted }: ICellRendererParams<Objective, string>) => value
        ? <span className="objective-owner-cell"><span className="objective-owner-avatar" aria-hidden="true">{value.split(/\s+/).map((part) => part[0]).join('')}</span>{valueFormatted}</span>
        : <span className="objective-owner-cell">Unassigned</span> },
    { field: 'status', headerName: 'Status', flex: .9, minWidth: 76, cellRenderer: ({ value }: ICellRendererParams<Objective, Objective['status']>) => objectiveStatusBadge(value ?? 'in_progress') },
    { field: 'progress', headerName: 'Progress', flex: 1, minWidth: 60, cellRenderer: ({ value, data }: ICellRendererParams<Objective, number>) => <div className="grid-progress"><span>{value ?? 0}%</span><Progress value={value ?? 0} size="xs" color={data?.status === 'on_track' ? 'teal' : data?.status === 'at_risk' ? 'yellow' : data?.status === 'blocked' ? 'red' : 'violet'} /></div> },
    {
      field: 'product', headerName: 'Product', flex: .9, minWidth: 86,
      valueGetter: ({ data }) => data ? objectiveProductName(data) : 'Unassigned',
    },
    { field: 'approval', headerName: 'Approval', flex: .95, minWidth: 78, cellRenderer: ({ value }: ICellRendererParams<Objective, string>) => value ? <Badge className={`objective-approval-status ${value.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}`}>{value}</Badge> : notProvided },
    { field: 'due_date', headerName: 'Due Date', flex: .85, minWidth: 75, valueFormatter: ({ value }) => value ? formatObjectiveDate(value) : '' },
    { field: 'workflow_count', headerName: 'Workflows', flex: .65, minWidth: 51, cellRenderer: ({ value }: ICellRendererParams<Objective, number>) => value === undefined ? notProvided : <span className="objective-workflow-count"><IconHierarchy size={11} />{value}</span> },
    { colId: 'actions', headerName: '', width: 24, minWidth: 24, maxWidth: 24, sortable: false, resizable: false,
      cellRenderer: ({ data }: ICellRendererParams<Objective>) => data && <Menu withinPortal position="bottom-end">
        <Menu.Target><button type="button" className="objective-row-actions" aria-label={`More actions for ${data.title}`}
          onClick={(event) => event.stopPropagation()}><IconDots size={13} /></button></Menu.Target>
        <Menu.Dropdown><Menu.Item onClick={() => { selectObjective(data); setDetailTab('pull-requests'); }}>View related PRs</Menu.Item>
          <Menu.Item onClick={() => { selectObjective(data); setDetailTab('activity'); }}>View activity</Menu.Item></Menu.Dropdown>
      </Menu>,
    },
  ], []);
  const legacyProducts = Array.from(new Set(items.filter((item) => !item.product_id).map((item) => item.product)
    .filter((product) => product && !source.products.some((known) => known.label === product))));
  const linkedProductOptions = items.filter((item) => item.product_id)
    .map((item) => ({ value: item.product_id, label: objectiveProductName(item) }));
  const productOptions = [
    { value: 'all', label: 'All Products' },
    ...new Map([...source.products, ...linkedProductOptions].map((option) => [option.value, option])).values(),
    ...legacyProducts.map((product) => ({ value: `legacy:${product}`, label: product })),
  ];
  const filteredItems = items.filter((item) =>
    `${item.title} ${item.description} ${item.owner} ${objectiveProductName(item)}`.toLowerCase().includes(search.toLowerCase()) &&
    (productFilter === 'all' || (item.product_id
      ? item.product_id === productFilter
      : `legacy:${item.product}` === productFilter)) &&
    (ownerFilter === 'all' || item.owner === ownerFilter) &&
    (statusFilter === 'all' || item.status === statusFilter) &&
    (dueQuarter === 'all' || dueDateIsInQuarter(item.due_date, dueQuarter === 'this' ? 0 : -1, sourceView.today)),
  );
  const plannedItems = [...filteredItems].sort((left, right) =>
    (left.due_date || '9999-12-31').localeCompare(right.due_date || '9999-12-31'));
  const gridEmptyMessage = items.length
    ? 'No objectives match these filters.' : 'No objectives yet. Create one to begin.';
  const gridHint = !filteredItems.length ? (items.length ? 'No objectives match these filters.' : '')
    : section === 'planning' ? 'Sorted by due date' : 'Select an objective to inspect details';
  const roadmapGroups = groupObjectivesByQuarter(filteredItems);
  const listUnavailable = source.loading || (source.failed && !items.length);
  const showsTable = !listUnavailable && section === 'objectives' && view === 'table';
  const count = (status: Objective['status']) => source.loading ? '…' : listUnavailable ? '—'
    : items.filter((item) => item.status === status).length;
  const cardProps = (item: Objective) => ({ item, selected: selected?.id === item.id, onSelect: selectObjective });

  return (
    <div className="objectives-page">
      <div className="objectives-title-row">
        <div className="objectives-title-copy">
          <span className="objectives-title-icon"><IconTarget size={25} /></span>
          <PageHeading title="Objectives" description="Plan, manage, and track engineering objectives across products, workflows, and delivery." />
        </div>
        <div className="objectives-title-actions">
          <div className="objective-filters">
            <Select aria-label="Filter by product" rightSection={selectChevron} rightSectionPointerEvents="none"
              leftSection={<IconCube size={13} />}
              data={productOptions} value={productFilter}
              onChange={(value) => setProductFilter(value ?? 'all')} />
            <Select aria-label="Filter by owner" rightSection={selectChevron} rightSectionPointerEvents="none"
              leftSection={<IconUser size={13} />}
              data={[{ value: 'all', label: 'All Owners' }, ...Array.from(new Set(items.map((item) => item.owner).filter(Boolean))).map((owner) => ({ value: owner, label: owner }))]}
              value={ownerFilter} onChange={(value) => setOwnerFilter(value ?? 'all')} />
            <Select aria-label="Filter by status" rightSection={selectChevron} rightSectionPointerEvents="none"
              leftSection={<IconActivity size={13} />}
              data={[{ value: 'all', label: 'All Status' }, ...objectiveStatusOptions]} value={statusFilter}
              onChange={(value) => setStatusFilter(value ?? 'all')} />
            <Select aria-label="Filter by due quarter" rightSection={selectChevron} rightSectionPointerEvents="none"
              leftSection={<IconCalendar size={13} />} data={[
              { value: 'this', label: 'This Quarter' }, { value: 'last', label: 'Last Quarter' },
              { value: 'all', label: 'All due dates' },
            ]} value={dueQuarter} onChange={(value) => setDueQuarter(value ?? 'this')} />
          </div>
          <Button className="new-objective-button" leftSection={<IconPlus size={16} />} onClick={() => { setSubmitError(''); setCreateOpen(true); }}>New Objective</Button>
        </div>
      </div>

      <section className="objective-metrics objective-metrics-preview" aria-label="Objective metrics">
        <MetricCard className="objective-metric purple" label="Objective Throughput"
          value={sourceView.throughput.value} detail={sourceView.throughput.detail} icon={<IconTarget size={18} />}
          trend={sourceView.throughput.bars && <span className="objective-metric-trend"><Badge>{sourceView.throughput.change}</Badge><span className="objective-throughput-bars" aria-hidden="true">
            {sourceView.throughput.bars.map((height, index) => <i key={index} style={{ height }} />)}
          </span></span>} />
        <MetricCard className="objective-metric teal" label="Objective Success Rate"
          value={sourceView.successRate.value} icon={<IconTargetArrow size={18} />}
          trend={sourceView.successRate.points && <span className="objective-metric-trend"><Badge>{sourceView.successRate.change}</Badge>
            <Sparkline data={sourceView.successRate.points} color="teal.4" w={54} h={24} withGradient={false} /></span>} />
        <MetricCard className="objective-metric" label="Total objectives" value={source.loading ? '…' : listUnavailable ? '—' : items.length}
          detail="Across this workspace" icon={<IconTarget size={18} />} />
        <MetricCard className="objective-metric green" label="On track" value={count('on_track')} detail="Objectives" icon={<IconCircleCheck size={18} />} />
        <MetricCard className="objective-metric amber" label="At risk" value={count('at_risk')} detail="Objectives" icon={<IconAlertTriangle size={18} />} />
        <MetricCard className="objective-metric red" label="Blocked" value={count('blocked')} detail="Objectives" icon={<IconCircleMinus size={18} />} />
      </section>

      <div className={`objective-content-grid objective-preview-layout${sourceView.referenceFrame ? ' objective-reference-frame' : ''}`}>
        <div className="objective-table-stack">
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
          <PanelCard className="objective-table-panel" withBorder>
            <div className="objective-grid-toolbar"><span>{source.loading ? 'Loading objectives…' : `${filteredItems.length} objectives`}</span><TextInput aria-label="Search objectives" placeholder="Search objectives…" value={search} onChange={(event) => setSearch(event.currentTarget.value)} /><span>{gridHint}</span>
              {source.failed && !listUnavailable && <Button variant="subtle" onClick={source.retry}>Retry</Button>}
            </div>
            <div className={`objective-grid-wrap objective-view-${view}`}>
              {source.loading
                ? <div className="objective-load-error" role="status">Loading objectives…</div>
                : listUnavailable ? <div className="objective-load-error" role="alert">
                  <span>Could not load objectives.</span>
                  <Button variant="subtle" onClick={source.retry}>Retry loading objectives</Button>
                </div> : section === 'planning' ? <div className="objective-planning-view" aria-label="Objective planning">
                  {plannedItems.length ? plannedItems.map((item) => <ObjectiveItemCard key={item.id} {...cardProps(item)} />)
                    : <div className="objective-view-empty">No objectives match the selected planning scope.</div>}
                </div> : section === 'roadmap' ? <div className="objective-roadmap-view" aria-label="Objective roadmap">
                  {roadmapGroups.length ? roadmapGroups.map(([label, group]) => (
                    <section className="objective-roadmap-group" aria-label={label} key={label}>
                      <h4>{label}<span>{group.items.length}</span></h4>
                      <div>{group.items.map((item) => <ObjectiveItemCard key={item.id} {...cardProps(item)} />)}</div>
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
                  paginationPageSize={pageSize}
                  suppressPaginationPanel
                  onGridReady={({ api }) => {
                    setObjectiveGridApi(api);
                    setPagination({ page: api.paginationGetCurrentPage(), pages: api.paginationGetTotalPages(),
                      count: api.paginationGetRowCount() });
                  }}
                  onPaginationChanged={({ api }) => setPagination({ page: api.paginationGetCurrentPage(),
                    pages: api.paginationGetTotalPages(), count: api.paginationGetRowCount() })}
                  rowSelection={{ mode: 'multiRow', checkboxes: true, headerCheckbox: true, selectAll: 'filtered', enableClickSelection: 'enableSelection' }}
                  selectionColumnDef={{ width: 32, minWidth: 32, maxWidth: 32, pinned: 'left', resizable: false, sortable: false, suppressMovable: true }}
                  onRowDataUpdated={({ api }) => {
                    if (selectedIDRef.current || api.getSelectedRows().length) return;
                    const first = api.getDisplayedRowAtIndex(0)?.data;
                    if (first) selectObjective(first);
                  }}
                  onSelectionChanged={({ api, source }) => {
                    // The grid reports its own programmatic selections after a delay. Acting on that report would
                    // replace an objective chosen in the meantime, so only a person's choice in the grid selects.
                    if (source === 'api') return;
                    const item = api.getSelectedRows()[0];
                    if (item) selectObjective(item);
                  }}
                  overlayNoRowsTemplate={`<span class="ag-overlay-no-rows-center">${gridEmptyMessage}</span>`}
                />
              ) : view === 'cards' ? (
                <div className="objective-card-grid">
                  {filteredItems.length ? filteredItems.map((item) => <ObjectiveItemCard key={item.id} {...cardProps(item)} />)
                    : <div className="objective-view-empty">No objectives match these filters.</div>}
                </div>
              ) : (
                <div className="objective-kanban">
                  {objectiveStatusOptions.map(({ value, label }) => {
                    const statusItems = filteredItems.filter((item) => item.status === value);
                    return <section className="objective-kanban-column" aria-label={label} key={value}>
                      <h4>{label}<span>{statusItems.length}</span></h4>
                      {statusItems.length ? statusItems.map((item) => <ObjectiveItemCard key={item.id} {...cardProps(item)} />)
                        : <div className="objective-view-empty">No objectives</div>}
                    </section>;
                  })}
                </div>
              )}
              {showsTable && <div className="objective-preview-pagination">
                <span>Showing {pagination.count ? pagination.page * pageSize + 1 : 0}–{Math.min((pagination.page + 1) * pageSize,
                  pagination.count)} of {pagination.count} objectives</span>
                <nav aria-label="Objectives pages">
                  {objectivePageNumbers(pagination.page, pagination.pages).map((page, index, pages) => <React.Fragment key={page}>
                    {index > 0 && page - pages[index - 1] > 1 && <span aria-hidden="true">…</span>}
                    <button type="button" aria-label={`Page ${page + 1}`}
                      aria-current={pagination.page === page ? 'page' : undefined}
                      onClick={() => objectiveGridApi?.paginationGoToPage(page)}>{page + 1}</button>
                  </React.Fragment>)}
                </nav>
              </div>}
            </div>
            <div className="objective-grid-footer-placeholder" />
          </PanelCard>
          <PanelCard className="objective-capacity" withBorder>
            <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconCalendar size={18} /></span>}
              title="Objective Planning & Capacity"
              description="Planned vs. actual objective delivery (This Quarter)"
              actions={sourceView.capacity && <div className="objective-capacity-legend"><span><i />Planned (cumulative)</span><span><i />Completed (cumulative)</span></div>} />
            {sourceView.capacity ? <AreaChart className="objective-capacity-chart" h={111} data={sourceView.capacity} dataKey="week"
              series={[{ name: 'planned', color: '#bd70f2', label: 'Planned' }, { name: 'completed', color: '#23d9a0', label: 'Completed' }]}
              withXAxis withYAxis withDots withTooltip gridAxis="xy" xAxisProps={{ tickLine: false, axisLine: false }}
              yAxisProps={{ width: 25, domain: [0, 40], ticks: [0, 10, 20, 30, 40], interval: 0 }} />
              : <p className="objective-unavailable-note">Unavailable: the control plane does not record when objectives were planned or completed.</p>}
          </PanelCard>
        </div>
        <div className="objective-detail-stack">
        <PanelCard className="objective-detail-panel" withBorder>
          {selected ? <ObjectiveDetail item={selected} source={source} tab={detailTab} editing={editing} notice={actionNotice}
            onTab={setDetailTab} onEditing={setEditing} onNotice={setActionNotice} /> : (
            <div className="objective-detail-empty"><span className="detail-objective-icon"><IconTarget size={19} /></span><h3>Objective details</h3><p>Select an objective to see its plan and progress, or create the first objective for this workspace.</p><Button className="new-objective-button" onClick={() => setCreateOpen(true)}>Create objective</Button></div>
          )}
          <ObjectiveMilestones details={selected && sourceView.details(selected)} />
        </PanelCard>
        </div>
      </div>

      <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="New objective" centered className="objective-modal">
        <form onSubmit={createForm.onSubmit((values) => void createObjective(values))}>
          <TextInput label="Objective title" placeholder="e.g. Improve review velocity" required {...createForm.getInputProps('title')} />
          <Textarea label="Description" placeholder="Describe the outcome and why it matters" minRows={3} {...createForm.getInputProps('description')} />
          <div className="objective-form-row">
            <TextInput label="Owner" placeholder="Name" {...createForm.getInputProps('owner')} />
            <Select label="Product" data={source.products}
              disabled={source.productsLoading || source.productsFailed} clearable {...createForm.getInputProps('product_id')} />
          </div>
          {source.productsFailed && <Text className="form-error" role="alert">Product choices are unavailable. You can create this objective without a product.</Text>}
          <TextInput label="Due date" type="date" {...createForm.getInputProps('due_date')} />
          {submitError && <Text className="form-error" role="alert">{submitError}</Text>}
          <div className="objective-form-actions"><Button variant="subtle" type="button" onClick={() => setCreateOpen(false)}>Cancel</Button><Button className="new-objective-button" type="submit" loading={creating}>Create objective</Button></div>
        </form>
      </Modal>
    </div>
  );
}
