import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, Button, Menu, Modal, Select, TextInput, Textarea } from '@mantine/core';
import { DndContext, useDraggable, useDroppable } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addEdge, Background, Controls, Handle, MiniMap, Position, ReactFlow, useEdgesState,
  useNodesState,
} from '@xyflow/react';
import type { Connection, Edge, NodeProps, ReactFlowInstance } from '@xyflow/react';
import {
  IconArrowLeft, IconCheck, IconChecklist, IconChevronDown, IconChevronRight, IconCirclePlus, IconDeviceFloppy, IconDots, IconGripVertical,
  IconHierarchy, IconInfoCircle, IconLayoutBoard, IconMaximize, IconPlayerPlay, IconRoute, IconSearch, IconUserCheck, IconX,
} from '@tabler/icons-react';
import '@xyflow/react/dist/style.css';
import { PageHeading } from './PageHeading';
import { PanelHeading } from './PanelHeading';
import { PanelCard } from './PanelCard';
import './workflows.css';
import { WorkflowDesignRouterSettings, WorkflowDesignRunPreview } from './WorkflowDesignPreview';
import type { WorkflowDesignRunView } from './WorkflowDesignPreview';
import { WorkflowMobileRunPreview } from './WorkflowMobileRunPreview';
import { WorkflowSectionPreview, WorkflowSectionTabs } from './WorkflowSectionsPreview';
import {
  components, componentGroups, defaultDescriptions, designPreviewCanvasPositions, designPreviewWorkflow, layoutNodes, loadWorkflows,
  mobileWorkflowGraph, overviewNodeLayout, workflowGraph, workflowNodeHeight, workflowNodeIcons, workflowNodeWidth,
  workflowSchema,
} from './workflowModel';
import type { ComponentType, Workflow, WorkflowData, WorkflowNode } from './workflowModel';

const paletteCategories = ['All', 'Agents', 'Actions', 'Control', 'Integrations'] as const;
type PaletteCategory = typeof paletteCategories[number];
const paletteCategoryTypes: Record<PaletteCategory, Set<ComponentType>> = {
  All: new Set(components.map(([, type]) => type)),
  Agents: new Set<ComponentType>(['planner', 'agent-router', 'agent-task', 'code-reviewer', 'test-generator', 'coverage-analyzer']),
  Actions: new Set<ComponentType>(['trigger', 'condition', 'loop', 'merge-gate']),
  Control: new Set<ComponentType>(['human-approval', 'merge-gate', 'condition', 'loop']),
  Integrations: new Set<ComponentType>(['publish-report']),
};

function WorkflowBlock({ data }: NodeProps<WorkflowNode>) {
  const Icon = data.previewIcon ?? workflowNodeIcons[data.kind];
  return <div className={`workflow-node ${data.kind}`}>
    <Handle type="target" position={Position.Left} />
    <span className="workflow-node-icon"><Icon size={17} /></span>
    <b>{data.label}</b><small>{data.description}</small>
    <Handle type="source" position={Position.Right} />
  </div>;
}

function ComponentPaletteItem({
  type, label, description, onAdd,
}: { type: ComponentType; label: string; description: string; onAdd: (type: ComponentType, label: string) => void }) {
  const Icon = workflowNodeIcons[type];
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${type}`, data: { type, label },
  });
  return <div className="workflow-component-row">
    <button className="workflow-component-add" type="button" onClick={() => onAdd(type, label)}>
      <span className={`workflow-component-icon ${type}`}><Icon size={15} /></span>
      <span className="workflow-component-copy"><b>{label}</b><small>{description}</small></span>
    </button>
    <button
      className="workflow-drag-handle"
      type="button"
      ref={setNodeRef}
      aria-label={`Drag ${label} to canvas`}
      style={{ opacity: isDragging ? .45 : 1 }}
      {...attributes}
      {...listeners}
    ><IconGripVertical size={14} /></button>
  </div>;
}

function WorkflowDropCanvas({ children }: { children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'workflow-canvas' });
  return <div ref={setNodeRef} className={`workflow-canvas${isOver ? ' drop-active' : ''}`}>
    {children}
  </div>;
}

const flowNodeTypes = { workflow: WorkflowBlock };

export function WorkflowOverview({ mobile = false, workflowID, designPreview = false }: {
  mobile?: boolean;
  workflowID?: string;
  designPreview?: boolean;
}) {
  const query = useQuery({ queryKey: ['workflows'], queryFn: loadWorkflows, enabled: !designPreview });
  const workflow = designPreview ? designPreviewWorkflow : workflowID
    ? query.data?.find((item) => item.id === workflowID)
    : query.data?.[0];
  const [nodes, setNodes] = useState<WorkflowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [layoutError, setLayoutError] = useState(false);

  useEffect(() => {
    if (!workflow) return;
    if (mobile) {
      const graph = mobileWorkflowGraph(workflow, designPreview, mobile);
      setLayoutError(false);
      setNodes(graph.nodes);
      setEdges(graph.edges);
      return;
    }
    if (designPreview) {
      const graph = mobileWorkflowGraph(workflow, true);
      setLayoutError(false);
      setNodes(graph.nodes);
      setEdges(graph.edges);
      return;
    }
    let isCurrent = true;
    const graph = mobileWorkflowGraph(workflow, designPreview);
    setLayoutError(false);
    void layoutNodes(graph.nodes, graph.edges, overviewNodeLayout).then((laidOut) => {
      if (!isCurrent) return;
      setNodes(laidOut);
      setEdges(graph.edges);
    }).catch(() => {
      if (isCurrent) setLayoutError(true);
    });
    return () => { isCurrent = false; };
  }, [workflow, mobile, designPreview]);

  return <PanelCard className="panel workflow-panel" id="workflow" withBorder>
    <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon">
      {designPreview ? <IconHierarchy size={22} /> : <IconRoute size={18} />}</span>}
      title={<span className="overview-heading-with-info">Workflow Orchestration{designPreview && <IconInfoCircle className="overview-heading-info" size={14} aria-hidden="true" />}</span>}
      description={designPreview ? 'Objective: Ship AI code review v2' : workflow?.name ?? 'Saved workflow definition'}
      actions={<div className={`panel-actions${designPreview ? ' workflow-overview-actions' : ''}`}>
        <Badge className={designPreview ? 'preview-running-badge' : 'muted-tag'} variant="light">
          {designPreview ? '● Running' : workflow?.status ?? 'Unavailable'}
        </Badge>
        {designPreview ? <>
          <a className="subtle-button" href="#workflows">View Runs</a>
          <a className="workflow-icon-link" href="#workflows" aria-label="Open workflow editor"><IconMaximize size={14} /></a>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target><button className="workflow-icon-link" aria-label="Workflow options"><IconDots size={16} /></button></Menu.Target>
            <Menu.Dropdown>
              <Menu.Item component="a" href="#workflows">Open workflow editor</Menu.Item>
              <Menu.Item component="a" href="#agents">View agent runs</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </> : <a className="subtle-button" href="#workflows">View workflow <IconChevronRight size={13} /></a>}
      </div>} />
    {!designPreview && query.isLoading ? <div className="workflow-overview-message">Loading saved workflow…</div>
      : !workflow || (!designPreview && query.isError) ? <div className="workflow-overview-message" role="status">Workflow definition unavailable</div>
        : layoutError ? <div className="workflow-overview-message" role="status">Could not arrange workflow graph</div>
          : <>
            <div className="workflow-overview-canvas" role="img"
              aria-label={
                `Key workflow stages for ${workflow.name}; ${nodes.length} stages summarize ` +
                `${workflow.nodes.length} components`
              }>
              <ReactFlow
                nodes={nodes} edges={edges} nodeTypes={flowNodeTypes} fitView={!mobile} minZoom={mobile ? 0.9 : 0.15}
                maxZoom={0.9} defaultViewport={mobile ? { x: 18, y: 8, zoom: 0.9 } : undefined}
                fitViewOptions={{ padding: designPreview ? 0.015 : 0.03 }}
                nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnDrag={false}
                zoomOnScroll={false} zoomOnPinch={false} attributionPosition="bottom-left"
              >
                <Background color={designPreview ? "#504665" : "#37324c"} gap={designPreview ? 12 : 18} size={1.2} />
              </ReactFlow>
            </div>
            {!designPreview && <div className="workflow-overview-status" aria-label="Workflow execution status">
              <span>{workflow.nodes.length} components · {workflow.edges.length} connections</span>
              <span>Execution unavailable · runner not connected</span>
            </div>}
          </>}
  </PanelCard>;
}

export function WorkflowsPage({ designPreview = false }: { designPreview?: boolean }) {
  const queryClient = useQueryClient();
  const [section, setSection] = useState<'Builder' | 'Runs' | 'Versions' | 'Schedules' | 'Permissions' | 'Settings'>('Builder');
  const [sectionActionNotice, setSectionActionNotice] = useState('');
  const [mobileSection, setMobileSection] = useState('Overview');
  const sectionPreview = designPreview && section !== 'Builder';
  const selectSection = (next: typeof section) => { setSection(next); setSectionActionNotice(''); };
  const navigateMobileSection = (name: string, target: string) => {
    setMobileSection(name);
    document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const query = useQuery({
    queryKey: ['workflows'], queryFn: loadWorkflows, enabled: !designPreview,
    initialData: designPreview ? [designPreviewWorkflow] : undefined,
  });
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const loadedWorkflowId = useRef('');
  const flow = useRef<ReactFlowInstance<WorkflowNode, Edge> | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [runPreviewView, setRunPreviewView] = useState<WorkflowDesignRunView>('Execution Graph');
  const [simulateRun, setSimulateRun] = useState(true);
  const [routerTab, setRouterTab] = useState<'Properties' | 'Prompt' | 'Variables' | 'Advanced'>('Properties');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'draft' | 'active'>('draft');
  const [notice, setNotice] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [paletteSearch, setPaletteSearch] = useState('');
  const [paletteCategory, setPaletteCategory] = useState<PaletteCategory>('All');
  const [canvasMode, setCanvasMode] = useState<'select' | 'pan'>('select');
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [miniMapVisible, setMiniMapVisible] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(designPreview ? ['Integrations'] : []),
  );
  const canvasRef = useRef<HTMLDivElement>(null);
  const selected = nodes.find((node) => node.id === selectedId);
  const InspectorIcon = workflowNodeIcons[selected?.data.kind ?? 'agent-router'];
  const selectedType = selected
    ? components.find(([, type]) => type === selected.data.kind)?.[2] ?? selected.data.kind
    : '';
  const activeWorkflow = query.data?.find((workflow) => workflow.id === selectedWorkflowId) ?? query.data?.[0];
  const mobileStages = activeWorkflow ? mobileWorkflowGraph(activeWorkflow).nodes : [];
  const approvalRequired = activeWorkflow?.nodes.some((node) => node.type === 'human-approval') ?? false;
  const filteredComponents = components.filter(([, type, label]) =>
    paletteCategoryTypes[paletteCategory].has(type)
    && `${label} ${defaultDescriptions[type]}`.toLowerCase().includes(paletteSearch.trim().toLowerCase()),
  );
  const save = useMutation({
    mutationFn: async () => {
      if (!activeWorkflow) throw new Error('Select a workflow first');
      const body = {
        name, description, status,
        nodes: nodes.map(({ id, position, data }) => ({
          id, type: data.kind, position, data: { label: data.label, description: data.description },
        })),
        edges: edges.map(({ id, source, target, label }) => ({
          id, source, target, label: typeof label === 'string' ? label : '',
        })),
      };
      const response = await fetch(`/api/v1/workflows/${activeWorkflow.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error((await response.text()).trim() || `Save failed: ${response.status}`);
      return workflowSchema.parse(await response.json());
    },
    onSuccess: async (workflow) => {
      await queryClient.invalidateQueries({ queryKey: ['workflows'] });
      setNotice(`Saved v${workflow.version}`);
    },
    onError: (error) => setNotice(error.message),
  });
  const createWorkflow = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/v1/workflows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: createName, description: createDescription }),
      });
      if (!response.ok) throw new Error((await response.text()).trim() || `Create failed: ${response.status}`);
      return workflowSchema.parse(await response.json());
    },
    onSuccess: async (workflow) => {
      await queryClient.invalidateQueries({ queryKey: ['workflows'] });
      setSelectedWorkflowId(workflow.id);
      setSelectedId('');
      setCreateOpen(false);
      setCreateName('');
      setCreateDescription('');
      setNotice(`Created ${workflow.name}`);
    },
    onError: (error) => setNotice(error.message),
  });
  useEffect(() => {
    if (!activeWorkflow) return;
    const current = activeWorkflow;
    if (current.id === loadedWorkflowId.current) return;
    let isCurrent = true;
    loadedWorkflowId.current = current.id;
    setName(current.name); setDescription(current.description); setStatus(current.status);
    const { nodes: workflowNodes, edges: workflowEdges } = workflowGraph(current, designPreview);
    const selectedNode = workflowNodes.find((node) => node.data.kind === 'agent-router');
    const selectedNodes = workflowNodes.map((node) => ({ ...node,
      ...(designPreview ? { position: designPreviewCanvasPositions[node.id] } : {}),
      ...(designPreview && node.data.kind === 'loop' ? { style: { width: 154 } } : {}),
      selected: node.id === selectedNode?.id,
    }));
    setSelectedId(selectedNode?.id ?? '');
    setInspectorOpen(true);
    setNodes(selectedNodes);
    setEdges(workflowEdges);
    void (designPreview ? Promise.resolve(selectedNodes) : layoutNodes(selectedNodes, workflowEdges)).then((laidOut) => {
      if (!isCurrent) return;
      const positions = new Map(laidOut.map((node) => [node.id, node.position]));
      setNodes((currentNodes) => currentNodes.map((node) => {
        const position = positions.get(node.id);
        return position ? { ...node, position } : node;
      }));
      setLayoutRevision((revision) => revision + 1);
    }).catch(() => {
      if (isCurrent) setNotice('Auto layout unavailable; arrange nodes manually');
    });
    return () => { isCurrent = false; };
  }, [activeWorkflow, setEdges, setNodes]);
  const onConnect = (connection: Connection) => setEdges((current) => addEdge({
    ...connection, id: crypto.randomUUID(), type: 'smoothstep',
  }, current));
  const addComponent = (type: ComponentType, label: string, position?: { x: number; y: number }) => {
    const id = crypto.randomUUID();
    setNodes((current) => [...current, {
      id, type: 'workflow', position: position ?? { x: 80 + current.length * 25, y: 100 + current.length * 20 },
      data: { label, description: defaultDescriptions[type], kind: type },
    }]);
    setSelectedId(id);
    setInspectorOpen(true);
    if (designPreview) setNotice('Block added locally · changes are not saved');
  };
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over?.id !== 'workflow-canvas') return;
    const component = event.active.data.current as { type?: ComponentType; label?: string } | undefined;
    if (!component?.type || !component.label) return;
    const pointer = event.activatorEvent as PointerEvent;
    const dropPoint = Number.isFinite(pointer.clientX) && Number.isFinite(pointer.clientY)
      ? flow.current?.screenToFlowPosition({
          x: pointer.clientX + event.delta.x, y: pointer.clientY + event.delta.y,
        })
      : undefined;
    const position = dropPoint && {
      x: dropPoint.x - workflowNodeWidth / 2,
      y: dropPoint.y - workflowNodeHeight / 2,
    };
    addComponent(component.type, component.label, position);
  };
  const validate = () => {
    const ids = new Set(nodes.map((node) => node.id));
    const valid = nodes.some((node) => node.data.kind === 'trigger') &&
      edges.every((edge) => ids.has(edge.source) && ids.has(edge.target));
    setNotice(valid
      ? 'Graph is valid · execution is not connected yet'
      : 'Add a Trigger and connect every edge to an existing node');
  };
  const updateSelected = (key: keyof WorkflowData, value: string) => setNodes((current) => current.map((node) => (
    node.id === selectedId ? { ...node, data: { ...node.data, [key]: value } } : node
  )));
  if (query.isLoading) return <div className="workflow-page"><p>Loading workflows…</p></div>;
  if (query.isError || !activeWorkflow) {
    return <div className="workflow-page"><p role="alert">{query.error?.message ?? 'No workflows available'}</p></div>;
  }
  return <section className={`workflow-page${designPreview && section === 'Builder' ? ' workflow-run-mock' : ''}`}>
    {designPreview && <header className="workflow-mobile-header" aria-label="Workflow navigation">
      <a href="#overview" aria-label="Back to Overview"><IconArrowLeft size={20} /></a>
      <div className="workflow-mobile-brand"><span className="brand-mark" aria-hidden="true" />Zenchron Engineering</div>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target><button className="workflow-mobile-menu-trigger" type="button" aria-label="More workflow actions"><IconDots size={19} /></button></Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={() => navigateMobileSection('Runs', 'workflow-mobile-run-summary')}>Show run status</Menu.Item>
          <Menu.Item onClick={() => navigateMobileSection('Approvals', 'workflow-mobile-run-approvals')}>Show approvals</Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </header>}
    <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="New Workflow">
      <TextInput
        label="Workflow name" value={createName} onChange={(event) => setCreateName(event.currentTarget.value)}
        maxLength={200} required
      />
      <Textarea
        label="Description" value={createDescription}
        onChange={(event) => setCreateDescription(event.currentTarget.value)} maxLength={1000} autosize minRows={2}
      />
      <Button
        className="workflow-create-button"
        loading={createWorkflow.isPending}
        disabled={designPreview || !createName.trim()}
        onClick={() => createWorkflow.mutate()}
      >Create workflow</Button>
    </Modal>
    <div className={`workflow-builder-layout${designPreview ? ' workflow-design-preview' : ''}${sectionPreview ? ' workflow-section-view' : ''}${designPreview && !inspectorOpen ? ' workflow-inspector-closed' : ''}`}>
      <div className={`workflow-page-heading${sectionPreview ? ' workflow-section-heading' : ''}`}>
        <PageHeading
          eyebrow={designPreview ? <>
            <span className="workflow-desktop-eyebrow">Workflows <IconChevronRight size={10} /> Workflow Builder</span>
            <span className="workflow-mobile-eyebrow">Objective</span>
          </> : 'ORCHESTRATION'}
          title={<>
            <span className="workflow-desktop-title">Workflow Builder — {activeWorkflow.name}</span>
            <span className="workflow-mobile-title">Workflow Orchestration</span>
          </>}
          titleAdornment={<Badge color={status === 'active' ? 'green' : 'gray'}>{designPreview ? <>
            <span className="workflow-desktop-status">Active</span>
            <span className="workflow-mobile-status">Running</span>
          </> : status}</Badge>}
          titleClassName="workflow-title-line"
          description={<>
            <span className="workflow-desktop-description">{activeWorkflow.description}</span>
            <span className="workflow-mobile-description">Ship AI code review v2</span>
          </>}
        />
        {sectionPreview ? <div className="workflow-toolbar workflow-section-meta" aria-label="Workflow summary">
          <Badge className="workflow-section-meta-badge">v2.4.0</Badge>
          <Badge className="workflow-section-meta-badge">8 Nodes</Badge>
          <Badge className="workflow-section-meta-badge">3 Agent Profiles</Badge>
          <span className="workflow-section-concept" role="status">
            {sectionActionNotice || 'CONCEPT · ILLUSTRATIVE DATA'}
          </span>
        </div> : <div className="workflow-toolbar">
          {designPreview ? <Menu position="bottom-start" withinPortal>
            <Menu.Target><button className="workflow-version-trigger" type="button" aria-label="Workflow version history">
              <Badge className="workflow-version" color="gray">v2.4.0 (Draft) <IconChevronDown size={12} /></Badge>
            </button></Menu.Target>
            <Menu.Dropdown><Menu.Item onClick={() => selectSection('Versions')}>Open version history</Menu.Item></Menu.Dropdown>
          </Menu> : <Badge className="workflow-version" color="gray">v{activeWorkflow.version}</Badge>}
          <Button className="workflow-validate" variant="default" leftSection={<IconCheck size={15} />} onClick={validate}>Validate</Button>
          <Button className="workflow-run" variant="default" leftSection={<IconPlayerPlay size={15} />}
            disabled={!designPreview} title={designPreview ? 'Show the simulated workflow run' : 'Runner not connected'}
            onClick={() => { setRunPreviewView('Execution Graph'); setSimulateRun(true); setNotice('Simulated run shown · workflow was not executed'); }}>
            Run
          </Button>
          <Button className="workflow-save" leftSection={<IconDeviceFloppy size={15} />} loading={!designPreview && save.isPending}
            disabled={!designPreview && save.isPending}
            onClick={() => designPreview ? setNotice('Draft acknowledged locally · changes are not persisted') : save.mutate()}>
            Save
          </Button>
          <Button className="workflow-publish" variant="light" disabled={!designPreview}
            title={designPreview ? 'Mark this draft as published in the preview only' : 'Workflow publishing is not connected'}
            onClick={() => setNotice('Published in preview only · no live workflow changed')}>Publish</Button>
        </div>}
      </div>
      <WorkflowSectionTabs section={section} designPreview={designPreview} onSelect={selectSection} />
      {section === 'Builder' ? <>
      <nav className="workflow-mobile-tabs" aria-label="Workflow mobile sections">
        {[
          ['Overview', 'workflow-mobile-overview'], ['Runs', 'workflow-mobile-run-summary'],
          ['Tasks', 'workflow-mobile-run-tasks'], ['Approvals', 'workflow-mobile-run-approvals'],
        ].map(([name, target]) => <button key={name} type="button" className={mobileSection === name ? 'selected' : ''}
          aria-current={mobileSection === name ? 'page' : undefined}
          onClick={() => navigateMobileSection(name, target)}>{name}</button>)}
      </nav>
      <div className="workflow-mobile-overview" id="workflow-mobile-overview">
        <WorkflowOverview mobile workflowID={activeWorkflow.id} designPreview={designPreview} />
      </div>
      {designPreview ? <WorkflowMobileRunPreview onAction={(action) => setNotice(`${action} previewed · no approval was recorded`)} /> : <>
        <div className="workflow-mobile-summary" id="workflow-mobile-run-summary" aria-label="Workflow execution status">
          <div><small>Run status</small><b>Not run</b></div>
          <div><small>Components</small><b>{activeWorkflow.nodes.length}</b></div>
          <div><small>Connections</small><b>{activeWorkflow.edges.length}</b></div>
          <p>Runner not connected. Saved graph is ready for a future run.</p>
        </div>
        <div className="workflow-mobile-details">
          <section aria-label="Task progress">
            <PanelCard id="workflow-mobile-run-tasks" className="workflow-mobile-detail-panel">
              <PanelHeading icon={<IconChecklist size={16} />} title="Task progress" />
              <div className="workflow-mobile-task-list">
                {mobileStages.map((stage) => <div className="workflow-mobile-task-row" key={stage.id}>
                  <span>{stage.data.label}</span><Badge color="gray">Not run</Badge>
                </div>)}
              </div>
            </PanelCard>
          </section>
          <section aria-label="Approvals">
            <PanelCard id="workflow-mobile-run-approvals" className="workflow-mobile-detail-panel">
              <PanelHeading icon={<IconUserCheck size={16} />} title="Approvals" />
              <div className="workflow-mobile-approval-state">
                <span>{approvalRequired ? 'Human approval' : 'No approval step configured'}</span>
                {approvalRequired && <Badge color="gray">Not requested</Badge>}
              </div>
              <p>No approval activity is recorded before a workflow run.</p>
            </PanelCard>
          </section>
        </div>
      </>}
      <DndContext onDragEnd={handleDragEnd}>
      <div className="workflow-editor">
      <aside className="workflow-palette">
        <PanelHeading className="workflow-subheading" icon={<IconCirclePlus size={16} />} title="Components"
          actions={designPreview && <button className="workflow-preview-custom-block" type="button"
            onClick={() => addComponent('agent-task', 'Custom Block')}>＋ Custom Block</button>} />
        <TextInput
          className="workflow-palette-search"
          aria-label="Search blocks"
          placeholder="Search blocks..."
          leftSection={<IconSearch size={14} />}
          value={paletteSearch}
          onChange={(event) => setPaletteSearch(event.currentTarget.value)}
        />
        {designPreview && <div className="workflow-preview-palette-categories" role="group" aria-label="Component categories">
          {paletteCategories.map((category) => <button key={category} type="button"
            aria-pressed={paletteCategory === category} onClick={() => setPaletteCategory(category)}>{category}</button>)}
        </div>}
        {componentGroups.map((group) => {
          const groupComponents = filteredComponents.filter(([category]) => category === group);
          const isCollapsed = collapsedGroups.has(group) && !paletteSearch.trim() && paletteCategory === 'All';
          const groupId = `workflow-group-${group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
          return groupComponents.length ? <div className="workflow-component-group" key={group}>
            <button className="workflow-component-group-toggle" type="button" aria-label={`Toggle ${group}`}
              aria-expanded={!isCollapsed} aria-controls={groupId} onClick={() => setCollapsedGroups((current) => {
                const next = new Set(current);
                if (next.has(group)) next.delete(group);
                else next.add(group);
                return next;
              })}>
              <b>{group}</b><IconChevronDown size={13} />
            </button>
            <div className="workflow-component-list" id={groupId} hidden={isCollapsed}>
              {groupComponents.map(([, type, label]) => (
                <ComponentPaletteItem key={type} type={type} label={label} description={defaultDescriptions[type]}
                  onAdd={addComponent} />
              ))}
            </div>
          </div> : null;
        })}
        {!filteredComponents.length && <p className="workflow-palette-empty">No blocks match your search.</p>}
      </aside>
      <Group
        className="workflow-center-group"
        orientation="vertical"
        defaultLayout={{ canvas: 63.15, preview: 36.85 }}
      >
        <Panel id="canvas" className="workflow-center-panel" minSize="40%">
      <div className="workflow-canvas-wrap" ref={canvasRef}>
        <div className="workflow-canvas-tools">
          {designPreview ? <>
            <div className="workflow-preview-toolset" role="group" aria-label="Canvas tools">
              <button className={canvasMode === 'select' ? 'selected' : ''} type="button" aria-label="Select nodes"
                aria-pressed={canvasMode === 'select'} onClick={() => setCanvasMode('select')}>↖</button>
              <button className={canvasMode === 'pan' ? 'selected' : ''} type="button" aria-label="Pan canvas"
                aria-pressed={canvasMode === 'pan'} onClick={() => setCanvasMode('pan')}>✋</button>
              <button type="button" aria-label="Add custom block" onClick={() => addComponent('agent-task', 'Custom Block')}>＋</button>
              <button type="button" aria-label="Fit graph to canvas" onClick={() => flow.current?.fitView({ duration: 200 })}>□</button>
              <button type="button" aria-label="Toggle canvas fullscreen" onClick={() => {
                const canvas = canvasRef.current;
                if (!canvas) return;
                const action = document.fullscreenElement === canvas
                  ? document.exitFullscreen() : canvas.requestFullscreen();
                void action.catch(() => setNotice('Canvas fullscreen is unavailable'));
              }}>⤢</button>
            </div>
            <div className="workflow-preview-zoom" role="group" aria-label="Canvas zoom">
              <button type="button" aria-label="Zoom out" onClick={() => flow.current?.zoomOut({ duration: 120 })}>−</button>
              <button className="workflow-zoom-level" type="button" aria-label="Reset canvas zoom"
                onClick={() => flow.current?.zoomTo(1, { duration: 120 })}>{Math.round(canvasZoom * 100)}%</button>
              <button type="button" aria-label="Zoom in" onClick={() => flow.current?.zoomIn({ duration: 120 })}>＋</button>
              <button type="button" aria-label="Toggle minimap" aria-pressed={miniMapVisible}
                onClick={() => setMiniMapVisible((visible) => !visible)}>▦</button>
            </div>
          </> : <>
            <div className="workflow-canvas-actions">
              <Select
                className="workflow-select"
                aria-label="Workflow"
                data={query.data?.map(({ id, name: workflowName }) => ({ value: id, label: workflowName })) ?? []}
                value={activeWorkflow.id}
                onChange={(id) => {
                  if (!id) return;
                  setSelectedWorkflowId(id);
                  setSelectedId('');
                }}
                searchable
                maxDropdownHeight={280}
              />
              <Button variant="default" onClick={() => setCreateOpen(true)}>New Workflow</Button>
            </div>
            <button onClick={async () => {
              try {
                setNodes(await layoutNodes(nodes, edges));
                setLayoutRevision((revision) => revision + 1);
                setNotice('Layout updated');
              } catch {
                setNotice('Could not arrange workflow nodes');
              }
            }}><IconLayoutBoard size={15} /> Auto layout</button>
          </>}
        </div>
        <WorkflowDropCanvas>
          <ReactFlow
            key={layoutRevision} nodes={nodes} edges={edges} nodeTypes={flowNodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onInit={(instance) => { flow.current = instance; setCanvasZoom(instance.getZoom()); }}
            onMoveEnd={(_, viewport) => setCanvasZoom(viewport.zoom)}
            nodesDraggable={designPreview ? canvasMode === 'select' : true}
            panOnDrag={designPreview ? canvasMode === 'pan' : true}
            onNodeClick={(_, node) => { setSelectedId(node.id); setInspectorOpen(true); }} fitView minZoom={0.2} attributionPosition="bottom-left"
          >
            {!designPreview && <Background bgColor="var(--workflow-canvas-bg)" color="#37324c"
              gap={18} size={2} />}
            {miniMapVisible && <MiniMap style={{ width: 128, height: 54 }} nodeColor="#8e52db" maskColor="#0b0b14bb" />}
            {!designPreview && <Controls position="top-right" />}
          </ReactFlow>
        </WorkflowDropCanvas>
        <div className={`workflow-status${designPreview ? ' workflow-preview-execution-flow' : ''}`} aria-live="polite">
          {designPreview ? <>
            <IconPlayerPlay size={16} />
            <div><b>Execution Flow (v2.4.0)</b>
              <span>{notice || 'Ready to run · 7 nodes · Est. 2m 14s · Cost $0.038'}</span></div>
          </> : <>
            <IconPlayerPlay size={14} /><span>{notice || 'Draft · validate and save changes'}</span>
            <small>Runner not connected</small>
          </>}
        </div>
      </div>
        </Panel>
        <Separator id="canvas-preview" className="workflow-resize-handle" />
        <Panel id="preview" className="workflow-center-panel" minSize="25%">
          <div className="workflow-run-preview" aria-label="Workflow execution preview">
            <div className="workflow-preview-heading">
              <div role="tablist" aria-label="Run preview views"><b>Run Preview</b>
                {(['Execution Graph', 'Logs', 'Outputs', 'Artifacts'] as const).map((view) => <button
                  key={view} type="button" role="tab" aria-selected={runPreviewView === view}
                  className={runPreviewView === view ? 'selected' : ''} disabled={!designPreview || !simulateRun}
                  title={designPreview ? undefined : 'Run a workflow to view execution details'}
                  onClick={() => setRunPreviewView(view)}>{view}</button>)}
              </div>
              {designPreview ? <label className="workflow-simulate-control">Simulate Run
                <button type="button" role="switch" aria-label="Simulate Run" aria-checked={simulateRun}
                  className="workflow-preview-toggle" onClick={() => setSimulateRun((enabled) => !enabled)} />
              </label> : <Badge color="gray">Runner unavailable</Badge>}
            </div>
            {designPreview && simulateRun ? <WorkflowDesignRunPreview view={runPreviewView} />
              : designPreview ? <div className="workflow-preview-paused" role="status">
                <b>Simulation paused</b><span>Turn on Simulate Run to view execution details.</span>
              </div> : <div className="workflow-preview-content">
              <div className="workflow-preview-empty"><IconPlayerPlay size={19} />
                <b>Execution preview unavailable</b>
                <span>Workflow execution is not connected. Save and validate this graph to keep its definition ready.</span>
              </div>
              <div className="workflow-preview-summary"><b>Graph definition</b>
                <span><small>Components</small> {nodes.length}</span>
                <span><small>Connections</small> {edges.length}</span>
                <span><small>Last run</small>Not run</span>
              </div>
            </div>}
          </div>
        </Panel>
      </Group>
      </div>
      </DndContext>
      <aside className="workflow-properties" hidden={designPreview && !inspectorOpen}>
        <PanelHeading className="workflow-subheading" title={selected?.data.label ?? 'Selected component'}
          icon={selected && <span className="workflow-inspector-icon" aria-hidden="true"><InspectorIcon size={18} /></span>}
          actions={designPreview && <div className="workflow-inspector-actions">
            <Menu position="bottom-end" withinPortal>
              <Menu.Target><button type="button" aria-label="Component options"><IconDots size={16} /></button></Menu.Target>
              <Menu.Dropdown><Menu.Item onClick={() => setSelectedId(nodes.find(({ data }) => data.kind === 'agent-router')?.id ?? '')}>Reset selection</Menu.Item></Menu.Dropdown>
            </Menu>
            <button type="button" aria-label="Close component settings" onClick={() => setInspectorOpen(false)}><IconX size={16} /></button>
          </div>} />
        {designPreview && <div className="workflow-inspector-tabs" role="tablist" aria-label="Agent Router settings">
          {(['Properties', 'Prompt', 'Variables', 'Advanced'] as const).map((tab) => <button key={tab}
            type="button" role="tab" aria-selected={routerTab === tab} aria-controls="router-settings-panel"
            className={routerTab === tab ? 'selected' : ''} onClick={() => setRouterTab(tab)}>{tab}</button>)}
        </div>}
        {selected ? <>
          {(!designPreview || routerTab === 'Properties') && <section className="workflow-basic-configuration" aria-label="Basic configuration">
            <h4>Basic Configuration</h4>
            <div className="workflow-basic-fields">
              <TextInput
                label="Node Name" value={selected.data.label}
                onChange={(event) => updateSelected('label', event.currentTarget.value)} maxLength={100}
                readOnly={designPreview}
              />
              <TextInput label="Type" value={selectedType} readOnly />
              <Textarea
                label="Description" value={designPreview && selected.data.kind === 'agent-router'
                  ? 'Route work to the appropriate agents (review, test, coverage) based on the plan and PR context.'
                  : selected.data.description}
                onChange={(event) => updateSelected('description', event.currentTarget.value)}
                maxLength={500} autosize minRows={2} readOnly={designPreview}
              />
            </div>
          </section>}
          {designPreview ? <div id="router-settings-panel" role="tabpanel" aria-label={`${routerTab} settings`}>
            {routerTab === 'Prompt' && <section className="workflow-preview-config workflow-router-sample" aria-label="Illustrative router prompt">
              <header><b>Router Prompt</b><span>ILLUSTRATIVE</span></header>
              <p>Route each task to the best specialized agent using its changed files, test requirements, and task context.
                Use the configured rules first, then choose a suitable agent when no rule matches.</p>
            </section>}
            {routerTab === 'Variables' && <section className="workflow-preview-config workflow-router-sample" aria-label="Illustrative router variables">
              <header><b>Available Variables</b><span>ILLUSTRATIVE</span></header>
              <div className="workflow-router-variable"><code>changed_files</code><span>Files changed by the pull request</span></div>
              <div className="workflow-router-variable"><code>task_type</code><span>Planner task category</span></div>
              <div className="workflow-router-variable"><code>repository</code><span>Repository context</span></div>
              <div className="workflow-router-variable"><code>pr_number</code><span>Pull request identifier</span></div>
            </section>}
            <div hidden={routerTab === 'Prompt' || routerTab === 'Variables'}>
              <WorkflowDesignRouterSettings section={routerTab === 'Advanced' ? 'Advanced' : 'Properties'} />
            </div>
          </div> : <Button color="red" variant="subtle" onClick={() => {
            setNodes((current) => current.filter((node) => node.id !== selectedId));
            setEdges((current) => current.filter((edge) => edge.source !== selectedId && edge.target !== selectedId));
            setSelectedId('');
          }}>Delete component</Button>}
        </> : <p className="workflow-hint">Select a node on the canvas to edit it.</p>}
        {!designPreview && <>
          <div className="workflow-divider" />
          <details className="workflow-settings">
            <summary>Workflow settings</summary>
            <TextInput label="Name" value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={200} />
            <Textarea
              label="Description" value={description} onChange={(event) => setDescription(event.currentTarget.value)}
              maxLength={1000} autosize minRows={2}
            />
            <label className="workflow-field">
              Status
              <select value={status} onChange={(event) => setStatus(event.currentTarget.value as 'draft' | 'active')}>
                <option value="draft">Draft</option><option value="active">Active</option>
              </select>
            </label>
          </details>
          <div className="workflow-divider" />
          <span className="workflow-hint">Version {activeWorkflow.version} · saved to local control plane</span>
        </>}
      </aside>
      </> : <WorkflowSectionPreview section={section}
        onAction={(action) => setSectionActionNotice(`${action} previewed · no workflow changes were saved`)} />}
    </div>
  </section>;
}
