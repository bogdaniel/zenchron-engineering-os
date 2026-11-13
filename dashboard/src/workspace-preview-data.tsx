import { useState } from 'react';
import type { WorkspaceProduct, WorkspaceSource, WorkspaceView } from './workspaceView';

type MockProduct = WorkspaceProduct & { description: string };

const product = (name: string, summary: string, state: string, icon: string, description = summary): MockProduct =>
  ({ id: name.toLowerCase().replaceAll(' ', '-'), name, summary, state, healthy: state === 'Active', icon, description });

const fixtureProducts = [
  product('Nova Platform', 'Developer platform & tools', 'Active', 'layers',
    'Developer platform, APIs, and core services for building on Zenchron.'),
  product('Orion Analytics', 'Data & insights for teams', 'Active', 'chart'),
  product('Helix Agents', 'AI engineering agents', 'Active', 'agents'),
  product('Atlas Workspace', 'Team productivity suite', 'Planning', 'workspace'),
  product('Pulse Integrations', 'Platform & third-party sync', 'Active', 'link'),
];
const addedProductSummary = 'Product workspace preview';

const initiatives = [
  ['Platform v3.0', 'In Progress', '0%', '36%', 'green'],
  ['AI Agent SDK', 'In Progress', '25%', '42%', 'purple'],
  ['Enterprise Controls', 'Planned', '52%', '24%', 'blue'],
  ['Developer Experience', 'Planned', '72%', '25%', 'teal'],
] as const;

const objectives = [
  ['Ship Platform v3.0', 78],
  ['Launch Agent SDK (Beta)', 62],
  ['Improve build & test time by 40%', 34],
  ['Expand enterprise readiness', 20],
  ['Increase developer adoption', 18],
] as const;
const completedObjectiveCount = 2;

const releases = [
  ['Stable (v3.x)', 'Live', 'v3.0.2', 100, 'green'],
  ['Beta (v3.1)', 'In Progress', 'v3.1.0-rc.2', 72, 'blue'],
  ['Next (v3.2)', 'Planned', 'v3.2.0', 0, 'purple'],
] as const;

const decisions = [
  ['Adopt layered agent SDK architecture', 'Approved', '2h ago'],
  ['Move v3.0 GA to Jan 27', 'Approved', '6h ago'],
  ['Use feature flags for enterprise rollout', 'Approved', '1d ago'],
  ['Defer custom permissions to v3.2', 'Pending', '1d ago'],
] as const;

const quarterOptions = ['Q1 ’25', 'Q2 ’25', 'Q3 ’25', 'Q4 ’25', 'Q1 ’26', 'Q2 ’26', 'Q3 ’26', 'Q4 ’26'];
const defaultQuarter = quarterOptions[1];
const deliveryMetrics: Record<string, string[]> = {
  'Last 4 weeks': ['3.8 days', '10.2 hrs', '1.1%'],
  'Last 8 weeks': ['4.2 days', '11.6 hrs', '1.3%'],
  'Last 12 weeks': ['4.7 days', '13.1 hrs', '1.8%'],
};
const deliveryRows = [['Cycle Time', '↓ −28%'], ['PR Merge Time', '↓ −31%'], ['Change Fail Rate', '↓ −0.9 pts']] as const;
const workflowRows = [
  { name: 'PR Review & CI', state: 'Running' }, { name: 'Build & Test', state: 'Success' },
  { name: 'Release (Staging)', state: 'Success' }, { name: 'Release (Prod)', state: 'Scheduled' },
];

function mockView(selected: MockProduct | undefined, quarter = defaultQuarter): WorkspaceView {
  const name = selected?.name ?? fixtureProducts[0].name;
  const isFirst = !selected || selected.id === fixtureProducts[0].id;
  const index = Math.max(0, fixtureProducts.findIndex((item) => item.id === selected?.id));
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const quarterIndex = quarterOptions.indexOf(quarter);
  const objectiveRows = objectives.map(([title, progress], row) => ({
    title: isFirst ? title : `${['Ship', 'Launch', 'Improve', 'Expand', 'Increase'][row]} ${name} ${['v2.0', 'Beta', 'reliability', 'adoption', 'delivery'][row]}`,
    progress, done: row < completedObjectiveCount,
  }));
  const repositoryRows = (isFirst
    ? ['zenchron/nova-platform', 'zenchron/agent-sdk', 'zenchron/platform-services', 'zenchron/devtools']
    : [`zenchron/${slug}`, `zenchron/${slug}-sdk`, `zenchron/${slug}-services`, `zenchron/${slug}-devtools`])
    .map((repository) => ({ name: repository, branch: 'Main' }));

  return {
    name,
    description: selected?.description ?? fixtureProducts[0].description,
    status: { label: 'Active', healthy: true },
    facts: ['Product', 'Owner: Platform Eng', 'Updated 2m ago'],
    metrics: {
      health: { value: ['99.4%', '96.8%', '98.2%', '94.5%', '99.1%'][index], badge: '✓ Healthy', healthy: true,
        trend: 'M1 19 12 17 20 18 29 9 39 13 47 6 54 9 63 1' },
      initiatives: { label: 'Active Initiatives', value: ['7', '5', '4', '6', '3'][index], delta: '↑ +2',
        trend: 'M1 23 10 18 17 19 26 11 34 14 42 8 49 10 56 4 63 1' },
      delivery: { value: ['68%', '74%', '62%', '81%', '70%'][index], caption: 'On-time delivery', delta: '↑ +6 pts',
        bars: [8, 12, 16, 21, 25, 30] },
      decisions: { value: '5', detail: 'Last 7 days' },
    },
    roadmap: {
      quarters: quarterOptions,
      labels: [{ text: quarterOptions[Math.max(0, quarterIndex - 1)] }, { text: quarter }, { text: 'Today', today: true },
        { text: quarterOptions[Math.min(7, quarterIndex + 1)] }, { text: quarterOptions[Math.min(7, quarterIndex + 2)] }],
      todayAt: '48%',
      rows: initiatives.map(([title, status, left, width, tone], row) => ({
        name: isFirst ? title : `${name} ${['v2.0', 'SDK', 'Controls', 'Developer Experience'][row]}`,
        status, tone, bar: { left, width },
      })),
    },
    objectives: { title: 'Open Objectives (5)', rows: objectiveRows, allTitle: 'Open Objectives (5)', allRows: objectiveRows },
    repositories: { title: 'Repositories (6)', rows: repositoryRows, more: '+ 2 more repositories', allRows: repositoryRows },
    workflows: { title: 'Linked Workflows (4)', rows: workflowRows, templatesTitle: 'Workflow Templates (4)', templateRows: workflowRows },
    files: { rows: [['Designs (Figma)', '24'], ['Documentation', '118'], ['Product Specs', '34'], ['Files & Assets', '269']] },
    stakeholders: {
      title: 'Stakeholders (8)',
      rows: [{ name: 'Alex Chen', role: 'Product Owner', avatar: '/alex-chen-avatar.jpg' },
        { name: 'Priya Shah', role: 'Engineering Manager' }, { name: 'Marcus Lee', role: 'Design Lead' },
        { name: 'Elena Rossi', role: 'Product Manager' }],
      more: '+ 4 more stakeholders',
      manageNote: 'Stakeholder records are illustrative in this preview and cannot be changed here.',
    },
    releases: { rows: releases.map(([title, state, version, progress, tone], row) => ({
      name: isFirst ? title : ['Stable (v2.x)', 'Beta (v2.1)', 'Next (v2.2)'][row], state,
      version: isFirst ? version : ['v2.0.2', 'v2.1.0-rc.2', 'v2.2.0'][row], progress, tone,
    })) },
    decisions: { rows: decisions.map(([title, state, time], row) => ({
      name: isFirst ? title : [`Adopt layered architecture for ${name}`, `Move ${name} GA to Jan 27`,
        `Use feature flags for ${name}`, `Defer custom permissions for ${name}`][row], state, time,
    })) },
    delivery: {
      ranges: Object.keys(deliveryMetrics),
      metrics: (range) => deliveryRows.map(([label, delta], row) => [label, (deliveryMetrics[range] ?? deliveryMetrics['Last 8 weeks'])[row], delta]),
      chart: {
        label: 'Delivery trend, Nov 24 to Jan 12',
        points: [[1, 61], [17, 47], [34, 49], [52, 39], [68, 45], [85, 34], [102, 30], [119, 20], [135, 13], [149, 2]],
        dates: ['Nov 24', 'Dec 1', 'Dec 8', 'Dec 15', 'Dec 22', 'Dec 29', 'Jan 5', 'Jan 12'],
      },
    },
  };
}

/** The Mock source: the approved fixtures, changed with `useState` only. Nothing here calls the control plane. */
export function useMockWorkspace(): WorkspaceSource {
  const [products, setProducts] = useState(fixtureProducts);
  const [favorites, setFavorites] = useState<string[]>([]);
  return {
    products,
    statuses: ['All', 'Active', 'Planning'],
    view: (productID, quarter) => mockView(products.find((item) => item.id === productID), quarter),
    favorites,
    toggleFavorite: (productID) => setFavorites((current) => current.includes(productID)
      ? current.filter((id) => id !== productID) : [...current, productID]),
    editable: (productID) => {
      const item = products.find((candidate) => candidate.id === productID);
      return item && { id: item.id, name: item.name, description: item.description, repository_ids: [] };
    },
    editorNote: 'Products added or edited here stay in this preview only; repository links are illustrative.',
    saveProduct: async (input, productID) => {
      if (products.some((item) => item.id !== productID && item.name.toLowerCase() === input.name.toLowerCase())) {
        throw new Error('A product with this name already exists.');
      }
      if (productID) {
        setProducts((current) => current.map((item) => item.id === productID
          ? { ...item, name: input.name, description: input.description || item.summary } : item));
        return { id: productID };
      }
      const id = `preview-${Date.now()}`;
      setProducts((current) => [...current, { id, name: input.name, summary: addedProductSummary, state: 'Active',
        healthy: true, icon: 'layers', description: input.description || addedProductSummary }]);
      return { id };
    },
    saving: false,
    shareNote: 'This local preview does not send invitations. Share the page URL with your team to open the same preview.',
  };
}
