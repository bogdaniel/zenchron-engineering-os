import { useState } from 'react';
import { Badge, Button, Menu, Modal, Progress, TextInput } from '@mantine/core';
import type { ReactNode } from 'react';
import {
  IconActivity, IconApps, IconBook, IconBrandFigma, IconBrandGithub, IconCalendarTime, IconChartBar,
  IconChevronDown, IconChevronRight, IconCode, IconCube, IconDots, IconFileText, IconFilter, IconFolder,
  IconGitBranch, IconHierarchy, IconHistory, IconHome, IconLink, IconMap2,
  IconPlayerPlay, IconRobot, IconRocket, IconSearch, IconShare, IconStack2, IconStar, IconTarget, IconUsers,
} from '@tabler/icons-react';
import { MetricCard } from './MetricCard';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import './workspace-preview.css';

const products = [
  ['Nova Platform', 'Developer platform & tools', 'Active', 'layers'],
  ['Orion Analytics', 'Data & insights for teams', 'Active', 'chart'],
  ['Helix Agents', 'AI engineering agents', 'Active', 'agents'],
  ['Atlas Workspace', 'Team productivity suite', 'Planning', 'workspace'],
  ['Pulse Integrations', 'Platform & third-party sync', 'Active', 'link'],
] as const;

const initiatives = [
  ['Platform v3.0', 'In Progress', '0%', '36%', 'green'],
  ['AI Agent SDK', 'In Progress', '25%', '42%', 'purple'],
  ['Enterprise Controls', 'Planned', '52%', '24%', 'blue'],
  ['Developer Experience', 'Planned', '72%', '25%', 'teal'],
] as const;

const objectives = [
  ['Ship Platform v3.0', '78%'],
  ['Launch Agent SDK (Beta)', '62%'],
  ['Improve build & test time by 40%', '34%'],
  ['Expand enterprise readiness', '20%'],
  ['Increase developer adoption', '18%'],
] as const;

const releases = [
  ['Stable (v3.x)', 'Live', 'v3.0.2', '100%', 'green'],
  ['Beta (v3.1)', 'In Progress', 'v3.1.0-rc.2', '72%', 'blue'],
  ['Next (v3.2)', 'Planned', 'v3.2.0', '0%', 'purple'],
] as const;

const decisions = [
  ['Adopt layered agent SDK architecture', 'Approved', '2h ago'],
  ['Move v3.0 GA to Jan 27', 'Approved', '6h ago'],
  ['Use feature flags for enterprise rollout', 'Approved', '1d ago'],
  ['Defer custom permissions to v3.2', 'Pending', '1d ago'],
] as const;

const tabs = ['Overview', 'Objectives', 'Repos', 'Files', 'Decisions', 'Templates'] as const;
type PreviewTab = typeof tabs[number];
const quarterOptions = ["Q1 ’25", "Q2 ’25", "Q3 ’25", "Q4 ’25", "Q1 ’26", "Q2 ’26", "Q3 ’26", "Q4 ’26"];
const deliveryMetrics = {
  'Last 4 weeks': ['3.8 days', '10.2 hrs', '1.1%'],
  'Last 8 weeks': ['4.2 days', '11.6 hrs', '1.3%'],
  'Last 12 weeks': ['4.7 days', '13.1 hrs', '1.8%'],
} as const;

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

export function WorkspaceDesignPreview() {
  const [search, setSearch] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<string>(products[0][0]);
  const [statusFilter, setStatusFilter] = useState<'All' | 'Active' | 'Planning'>('All');
  const [favoriteProducts, setFavoriteProducts] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<PreviewTab>('Overview');
  const [roadmapView, setRoadmapView] = useState<'Roadmap' | 'Timeline'>('Roadmap');
  const [roadmapQuarter, setRoadmapQuarter] = useState(quarterOptions[1]);
  const [deliveryRange, setDeliveryRange] = useState<keyof typeof deliveryMetrics>('Last 8 weeks');
  const [newProductOpen, setNewProductOpen] = useState(false);
  const [newProductName, setNewProductName] = useState('');
  const [addedProducts, setAddedProducts] = useState<string[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [stakeholdersOpen, setStakeholdersOpen] = useState(false);
  const productNames = [...products.map(([name]) => name), ...addedProducts];
  const visibleProducts = productNames.filter((name) => name.toLowerCase().includes(search.trim().toLowerCase()) &&
    (statusFilter === 'All' || (products.find(([productName]) => productName === name)?.[2] ?? 'Active') === statusFilter));
  const isDuplicateProduct = productNames.some((name) => name.toLowerCase() === newProductName.trim().toLowerCase());
  const productDetails = products.find(([name]) => name === selectedProduct);
  const productDescription = productDetails?.[1] ?? 'Product workspace preview';
  const productIndex = Math.max(0, products.findIndex(([name]) => name === selectedProduct)) % products.length;
  const productSlug = selectedProduct.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const isFavorite = favoriteProducts.includes(selectedProduct);
  const selectedInitiatives = initiatives.map((initiative, index) => selectedProduct === products[0][0] ? initiative : [
    `${selectedProduct} ${['v2.0', 'SDK', 'Controls', 'Developer Experience'][index]}`,
    initiative[1], initiative[2], initiative[3], initiative[4],
  ] as const);
  const selectedObjectives = selectedProduct === products[0][0] ? objectives : objectives.map((objective, index) => [
    `${['Ship', 'Launch', 'Improve', 'Expand', 'Increase'][index]} ${selectedProduct} ${['v2.0', 'Beta', 'reliability', 'adoption', 'delivery'][index]}`,
    objective[1],
  ] as const);
  const selectedRepositories = selectedProduct === products[0][0]
    ? ['zenchron/nova-platform', 'zenchron/agent-sdk', 'zenchron/platform-services', 'zenchron/devtools']
    : [`zenchron/${productSlug}`, `zenchron/${productSlug}-sdk`, `zenchron/${productSlug}-services`, `zenchron/${productSlug}-devtools`];
  const selectedDecisions = selectedProduct === products[0][0] ? decisions : decisions.map(([name, state, time], index) => [
    [`Adopt layered architecture for ${selectedProduct}`, `Move ${selectedProduct} GA to Jan 27`,
      `Use feature flags for ${selectedProduct}`, `Defer custom permissions for ${selectedProduct}`][index], state, time,
  ] as const);
  const selectedReleases = selectedProduct === products[0][0] ? releases : releases.map((release, index) => [
    ['Stable (v2.x)', 'Beta (v2.1)', 'Next (v2.2)'][index], release[1],
    ['v2.0.2', 'v2.1.0-rc.2', 'v2.2.0'][index], release[3], release[4],
  ] as const);
  const productHealth = ['99.4%', '96.8%', '98.2%', '94.5%', '99.1%'][productIndex];
  const activeInitiativeCount = ['7', '5', '4', '6', '3'][productIndex];
  const onTimeDelivery = ['68%', '74%', '62%', '81%', '70%'][productIndex];

  function addProduct() {
    const name = newProductName.trim();
    if (!name || isDuplicateProduct) return;
    setAddedProducts((current) => [...current, name]);
    setSelectedProduct(name);
    setNewProductName('');
    setNewProductOpen(false);
    setActiveTab('Overview');
  }

  return <section className="workspace-mock" aria-label="Product Workspace design preview" data-preview="mock">
    <aside className="workspace-mock-directory" aria-label="Product workspaces">
      <PanelHeading title="Product Workspace" description="Organize engineering work by product, roadmap, and delivery." />
      <button className="workspace-mock-new" onClick={() => setNewProductOpen(true)} type="button">＋ New Workspace</button>
      <div className="workspace-mock-search-row">
        <TextInput aria-label="Search products" placeholder="Search products…" leftSection={<IconSearch size={14} />}
          value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><button className="workspace-mock-filter" type="button" aria-label={`Filter products: ${statusFilter}`}><IconFilter size={13} /></button></Menu.Target>
          <Menu.Dropdown>{(['All', 'Active', 'Planning'] as const).map((filter) => <Menu.Item key={filter}
            onClick={() => setStatusFilter(filter)}>{filter}</Menu.Item>)}</Menu.Dropdown>
        </Menu>
      </div>
      <div className="workspace-mock-products">
        {visibleProducts.map((name) => {
          const product = products.find(([productName]) => productName === name);
          const [, description, state, icon] = product ?? [name, 'Product workspace preview', 'Active', 'layers'];
          return <button key={name} type="button" onClick={() => { setSelectedProduct(name); setActiveTab('Overview'); }}
            aria-pressed={selectedProduct === name} className={`workspace-mock-product${selectedProduct === name ? ' selected' : ''}`}>
          <span className={`workspace-mock-product-icon ${icon}`}>{icon === 'chart' ? <IconChartBar size={17} />
            : icon === 'agents' ? <IconRobot size={17} /> : icon === 'workspace' ? <IconHierarchy size={17} />
              : icon === 'link' ? <IconLink size={17} /> : <IconStack2 size={17} />}</span>
          <span className="workspace-mock-product-copy"><b>{name}</b><small>{description}</small></span>
          <Badge className={state === 'Active' ? 'workspace-mock-active' : 'workspace-mock-planning'} variant="light">{state}</Badge>
          <IconChevronRight className="workspace-mock-chevron" size={13} />
        </button>;
        })}
        {!visibleProducts.length && <p className="workspace-mock-empty">No products match your search.</p>}
        <button className="workspace-mock-all" onClick={() => { setSearch(''); setStatusFilter('All'); }} type="button"><IconApps size={15} /> All Products ({products.length + addedProducts.length}) <IconChevronRight size={13} /></button>
      </div>
    </aside>

    <div className="workspace-mock-detail">
      <header className="workspace-mock-heading">
        <span className="workspace-mock-product-icon large"><IconStack2 size={25} /></span>
        <div><div className="workspace-mock-name-row"><h1>{selectedProduct}</h1><button className="workspace-mock-favorite" type="button"
          aria-label={`${isFavorite ? 'Remove' : 'Add'} ${selectedProduct} ${isFavorite ? 'from' : 'to'} favorites`}
          aria-pressed={isFavorite} onClick={() => setFavoriteProducts((current) => current.includes(selectedProduct)
            ? current.filter((name) => name !== selectedProduct) : [...current, selectedProduct])}>
          <IconStar size={17} fill={isFavorite ? 'currentColor' : 'none'} /></button></div>
          <p>{selectedProduct === products[0][0] ? 'Developer platform, APIs, and core services for building on Zenchron.' : productDescription}</p>
          <span className="workspace-mock-meta"><b>● Active</b><i /> Product <i /> Owner: Platform Eng <i /> Updated 2m ago</span></div>
        <button onClick={() => setShareOpen(true)} type="button"><IconShare size={13} /> Share</button>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><button className="workspace-mock-menu" aria-label="Product actions" type="button"><IconDots size={16} /></button></Menu.Target>
          <Menu.Dropdown><Menu.Item onClick={() => setActiveTab('Overview')}>Open overview</Menu.Item>
            <Menu.Item onClick={() => setNewProductOpen(true)}>Add another product</Menu.Item></Menu.Dropdown>
        </Menu>
        <button className="workspace-mock-add" onClick={() => setNewProductOpen(true)} type="button">＋ Add Product</button>
      </header>

      <div className="workspace-mock-metrics">
        <MetricCard className="workspace-mock-metric health" label="Product Health" value={productHealth} icon={<IconActivity size={14} />}
          detail={<span className="workspace-mock-health"><b>✓ Healthy</b><svg viewBox="0 0 64 22" aria-hidden="true"><path d="M1 19 12 17 20 18 29 9 39 13 47 6 54 9 63 1" /></svg></span>} />
        <MetricCard className="workspace-mock-metric initiatives" label="Active Initiatives" value={activeInitiativeCount} icon={<IconStack2 size={14} />}
          detail={<span className="workspace-mock-growth">↑ +2</span>} />
        <MetricCard className="workspace-mock-metric delivery" label="Delivery Metrics" value={onTimeDelivery} icon={<IconChartBar size={14} />}
          detail={<span>On-time delivery <b className="workspace-mock-growth">↑ +6 pts</b></span>} />
        <MetricCard className="workspace-mock-metric" label="Recent Decisions" value="5" icon={<IconHistory size={14} />}
          detail="Last 7 days" />
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
            {(['Roadmap', 'Timeline'] as const).map((view) => <button key={view} type="button"
              aria-pressed={roadmapView === view} className={roadmapView === view ? 'selected' : ''}
              onClick={() => setRoadmapView(view)}>{view === 'Timeline' && <IconCalendarTime size={11} />}{view}</button>)}
            <Menu position="bottom-end" withinPortal>
              <Menu.Target><button type="button" aria-label="Choose roadmap quarter">{roadmapQuarter}<IconChevronDown size={10} /></button></Menu.Target>
              <Menu.Dropdown>{quarterOptions.map((quarter) => <Menu.Item key={quarter} onClick={() => setRoadmapQuarter(quarter)}>{quarter}</Menu.Item>)}</Menu.Dropdown>
            </Menu>
          </span>}>
          {roadmapView === 'Roadmap' ? <div className="workspace-mock-roadmap"><div className="workspace-mock-quarter-labels"><span />{[quarterOptions[Math.max(0, quarterOptions.indexOf(roadmapQuarter) - 1)], roadmapQuarter, 'Today', quarterOptions[Math.min(7, quarterOptions.indexOf(roadmapQuarter) + 1)], quarterOptions[Math.min(7, quarterOptions.indexOf(roadmapQuarter) + 2)]].map((q, index) => <span key={`${q}-${index}`}>{q}</span>)}</div>
            {selectedInitiatives.map(([name, status, start, width, tone]) => <div className="workspace-mock-roadmap-row" key={name}>
              <span className={`workspace-mock-dot ${tone}`} /> <b>{name}</b><div className="workspace-mock-track"><span className={tone} style={{ left: start, width }}>{status}</span></div>
            </div>)}
          </div> : <div className="workspace-mock-timeline">{selectedInitiatives.map(([name, status, , , tone]) => <div className="workspace-mock-timeline-row" key={name}>
            <span className={`workspace-mock-dot ${tone}`} /><b>{name}</b><small>{status}</small></div>)}</div>}
        </Card>
        <Card className="objectives" title="Open Objectives (5)" icon={<IconTarget size={15} />} action="View All"
          onAction={() => setActiveTab('Objectives')}
          hidden={activeTab !== 'Overview' && activeTab !== 'Objectives'}>
          <div className="workspace-mock-objectives">{selectedObjectives.map(([title, progress], index) => <div key={title}>
            <span className={`workspace-mock-objective-status${index < 2 ? ' done' : ''}`}>{index < 2 ? '✓' : '○'}</span><b>{title}</b>
            <Progress value={Number(progress.slice(0, -1))} size="xs" color="teal.5" /><small>{progress}</small>
          </div>)}</div>
        </Card>

        <Card className="repositories" title="Repositories (6)" icon={<IconCode size={15} />} action="View All"
          onAction={() => setActiveTab('Repos')}
          hidden={activeTab !== 'Overview' && activeTab !== 'Repos'}>
          <div className="workspace-mock-list">{selectedRepositories.map((repo) => <div key={repo}><IconBrandGithub className="workspace-mock-git-icon" size={13} aria-hidden="true" /><b>{repo}</b><span className="workspace-mock-repo-branch">Main</span></div>)}<small>+ 2 more repositories</small></div>
        </Card>
        <Card className="linked-workflows" title={activeTab === 'Templates' ? 'Workflow Templates (4)' : 'Linked Workflows (4)'}
          icon={<IconHierarchy size={15} />} action="View All" onAction={() => setActiveTab('Templates')}
          hidden={activeTab !== 'Overview' && activeTab !== 'Repos' && activeTab !== 'Templates'}>
          <div className="workspace-mock-list status-list">{[['PR Review & CI', 'Running'], ['Build & Test', 'Success'], ['Release (Staging)', 'Success'], ['Release (Prod)', 'Scheduled']].map(([name, state]) => <div key={name}><span className="workspace-mock-run"><IconPlayerPlay size={12} fill="currentColor" /></span><b>{name}</b><Badge className={`workspace-mock-state ${state.toLowerCase().replaceAll(' ', '-')}`} variant="light">{state}</Badge></div>)}</div>
        </Card>
        <Card className="files" title="Design / Docs / Files" icon={<IconFileText size={15} />} action="View All"
          onAction={() => setActiveTab('Files')}
          hidden={activeTab !== 'Overview' && activeTab !== 'Files'}>
          <div className="workspace-mock-list files">{[['Designs (Figma)', '24'], ['Documentation', '118'], ['Product Specs', '34'], ['Files & Assets', '269']].map(([name, count], i) => <div key={name}><span>{i === 0 ? <IconBrandFigma size={14} /> : i === 1 ? <IconBook size={14} /> : i === 2 ? <IconFileText size={14} /> : <IconFolder size={14} />}</span><b>{name}</b><em>{count}</em></div>)}</div>
        </Card>
        <Card className="people" title="Stakeholders (8)" icon={<IconUsers size={15} />} action="Manage"
          onAction={() => setStakeholdersOpen(true)}
          hidden={activeTab !== 'Overview' && activeTab !== 'Decisions'}>
          <div className="workspace-mock-list people">{[['Alex Chen', 'Product Owner'], ['Priya Shah', 'Engineering Manager'], ['Marcus Lee', 'Design Lead'], ['Elena Rossi', 'Product Manager']].map(([name, role]) => <div key={name}><span>{name === 'Alex Chen' ? <img src="/alex-chen-avatar.jpg" alt="" /> : name.slice(0, 1)}</span><b>{name}</b><small>{role}</small></div>)}<small>+ 4 more stakeholders</small></div>
        </Card>

        <Card className="release" title="Release Streams" description="Coordinated release trains and environments" icon={<IconRocket size={15} />} action="View All"
          onAction={() => setActiveTab('Templates')}
          hidden={activeTab !== 'Overview' && activeTab !== 'Templates'}>
          <div className="workspace-mock-list release-list">{selectedReleases.map(([name, state, version, progress, tone]) => <div key={name}><IconCube className={`workspace-mock-release-icon ${tone}`} size={16} /><b>{name}</b><Badge className={`workspace-mock-state ${state.toLowerCase().replaceAll(' ', '-')}`} variant="light">{state}</Badge><small>{version}</small><Progress value={Number(progress.slice(0, -1))} size="xs" color={tone === 'green' ? 'teal.5' : tone === 'blue' ? 'blue.5' : 'violet.5'} /></div>)}</div>
        </Card>
        <Card className="decisions" title="Recent Decisions" icon={<IconHistory size={15} />} action="View All"
          onAction={() => setActiveTab('Decisions')}
          hidden={activeTab !== 'Overview' && activeTab !== 'Decisions'}>
          <div className="workspace-mock-list decision-list">{selectedDecisions.map(([name, state, time]) => <div key={name}><IconFileText size={13} /><b>{name}</b><Badge className={`workspace-mock-state ${state.toLowerCase()}`} variant="light">{state}</Badge><small>{time}</small></div>)}</div>
        </Card>
        <Card className="analytics" title="Delivery Metrics" icon={<IconChartBar size={15} />}
          hidden={activeTab !== 'Overview'}
          action={<Menu position="bottom-end" withinPortal>
            <Menu.Target><button className="workspace-mock-range" type="button" aria-label="Choose delivery metrics time range">{deliveryRange}<IconChevronDown size={11} /></button></Menu.Target>
            <Menu.Dropdown>{Object.keys(deliveryMetrics).map((range) => <Menu.Item key={range}
              onClick={() => setDeliveryRange(range as keyof typeof deliveryMetrics)}>{range}</Menu.Item>)}</Menu.Dropdown>
          </Menu>}>
          <div className="workspace-mock-analytics"><div><span>Cycle Time</span><b>{deliveryMetrics[deliveryRange][0]} <small>↓ −28%</small></b></div><div><span>PR Merge Time</span><b>{deliveryMetrics[deliveryRange][1]} <small>↓ −31%</small></b></div><div><span>Change Fail Rate</span><b>{deliveryMetrics[deliveryRange][2]} <small>↓ −0.9 pts</small></b></div>
            <svg viewBox="0 0 150 90" preserveAspectRatio="none" role="img" aria-label="Delivery trend, Nov 24 to Jan 12">
              <defs><linearGradient id="workspace-mock-chart-fill" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#c878ff" stopOpacity=".3" /><stop offset="1" stopColor="#c878ff" stopOpacity="0" /></linearGradient></defs>
              <g className="workspace-mock-grid">{[10, 27, 44, 61].map((y) => <path key={y} d={`M0 ${y}H150`} />)}</g>
              <path className="workspace-mock-area" d="M1 61 17 47 34 49 52 39 68 45 85 34 102 30 119 20 135 13 149 2V72H1Z" />
              <path className="workspace-mock-line" d="M1 61 17 47 34 49 52 39 68 45 85 34 102 30 119 20 135 13 149 2" />
              <g className="workspace-mock-axis">{['Nov 24', 'Dec 1', 'Dec 8', 'Dec 15', 'Dec 22', 'Dec 29', 'Jan 5', 'Jan 12'].map((date, index) => <text key={date} x={index * 21} y="86">{date}</text>)}</g>
            </svg></div>
        </Card>
      </div>
    </div>
    <Modal opened={newProductOpen} onClose={() => setNewProductOpen(false)} title="Add a product to this preview" centered>
      <TextInput autoFocus label="Product name" placeholder="e.g. Nova Platform" value={newProductName}
        onChange={(event) => setNewProductName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') addProduct(); }} />
      {isDuplicateProduct && <p className="workspace-mock-empty" role="alert">A product with this name already exists.</p>}
      <Button mt="md" onClick={addProduct} disabled={!newProductName.trim() || isDuplicateProduct}>Add product</Button>
    </Modal>
    <Modal opened={shareOpen} onClose={() => setShareOpen(false)} title="Share Product Workspace" centered>
      <p>This local preview does not send invitations. Share the page URL with your team to open the same preview.</p>
      <TextInput aria-label="Preview link" value={window.location.href} readOnly />
    </Modal>
    <Modal opened={stakeholdersOpen} onClose={() => setStakeholdersOpen(false)} title="Stakeholders" centered>
      <p>Stakeholder records are illustrative in this preview and cannot be changed here.</p>
    </Modal>
  </section>;
}
