import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, Button, Menu, Modal, TextInput, Textarea } from '@mantine/core';
import { DndContext, useDroppable } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useQuery } from '@tanstack/react-query';
import { addEdge, Background, Handle, MiniMap, Position, ReactFlow, useEdgesState, useNodesState } from '@xyflow/react';
import type { Connection, Edge, NodeProps, ReactFlowInstance } from '@xyflow/react';
import {
  IconArrowLeft, IconCheck, IconChevronDown, IconChevronRight, IconDeviceFloppy, IconDots, IconHierarchy, IconInfoCircle,
  IconMaximize, IconPlayerPlay, IconX,
} from '@tabler/icons-react';
import '@xyflow/react/dist/style.css';
import { PageHeading } from './PageHeading';
import { PanelHeading } from './PanelHeading';
import { PanelCard } from './PanelCard';
import './workflows.css';
import { nodeSettingsTabs, WorkflowNodeSettings } from './WorkflowNodeSettings';
import type { NodeSettingsTab } from './WorkflowNodeSettings';
import { customBlock, WorkflowPalette } from './WorkflowPalette';
import { WorkflowPhoneRunCards, WorkflowRunPreview } from './WorkflowRun';
import { WorkflowSectionTabs, WorkflowSectionView } from './WorkflowSections';
import type { WorkflowSection } from './WorkflowSections';
import { useMockWorkflows } from './workflow-preview-data';
import {
  components, defaultDescriptions, designPreviewWorkflow, layoutNodes, loadWorkflows, mobileWorkflowGraph, workflowEdgeClass,
  workflowGraph, workflowNodeIcons, workflowNodeSize,
} from './workflowModel';
import type { ComponentType, WorkflowData, WorkflowNode } from './workflowModel';
import { runPreviewViews, useLiveWorkflows, workflowStatusLabels } from './workflowsView';
import type { RunPreviewView, WorkflowDraft } from './workflowsView';

function WorkflowBlock({ data }: NodeProps<WorkflowNode>) {
  const Icon = data.previewIcon ?? workflowNodeIcons[data.kind];
  return <div className={`workflow-node ${data.kind}`}>
    <Handle type="target" position={Position.Left} />
    <span className="workflow-node-icon"><Icon size={17} /></span>
    <b>{data.label}</b><small>{data.description}</small>
    <Handle type="source" position={Position.Right} />
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
  const { nodes, edges } = useMemo(
    () => workflow ? mobileWorkflowGraph(workflow, designPreview, mobile) : { nodes: [], edges: [] },
    [workflow, designPreview, mobile],
  );
  // No workflow runner is connected, so only the fixture has a run to report.
  const execution = designPreview
    ? { badge: '● Running', badgeClass: 'preview-running-badge', stagesComplete: true }
    : { badge: 'Execution unavailable', badgeClass: 'muted-tag', stagesComplete: false,
      note: workflow && `${workflow.nodes.length} components · ${workflow.edges.length} connections · runner not connected` };

  return <PanelCard className="panel workflow-panel" id="workflow" withBorder>
    <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconHierarchy size={22} /></span>}
      title={<span className="overview-heading-with-info">Workflow Orchestration<IconInfoCircle className="overview-heading-info" size={14} aria-hidden="true" /></span>}
      description={designPreview ? 'Objective: Ship AI code review v2'
        : workflow ? `${workflow.name} · ${workflow.status}` : 'Saved workflow definition'}
      actions={<div className="panel-actions workflow-overview-actions">
        <Badge className={execution.badgeClass} variant="light">{execution.badge}</Badge>
        <a className="subtle-button" href="#workflows">View Runs</a>
        <a className="workflow-icon-link" href="#workflows" aria-label="Open workflow editor"><IconMaximize size={14} /></a>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><button className="workflow-icon-link" aria-label="Workflow options"><IconDots size={16} /></button></Menu.Target>
          <Menu.Dropdown>
            {execution.note && <Menu.Label>{execution.note}</Menu.Label>}
            <Menu.Item component="a" href="#workflows">Open workflow editor</Menu.Item>
            <Menu.Item component="a" href="#agents">View agent runs</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </div>} />
    {!designPreview && query.isLoading ? <div className="workflow-overview-message">Loading saved workflow…</div>
      : !workflow || (!designPreview && query.isError) ? <div className="workflow-overview-message" role="status">Workflow definition unavailable</div>
        : <div className={`workflow-overview-canvas${execution.stagesComplete ? ' stages-complete' : ''}`} role="img"
          aria-label={
            `Key workflow stages for ${workflow.name}; ${nodes.length} stages summarize ` +
            `${workflow.nodes.length} components`
          }>
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={flowNodeTypes} fitView={!mobile} minZoom={mobile ? 0.9 : 0.15}
            maxZoom={0.9} defaultViewport={mobile ? { x: 18, y: 8, zoom: 0.9 } : undefined}
            fitViewOptions={{ padding: 0.015 }}
            nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnDrag={false}
            zoomOnScroll={false} zoomOnPinch={false} attributionPosition="bottom-left"
          >
            <Background color="#504665" gap={12} size={1.2} />
          </ReactFlow>
        </div>}
  </PanelCard>;
}

const mobileSections = [
  ['Overview', 'workflow-mobile-overview'], ['Runs', 'workflow-mobile-run-summary'],
  ['Tasks', 'workflow-mobile-run-tasks'], ['Approvals', 'workflow-mobile-run-approvals'],
];
const runnerOffline = 'Runner not connected';
/** workflows.css draws compact cards from this width up. */
const hasCompactCards = () => window.matchMedia('(min-width: 1051px)').matches;
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export function WorkflowsPage({ designPreview = false }: { designPreview?: boolean }) {
  const mock = useMockWorkflows();
  const live = useLiveWorkflows(!designPreview);
  const source = designPreview ? mock : live;
  const [section, setSection] = useState<WorkflowSection>('Builder');
  const [notice, setNotice] = useState({ text: '', isError: false });
  const report = (text: string, isError = false) => setNotice({ text, isError });
  const [mobileSection, setMobileSection] = useState('Overview');
  const selectSection = (next: WorkflowSection) => { setSection(next); report(''); };
  const navigateMobileSection = (name: string, target: string) => {
    setMobileSection(name);
    document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const loadedWorkflowId = useRef('');
  const flow = useRef<ReactFlowInstance<WorkflowNode, Edge> | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [runPreviewView, setRunPreviewView] = useState<RunPreviewView>('Execution Graph');
  const [simulateRun, setSimulateRun] = useState(true);
  const [settingsTab, setSettingsTab] = useState<NodeSettingsTab>('Properties');
  const [definition, setDefinition] = useState<Pick<WorkflowDraft, 'name' | 'description' | 'status'>>(
    { name: '', description: '', status: 'draft' });
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createError, setCreateError] = useState('');
  const [canvasMode, setCanvasMode] = useState<'select' | 'pan'>('select');
  const [canvasZoom, setCanvasZoom] = useState(1);
  const [miniMapVisible, setMiniMapVisible] = useState(true);
  const canvasRef = useRef<HTMLDivElement>(null);
  const selected = nodes.find((node) => node.id === selectedId);
  const InspectorIcon = workflowNodeIcons[selected?.data.kind ?? 'agent-router'];
  const selectedType = selected
    ? components.find(([, type]) => type === selected.data.kind)?.[2] ?? selected.data.kind
    : '';
  const activeWorkflow = source.workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? source.workflows[0];
  const kindOf = (id: string | null) => nodes.find((node) => node.id === id)?.data.kind;
  const openWorkflow = (id: string) => { setSelectedWorkflowId(id); setSelectedId(''); };
  const save = async () => {
    if (!activeWorkflow) return;
    try {
      report(await source.save(activeWorkflow.id, {
        ...definition,
        nodes: nodes.map(({ id, position, data }) => ({
          id, type: data.kind, position, data: { label: data.label, description: data.description },
        })),
        edges: edges.map(({ id, source: from, target, label }) => ({
          id, source: from, target, label: typeof label === 'string' ? label : '',
        })),
      }));
    } catch (error) {
      report(errorMessage(error, 'Save failed'), true);
    }
  };
  const createWorkflow = async () => {
    setCreateError('');
    try {
      const created = await source.create(createName, createDescription);
      openWorkflow(created.workflow.id);
      setCreateOpen(false);
      setCreateName('');
      setCreateDescription('');
      report(created.notice);
    } catch (error) {
      setCreateError(errorMessage(error, 'Create failed'));
    }
  };
  useEffect(() => {
    if (!activeWorkflow) return;
    const current = activeWorkflow;
    if (current.id === loadedWorkflowId.current) return;
    let isCurrent = true;
    loadedWorkflowId.current = current.id;
    setDefinition({ name: current.name, description: current.description, status: current.status });
    const { nodes: workflowNodes, edges: workflowEdges } = workflowGraph(current);
    const { positions } = source.describe(current);
    const selectedNode = workflowNodes.find((node) => node.data.kind === 'agent-router');
    const selectedNodes = workflowNodes.map((node) => ({ ...node,
      ...(positions?.[node.id] ? { position: positions[node.id] } : {}),
      ...(node.data.kind === 'loop' ? { style: { width: workflowNodeSize('loop', true).width } } : {}),
      selected: node.id === selectedNode?.id,
    }));
    setSelectedId(selectedNode?.id ?? '');
    setInspectorOpen(true);
    setNodes(selectedNodes);
    setEdges(workflowEdges);
    void (positions ? Promise.resolve(selectedNodes) : layoutNodes(selectedNodes, workflowEdges, hasCompactCards())).then((laidOut) => {
      if (!isCurrent) return;
      const laidOutPositions = new Map(laidOut.map((node) => [node.id, node.position]));
      setNodes((currentNodes) => currentNodes.map((node) => {
        const position = laidOutPositions.get(node.id);
        return position ? { ...node, position } : node;
      }));
      setLayoutRevision((revision) => revision + 1);
    }).catch(() => {
      if (isCurrent) report('Auto layout unavailable; arrange nodes manually', true);
    });
    return () => { isCurrent = false; };
  }, [activeWorkflow, setEdges, setNodes]);
  const onConnect = (connection: Connection) => setEdges((current) => addEdge({
    ...connection, id: crypto.randomUUID(), type: 'smoothstep',
    className: workflowEdgeClass(kindOf(connection.source), kindOf(connection.target)),
  }, current));
  const addComponent = (type: ComponentType, label: string, position?: { x: number; y: number }) => {
    const id = crypto.randomUUID();
    setNodes((current) => [...current, {
      id, type: 'workflow', position: position ?? { x: 80 + current.length * 25, y: 100 + current.length * 20 },
      data: { label, description: defaultDescriptions[type], kind: type },
    }]);
    setSelectedId(id);
    setInspectorOpen(true);
    report(source.blockAddedNotice);
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
    const size = workflowNodeSize(component.type, hasCompactCards());
    const position = dropPoint && { x: dropPoint.x - size.width / 2, y: dropPoint.y - size.height / 2 };
    addComponent(component.type, component.label, position);
  };
  const autoLayout = async () => {
    try {
      setNodes(await layoutNodes(nodes, edges, hasCompactCards()));
      setLayoutRevision((revision) => revision + 1);
      report('Layout updated');
    } catch (error) {
      report(`Could not arrange workflow nodes: ${errorMessage(error, 'layout failed')}`, true);
    }
  };
  const validate = () => {
    const ids = new Set(nodes.map((node) => node.id));
    const valid = nodes.some((node) => node.data.kind === 'trigger') &&
      edges.every((edge) => ids.has(edge.source) && ids.has(edge.target));
    report(valid
      ? 'Graph is valid · execution is not connected yet'
      : 'Add a Trigger and connect every edge to an existing node', !valid);
  };
  const updateSelected = (key: keyof WorkflowData, value: string) => setNodes((current) => current.map((node) => (
    node.id === selectedId ? { ...node, data: { ...node.data, [key]: value } } : node
  )));
  const deleteSelected = () => {
    setNodes((current) => current.filter((node) => node.id !== selectedId));
    setEdges((current) => current.filter((edge) => edge.source !== selectedId && edge.target !== selectedId));
    setSelectedId('');
  };
  if (source.loading) return <div className="workflow-page"><p role="status">Loading workflows…</p></div>;
  if (source.error || !activeWorkflow) {
    return <div className="workflow-page"><p role="alert">{source.error ?? 'No workflows available'}</p></div>;
  }
  const view = source.describe(activeWorkflow);
  const { acknowledge, publish } = source;
  const isBuilder = section === 'Builder';
  const layoutClasses = [
    'workflow-builder-layout', 'workflow-design-preview', !isBuilder && 'workflow-section-view',
    !inspectorOpen && 'workflow-inspector-closed', view.positions && 'workflow-arranged', view.timeline && 'workflow-steps-passed',
  ].filter(Boolean).join(' ');
  return <section className={`workflow-page${isBuilder ? ' workflow-run-mock' : ''}`}>
    <header className="workflow-mobile-header" aria-label="Workflow navigation">
      <a href="#overview" aria-label="Back to Overview"><IconArrowLeft size={20} /></a>
      <div className="workflow-mobile-brand"><span className="brand-mark" aria-hidden="true" />Zenchron Engineering</div>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target><button className="workflow-mobile-menu-trigger" type="button" aria-label="More workflow actions"><IconDots size={19} /></button></Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={() => navigateMobileSection('Runs', 'workflow-mobile-run-summary')}>Show run status</Menu.Item>
          <Menu.Item onClick={() => navigateMobileSection('Approvals', 'workflow-mobile-run-approvals')}>Show approvals</Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </header>
    <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="New Workflow">
      <TextInput
        label="Workflow name" value={createName} onChange={(event) => setCreateName(event.currentTarget.value)}
        maxLength={200} required
      />
      <Textarea
        label="Description" value={createDescription}
        onChange={(event) => setCreateDescription(event.currentTarget.value)} maxLength={1000} autosize minRows={2}
      />
      {createError && <p className="form-error" role="alert">{createError}</p>}
      <Button
        className="workflow-create-button"
        loading={source.creating}
        disabled={!createName.trim()}
        onClick={createWorkflow}
      >Create workflow</Button>
    </Modal>
    <div className={layoutClasses}>
      <div className={`workflow-page-heading${isBuilder ? '' : ' workflow-section-heading'}`}>
        <PageHeading
          eyebrow={<>
            <span className="workflow-desktop-eyebrow">Workflows <IconChevronRight size={10} /> Workflow Builder</span>
            <span className="workflow-mobile-eyebrow">{view.phone.eyebrow}</span>
          </>}
          title={<>
            <span className="workflow-desktop-title">Workflow Builder — {activeWorkflow.name}</span>
            <span className="workflow-mobile-title">Workflow Orchestration</span>
          </>}
          titleAdornment={<Badge color={definition.status === 'active' ? 'green' : 'gray'}>
            <span className="workflow-desktop-status">{workflowStatusLabels[definition.status]}</span>
            <span className="workflow-mobile-status">{view.phone.status ?? workflowStatusLabels[definition.status]}</span>
          </Badge>}
          titleClassName="workflow-title-line"
          description={<>
            <span className="workflow-desktop-description">{activeWorkflow.description}</span>
            <span className="workflow-mobile-description">{view.phone.description}</span>
          </>}
        />
        {isBuilder ? <div className="workflow-toolbar">
          <Menu position="bottom-start" withinPortal>
            <Menu.Target><button className="workflow-version-trigger" type="button" aria-label="Workflow menu">
              <Badge className="workflow-version" color="gray">{view.versionLabel} <IconChevronDown size={12} /></Badge>
            </button></Menu.Target>
            {/* ponytail: plain list, fine below ~50 workflows; add a filter field if lists grow */}
            <Menu.Dropdown className="workflow-menu">
              <Menu.Label>Workflows</Menu.Label>
              {source.workflows.map(({ id, name }) => <Menu.Item key={id} onClick={() => openWorkflow(id)}
                aria-current={id === activeWorkflow.id ? 'true' : undefined}
                rightSection={id === activeWorkflow.id && <IconCheck size={13} aria-hidden="true" />}>{name}</Menu.Item>)}
              <Menu.Item onClick={() => setCreateOpen(true)}>New workflow…</Menu.Item>
              <Menu.Divider />
              <Menu.Item onClick={() => selectSection('Versions')}>Open version history</Menu.Item>
              <Menu.Item onClick={autoLayout}>Auto layout</Menu.Item>
            </Menu.Dropdown>
          </Menu>
          <Button className="workflow-validate" variant="default" leftSection={<IconCheck size={15} />} onClick={validate}>Validate</Button>
          <Button className="workflow-run" variant="default" leftSection={<IconPlayerPlay size={15} />}
            disabled={!view.timeline} title={view.timeline ? undefined : runnerOffline}
            onClick={() => { setRunPreviewView('Execution Graph'); setSimulateRun(true); report('Simulated run shown · workflow was not executed'); }}>
            Run
          </Button>
          <Button className="workflow-save" leftSection={<IconDeviceFloppy size={15} />} loading={source.saving}
            disabled={source.saving} onClick={save}>
            Save
          </Button>
          <Button className="workflow-publish" variant="light" disabled={!publish}
            title={publish ? undefined : 'Workflow publishing is not connected'}
            onClick={() => publish && report(publish())}>Publish</Button>
        </div> : <div className="workflow-toolbar workflow-section-meta" aria-label="Workflow summary">
          {view.sectionBadges.map((badge) => <Badge className="workflow-section-meta-badge" key={badge}>{badge}</Badge>)}
          <span className={`workflow-section-concept${notice.isError ? ' workflow-status-error' : ''}`} role="status">
            {notice.text || view.sectionNote}
          </span>
        </div>}
      </div>
      <WorkflowSectionTabs section={section} onSelect={selectSection} />
      {isBuilder ? <>
      <nav className="workflow-mobile-tabs" aria-label="Workflow mobile sections">
        {mobileSections.map(([name, target]) => <button key={name} type="button" className={mobileSection === name ? 'selected' : ''}
          aria-current={mobileSection === name ? 'page' : undefined}
          onClick={() => navigateMobileSection(name, target)}>{name}</button>)}
      </nav>
      <div className="workflow-mobile-overview" id="workflow-mobile-overview">
        <WorkflowOverview mobile workflowID={activeWorkflow.id} designPreview={designPreview} />
      </div>
      <WorkflowPhoneRunCards run={view.phone.run}
        onAction={acknowledge && ((action) => report(acknowledge(action, 'no approval was recorded')))} />
      <DndContext onDragEnd={handleDragEnd}>
      <div className="workflow-editor">
      <WorkflowPalette onAdd={addComponent} />
      <Group
        className="workflow-center-group"
        orientation="vertical"
        defaultLayout={{ canvas: 63.15, preview: 36.85 }}
      >
        <Panel id="canvas" className="workflow-center-panel" minSize="40%">
      <div className="workflow-canvas-wrap" ref={canvasRef}>
        <div className="workflow-canvas-tools">
          <div className="workflow-preview-toolset" role="group" aria-label="Canvas tools">
            <button className={canvasMode === 'select' ? 'selected' : ''} type="button" aria-label="Select nodes"
              aria-pressed={canvasMode === 'select'} onClick={() => setCanvasMode('select')}>↖</button>
            <button className={canvasMode === 'pan' ? 'selected' : ''} type="button" aria-label="Pan canvas"
              aria-pressed={canvasMode === 'pan'} onClick={() => setCanvasMode('pan')}>✋</button>
            <button type="button" aria-label="Add custom block" onClick={() => addComponent(customBlock.type, customBlock.label)}>＋</button>
            <button type="button" aria-label="Fit graph to canvas" onClick={() => flow.current?.fitView({ duration: 200 })}>□</button>
            <button type="button" aria-label="Toggle canvas fullscreen" onClick={() => {
              const canvas = canvasRef.current;
              if (!canvas) return;
              const action = document.fullscreenElement === canvas
                ? document.exitFullscreen() : canvas.requestFullscreen();
              void action.catch(() => report('Canvas fullscreen is unavailable', true));
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
        </div>
        <WorkflowDropCanvas>
          <ReactFlow
            key={layoutRevision} nodes={nodes} edges={edges} nodeTypes={flowNodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onInit={(instance) => { flow.current = instance; setCanvasZoom(instance.getZoom()); }}
            onMoveEnd={(_, viewport) => setCanvasZoom(viewport.zoom)}
            nodesDraggable={canvasMode === 'select'} panOnDrag={canvasMode === 'pan'}
            onNodeClick={(_, node) => { setSelectedId(node.id); setInspectorOpen(true); }} fitView minZoom={0.2} attributionPosition="bottom-left"
          >
            {miniMapVisible && <MiniMap style={{ width: 128, height: 54 }} nodeColor="#8e52db" maskColor="#0b0b14bb" />}
          </ReactFlow>
        </WorkflowDropCanvas>
        <div className={`workflow-status workflow-preview-execution-flow${notice.isError ? ' workflow-status-error' : ''}`} aria-live="polite">
          <IconPlayerPlay size={16} />
          <div><b>{view.execution.title}</b><span>{notice.text || view.execution.idle}</span></div>
        </div>
      </div>
        </Panel>
        <Separator id="canvas-preview" className="workflow-resize-handle" />
        <Panel id="preview" className="workflow-center-panel" minSize="25%">
          <div className="workflow-run-preview" aria-label="Workflow execution preview">
            <div className="workflow-preview-heading">
              <div role="tablist" aria-label="Run preview views"><b>Run Preview</b>
                {runPreviewViews.map((name) => <button
                  key={name} type="button" role="tab" aria-selected={runPreviewView === name}
                  className={runPreviewView === name ? 'selected' : ''} disabled={!view.timeline || !simulateRun}
                  title={view.timeline ? undefined : 'Run a workflow to view execution details'}
                  onClick={() => setRunPreviewView(name)}>{name}</button>)}
              </div>
              <label className="workflow-simulate-control">Simulate Run
                <button type="button" role="switch" aria-label="Simulate Run" aria-checked={Boolean(view.timeline) && simulateRun}
                  className="workflow-preview-toggle" disabled={!view.timeline} title={view.timeline ? undefined : runnerOffline}
                  onClick={() => setSimulateRun((enabled) => !enabled)} />
              </label>
            </div>
            {view.timeline && simulateRun ? <WorkflowRunPreview run={view.timeline} view={runPreviewView} />
              : <div className="workflow-preview-paused" role="status">{view.timeline ? <>
                <b>Simulation paused</b><span>Turn on Simulate Run to view execution details.</span>
              </> : <>
                <b>Execution preview unavailable</b>
                <span>Workflow execution is not connected. This graph has {nodes.length} components and {edges.length} connections
                  and has not run.</span>
              </>}</div>}
          </div>
        </Panel>
      </Group>
      </div>
      </DndContext>
      <aside className="workflow-properties" hidden={!inspectorOpen}>
        <PanelHeading className="workflow-subheading" title={selected?.data.label ?? 'Selected component'}
          icon={selected && <span className="workflow-inspector-icon" aria-hidden="true"><InspectorIcon size={18} /></span>}
          actions={<div className="workflow-inspector-actions">
            <Menu position="bottom-end" withinPortal>
              <Menu.Target><button type="button" aria-label="Component options"><IconDots size={16} /></button></Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={() => setSelectedId(nodes.find(({ data }) => data.kind === 'agent-router')?.id ?? '')}>Reset selection</Menu.Item>
                <Menu.Item color="red" disabled={!selected} onClick={deleteSelected}>Delete component</Menu.Item>
              </Menu.Dropdown>
            </Menu>
            <button type="button" aria-label="Close component settings" onClick={() => setInspectorOpen(false)}><IconX size={16} /></button>
          </div>} />
        <div className="workflow-inspector-tabs" role="tablist" aria-label="Component settings">
          {nodeSettingsTabs.map((tab) => <button key={tab}
            type="button" role="tab" aria-selected={settingsTab === tab} aria-controls="router-settings-panel"
            className={settingsTab === tab ? 'selected' : ''} disabled={tab !== 'Properties' && !view.nodeSettings}
            title={tab !== 'Properties' && !view.nodeSettings ? 'Unavailable · only a component\'s name and description are stored' : undefined}
            onClick={() => setSettingsTab(tab)}>{tab}</button>)}
        </div>
        {selected ? <>
          {settingsTab === 'Properties' && <section className="workflow-basic-configuration" aria-label="Basic configuration">
            <h4>Basic Configuration</h4>
            <div className="workflow-basic-fields">
              <TextInput
                label="Node Name" value={selected.data.label}
                onChange={(event) => updateSelected('label', event.currentTarget.value)} maxLength={100}
                readOnly={Boolean(view.inspectorDescriptions)}
              />
              <TextInput label="Type" value={selectedType} readOnly />
              <Textarea
                label="Description" value={view.inspectorDescriptions?.[selected.id] ?? selected.data.description}
                onChange={(event) => updateSelected('description', event.currentTarget.value)}
                maxLength={500} autosize minRows={2} readOnly={Boolean(view.inspectorDescriptions)}
              />
            </div>
          </section>}
          <WorkflowNodeSettings settings={view.nodeSettings} tab={settingsTab} />
        </> : <p className="workflow-hint">Select a node on the canvas to edit it.</p>}
      </aside>
      </> : <WorkflowSectionView section={section} data={view.sections}
        onAction={acknowledge && ((action) => report(acknowledge(action, 'no workflow changes were saved')))}
        definition={definition} isSaving={source.saving} onSave={save}
        onDefinitionChange={(change) => setDefinition((current) => ({ ...current, ...change }))} />}
    </div>
  </section>;
}
