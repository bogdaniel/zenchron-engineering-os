import { useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Progress, TextInput } from '@mantine/core';
import {
  IconActivity,
  IconAlertTriangle,
  IconChartBar,
  IconCode,
  IconFileText,
  IconGitBranch,
  IconHistory,
  IconLayersIntersect,
  IconRoute,
  IconSearch,
  IconTarget,
  IconUsers,
} from '@tabler/icons-react';
import { agentsSchema } from './agentsData';
import type { Objective } from './objectives';
import type { Project } from './projects';
import { workflowsSchema } from './workflowModel';
import { loadProducts, ProductEditor, productSchema } from './productEditor';
import type { Product, ProductInput } from './productEditor';
import { MetricCard } from './MetricCard';
import { PanelHeading } from './PanelHeading';
import { PageHeading } from './PageHeading';
import { PanelCard } from './PanelCard';
import './workspace.css';
import { WorkspaceDesignPreview } from './WorkspaceDesignPreview';

type WorkspaceTab = 'overview' | 'objectives' | 'repositories' | 'files' | 'decisions' | 'templates';

interface WorkspacePageProps {
  designPreview?: boolean;
  projects: Project[] | undefined;
  objectives: Objective[] | undefined;
  projectsLoading: boolean;
  projectsError: boolean;
  objectivesLoading: boolean;
  objectivesError: boolean;
}

const tabs: { id: WorkspaceTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'objectives', label: 'Objectives' },
  { id: 'repositories', label: 'Repos' },
  { id: 'files', label: 'Files' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'templates', label: 'Templates' },
];

async function loadWorkflows() {
  const response = await fetch('/api/v1/workflows');
  if (!response.ok) throw new Error(`Could not load workspace workflows (${response.status})`);
  return workflowsSchema.parse(await response.json());
}

async function loadAgents() {
  const response = await fetch('/api/v1/agents');
  if (!response.ok) throw new Error(`Could not load workspace agents (${response.status})`);
  return agentsSchema.parse(await response.json());
}

export function WorkspacePage(props: WorkspacePageProps) {
  if (props.designPreview) return <WorkspaceDesignPreview />;
  return <LiveWorkspacePage {...props} />;
}

function LiveWorkspacePage({
  projects,
  objectives,
  projectsLoading,
  projectsError,
  objectivesLoading,
  objectivesError,
}: WorkspacePageProps) {
  const queryClient = useQueryClient();
  const [selectedID, setSelectedID] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('overview');
  const [editOpen, setEditOpen] = useState(false);
  const [editingID, setEditingID] = useState<string | null>(null);
  const [saveError, setSaveError] = useState('');
  const products = useQuery({ queryKey: ['products'], queryFn: loadProducts });
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: loadWorkflows });
  const agents = useQuery({ queryKey: ['agents'], queryFn: loadAgents });
  const saveProduct = useMutation({
    mutationFn: async (input: ProductInput) => {
      const url = editingID ? `/api/v1/products/${editingID}` : '/api/v1/products';
      const response = await fetch(url, {
        method: editingID ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(await response.text());
      return productSchema.parse(await response.json());
    },
    onSuccess: async (product) => {
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      setSelectedID(product.id);
      setSaveError('');
      setEditOpen(false);
    },
    onError: (error) => setSaveError(error.message),
  });
  const selected = products.data?.find((product) => product.id === selectedID) ?? products.data?.[0];
  const visibleProducts = products.data?.filter((product) =>
    product.name.toLowerCase().includes(productSearch.trim().toLowerCase()),
  ) ?? [];
  const linkedProjects = projects?.filter((project) => selected?.repository_ids.includes(project.id)) ?? [];
  const healthyRepositories = linkedProjects.filter((project) => project.worker_status === 'online').length;
  const productObjectives = objectives?.filter((objective) => objective.product_id === selected?.id) ?? [];
  const openObjectives = productObjectives.filter((objective) => objective.status !== 'completed');

  function openEditor(product?: Product) {
    setEditingID(product?.id ?? null);
    setSaveError('');
    setEditOpen(true);
  }

  return (
    <section className="workspace-page">
      <div className="workspace-title-row">
        <PageHeading eyebrow="PRODUCT WORKSPACE" title="Product Workspace" description="Organize engineering work by product, repositories, and delivery." />
        <Button className="workspace-add-product" onClick={() => openEditor()} type="button">
          + Add Product
        </Button>
      </div>

      <div className="workspace-layout">
        <aside className="workspace-directory shared-panel-surface" aria-label="Project workspaces">
          <PanelHeading className="workspace-directory-heading" title="Product Workspace"
            description="Organize engineering work by product and delivery."
            actions={<Badge className="workspace-count" variant="light">{products.data?.length ?? '—'}</Badge>} />
          <Button className="workspace-add-product workspace-directory-create" onClick={() => openEditor()} type="button">
            + New Workspace
          </Button>
          <TextInput
            aria-label="Search products"
            className="workspace-product-search"
            leftSection={<IconSearch size={15} />}
            placeholder="Search products…"
            value={productSearch}
            onChange={(event) => setProductSearch(event.currentTarget.value)}
          />
          {products.isError ? (
            <div className="workspace-empty" role="alert">Product list unavailable.</div>
          ) : projectsLoading ? (
            <div className="workspace-empty">Loading worker inventory…</div>
          ) : products.isLoading ? (
            <div className="workspace-empty">Loading products…</div>
          ) : products.data?.length ? (
            visibleProducts.length ? <div className="workspace-project-list">
              {visibleProducts.map((product) => <button
                className={`workspace-project-option${product.id === selected?.id ? ' active' : ''}`}
                key={product.id}
                onClick={() => { setSelectedID(product.id); setActiveTab('overview'); }}
                type="button"
              >
                <span className="workspace-project-icon"><IconLayersIntersect size={17} /></span>
                <span className="workspace-project-name">
                  <b>{product.name}</b><small>{product.repository_ids.length} linked repositories</small>
                </span>
                <Badge className="workspace-status active" variant="light">Product</Badge>
              </button>)}
            </div> : <div className="workspace-empty">No products match your search.</div>
          ) : (
            <div className="workspace-empty">{productSearch ? 'No products match your search.' : 'No products yet. Add a product to group repositories.'}</div>
          )}
          <p className="workspace-directory-note">Repository paths stay on each worker.</p>
        </aside>

        <div className="workspace-detail">
          <div className="workspace-project-heading">
            <span className="workspace-project-icon large"><IconLayersIntersect size={20} /></span>
            <div className="workspace-project-copy">
              <span className="eyebrow">PRODUCT</span>
              <h3 className="entity-detail-heading">{selected?.name ?? 'No product selected'}</h3>
              <p>{selected?.description || 'Group repositories and view current engineering work.'}</p>
            </div>
            <div className="workspace-heading-actions">
              {selected && <Badge className={`workspace-status ${healthyRepositories ? 'online' : 'offline'}`}
                variant="light">
                {selected.repository_ids.length === 0 ? 'No repositories'
                  : healthyRepositories ? 'Healthy' : linkedProjects.length ? 'Offline' : 'Unavailable'}
              </Badge>}
              {selected && <Button className="workspace-edit-product" onClick={() => openEditor(selected)} type="button">
                Edit Product
              </Button>}
              <Button className="workspace-add-product" onClick={() => openEditor()} type="button">+ Add Product</Button>
            </div>
          </div>

          <div className="workspace-metrics">
            <WorkspaceMetric
              label="Product health"
              value={!selected ? 'Unavailable' : selected.repository_ids.length === 0 ? 'No repositories'
                : healthyRepositories ? 'Healthy' : linkedProjects.length ? 'Offline' : 'Unavailable'}
              detail={selected ? `${healthyRepositories} of ${selected.repository_ids.length} repositories online`
                : 'No product selected'}
              healthy={Boolean(healthyRepositories)}
              icon={<IconActivity size={16} />}
            />
            <WorkspaceMetric
              label="Open objectives"
              value={objectivesLoading ? 'Loading' : objectivesError ? 'Unavailable' : openObjectives.length}
              detail="Assigned to this product"
              icon={<IconTarget size={16} />}
            />
            <WorkspaceMetric
              label="Workflow definitions"
              value={workflows.isLoading ? 'Loading' : workflows.isError ? 'Unavailable' : workflows.data?.length ?? 0}
              detail="Reusable workflow definitions"
              icon={<IconRoute size={16} />}
            />
            <WorkspaceMetric label="Delivery metrics" value="Unavailable" detail="Requires PR and run history"
              icon={<IconChartBar size={16} />} />
          </div>

          <nav className="workspace-tabs" aria-label="Workspace sections">
            {tabs.map((tab) => (
              <button
                aria-current={activeTab === tab.id ? 'page' : undefined}
                className={activeTab === tab.id ? 'active' : ''}
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </nav>

          {activeTab === 'overview' ? (
            <div className="workspace-content-grid">
              <WorkspacePanel
                className="roadmap-panel"
                title="Product roadmap"
                note="Objective due dates and progress"
                icon={<IconActivity size={16} />}
              >
                <ProductRoadmap
                  objectives={productObjectives}
                  hasProduct={Boolean(selected)}
                  isLoading={objectivesLoading}
                  isError={objectivesError}
                />
              </WorkspacePanel>

              <WorkspacePanel title="Open objectives" note="Assigned to this product" icon={<IconActivity size={16} />}>
                {objectivesError ? (
                  <div className="workspace-empty" role="alert">Objective data unavailable.</div>
                ) : objectivesLoading ? (
                  <div className="workspace-empty">Loading objectives…</div>
                ) : openObjectives.length ? (
                  <div className="workspace-objective-list">
                    {openObjectives.slice(0, 4).map((objective) => (
                      <div className="workspace-objective" key={objective.id}>
                        <span><b>{objective.title}</b><small>{objective.product || 'Unassigned product'}</small></span>
                        <span className={`workspace-objective-status ${objective.status}`}>
                          {objective.status.replace('_', ' ')}
                        </span>
                        <Progress value={objective.progress} color="violet.5" size="xs" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="workspace-empty">No open workspace objectives.</div>
                )}
              </WorkspacePanel>

              <WorkspacePanel
                className="repository-panel"
                title="Repositories"
                note="Linked to this product"
                icon={<IconGitBranch size={16} />}
              >
                <WorkspaceRepositories
                  product={selected}
                  projects={projects}
                  isLoading={projectsLoading}
                  isError={projectsError}
                />
                <a className="workspace-link" href="#projects">Open repository inventory →</a>
              </WorkspacePanel>

              <WorkspacePanel
                className="workflow-panel"
                title="Available workflows"
                note="Not assigned to a product"
                icon={<IconRoute size={16} />}
              >
                {workflows.isError ? (
                  <div className="workspace-empty" role="alert">Workflow definitions unavailable.</div>
                ) : workflows.isLoading ? (
                  <div className="workspace-empty">Loading workflow definitions…</div>
                ) : workflows.data?.length ? (
                  <div className="workspace-definition-list">
                    {workflows.data.slice(0, 4).map((workflow) => (
                      <div key={workflow.id}><span>{workflow.name}</span>
                        <Badge className={`workspace-status ${workflow.status}`} variant="light">
                          {workflow.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                ) : <div className="workspace-empty">No workflow definitions saved.</div>}
              </WorkspacePanel>

              <UnavailablePanel
                title="Designs / Docs / Files"
                detail="No design or document integration is connected."
                icon={<IconFileText size={16} />}
              />
              <UnavailablePanel
                title="Recent decisions"
                detail="Decision history is not recorded by this preview."
                icon={<IconHistory size={16} />}
              />
              <UnavailablePanel
                title="Stakeholders"
                detail="Workspace membership and roles are not configured."
                icon={<IconUsers size={16} />}
              />
            </div>
          ) : activeTab === 'objectives' ? (
            <WorkspaceObjectives
              objectives={productObjectives}
              isLoading={objectivesLoading}
              isError={objectivesError}
            />
          ) : activeTab === 'repositories' ? (
            <WorkspaceRepositories
              product={selected}
              projects={projects}
              isLoading={projectsLoading}
              isError={projectsError}
            />
          ) : activeTab === 'templates' ? (
            <div className="workspace-template-grid">
              <WorkspacePanel
                title="Workflow definitions"
                note="Reusable automation graphs"
                icon={<IconRoute size={16} />}
              >
                <DefinitionNames
                  names={workflows.data?.map((workflow) => workflow.name) ?? []}
                  unavailable={workflows.isError}
                  loading={workflows.isLoading}
                />
              </WorkspacePanel>
              <WorkspacePanel
                title="Agent profiles"
                note="Reusable prompt and tool configurations"
                icon={<IconUsers size={16} />}
              >
                <DefinitionNames
                  names={agents.data?.map((agent) => agent.name) ?? []}
                  unavailable={agents.isError}
                  loading={agents.isLoading}
                />
              </WorkspacePanel>
            </div>
          ) : (
            <UnavailablePanel
              title={activeTab === 'files' ? 'Files & evidence' : 'Decision history'}
              detail={activeTab === 'files'
                ? 'File search and evidence artifacts are unavailable until a storage integration and agent runs exist.'
                : 'Decisions require linked review and audit records, which are not available yet.'}
              icon={activeTab === 'files' ? <IconFileText size={16} /> : <IconAlertTriangle size={16} />}
            />
          )}
        </div>
      </div>

      <ProductEditor
        opened={editOpen}
        product={products.data?.find((product) => product.id === editingID)}
        projects={projects}
        onClose={() => setEditOpen(false)}
        onSave={(input) => saveProduct.mutate(input)}
        isSaving={saveProduct.isPending}
        error={saveError}
      />
    </section>
  );
}

function objectiveDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function ProductRoadmap({ objectives, hasProduct, isLoading, isError }: {
  objectives: Objective[];
  hasProduct: boolean;
  isLoading: boolean;
  isError: boolean;
}) {
  if (isError) return <div className="workspace-empty" role="alert">Objective roadmap unavailable.</div>;
  if (isLoading) return <div className="workspace-empty">Loading objective roadmap…</div>;
  if (!hasProduct) return <div className="workspace-empty">Add a product and link dated objectives to see a roadmap.</div>;
  const datedObjectives = objectives
    .map((objective) => ({ objective, dueDate: objectiveDate(objective.due_date) }))
    .filter((item): item is { objective: Objective; dueDate: Date } => item.dueDate !== null)
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
    .slice(0, 4);
  if (!datedObjectives.length) {
    return <div className="workspace-empty">Add due dates to product objectives to see them on the roadmap.</div>;
  }

  const firstDate = datedObjectives[0].dueDate;
  const lastDate = datedObjectives.at(-1)!.dueDate;
  const start = Date.UTC(firstDate.getUTCFullYear(), Math.floor(firstDate.getUTCMonth() / 3) * 3, 1);
  const quarterCount = (lastDate.getUTCFullYear() - firstDate.getUTCFullYear()) * 4 +
    Math.floor(lastDate.getUTCMonth() / 3) - Math.floor(firstDate.getUTCMonth() / 3) + 1;
  const end = Date.UTC(firstDate.getUTCFullYear(), Math.floor(firstDate.getUTCMonth() / 3) * 3 + quarterCount * 3, 1);
  const quarters = Array.from({ length: quarterCount }, (_, index) => {
    const date = new Date(Date.UTC(firstDate.getUTCFullYear(), Math.floor(firstDate.getUTCMonth() / 3) * 3 + index * 3, 1));
    return `Q${Math.floor(date.getUTCMonth() / 3) + 1} '${String(date.getUTCFullYear()).slice(-2)}`;
  });

  return (
    <div className="workspace-roadmap">
      <div className="workspace-roadmap-axis"><span />
        <div style={{ gridTemplateColumns: `repeat(${quarters.length}, minmax(0, 1fr))` }}>
          {quarters.map((quarter) => <span key={quarter}>{quarter}</span>)}
        </div>
      </div>
      {datedObjectives.map(({ objective, dueDate }) => (
        <div className="workspace-roadmap-row" key={objective.id}>
          <span className="workspace-roadmap-label">
            <b>{objective.title}</b>
            <small>{dueDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })} · {objective.progress}%</small>
          </span>
          <div className="workspace-roadmap-track" aria-label={`${objective.title}, due ${objective.due_date}`}>
            {quarters.map((quarter, index) => <span className="workspace-roadmap-quarter" key={quarter} style={{ left: `${index / quarters.length * 100}%` }} />)}
            <span className={`workspace-roadmap-marker ${objective.status}`} style={{ left: `${(dueDate.getTime() - start) / (end - start) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function WorkspaceMetric({ label, value, detail, healthy = false, icon }: {
  label: string;
  value: string | number;
  detail: string;
  healthy?: boolean;
  icon: ReactNode;
}) {
  return <MetricCard className="workspace-metric" valueClassName={healthy ? 'healthy' : undefined}
    label={label} value={value} detail={detail} icon={icon} />;
}

function WorkspacePanelHeading({ title, note, icon }: { title: string; note: string; icon: ReactNode }) {
  return <PanelHeading className="workspace-panel-heading" title={title} description={note} icon={<span>{icon}</span>} />;
}

function WorkspacePanel({ title, note, icon, className, children }: {
  title: string;
  note: string;
  icon: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <PanelCard className={`workspace-panel${className ? ` ${className}` : ''}`} withBorder>
      <WorkspacePanelHeading title={title} note={note} icon={icon} />
      {children}
    </PanelCard>
  );
}

function UnavailablePanel({ title, detail, icon }: { title: string; detail: string; icon: ReactNode }) {
  return (
    <WorkspacePanel title={title} note="Unavailable" icon={icon} className="unavailable-panel">
      <div className="workspace-empty">{detail}</div>
    </WorkspacePanel>
  );
}

function WorkspaceObjectives({ objectives, isLoading, isError }: {
  objectives: Objective[] | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  if (isError) return <div className="workspace-empty" role="alert">Objective data unavailable.</div>;
  if (isLoading) return <div className="workspace-empty">Loading objectives…</div>;
  if (!objectives?.length) return <div className="workspace-empty">No workspace objectives.</div>;
  return (
    <div className="workspace-objective-list full">
      {objectives.map((objective) => (
        <div className="workspace-objective" key={objective.id}>
          <span>
            <b>{objective.title}</b>
            <small>{objective.product || 'Unassigned product'} · {objective.owner || 'No owner'}</small>
          </span>
          <span className={`workspace-objective-status ${objective.status}`}>{objective.status.replace('_', ' ')}</span>
          <Progress value={objective.progress} color="violet.5" size="xs" />
        </div>
      ))}
    </div>
  );
}

function WorkspaceRepositories({ product, projects, isLoading, isError }: {
  product: Product | undefined;
  projects: Project[] | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  if (!product) return <div className="workspace-empty">Add a product to link repositories.</div>;
  if (isError) return <div className="workspace-empty" role="alert">Repository inventory unavailable.</div>;
  if (isLoading) return <div className="workspace-empty">Loading repository inventory…</div>;
  if (!product.repository_ids.length) return <div className="workspace-empty">No repositories linked yet.</div>;
  return (
    <div className="workspace-repository-list">
      {product.repository_ids.map((id) => {
        const project = projects?.find((item) => item.id === id);
        return (
          <PanelCard className="workspace-panel workspace-repository-row" key={id} withBorder>
            <IconCode size={18} />
            <div>
              <b>{project?.name ?? `Unavailable repository · ${id.slice(0, 8)}`}</b>
              <small>{project
                ? `${project.worker_name} · ${project.branch || 'Unknown branch'}`
                : 'Worker has not reported this checkout'}
              </small>
            </div>
            <Badge className={`workspace-status ${project?.worker_status ?? 'offline'}`} variant="light">
              {project?.worker_status ?? 'unavailable'}
            </Badge>
          </PanelCard>
        );
      })}
    </div>
  );
}

function DefinitionNames({ names, unavailable, loading }: { names: string[]; unavailable: boolean; loading: boolean }) {
  if (unavailable) return <div className="workspace-empty" role="alert">Definitions unavailable.</div>;
  if (loading) return <div className="workspace-empty">Loading definitions…</div>;
  if (!names.length) return <div className="workspace-empty">No definitions saved.</div>;
  return <div className="workspace-definition-list">{names.map((name) => <div key={name}>{name}</div>)}</div>;
}
