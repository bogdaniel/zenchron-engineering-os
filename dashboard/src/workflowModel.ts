import { MarkerType } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';
import { z } from 'zod';
import {
  IconBolt, IconChartBar, IconChecklist, IconCode, IconFileText, IconFlask, IconGitBranch, IconGitMerge, IconHierarchy,
  IconMessage2, IconPlayerPlayFilled, IconRepeat, IconRobot, IconRoute, IconStack2, IconTestPipe, IconUserCheck,
} from '@tabler/icons-react';

export const nodeTypes = [
  'trigger', 'planner', 'agent-router', 'agent-task', 'code-reviewer', 'test-generator',
  'coverage-analyzer', 'human-approval', 'merge-gate', 'publish-report', 'condition', 'loop',
] as const;
export const nodeDataSchema = z.object({ label: z.string(), description: z.string() });
export const nodeSchema = z.object({
  id: z.string(), type: z.enum(nodeTypes),
  position: z.object({ x: z.number(), y: z.number() }), data: nodeDataSchema,
});
export const edgeSchema = z.object({ id: z.string(), source: z.string(), target: z.string(), label: z.string() });
export const workflowSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), status: z.enum(['draft', 'active']), version: z.number(),
  nodes: z.array(nodeSchema), edges: z.array(edgeSchema), updated_at: z.string(),
});
export const workflowsSchema = z.array(workflowSchema);
export type WorkflowData = z.infer<typeof nodeDataSchema>;
export type WorkflowNode = Node<WorkflowData & { kind: ComponentType; previewIcon?: typeof IconRoute }>;
export type Workflow = z.infer<typeof workflowSchema>;
export const workflowNodeWidth = 190;
export const workflowNodeHeight = 110;
export const overviewNodeLayout = { width: 190, height: 54, spacing: 8 };
export const designPreviewPositions: Record<string, { x: number; y: number }> = {
  trigger: { x: 10, y: 72 }, plan: { x: 252, y: 72 }, build: { x: 461, y: 72 },
  test: { x: 666, y: 24 }, review: { x: 666, y: 112 }, merge: { x: 911, y: 72 },
};
export const designPreviewCanvasPositions: Record<string, { x: number; y: number }> = {
  trigger: { x: 0, y: 180 }, plan: { x: 210, y: 180 }, build: { x: 420, y: 180 },
  retry: { x: 420, y: 40 }, review: { x: 630, y: 100 }, tests: { x: 630, y: 180 },
  coverage: { x: 630, y: 260 }, condition: { x: 840, y: 40 }, approval: { x: 840, y: 180 },
  merge: { x: 1050, y: 180 }, publish: { x: 1260, y: 180 },
};
export const mobileOverviewStages: {
  id: string; label: string; description: string; kind: ComponentType; types: ComponentType[];
  position: { x: number; y: number }; previewIcon?: typeof IconRoute;
}[] = [
  {
    id: 'trigger', label: 'Trigger', description: 'PR or objective update', kind: 'trigger', types: ['trigger'],
    position: { x: 0, y: 36 }, previewIcon: IconPlayerPlayFilled,
  },
  { id: 'plan', label: 'Plan', description: 'Generate plan', kind: 'planner', types: ['planner'],
    position: { x: 54, y: 36 }, previewIcon: IconStack2 },
  {
    id: 'build', label: 'Build', description: 'Run agents', kind: 'agent-router', types: ['agent-router', 'agent-task'],
    position: { x: 108, y: 36 }, previewIcon: IconCode,
  },
  {
    id: 'test', label: 'Test', description: 'Run test suite', kind: 'test-generator',
    types: ['test-generator', 'coverage-analyzer', 'condition', 'loop'], position: { x: 162, y: 10 },
    previewIcon: IconFlask,
  },
  {
    id: 'review', label: 'Review', description: 'AI + human review', kind: 'code-reviewer', types: ['code-reviewer'],
    position: { x: 162, y: 62 }, previewIcon: IconMessage2,
  },
  {
    id: 'merge', label: 'Merge', description: 'Gated release', kind: 'merge-gate',
    types: ['human-approval', 'merge-gate', 'publish-report'], position: { x: 216, y: 36 },
    previewIcon: IconGitBranch,
  },
];
export const designPreviewWorkflow: Workflow = {
  id: 'overview-design-preview', name: 'PR Review & Release Orchestration',
  description: 'Automate code review, test generation, coverage analysis, approval, and release reporting.',
  status: 'active', version: 1,
  updated_at: '',
  nodes: [
    ['trigger', 'trigger', 'Trigger', 'PR or objective update'],
    ['plan', 'planner', 'Planner', 'Create an execution plan'],
    ['build', 'agent-router', 'Agent Router', 'Route work to specialized agents'],
    ['retry', 'loop', 'Retry (max 2)', 'On failure'],
    ['review', 'code-reviewer', 'Code Reviewer', 'Analyze changes and provide review'],
    ['tests', 'test-generator', 'Test Generator', 'Generate and update tests'],
    ['coverage', 'coverage-analyzer', 'Coverage Analyzer', 'Compute test coverage and quality'],
    ['condition', 'condition', 'Condition', 'Coverage ≥ 80% and tests pass'],
    ['approval', 'human-approval', 'Human Approval', 'Review results and approve'],
    ['merge', 'merge-gate', 'Merge Gate', 'Conditional merge with policies'],
    ['publish', 'publish-report', 'Publish Report', 'Generate and publish release report'],
  ].map(([id, type, label, description]) => ({
    id, type: type as ComponentType, position: { x: 0, y: 0 }, data: { label, description },
  })),
  edges: [
    ['trigger', 'plan'], ['plan', 'build'], ['build', 'review'], ['build', 'tests'], ['build', 'coverage'],
    ['review', 'approval'], ['tests', 'condition'], ['coverage', 'condition'], ['condition', 'approval'],
    ['review', 'retry'], ['tests', 'retry'], ['coverage', 'retry'], ['retry', 'build'],
    ['approval', 'merge'], ['merge', 'publish'],
  ].map(([source, target]) => ({ id: `${source}-${target}`, source, target, label: '' })),
};

export const components = [
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
export type ComponentType = typeof components[number][1];
export const workflowNodeIcons: Record<ComponentType, typeof IconRoute> = {
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
export const componentGroups = [...new Set(components.map(([group]) => group))];
export const defaultDescriptions: Record<ComponentType, string> = {
  trigger: 'Start on a pull request or event', planner: 'Create an execution plan',
  'agent-router': 'Route work to specialized agents', 'agent-task': 'Run a configured agent',
  'code-reviewer': 'Review changes and report findings', 'test-generator': 'Generate and run focused tests',
  'coverage-analyzer': 'Analyze test coverage', 'human-approval': 'Request reviewer approval',
  'merge-gate': 'Apply repository and policy checks', condition: 'Continue when conditions pass',
  loop: 'Repeat for each item', 'publish-report': 'Publish a release report',
};

export async function loadWorkflows(): Promise<Workflow[]> {
  const response = await fetch('/api/v1/workflows');
  if (!response.ok) throw new Error(`Workflow list failed: ${response.status}`);
  return workflowsSchema.parse(await response.json());
}

export async function layoutNodes(
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

export function mobileWorkflowGraph(workflow: Workflow, designPreview = false, mobile = false) {
  const stageByType = new Map<ComponentType, string>();
  for (const stage of mobileOverviewStages) {
    for (const type of stage.types) stageByType.set(type, stage.id);
  }
  const stageByNode = new Map<string, string>();
  const loopNodeIDs = designPreview
    ? new Set(workflow.nodes.filter((node) => node.type === 'loop').map((node) => node.id)) : new Set<string>();
  for (const node of workflow.nodes) {
    const stage = stageByType.get(node.type);
    if (!stage) continue;
    stageByNode.set(node.id, stage);
  }
  const configuredStages = new Set(stageByNode.values());
  const stages = mobileOverviewStages.filter(({ id }) => configuredStages.has(id));
  const nodes: WorkflowNode[] = stages.map(({ id, label, description, kind, previewIcon, position }) => ({
    id, type: 'workflow', position: designPreview && !mobile ? designPreviewPositions[id] ?? position : position,
    data: {
      kind, label, ...(designPreview ? { previewIcon } : {}),
      description: designPreview && id === 'trigger' ? 'Objective updated'
        : designPreview && id === 'merge' ? 'To trusted-main' : description,
    },
  }));
  const stageIDs = new Set(stages.map(({ id }) => id));
  const edgeIDs = new Set<string>();
  const edges = workflow.edges.flatMap((edge) => {
    if (loopNodeIDs.has(edge.source) || loopNodeIDs.has(edge.target)) return [];
    const source = stageByNode.get(edge.source);
    const target = stageByNode.get(edge.target);
    if (!source || !target || source === target || !stageIDs.has(source) || !stageIDs.has(target)) return [];
    const id = `${source}-${target}`;
    if (edgeIDs.has(id)) return [];
    edgeIDs.add(id);
    return [{ id, source, target, type: 'smoothstep' as const, animated: false,
      ...(designPreview ? { markerEnd: { type: MarkerType.ArrowClosed, color: '#c4d8ff' } } : {}) }];
  });
  return { nodes, edges };
}

export function workflowGraph(workflow: Workflow) {
  const loopNodeIDs = new Set(workflow.nodes.filter((node) => node.type === 'loop').map((node) => node.id));
  return {
    nodes: workflow.nodes.map((node) => ({
      ...node, type: 'workflow', data: { ...node.data, kind: node.type },
    })),
    edges: workflow.edges.map((edge) => ({ ...edge, type: 'smoothstep', animated: false,
      ...(loopNodeIDs.has(edge.source) || loopNodeIDs.has(edge.target) ? { className: 'workflow-loop-edge' } : {}) })),
  };
}

