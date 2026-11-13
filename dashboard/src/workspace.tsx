import { Fragment, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Badge, Menu, Modal, Progress, TextInput } from '@mantine/core';
import {
  IconActivity, IconAffiliate, IconApps, IconBook, IconBrandFigma, IconBrandGithub, IconCalendarTime, IconChartBar,
  IconChevronDown, IconChevronRight, IconCode, IconCube, IconDots, IconFileText, IconFilter, IconFolder,
  IconGitBranch, IconHierarchy, IconHistory, IconHome, IconLink, IconMap2,
  IconPlayerPlay, IconRocket, IconSearch, IconShare, IconStack2, IconStar, IconTarget, IconUsers,
} from '@tabler/icons-react';
import { MetricCard } from './MetricCard';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import { ProductEditor } from './productEditor';
import type { ProductInput } from './productEditor';
import { useMockWorkspace } from './workspace-preview-data';
import { useLiveWorkspace } from './workspaceView';
import type { WorkspaceFacts, WorkspaceNote, WorkspaceObjectiveRow, WorkspaceStatusRow } from './workspaceView';
import './workspace-preview.css';

interface WorkspacePageProps extends WorkspaceFacts {
  designPreview?: boolean;
}

const tabs = ['Overview', 'Objectives', 'Repos', 'Files', 'Decisions', 'Templates'] as const;
type WorkspaceTab = typeof tabs[number];
const noFavoritesReason = 'Favorites are not stored by the control plane';
const stateClass = (state: string) => state.toLowerCase().replaceAll(' ', '-');

function Card({ title, description, icon, action, onAction, hidden, className, children }: {
  title: string; description?: string; icon: ReactNode; action?: ReactNode; onAction?: () => void;
  hidden?: boolean; className?: string; children: ReactNode;
}) {
  return <PanelCard className={`workspace-mock-card${className ? ` ${className}` : ''}${hidden ? ' is-hidden' : ''}`} withBorder>
    <PanelHeading title={title} description={description} icon={<span className="workspace-mock-card-icon">{icon}</span>}
      actions={action && (typeof action === 'string' && onAction
        ? <button className="workspace-mock-card-action" onClick={onAction} type="button">{action} →</button>
        : <span className="workspace-mock-card-action">{action}</span>)} />
    {children}
  </PanelCard>;
}

function Note({ note }: { note: WorkspaceNote }) {
  return <p className="workspace-mock-empty" role={note.alert ? 'alert' : undefined}>{note.text}</p>;
}

/** A row title with the secondary facts Live adds after it; the fixtures have none. */
function RowTitle({ title, detail }: { title: string; detail?: string }) {
  if (!detail) return <b>{title}</b>;
  return <b title={`${title} · ${detail}`}><span>{title}</span><span className="workspace-mock-row-detail"> · {detail}</span></b>;
}

function ObjectiveRows({ rows }: { rows: WorkspaceObjectiveRow[] }) {
  return <div className="workspace-mock-objectives">{rows.map((row) => <div key={row.title}>
    <span className={`workspace-mock-objective-status${row.done ? ' done' : ''}`} role="img"
      aria-label={row.done ? 'Completed objective' : 'Open objective'}>{row.done ? '✓' : ''}</span>
    <RowTitle title={row.title} detail={row.detail} />
    <Progress value={row.progress} size="xs" color="teal.5" /><small>{`${row.progress}%`}</small>
  </div>)}</div>;
}

function StatusRows({ rows }: { rows: WorkspaceStatusRow[] }) {
  return <div className="workspace-mock-list status-list">{rows.map(({ name, state }) => <div key={`${name}-${state}`}>
    <span className="workspace-mock-run"><IconPlayerPlay size={12} fill="currentColor" /></span><b>{name}</b>
    <Badge className={`workspace-mock-state ${stateClass(state)}`} variant="light">{state}</Badge>
  </div>)}</div>;
}

export function WorkspacePage({ designPreview = false, ...facts }: WorkspacePageProps) {
  const mock = useMockWorkspace();
  const live = useLiveWorkspace(!designPreview, facts);
  const source = designPreview ? mock : live;
  const [search, setSearch] = useState('');
  const [selectedID, setSelectedID] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('Overview');
  const [roadmapView, setRoadmapView] = useState<'Roadmap' | 'Timeline'>('Roadmap');
  const [roadmapQuarter, setRoadmapQuarter] = useState<string>();
  const [deliveryRange, setDeliveryRange] = useState('Last 8 weeks');
  const [editor, setEditor] = useState<{ productID?: string } | null>(null);
  const [saveError, setSaveError] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [stakeholdersOpen, setStakeholdersOpen] = useState(false);
  const { products } = source;
  const selected = products.find((product) => product.id === selectedID) ?? products[0];
  const view = source.view(selected?.id, roadmapQuarter);
  const { metrics, roadmap, objectives, repositories, workflows, files, stakeholders, releases, decisions, delivery } = view;
  const visibleProducts = products.filter((product) => product.name.toLowerCase().includes(search.trim().toLowerCase())
    && (statusFilter === 'All' || product.state === statusFilter));
  const isFavorite = Boolean(selected && source.favorites.includes(selected.id));
  const showAll = activeTab !== 'Overview';
  const objectiveList = activeTab === 'Objectives'
    ? { title: objectives.allTitle, rows: objectives.allRows, note: objectives.allNote } : objectives;
  const workflowList = activeTab === 'Templates'
    ? { title: workflows.templatesTitle, rows: workflows.templateRows, note: workflows.templatesNote } : workflows;
  const chartLine = delivery.chart && `M${delivery.chart.points.map((point) => point.join(' ')).join(' ')}`;

  function selectProduct(productID: string) {
    setSelectedID(productID);
    setActiveTab('Overview');
  }

  function openEditor(productID?: string) {
    setSaveError('');
    setEditor({ productID });
  }

  function saveProduct(input: ProductInput) {
    source.saveProduct(input, editor?.productID).then((product) => {
      selectProduct(product.id);
      setEditor(null);
    }, (error: Error) => setSaveError(error.message));
  }

  return <section className="workspace-mock" aria-label="Product Workspace">
    <aside className="workspace-mock-directory" aria-label="Product workspaces">
      <PanelHeading title="Product Workspace" description="Organize engineering work by product, roadmap, and delivery." />
      <button className="workspace-mock-new" onClick={() => openEditor()} type="button">＋ New Workspace</button>
      <div className="workspace-mock-search-row">
        <TextInput aria-label="Search products" placeholder="Search products…" leftSection={<IconSearch size={14} />}
          value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><button className="workspace-mock-filter" type="button" aria-label={`Filter products: ${statusFilter}`}><IconFilter size={13} /></button></Menu.Target>
          <Menu.Dropdown>{source.statuses.map((filter) => <Menu.Item key={filter}
            onClick={() => setStatusFilter(filter)}>{filter}</Menu.Item>)}</Menu.Dropdown>
        </Menu>
      </div>
      <div className="workspace-mock-products">
        {!source.directoryNote && visibleProducts.map((product) => <button key={product.id} type="button" onClick={() => selectProduct(product.id)}
          aria-pressed={selected?.id === product.id} className={`workspace-mock-product${selected?.id === product.id ? ' selected' : ''}`}>
          <span className={`workspace-mock-product-icon ${product.icon}`}>{product.icon === 'chart' ? <IconChartBar size={17} />
            : product.icon === 'agents' ? <IconAffiliate size={17} /> : product.icon === 'workspace' ? <IconHierarchy size={17} />
              : product.icon === 'link' ? <IconLink size={17} /> : <IconStack2 size={17} />}</span>
          <span className="workspace-mock-product-copy"><b>{product.name}</b><small>{product.summary}</small></span>
          <Badge className={product.healthy ? 'workspace-mock-active' : 'workspace-mock-planning'} variant="light">{product.state}</Badge>
          <IconChevronRight className="workspace-mock-chevron" size={13} />
        </button>)}
        {source.directoryNote ? <Note note={source.directoryNote} />
          : !visibleProducts.length && <p className="workspace-mock-empty">No products match your search.</p>}
        <button className="workspace-mock-all" onClick={() => { setSearch(''); setStatusFilter('All'); }} type="button"><IconApps size={15} /> All Products ({products.length}) <IconChevronRight size={13} /></button>
      </div>
    </aside>

    <div className="workspace-mock-detail">
      <header className="workspace-mock-heading">
        <span className="workspace-mock-product-icon large"><IconStack2 size={25} /></span>
        <div><div className="workspace-mock-name-row"><h1>{view.name}</h1><button className="workspace-mock-favorite" type="button"
          aria-label={`${isFavorite ? 'Remove' : 'Add'} ${view.name} ${isFavorite ? 'from' : 'to'} favorites`}
          aria-pressed={isFavorite} disabled={!source.toggleFavorite || !selected}
          title={source.toggleFavorite ? undefined : noFavoritesReason}
          onClick={() => selected && source.toggleFavorite?.(selected.id)}>
          <IconStar size={17} fill={isFavorite ? 'currentColor' : 'none'} /></button></div>
          <p>{view.description}</p>
          <span className="workspace-mock-meta"><b className={view.status.healthy ? undefined : 'attention'}>● {view.status.label}</b>
            {view.facts.map((fact) => <Fragment key={fact}><i /> {fact} </Fragment>)}</span></div>
        <button onClick={() => setShareOpen(true)} type="button"><IconShare size={13} /> Share</button>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><button className="workspace-mock-menu" aria-label="Product actions" type="button"><IconDots size={16} /></button></Menu.Target>
          <Menu.Dropdown><Menu.Item onClick={() => setActiveTab('Overview')}>Open overview</Menu.Item>
            <Menu.Item disabled={!selected} onClick={() => openEditor(selected?.id)}>Edit product</Menu.Item>
            <Menu.Item onClick={() => openEditor()}>Add another product</Menu.Item>
            <Menu.Item component="a" href="#projects">Open repository inventory</Menu.Item>
            {/* The directory is hidden on narrow screens; this keeps product switching reachable there. */}
            {products.length > 0 && <Menu.Label>Switch product</Menu.Label>}
            {products.map((product) => <Menu.Item key={product.id} onClick={() => selectProduct(product.id)}>{product.name}</Menu.Item>)}
          </Menu.Dropdown>
        </Menu>
        <button className="workspace-mock-add" onClick={() => openEditor()} type="button">＋ Add Product</button>
      </header>

      <div className="workspace-mock-metrics">
        <MetricCard className="workspace-mock-metric health" label="Product Health" value={metrics.health.value} icon={<IconActivity size={14} />}
          detail={<span className={`workspace-mock-health${metrics.health.healthy ? '' : ' attention'}`}><b>{metrics.health.badge}</b>
            {metrics.health.trend && <svg viewBox="0 0 64 22" aria-hidden="true"><path d={metrics.health.trend} /></svg>}</span>} />
        <MetricCard className="workspace-mock-metric initiatives" label={metrics.initiatives.label} value={metrics.initiatives.value} icon={<IconStack2 size={14} />}
          trend={<span className="workspace-mock-initiative-trend">{metrics.initiatives.delta && <b>{metrics.initiatives.delta}</b>}
            {metrics.initiatives.caption && <small>{metrics.initiatives.caption}</small>}
            {metrics.initiatives.trend && <svg viewBox="0 0 64 26" role="img" aria-label="Active initiative trend">
              <path d={metrics.initiatives.trend} /></svg>}</span>} />
        <MetricCard className="workspace-mock-metric delivery" label="Delivery Metrics" value={metrics.delivery.value} icon={<IconChartBar size={14} />}
          trend={<span className="workspace-mock-delivery-trend"><span>{metrics.delivery.caption}{metrics.delivery.delta && <b>{metrics.delivery.delta}</b>}</span>
            {metrics.delivery.bars && <svg className="workspace-mock-delivery-bars" viewBox="0 0 58 30" role="img" aria-label="Delivery metrics trend">
              {metrics.delivery.bars.map((height, index) => <rect key={index} x={index * 9} y={30 - height} width="5" height={height} />)}
            </svg>}</span>} />
        <MetricCard className="workspace-mock-metric decisions" label="Recent Decisions" value={metrics.decisions.value} icon={<IconHistory size={14} />}
          trend={<IconStack2 className="workspace-mock-decisions-mark" size={34} aria-hidden="true" />}
          detail={metrics.decisions.detail} />
      </div>

      <nav className="workspace-mock-tabs" aria-label="Product sections">
        {tabs.map((tab, index) => <button key={tab} type="button" aria-current={activeTab === tab ? 'page' : undefined}
          onClick={() => setActiveTab(tab)} className={activeTab === tab ? 'active' : ''}>
          {index === 0 ? <IconHome size={13} /> : index === 1 ? <IconTarget size={13} />
            : index === 2 ? <IconCode size={13} /> : index === 3 ? <IconFolder size={13} />
              : index === 4 ? <IconGitBranch size={13} /> : <IconStack2 size={13} />}{tab}
        </button>)}
      </nav>

      <div className={`workspace-mock-grid ${activeTab.toLowerCase()}`}>
        <Card className="roadmap" title="Product Roadmap" description="Strategic delivery plan and key milestones" icon={<IconMap2 size={15} />}
          hidden={activeTab !== 'Overview' && activeTab !== 'Objectives'}
          action={<span className="workspace-mock-roadmap-tabs">
            {(['Roadmap', 'Timeline'] as const).map((option) => <button key={option} type="button"
              aria-pressed={roadmapView === option} className={roadmapView === option ? 'selected' : ''}
              onClick={() => setRoadmapView(option)}>{option === 'Timeline' && <IconCalendarTime size={11} />}{option}</button>)}
            <Menu position="bottom-end" withinPortal>
              <Menu.Target><button type="button" aria-label="Choose roadmap quarter" disabled={!roadmap.quarters.length}
                title={roadmap.quarters.length ? undefined : 'No dated objectives to place on the roadmap'}>Quarterly<IconChevronDown size={10} /></button></Menu.Target>
              <Menu.Dropdown>{roadmap.quarters.map((quarter) => <Menu.Item key={quarter} onClick={() => setRoadmapQuarter(quarter)}>{quarter}</Menu.Item>)}</Menu.Dropdown>
            </Menu>
          </span>}>
          {roadmap.note ? <Note note={roadmap.note} /> : roadmapView === 'Roadmap' ? <div className="workspace-mock-roadmap"
            data-today={roadmap.todayAt ? '' : undefined} style={{ '--workspace-today': roadmap.todayAt } as CSSProperties}>
            <div className="workspace-mock-quarter-labels"><span />{roadmap.labels.map((label, index) => <span
              key={`${label.text}-${index}`} className={label.today ? 'today' : undefined}>{label.text}</span>)}</div>
            {roadmap.rows.map((row) => <div className="workspace-mock-roadmap-row" key={row.name}>
              <span className={`workspace-mock-dot ${row.tone}`} /> <b title={row.detail}>{row.name}</b><div className="workspace-mock-track">
                {row.bar && <span className={row.tone} style={row.bar}>{row.status}</span>}</div>
            </div>)}
          </div> : <div className="workspace-mock-timeline">{roadmap.rows.map((row) => <div className="workspace-mock-timeline-row" key={row.name}>
            <span className={`workspace-mock-dot ${row.tone}`} /><b>{row.name}</b><small>{row.detail ? `${row.status} · ${row.detail}` : row.status}</small></div>)}</div>}
        </Card>
        <Card className="objectives" title={objectiveList.title} icon={<IconTarget size={15} />} action="View All"
          onAction={() => setActiveTab('Objectives')}
          hidden={activeTab !== 'Overview' && activeTab !== 'Objectives'}>
          {objectiveList.note ? <Note note={objectiveList.note} /> : <ObjectiveRows rows={objectiveList.rows} />}
        </Card>

        <Card className="repositories" title={repositories.title} icon={<IconCode size={15} />} action="View All"
          onAction={() => setActiveTab('Repos')}
          hidden={activeTab !== 'Overview' && activeTab !== 'Repos'}>
          {repositories.note ? <Note note={repositories.note} /> : <div className="workspace-mock-list">
            {(showAll ? repositories.allRows : repositories.rows).map((repository) => <div key={repository.name}>
              <IconBrandGithub className="workspace-mock-git-icon" size={13} aria-hidden="true" />
              <RowTitle title={repository.name} detail={repository.detail} /><span className="workspace-mock-repo-branch">{repository.branch}</span></div>)}
            {repositories.more && (!showAll || repositories.allRows.length === repositories.rows.length) && <small>{repositories.more}</small>}</div>}
        </Card>
        <Card className="linked-workflows" title={workflowList.title}
          icon={<IconHierarchy size={15} />} action="View All" onAction={() => setActiveTab('Templates')}
          hidden={activeTab !== 'Overview' && activeTab !== 'Repos' && activeTab !== 'Templates'}>
          {workflowList.note ? <Note note={workflowList.note} /> : <StatusRows rows={workflowList.rows} />}
        </Card>
        <Card className="files" title="Design / Docs / Files" icon={<IconFileText size={15} />} action="View All"
          onAction={() => setActiveTab('Files')}
          hidden={activeTab !== 'Overview' && activeTab !== 'Files'}>
          {files.note ? <Note note={files.note} /> : <div className="workspace-mock-list files">{files.rows.map(([name, count], i) => <div key={name}>
            <span>{i === 0 ? <IconBrandFigma size={14} /> : i === 1 ? <IconBook size={14} /> : i === 2 ? <IconFileText size={14} /> : <IconFolder size={14} />}</span><b>{name}</b><em>{count}</em></div>)}</div>}
        </Card>
        <Card className="people" title={stakeholders.title} icon={<IconUsers size={15} />} action="Manage"
          onAction={() => setStakeholdersOpen(true)}
          hidden={activeTab !== 'Overview' && activeTab !== 'Decisions'}>
          {stakeholders.note ? <Note note={stakeholders.note} /> : <div className="workspace-mock-list people">{stakeholders.rows.map(({ name, role, avatar }) => <div key={name}>
            <span>{avatar ? <img src={avatar} alt="" /> : name.slice(0, 1)}</span><b>{name}</b><small>{role}</small></div>)}
            {stakeholders.more && <small>{stakeholders.more}</small>}</div>}
        </Card>
      </div>
    </div>

    <div className={`workspace-mock-bottom ${activeTab.toLowerCase()}`}>
      <Card className="release" title="Release Streams" description="Coordinated release trains and environments" icon={<IconRocket size={15} />} action="View All"
        onAction={() => setActiveTab('Templates')}
        hidden={activeTab !== 'Overview' && activeTab !== 'Templates'}>
        {releases.note ? <Note note={releases.note} /> : <div className="workspace-mock-list release-list">{releases.rows.map(({ name, state, version, progress, tone }) => <div key={name}>
          <IconCube className={`workspace-mock-release-icon ${tone}`} size={16} /><b>{name}</b><Badge className={`workspace-mock-state ${stateClass(state)}`} variant="light">{state}</Badge><small>{version}</small>
          <Progress value={progress} size="xs" color={tone === 'green' ? 'teal.5' : tone === 'blue' ? 'blue.5' : 'violet.5'} /><small className="release-progress-label">{`${progress}%`}</small></div>)}</div>}
      </Card>
      <Card className="decisions" title="Recent Decisions" icon={<IconHistory size={15} />} action="View All"
        onAction={() => setActiveTab('Decisions')}
        hidden={activeTab !== 'Overview' && activeTab !== 'Decisions'}>
        {decisions.note ? <Note note={decisions.note} /> : <div className="workspace-mock-list decision-list">{decisions.rows.map(({ name, state, time }) => <div key={name}>
          <IconFileText size={13} /><b>{name}</b><Badge className={`workspace-mock-state ${stateClass(state)}`} variant="light">{state}</Badge><small>{time}</small></div>)}</div>}
      </Card>
      <Card className="analytics" title="Delivery Metrics" icon={<IconChartBar size={15} />}
        hidden={activeTab !== 'Overview'}
        action={<Menu position="bottom-end" withinPortal>
          <Menu.Target><button className="workspace-mock-range" type="button" aria-label="Choose delivery metrics time range"
            disabled={!delivery.ranges.length} title={delivery.ranges.length ? undefined : delivery.note?.text}>
            {delivery.ranges.length ? deliveryRange : 'No history'}<IconChevronDown size={11} /></button></Menu.Target>
          <Menu.Dropdown>{delivery.ranges.map((range) => <Menu.Item key={range} onClick={() => setDeliveryRange(range)}>{range}</Menu.Item>)}</Menu.Dropdown>
        </Menu>}>
        {delivery.note ? <Note note={delivery.note} /> : <div className="workspace-mock-analytics">
          {delivery.metrics(deliveryRange).map(([label, value, delta]) => <div key={label}><span>{label}</span><b>{value} <small>{delta}</small></b></div>)}
          {delivery.chart && chartLine && <svg viewBox="0 0 150 90" preserveAspectRatio="none" role="img" aria-label={delivery.chart.label}>
            <defs><linearGradient id="workspace-mock-chart-fill" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#c878ff" stopOpacity=".3" /><stop offset="1" stopColor="#c878ff" stopOpacity="0" /></linearGradient></defs>
            <g className="workspace-mock-grid">{[10, 27, 44, 61].map((y) => <path key={y} d={`M0 ${y}H150`} />)}</g>
            <path className="workspace-mock-area" d={`${chartLine}V72H1Z`} />
            <path className="workspace-mock-line" d={chartLine} />
            <g className="workspace-mock-points">{delivery.chart.points.map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" />)}</g>
            <g className="workspace-mock-axis">{delivery.chart.dates.map((date, index) => <text key={date} x={index * 21} y="86">{date}</text>)}</g>
          </svg>}</div>}
      </Card>
    </div>
    <ProductEditor opened={editor !== null} product={editor?.productID ? source.editable(editor.productID) : undefined}
      projects={source.repositories} repositoryNote={source.editorNote} onClose={() => setEditor(null)}
      onSave={saveProduct} isSaving={source.saving} error={saveError} />
    <Modal opened={shareOpen} onClose={() => setShareOpen(false)} title="Share Product Workspace" centered>
      <p>{source.shareNote}</p>
      <TextInput aria-label="Workspace link" value={window.location.href} readOnly />
    </Modal>
    <Modal opened={stakeholdersOpen} onClose={() => setStakeholdersOpen(false)} title="Stakeholders" centered>
      <p>{stakeholders.manageNote}</p>
    </Modal>
  </section>;
}
