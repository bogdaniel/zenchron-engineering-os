import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, Button, Card, Menu, Modal, Select, TextInput, Textarea } from '@mantine/core';
import { DndContext, useDraggable, useDroppable } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addEdge, Background, Controls, Handle, MiniMap, Position, ReactFlow, useEdgesState, useNodesState,
} from '@xyflow/react';
import type { Connection, Edge, Node, NodeProps, ReactFlowInstance } from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';
import { z } from 'zod';
import {
  IconBolt, IconCheck, IconChecklist, IconChevronRight, IconCirclePlus, IconCode, IconDeviceFloppy, IconDots,
  IconFileText, IconGitBranch, IconGitMerge, IconGripVertical, IconHierarchy, IconLayoutBoard, IconMaximize,
  IconPlayerPlay, IconRepeat, IconRobot, IconRoute, IconSearch, IconTestPipe, IconChartBar, IconUserCheck,
} from '@tabler/icons-react';
import '@xyflow/react/dist/style.css';
import { PageHeading } from './PageHeading';
import { PanelHeading } from './PanelHeading';
import { PanelCard } from './PanelCard';
import './workflows.css';

const nodeTypes = [
  'trigger', 'planner', 'agent-router', 'agent-task', 'code-reviewer', 'test-generator',
  'coverage-analyzer', 'human-approval', 'merge-gate', 'publish-report', 'condition', 'loop',
] as const;
const nodeDataSchema = z.object({ label: z.string(), description: z.string() });
const nodeSchema = z.object({
  id: z.string(), type: z.enum(nodeTypes),
  position: z.object({ x: z.number(), y: z.number() }), data: nodeDataSchema,
});
const edgeSchema = z.object({ id: z.string(), source: z.string(), target: z.string(), label: z.string() });
const workflowSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), status: z.enum(['draft', 'active']), version: z.number(),
  nodes: z.array(nodeSchema), edges: z.array(edgeSchema), updated_at: z.string(),
});
export const workflowsSchema = z.array(workflowSchema);
type WorkflowData = z.infer<typeof nodeDataSchema>;
type WorkflowNode = Node<WorkflowData & { kind: ComponentType }>;
type Workflow = z.infer<typeof workflowSchema>;
const workflowNodeWidth = 190;
const workflowNodeHeight = 110;
const overviewNodeLayout = { width: 190, height: 54, spacing: 8 };
const mobileOverviewStages: {
  id: string; label: string; description: string; kind: ComponentType; types: ComponentType[];
  position: { x: number; y: number };
}[] = [
  {
    id: 'trigger', label: 'Trigger', description: 'PR or objective update', kind: 'trigger', types: ['trigger'],
    position: { x: 0, y: 36 },
  },
  { id: 'plan', label: 'Plan', description: 'Generate plan', kind: 'planner', types: ['planner'], position: { x: 54, y: 36 } },
  {
    id: 'build', label: 'Build', description: 'Run agents', kind: 'agent-router', types: ['agent-router', 'agent-task'],
    position: { x: 108, y: 36 },
  },
  {
    id: 'test', label: 'Test', description: 'Run test suite', kind: 'test-generator',
    types: ['test-generator', 'coverage-analyzer', 'condition', 'loop'], position: { x: 162, y: 10 },
  },
  {
    id: 'review', label: 'Review', description: 'AI + human review', kind: 'code-reviewer', types: ['code-reviewer'],
    position: { x: 162, y: 62 },
  },
  {
    id: 'merge', label: 'Merge', description: 'Gated release', kind: 'merge-gate',
    types: ['human-approval', 'merge-gate', 'publish-report'], position: { x: 216, y: 36 },
  },
];
const designPreviewWorkflow: Workflow = {
  id: 'overview-design-preview', name: 'PR Review & Release Orchestration', description: '', status: 'active', version: 1,
  updated_at: '',
  nodes: [
    ['trigger', 'trigger', 'Trigger', 'PR or objective update'],
    ['plan', 'planner', 'Plan', 'Generate plan'],
    ['build', 'agent-router', 'Build', 'Run agents'],
    ['tests', 'test-generator', 'Test', 'Run test suite'],
    ['coverage', 'coverage-analyzer', 'Coverage', 'Analyze coverage'],
    ['review', 'code-reviewer', 'Review', 'AI + human review'],
    ['approval', 'human-approval', 'Approval', 'Require manual review'],
    ['merge', 'merge-gate', 'Merge', 'Apply merge gate'],
    ['publish', 'publish-report', 'Publish', 'Release report'],
  ].map(([id, type, label, description]) => ({
    id, type: type as ComponentType, position: { x: 0, y: 0 }, data: { label, description },
  })),
  edges: [
    ['trigger', 'plan'], ['plan', 'build'], ['build', 'tests'], ['build', 'coverage'], ['build', 'review'],
    ['tests', 'approval'], ['coverage', 'approval'], ['review', 'approval'], ['approval', 'merge'], ['merge', 'publish'],
  ].map(([source, target]) => ({ id: `${source}-${target}`, source, target, label: '' })),
};

const components = [
  ['Core', 'trigger', 'Trigger'], ['Core', 'planner', 'Planner'],
  ['Core', 'agent-router', 'Agent Router'], ['Core', 'agent-task', 'Agent Task'],
  ['Quality & Validation', 'code-reviewer', 'Code Reviewer'],
  ['Quality & Validation', 'test-generator', 'Test Generator'],
  ['Quality & Validation', 'coverage-analyzer', 'Coverage Analyzer'],
  ['Control & Human-in-the-loop', 'human-approval', 'Human Approval'],
  ['Control & Human-in-the-loop', 'merge-gate', 'Merge Gate'],
  ['Control & Human-in-the-loop', 'condition', 'Condition'],
  ['Control & Human-in-the-loop', 'loop', 'Loop'],
  ['Control & Human-in-the-loop', 'publish-report', 'Publish Report'],
] as const;
type ComponentType = typeof components[number][1];
const workflowNodeIcons: Record<ComponentType, typeof IconRoute> = {
  trigger: IconBolt,
  planner: IconChecklist,
  'agent-router': IconHierarchy,
  'agent-task': IconRobot,
  'code-reviewer': IconCode,
  'test-generator': IconTestPipe,
  'coverage-analyzer': IconChartBar,
  'human-approval': IconUserCheck,
  'merge-gate': IconGitMerge,
  'publish-report': IconFileText,
  condition: IconGitBranch,
  loop: IconRepeat,
};
const componentGroups = [...new Set(components.map(([group]) => group))];
const defaultDescriptions: Record<ComponentType, string> = {
  trigger: 'Start on a pull request or event', planner: 'Create an execution plan',
  'agent-router': 'Route work to specialized agents', 'agent-task': 'Run a configured agent',
  'code-reviewer': 'Review changes and report findings', 'test-generator': 'Generate and run focused tests',
  'coverage-analyzer': 'Analyze test coverage', 'human-approval': 'Request reviewer approval',
  'merge-gate': 'Apply repository and policy checks', condition: 'Continue when conditions pass',
  loop: 'Repeat for each item', 'publish-report': 'Publish a release report',
};

async function loadWorkflows(): Promise<Workflow[]> {
  const response = await fetch('/api/v1/workflows');
  if (!response.ok) throw new Error(`Workflow list failed: ${response.status}`);
  return workflowsSchema.parse(await response.json());
}

function WorkflowBlock({ data }: NodeProps<WorkflowNode>) {
  const Icon = workflowNodeIcons[data.kind];
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

async function layoutNodes(
  nodes: WorkflowNode[], edges: Edge[],
  size = { width: workflowNodeWidth, height: workflowNodeHeight, spacing: 15 },
): Promise<WorkflowNode[]> {
  const elk = new ELK();
  const graph = await elk.layout({
    id: 'workflow',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': String(size.spacing),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(size.spacing),
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: nodes.map((node) => ({ id: node.id, width: size.width, height: size.height })),
    edges: edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  });
  return nodes.map((node) => {
    const position = graph.children?.find((child) => child.id === node.id);
    return position ? { ...node, position: { x: position.x ?? 0, y: position.y ?? 0 } } : node;
  });
}

function mobileWorkflowGraph(workflow: Workflow, designPreview = false) {
  const stageByType = new Map<ComponentType, string>();
  for (const stage of mobileOverviewStages) {
    for (const type of stage.types) stageByType.set(type, stage.id);
  }
  const stageByNode = new Map<string, string>();
  for (const node of workflow.nodes) {
    const stage = stageByType.get(node.type);
    if (!stage) continue;
    stageByNode.set(node.id, stage);
  }
  const configuredStages = new Set(stageByNode.values());
  const stages = mobileOverviewStages.filter(({ id }) => configuredStages.has(id));
  const nodes: WorkflowNode[] = stages.map(({ id, label, description, kind, position }) => ({
    id, type: 'workflow', position,
    data: {
      kind, label,
      description: designPreview && id === 'trigger' ? 'PR opened / updated'
        : designPreview && id === 'merge' ? 'To trusted-main' : description,
    },
  }));
  const stageIDs = new Set(stages.map(({ id }) => id));
  const edgeIDs = new Set<string>();
  const edges = workflow.edges.flatMap((edge) => {
    const source = stageByNode.get(edge.source);
    const target = stageByNode.get(edge.target);
    if (!source || !target || source === target || !stageIDs.has(source) || !stageIDs.has(target)) return [];
    const id = `${source}-${target}`;
    if (edgeIDs.has(id)) return [];
    edgeIDs.add(id);
    return [{ id, source, target, type: 'smoothstep' as const, animated: false }];
  });
  return { nodes, edges };
}

function workflowGraph(workflow: Workflow) {
  return {
    nodes: workflow.nodes.map((node) => ({
      ...node, type: 'workflow', data: { ...node.data, kind: node.type },
    })),
    edges: workflow.edges.map((edge) => ({ ...edge, type: 'smoothstep', animated: false })),
  };
}

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
      const graph = mobileWorkflowGraph(workflow, designPreview);
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
  }, [workflow, mobile]);

  return <PanelCard className="panel workflow-panel" id="workflow" withBorder>
    <PanelHeading className="panel-heading" icon={<span className="section-icon purple-icon"><IconRoute size={18} /></span>}
      title="Workflow Orchestration" description={designPreview ? 'Objective: Ship AI code review v2' : workflow?.name ?? 'Saved workflow definition'}
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
                fitViewOptions={{ padding: 0.03 }}
                nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnDrag={false}
                zoomOnScroll={false} zoomOnPinch={false} attributionPosition="bottom-left"
              >
                <Background color="#37324c" gap={18} size={1} />
              </ReactFlow>
            </div>
            {!designPreview && <div className="workflow-overview-status" aria-label="Workflow execution status">
              <span>{workflow.nodes.length} components · {workflow.edges.length} connections</span>
              <span>Execution unavailable · runner not connected</span>
            </div>}
          </>}
  </PanelCard>;
}

export function WorkflowsPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['workflows'], queryFn: loadWorkflows });
  const [selectedWorkflowId, setSelectedWorkflowId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const loadedWorkflowId = useRef('');
  const flow = useRef<ReactFlowInstance<WorkflowNode, Edge> | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'draft' | 'active'>('draft');
  const [notice, setNotice] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [paletteSearch, setPaletteSearch] = useState('');
  const selected = nodes.find((node) => node.id === selectedId);
  const InspectorIcon = workflowNodeIcons[selected?.data.kind ?? 'agent-router'];
  const selectedType = selected
    ? components.find(([, type]) => type === selected.data.kind)?.[2] ?? selected.data.kind
    : '';
  const activeWorkflow = query.data?.find((workflow) => workflow.id === selectedWorkflowId) ?? query.data?.[0];
  const mobileStages = activeWorkflow ? mobileWorkflowGraph(activeWorkflow).nodes : [];
  const approvalRequired = activeWorkflow?.nodes.some((node) => node.type === 'human-approval') ?? false;
  const filteredComponents = components.filter(([, type, label]) =>
    `${label} ${defaultDescriptions[type]}`.toLowerCase().includes(paletteSearch.trim().toLowerCase()),
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
    const { nodes: workflowNodes, edges: workflowEdges } = workflowGraph(current);
    const selectedNode = workflowNodes.find((node) => node.data.kind === 'agent-router');
    const selectedNodes = workflowNodes.map((node) => ({ ...node, selected: node.id === selectedNode?.id }));
    setSelectedId(selectedNode?.id ?? '');
    setNodes(selectedNodes);
    setEdges(workflowEdges);
    void layoutNodes(selectedNodes, workflowEdges).then((laidOut) => {
      if (!isCurrent) return;
      setNodes(laidOut);
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
  return <section className="workflow-page">
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
        disabled={!createName.trim()}
        onClick={() => createWorkflow.mutate()}
      >Create workflow</Button>
    </Modal>
    <div className="workflow-builder-layout">
      <div className="workflow-page-heading">
        <PageHeading
          eyebrow="ORCHESTRATION"
          title={<>
            <span className="workflow-desktop-title">Workflow Builder — {activeWorkflow.name}</span>
            <span className="workflow-mobile-title">Workflow Orchestration</span>
          </>}
          titleAdornment={<Badge color={status === 'active' ? 'green' : 'gray'}>{status}</Badge>}
          titleClassName="workflow-title-line"
          description={<>
            <span className="workflow-desktop-description">{activeWorkflow.description}</span>
            <span className="workflow-mobile-description">{activeWorkflow.name}</span>
          </>}
        />
        <div className="workflow-toolbar">
          <Badge className="workflow-version" color="gray">v{activeWorkflow.version}</Badge>
          <Button className="workflow-validate" variant="default" leftSection={<IconCheck size={15} />} onClick={validate}>Validate</Button>
          <Button className="workflow-run" variant="default" leftSection={<IconPlayerPlay size={15} />} disabled title="Runner not connected">
            Run
          </Button>
          <Button className="workflow-save" leftSection={<IconDeviceFloppy size={15} />} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
          <Button className="workflow-publish" variant="light" disabled title="Workflow publishing is not connected">Publish</Button>
        </div>
      </div>
      <nav className="workflow-section-tabs" aria-label="Workflow sections">
        {['Builder', 'Runs', 'Versions', 'Schedules', 'Permissions', 'Settings'].map((section, index) => (
          <button className={index === 0 ? 'selected' : ''} disabled={index !== 0} key={section}>{section}</button>
        ))}
      </nav>
      <nav className="workflow-mobile-tabs" aria-label="Workflow mobile sections">
        <button className="selected" aria-current="page">Overview</button>
        <button disabled>Runs</button><button disabled>Tasks</button><button disabled>Approvals</button>
      </nav>
      <div className="workflow-mobile-overview"><WorkflowOverview mobile workflowID={activeWorkflow.id} /></div>
      <div className="workflow-mobile-summary" aria-label="Workflow execution status">
        <div><small>Run status</small><b>Not run</b></div>
        <div><small>Components</small><b>{activeWorkflow.nodes.length}</b></div>
        <div><small>Connections</small><b>{activeWorkflow.edges.length}</b></div>
        <p>Runner not connected. Saved graph is ready for a future run.</p>
      </div>
      <div className="workflow-mobile-details">
        <section aria-label="Task progress">
          <PanelCard className="workflow-mobile-detail-panel">
            <PanelHeading icon={<IconChecklist size={16} />} title="Task progress" />
            <div className="workflow-mobile-task-list">
              {mobileStages.map((stage) => <div className="workflow-mobile-task-row" key={stage.id}>
                <span>{stage.data.label}</span><Badge color="gray">Not run</Badge>
              </div>)}
            </div>
          </PanelCard>
        </section>
        <section aria-label="Approvals">
          <PanelCard className="workflow-mobile-detail-panel">
            <PanelHeading icon={<IconUserCheck size={16} />} title="Approvals" />
            <div className="workflow-mobile-approval-state">
              <span>{approvalRequired ? 'Human approval' : 'No approval step configured'}</span>
              {approvalRequired && <Badge color="gray">Not requested</Badge>}
            </div>
            <p>No approval activity is recorded before a workflow run.</p>
          </PanelCard>
        </section>
      </div>
      <DndContext onDragEnd={handleDragEnd}>
      <div className="workflow-editor">
      <aside className="workflow-palette">
        <PanelHeading className="workflow-subheading" icon={<IconCirclePlus size={16} />} title="Components" />
        <TextInput
          className="workflow-palette-search"
          aria-label="Search blocks"
          placeholder="Search blocks..."
          leftSection={<IconSearch size={14} />}
          value={paletteSearch}
          onChange={(event) => setPaletteSearch(event.currentTarget.value)}
        />
        {componentGroups.map((group) => {
          const groupComponents = filteredComponents.filter(([category]) => category === group);
          return groupComponents.length ? <div className="workflow-component-group" key={group}>
            <b>{group}</b>
            <div className="workflow-component-list">
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
      <div className="workflow-canvas-wrap">
        <div className="workflow-canvas-tools">
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
        </div>
        <WorkflowDropCanvas>
          <ReactFlow
            key={layoutRevision} nodes={nodes} edges={edges} nodeTypes={flowNodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onInit={(instance) => { flow.current = instance; }}
            onNodeClick={(_, node) => setSelectedId(node.id)} fitView minZoom={0.2} attributionPosition="bottom-left"
          >
            <Background color="#37324c" gap={18} />
            <MiniMap nodeColor="#8e52db" maskColor="#0b0b14bb" />
            <Controls position="top-right" />
          </ReactFlow>
        </WorkflowDropCanvas>
        <div className="workflow-status" aria-live="polite">
          <IconPlayerPlay size={14} /><span>{notice || 'Draft · validate and save changes'}</span>
          <small>Runner not connected</small>
        </div>
      </div>
        </Panel>
        <Separator id="canvas-preview" className="workflow-resize-handle" />
        <Panel id="preview" className="workflow-center-panel" minSize="25%">
          <div className="workflow-run-preview" aria-label="Workflow execution preview">
            <div className="workflow-preview-heading">
              <div><b>Run Preview</b><button disabled>Execution Graph</button><button disabled>Logs</button>
                <button disabled>Outputs</button><button disabled>Artifacts</button></div>
              <Badge color="gray">Runner unavailable</Badge>
            </div>
            <div className="workflow-preview-content">
              <div className="workflow-preview-empty"><IconPlayerPlay size={19} />
                <b>Execution preview unavailable</b>
                <span>Workflow execution is not connected. Save and validate this graph to keep its definition ready.</span>
              </div>
              <div className="workflow-preview-summary"><b>Graph definition</b>
                <span><small>Components</small> {nodes.length}</span>
                <span><small>Connections</small> {edges.length}</span>
                <span><small>Last run</small>Not run</span>
              </div>
            </div>
          </div>
        </Panel>
      </Group>
      </div>
      </DndContext>
      <aside className="workflow-properties">
        <PanelHeading className="workflow-subheading" title={selected?.data.label ?? 'Selected component'}
          icon={selected && <span className="workflow-inspector-icon" aria-hidden="true"><InspectorIcon size={18} /></span>} />
        {selected ? <>
          <section className="workflow-basic-configuration" aria-label="Basic configuration">
            <h4>Basic Configuration</h4>
            <div className="workflow-basic-fields">
              <TextInput
                label="Node Name" value={selected.data.label}
                onChange={(event) => updateSelected('label', event.currentTarget.value)} maxLength={100}
              />
              <TextInput label="Type" value={selectedType} readOnly />
              <Textarea
                label="Description" value={selected.data.description}
                onChange={(event) => updateSelected('description', event.currentTarget.value)}
                maxLength={500} autosize minRows={2}
              />
            </div>
          </section>
          <Button color="red" variant="subtle" onClick={() => {
            setNodes((current) => current.filter((node) => node.id !== selectedId));
            setEdges((current) => current.filter((edge) => edge.source !== selectedId && edge.target !== selectedId));
            setSelectedId('');
          }}>Delete component</Button>
        </> : <p className="workflow-hint">Select a node on the canvas to edit it.</p>}
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
      </aside>
    </div>
  </section>;
}
