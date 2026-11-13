import { expect, test, type Page } from '@playwright/test';

async function chooseFromWorkflowMenu(page: Page, item: string | RegExp) {
  await page.getByRole('button', { name: 'Workflow menu' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

const seededWorkflow = 'PR Review & Release Orchestration';
const fixtureOnlyText = ['PR #4827', 'RUN-10428', 'v2.4.0', 'Alex Chen', 'Weekday PR Quality Check', '$0.038'];

async function useLocalSession(page: Page) {
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: true, login: 'Local workspace' }),
  }));
}

test('workflow graph can be edited and saved to the control plane', async ({ page }) => {
  await page.addInitScript(() => {
    if (!crypto.randomUUID) Object.defineProperty(Crypto.prototype, 'randomUUID', {
      value: () => crypto.getRandomValues(new Uint32Array(4)).join('-'),
    });
  });
  await useLocalSession(page);
  await page.route('**/api/v1/workflows**', (route) => {
    const apiURL = new URL(route.request().url());
    apiURL.port = '8083';
    return route.continue({ url: apiURL.toString() });
  });
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/');
  await page.getByRole('link', { name: 'Workflows' }).click();
  await expect(page.getByRole('heading', { name: /Workflow Builder — PR Review & Release Orchestration/ })).toBeVisible();
  await expect(page.locator('.workflow-page-heading .eyebrow')).toContainText('Workflow Builder');
  await expect(page.locator('.workflow-mobile-run-preview')).toBeHidden();
  const titleBox = await page.locator('.workflow-page-heading .page-heading h2').boundingBox();
  const toolbarBox = await page.locator('.workflow-toolbar').boundingBox();
  expect(titleBox?.height).toBeLessThan(30);
  expect(titleBox && toolbarBox && Math.abs(titleBox.y - toolbarBox.y)).toBeLessThan(16);
  await expect(page.locator('.workflow-version')).toHaveText(/^v\d+ \((Draft|Active)\)/);
  await page.getByRole('button', { name: 'Workflow menu' }).click();
  await expect(page.getByRole('menuitem', { name: seededWorkflow })).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Node Name' })).toHaveValue('Agent Router');
  await expect(page.getByRole('textbox', { name: 'Node Name' })).not.toHaveAttribute('readonly');
  await expect(page.getByRole('textbox', { name: 'Type' })).toHaveValue('Agent Router');
  await expect(page.getByRole('textbox', { name: 'Type' })).toHaveAttribute('readonly', '');
  await expect(page.getByRole('region', { name: 'Basic configuration' })).toBeVisible();
  await expect(page.locator('.workflow-properties .workflow-subheading h3')).toHaveText('Agent Router');
  const settingsTabs = page.getByRole('tablist', { name: 'Component settings' });
  await expect(settingsTabs.getByRole('tab', { name: 'Properties' })).toHaveAttribute('aria-selected', 'true');
  for (const tab of ['Prompt', 'Variables', 'Advanced']) await expect(settingsTabs.getByRole('tab', { name: tab })).toBeDisabled();
  const componentSettings = page.getByRole('tabpanel', { name: 'Component settings' });
  await expect(componentSettings.locator('header')).toHaveText([
    /Routing Parameters\s*Unavailable/, /Budgets & Limits\s*Unavailable/, /Retry Rules\s*Unavailable/, /Execution Conditions\s*Unavailable/,
  ]);
  await expect(page.getByRole('button', { name: 'Add Rule' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCSS('background-color', 'rgb(37, 35, 51)');
  const runPreview = page.locator('.workflow-run-preview');
  await expect(runPreview.getByRole('status')).toContainText('Execution preview unavailable');
  await expect(runPreview.getByRole('status')).toContainText('9 components and 10 connections');
  await expect(runPreview.getByRole('tab')).toHaveCount(4);
  for (const tab of await runPreview.getByRole('tab').all()) await expect(tab).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'Simulate Run' })).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'Simulate Run' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('region', { name: 'Simulated run timeline' })).toHaveCount(0);
  const executionFlow = page.locator('.workflow-preview-execution-flow');
  await expect(executionFlow).toContainText(/Execution Flow \(v\d+\)/);
  await expect(executionFlow).toContainText('Not run · 9 nodes · runner not connected');
  for (const text of fixtureOnlyText) await expect(page.locator('.workflow-page')).not.toContainText(text);
  await expect(page.locator('.workflow-component-add').filter({ hasText: 'Trigger' }))
    .toContainText('Start on a pull request or event');
  await expect(page.locator('.workflow-component-icon.trigger svg')).toBeVisible();
  await expect(page.locator('.workflow-component-icon.trigger')).toHaveCSS('color', 'rgb(84, 216, 208)');
  expect((await page.locator('.workflow-component-row').first().boundingBox())?.height).toBe(34);
  expect(await page.locator('.workflow-component-copy small').first().evaluate((description) =>
    description.scrollHeight <= description.clientHeight)).toBe(true);
  await expect(page.getByRole('group', { name: 'Component categories' }).getByRole('button'))
    .toHaveText(['All', 'Agents', 'Actions', 'Control', 'Integrations']);
  const palette = await page.locator('.workflow-palette').boundingBox();
  const canvasPanel = await page.locator('.workflow-canvas-wrap').boundingBox();
  const preview = await page.locator('.workflow-run-preview').boundingBox();
  const properties = await page.locator('.workflow-properties').boundingBox();
  const builder = await page.locator('.workflow-builder-layout').boundingBox();
  expect(await page.locator('.sidebar').evaluate((sidebar) => sidebar.getBoundingClientRect().width)).toBe(247);
  expect(palette?.x).toBe(263);
  expect(palette?.y).toBeGreaterThanOrEqual(201);
  expect(palette?.y).toBeLessThanOrEqual(203);
  expect(palette?.width).toBe(220);
  expect(palette?.height).toBeGreaterThanOrEqual(650);
  expect(canvasPanel?.x).toBe(palette!.x + palette!.width + 10);
  expect(canvasPanel?.width).toBeGreaterThan(800);
  expect(canvasPanel?.height).toBe(413);
  expect(properties && builder).toBeTruthy();
  expect(properties!.x + properties!.width).toBeCloseTo(builder!.x + builder!.width, 0);
  expect(properties?.y).toBe(90);
  expect(properties?.height).toBeGreaterThanOrEqual(760);
  expect(await page.locator('.workflow-properties').evaluate((panel) => panel.getBoundingClientRect().width)).toBe(288);
  expect(preview?.x).toBe(canvasPanel?.x);
  expect(await page.locator('.workflow-canvas .workflow-node small').evaluateAll((descriptions) =>
    descriptions.every((description) => description.scrollWidth <= description.clientWidth))).toBe(true);
  expect(preview?.y).toBeGreaterThanOrEqual(621);
  expect(preview?.y).toBeLessThanOrEqual(623);
  expect(preview?.height).toBeGreaterThanOrEqual(240);
  const trigger = page.locator('.workflow-canvas .workflow-node.trigger');
  await expect(trigger).toHaveCSS('width', '89px');
  await expect(page.locator('.workflow-canvas .workflow-node.code-reviewer')).toHaveCSS('width', '128px');
  await expect(trigger).toHaveCSS('border-top-color', 'rgb(84, 216, 208)');
  expect(await trigger.evaluate((node) => getComputedStyle(node, '::after').content),
    'a saved graph has not run, so no component carries a passed-step marker').toBe('none');
  await expect(page.locator('.workflow-canvas .workflow-node.trigger .workflow-node-icon')).toHaveCSS('color', 'rgb(84, 216, 208)');
  await expect(page.locator('.workflow-canvas .workflow-node.planner .workflow-node-icon')).toHaveCSS('color', 'rgb(125, 185, 255)');
  await expect(page.locator('.workflow-canvas .workflow-node.human-approval .workflow-node-icon')).toHaveCSS('color', 'rgb(67, 221, 166)');
  expect(await trigger.evaluate((node) => getComputedStyle(node).boxShadow)).toContain('84, 216, 208');
  await expect(page.locator('.workflow-canvas .react-flow__node.selected .workflow-node'))
    .toHaveCSS('outline-color', 'rgb(195, 139, 255)');
  await expect(page.locator('.workflow-canvas .workflow-preview-edge-planner .react-flow__edge-path').first())
    .toHaveCSS('stroke', 'rgb(196, 216, 255)');
  await expect(page.locator('.workflow-canvas .workflow-preview-edge-human-approval .react-flow__edge-path').first())
    .toHaveCSS('stroke', 'rgb(67, 221, 166)');
  const canvasSurface = page.locator('.workflow-canvas .react-flow');
  await expect(canvasSurface).toHaveCSS('background-image', /radial-gradient/);
  await expect(page.locator('.workflow-canvas .react-flow__background')).toHaveCount(0);
  await expect(page.locator('.workflow-canvas .react-flow__controls')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Canvas tools' })).toBeVisible();
  const miniMap = await page.locator('.workflow-canvas .react-flow__minimap').boundingBox();
  const attribution = page.locator('.workflow-canvas .react-flow__attribution');
  await expect(attribution).toBeVisible();
  const attributionBox = await attribution.boundingBox();
  const triggerBox = await trigger.boundingBox();
  expect(attributionBox && triggerBox && attributionBox.y).toBeLessThan(triggerBox!.y);
  const graphLabelSize = await page.evaluate(() => {
    const node = document.querySelector('.workflow-canvas .workflow-node');
    const viewport = document.querySelector('.workflow-canvas .react-flow__viewport');
    if (!node || !viewport) return 0;
    const zoom = new DOMMatrix(getComputedStyle(viewport).transform).a;
    return parseFloat(getComputedStyle(node.querySelector('b')!).fontSize) * zoom;
  });
  expect(graphLabelSize).toBeGreaterThanOrEqual(10);
  expect(miniMap?.width).toBe(128);
  expect(miniMap?.height).toBe(54);
  const allNodesInsideCanvas = () => page.locator('.workflow-canvas .react-flow').evaluate((canvas) => {
    const bounds = canvas.getBoundingClientRect();
    return [...canvas.querySelectorAll('.workflow-node')].every((node) => {
      const box = node.getBoundingClientRect();
      return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
    });
  });
  await expect.poll(allNodesInsideCanvas, { message: 'the automatic layout fits the whole saved graph in the canvas' }).toBe(true);
  const nodesOverlap = await page.locator('.workflow-canvas .workflow-node').evaluateAll((nodes) => {
    const boxes = nodes.map((node) => node.getBoundingClientRect());
    return boxes.some((box, index) => boxes.slice(index + 1).some((other) =>
      box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom));
  });
  expect(nodesOverlap, 'the automatic layout uses the compact card sizes').toBe(false);
  const zoomLevel = page.getByRole('button', { name: 'Reset canvas zoom' });
  const fittedZoom = await zoomLevel.textContent();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(zoomLevel).not.toHaveText(fittedZoom!);
  await page.getByRole('button', { name: 'Fit graph to canvas' }).click();
  await expect(zoomLevel).toHaveText(fittedZoom!);
  const editorStatus = await page.locator('.workflow-status').boundingBox();
  expect(canvasPanel && editorStatus && editorStatus.y + editorStatus.height)
    .toBeLessThanOrEqual(canvasPanel!.y + canvasPanel!.height);
  await chooseFromWorkflowMenu(page, 'Auto layout');
  await expect(page.locator('.workflow-status')).toContainText('Layout updated');
  const branchNodes = await Promise.all(['code-reviewer', 'test-generator', 'coverage-analyzer']
    .map((kind) => page.locator(`.workflow-canvas .workflow-node.${kind}`).boundingBox()));
  expect(branchNodes.every(Boolean)).toBe(true);
  expect(branchNodes[0]!.y).toBeLessThan(branchNodes[1]!.y);
  expect(branchNodes[1]!.y).toBeLessThan(branchNodes[2]!.y);
  await page.setViewportSize({ width: 1522, height: 856 });
  const workflowTitle = page.locator('.workflow-page-heading .page-heading h2');
  await expect(workflowTitle).toHaveCSS('font-size', '22px');
  expect((await workflowTitle.boundingBox())?.height).toBeLessThan(30);
  await page.setViewportSize({ width: 1672, height: 941 });
  const runButton = page.getByRole('button', { name: 'Run', exact: true });
  await expect(runButton).toBeDisabled();
  await expect(runButton).toHaveAttribute('title', 'Runner not connected');
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveAttribute('title', 'Workflow publishing is not connected');
  await page.getByRole('button', { name: 'Validate', exact: true }).click();
  await expect(page.locator('.workflow-status')).toContainText('Graph is valid');
  const paletteSearch = page.getByRole('textbox', { name: 'Search blocks' });
  await paletteSearch.fill('coverage');
  await expect(page.locator('.workflow-component-row')).toHaveCount(1);
  await expect(page.locator('.workflow-component-row')).toContainText('Coverage Analyzer');
  await paletteSearch.fill('no matching block');
  await expect(page.locator('.workflow-palette-empty')).toHaveText('No blocks match your search.');
  await paletteSearch.fill('');
  await expect(page.locator('.workflow-component-list button').filter({ hasText: 'Trigger' })).toBeVisible();
  const addAgentTask = page.locator('.workflow-component-add').filter({ hasText: 'Agent Task' });
  await addAgentTask.click();
  await expect(page.locator('.workflow-canvas .workflow-node')).toHaveCount(10);
  await expect(page.locator('.workflow-status')).toContainText('Block added · save to keep it');
  const saveRequest = page.waitForRequest((request) => request.method() === 'PUT' && request.url().includes('/api/v1/workflows/'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/Saved v\d+/)).toBeVisible();
  const savedGraph = (await saveRequest).postDataJSON() as { name: string; nodes: { type: string }[]; edges: unknown[] };
  expect(savedGraph.name).toBe(seededWorkflow);
  expect(savedGraph.nodes).toHaveLength(10);
  expect(savedGraph.nodes.filter((node) => node.type === 'agent-task')).toHaveLength(1);
  expect(savedGraph.edges).toHaveLength(10);
  await page.locator('.workflow-canvas .workflow-node').filter({ hasText: 'Trigger' }).click();
  await expect(page.getByRole('textbox', { name: 'Node Name' })).toHaveValue('Trigger');
  await page.getByRole('textbox', { name: 'Node Name' }).fill('PR Trigger');
  await expect(page.locator('.workflow-canvas .workflow-node.trigger b')).toHaveText('PR Trigger');
  await page.getByRole('textbox', { name: 'Node Name' }).fill('Trigger');
  await page.locator('.workflow-canvas .workflow-node').filter({ hasText: 'Agent Task' }).click();
  await expect(page.locator('.workflow-properties .workflow-subheading h3')).toHaveText('Agent Task');
  await page.getByRole('button', { name: 'Component options' }).click();
  await page.getByRole('menuitem', { name: 'Delete component' }).click();
  await expect(page.locator('.workflow-canvas .workflow-node')).toHaveCount(9);
  await expect(page.getByText('Select a node on the canvas to edit it.')).toBeVisible();
  const workflowName = `E2E workflow ${Date.now()}`;
  await chooseFromWorkflowMenu(page, 'New workflow…');
  const createDialog = page.getByRole('dialog', { name: 'New Workflow' });
  await createDialog.getByLabel('Workflow name').fill(workflowName);
  await createDialog.getByLabel('Description').fill('Created from the workflow builder.');
  await createDialog.getByRole('button', { name: 'Create workflow' }).click();
  await expect(page.getByRole('heading', { name: `Workflow Builder — ${workflowName}` })).toBeVisible();
  await expect(page.locator('.workflow-version')).toHaveText(/^v1 \(Draft\)/);
  await expect(page.locator('.workflow-status')).toContainText(`Created ${workflowName}`);
  await expect(page.locator('.workflow-canvas .workflow-node')).toHaveCount(2);

  const sectionTab = (name: string) => page.getByRole('navigation', { name: 'Workflow sections' }).getByRole('button', { name, exact: true });
  const sectionNote = page.locator('.workflow-section-concept');
  const emptyStates = page.locator('.workflow-section-empty');
  await sectionTab('Settings').click();
  await expect(page.locator('.workflow-section-preview-title h2')).toHaveText('Workflow Settings');
  await expect(page.locator('.workflow-section-meta')).toContainText('v1');
  await expect(page.locator('.workflow-section-meta')).toContainText('2 Nodes');
  await expect(page.locator('.workflow-section-meta')).toContainText('Agent profiles unavailable');
  await expect(sectionNote).toHaveText('SAVED DEFINITION · NO RUN DATA');
  await expect(page.getByLabel('Workflow name')).toHaveValue(workflowName);
  await expect(page.getByLabel('Description')).toHaveValue('Created from the workflow builder.');
  await expect(page.getByLabel('Status')).toHaveValue('draft');
  for (const field of ['Repository', 'Target branch', 'Maximum run duration', 'Concurrent runs', 'Maximum retries', 'Retry backoff']) {
    await expect(page.getByLabel(field)).toHaveText('Unavailable');
  }
  await expect(emptyStates).toHaveText([/^Unavailable · the control plane stores/, 'No notification rules are stored for this workflow.']);
  await expect(page.getByRole('button', { name: 'Archive Workflow' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'View Audit Log' })).toBeDisabled();
  const renamedWorkflow = `${workflowName} renamed`;
  await page.getByLabel('Workflow name').fill(renamedWorkflow);
  await page.getByLabel('Status').selectOption('active');
  const settingsRequest = page.waitForRequest((request) => request.method() === 'PUT' && request.url().includes('/api/v1/workflows/'));
  await page.getByRole('button', { name: 'Save Settings' }).click();
  await expect(sectionNote).toHaveText('Saved v2');
  expect((await settingsRequest).postDataJSON()).toMatchObject({
    name: renamedWorkflow, description: 'Created from the workflow builder.', status: 'active',
  });
  await expect(page.getByRole('heading', { name: `Workflow Builder — ${renamedWorkflow}` })).toBeVisible();

  await sectionTab('Runs').click();
  await expect(page.locator('.workflow-run-metric b')).toHaveText(['Unavailable', 'Unavailable', 'Unavailable', 'Unavailable']);
  await expect(page.locator('.workflow-table-row')).toHaveCount(0);
  await expect(emptyStates).toHaveText(/^Unavailable · workflow execution is not connected/);
  await expect(page.locator('.workflow-run-facts b')).toHaveText(['Unavailable', 'Unavailable', 'Unavailable']);
  for (const control of ['Run Workflow', 'View all →', /Export logs/, 'Review Approval']) {
    await expect(page.getByRole('button', { name: control })).toBeDisabled();
  }
  await expect(page.getByRole('button', { name: 'Run Workflow' })).toHaveAttribute('title', /workflow execution is not connected/);
  await sectionTab('Versions').click();
  await expect(page.locator('.workflow-version-row')).toHaveCount(1);
  await expect(page.locator('.workflow-version-row')).toContainText('v2');
  await expect(page.locator('.workflow-version-row')).toContainText('ACTIVE');
  await expect(page.locator('.workflow-version-row')).toContainText(/Saved .*\d{4}/);
  await expect(page.locator('.workflow-compare-graph')).toHaveCount(0);
  await expect(emptyStates).toHaveText(/keeps only the latest saved version/);
  for (const control of ['Publish Draft', 'Restore Draft', 'Publish']) {
    await expect(page.getByRole('button', { name: control, exact: true })).toBeDisabled();
  }
  await sectionTab('Schedules').click();
  await expect(page.locator('.workflow-schedule-row')).toHaveCount(0);
  await expect(page.locator('.workflow-calendar-day')).toHaveCount(0);
  await expect(emptyStates).toHaveText([/schedules and triggers are not connected/, 'No runs are scheduled.']);
  await expect(page.locator('.workflow-schedule-calendar output')).toHaveText(['Unavailable', 'Unavailable', 'Unavailable', 'Unavailable']);
  for (const control of ['New Schedule', 'Save Schedule']) await expect(page.getByRole('button', { name: control })).toBeDisabled();
  await sectionTab('Permissions').click();
  await expect(page.locator('.workflow-collaborator')).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expect(emptyStates).toHaveText([
    /per-workflow roles are not stored/, 'No workflow-level grants are stored.', 'No protection rules are stored for this workflow.',
  ]);
  await expect(page.getByLabel('Minimum reviewers')).toHaveText('Unavailable');
  for (const control of ['Invite Member', 'Save Permissions']) await expect(page.getByRole('button', { name: control })).toBeDisabled();
  for (const text of fixtureOnlyText) await expect(page.locator('.workflow-page')).not.toContainText(text);
  await sectionTab('Builder').click();
  await page.getByRole('button', { name: 'Workflow menu' }).click();
  await expect(page.getByRole('menuitem', { name: renamedWorkflow })).toHaveAttribute('aria-current', 'true');
  await page.getByRole('menuitem', { name: seededWorkflow }).click();
  await expect(page.getByRole('heading', { name: `Workflow Builder — ${seededWorkflow}` })).toBeVisible();
  await expect(page.locator('.workflow-canvas .workflow-node')).toHaveCount(10);
  await expect(page.getByRole('textbox', { name: 'Node Name' })).toHaveValue('Agent Router');
  const dragHandle = page.getByRole('button', { name: 'Drag Agent Task to canvas' });
  const source = await dragHandle.boundingBox();
  const canvas = await page.locator('.workflow-canvas').boundingBox();
  expect(source).not.toBeNull();
  expect(canvas).not.toBeNull();
  const dropPoint = { x: canvas!.x + canvas!.width / 2, y: canvas!.y + canvas!.height / 2 };
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
  await page.mouse.down();
  await page.mouse.move(dropPoint.x, dropPoint.y, { steps: 8 });
  await page.mouse.up();
  const droppedNodes = page.locator('.workflow-canvas .workflow-node').filter({ hasText: 'Agent Task' });
  await expect(droppedNodes).toHaveCount(2);
  const droppedNode = droppedNodes.last();
  await expect.poll(async () => {
    const bounds = await droppedNode.boundingBox();
    if (!bounds) return false;
    return Math.abs(bounds.x + bounds.width / 2 - dropPoint.x) < 30 &&
      Math.abs(bounds.y + bounds.height / 2 - dropPoint.y) < 30;
  }).toBe(true);
  await expect(page.locator('.workflow-canvas .workflow-node')).toHaveCount(11);
  await expect(page.locator('.workflow-properties .workflow-subheading h3')).toHaveText('Agent Task');
  const splitter = page.getByRole('separator');
  await expect(splitter).toHaveAttribute('tabindex', '0');
  const separatorBox = await splitter.boundingBox();
  const previewBeforeResize = await page.locator('.workflow-run-preview').boundingBox();
  expect(separatorBox).not.toBeNull();
  expect(previewBeforeResize).not.toBeNull();
  await page.mouse.move(separatorBox!.x + separatorBox!.width / 2, separatorBox!.y + separatorBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(separatorBox!.x + separatorBox!.width / 2, separatorBox!.y - 32, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await page.locator('.workflow-run-preview').boundingBox())?.height ?? 0)
    .toBeGreaterThan(previewBeforeResize!.height + 20);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.workflow-mobile-header')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Workflow mobile sections' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workflow Orchestration' })).toBeVisible();
  await expect(page.locator('.workflow-mobile-eyebrow')).toHaveText('Workflow');
  await expect(page.locator('.workflow-mobile-description')).toHaveText(seededWorkflow);
  await expect(page.locator('.workflow-mobile-status')).toHaveText(/^(Draft|Active)$/);
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.locator('.workflow-editor')).toBeHidden();
  await expect(page.locator('.workflow-properties')).toBeHidden();
  await expect(page.locator('.workflow-toolbar')).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Workflow sections' })).toBeHidden();
  await expect(page.locator('.workflow-mobile-overview .workflow-overview-canvas')).toBeVisible();
  await expect(page.locator('.workflow-mobile-overview .panel-heading')).toBeHidden();
  await expect(page.locator('.workflow-mobile-run-preview')).toBeVisible();
  const mobileNodes = page.locator('.workflow-mobile-overview .workflow-node');
  await expect(mobileNodes).toHaveCount(6);
  expect(await mobileNodes.locator('b').allTextContents()).toEqual(['Trigger', 'Plan', 'Build', 'Test', 'Review', 'Merge']);
  await expect(page.locator('.workflow-mobile-overview .workflow-overview-canvas'))
    .toHaveAttribute('aria-label', /6 stages summarize 10 components/);
  await expect(page.locator('.workflow-mobile-overview .react-flow__edge-path').first()).toHaveAttribute('marker-end', /url/);
  expect(await mobileNodes.evaluateAll((nodes) => {
    const canvas = nodes[0].closest('.workflow-overview-canvas')!.getBoundingClientRect();
    const boxes = nodes.map((node) => node.getBoundingClientRect());
    return boxes.every((box, index) => box.left >= canvas.left && box.right <= canvas.right &&
      box.top >= canvas.top && box.bottom <= canvas.bottom && boxes.slice(index + 1).every((other) =>
        box.right <= other.left || box.left >= other.right || box.bottom <= other.top || box.top >= other.bottom));
  })).toBe(true);
  const runSummary = page.locator('.workflow-mobile-run-summary');
  await expect(runSummary).toContainText('10 components · 10 connections · runner not connected');
  await expect(runSummary.locator('.workflow-mobile-idle')).toHaveText('Not run');
  expect(await runSummary.locator('.workflow-mobile-idle').evaluate((badge) => badge.scrollWidth <= badge.clientWidth),
    'the run state badge is not clipped').toBe(true);
  await expect(page.locator('.workflow-mobile-run-progress')).toHaveCount(0);
  await expect(page.locator('.workflow-mobile-run-task')).toHaveCount(6);
  await expect(page.locator('.workflow-mobile-run-task small')).toHaveText(Array.from({ length: 6 }, () => 'Not run'));
  await expect(page.locator('.workflow-mobile-run-task.complete, .workflow-mobile-run-task.active')).toHaveCount(0);
  const approvalsCard = page.locator('.workflow-mobile-run-approvals');
  await expect(approvalsCard.locator('.workflow-mobile-approval-row')).toHaveText(/Human Approval\s*Not requested/);
  await expect(approvalsCard.getByRole('button')).toHaveCount(0);
  await approvalsCard.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  const approvals = await approvalsCard.boundingBox();
  const mobileNavigation = await page.locator('.sidebar nav').boundingBox();
  if (!approvals || !mobileNavigation) throw new Error('Mobile approval or navigation bounds are unavailable');
  expect(approvals.y + approvals.height).toBeLessThanOrEqual(mobileNavigation.y);
  const mobileGraphLabelSize = await page.locator('.workflow-mobile-overview .workflow-overview-canvas .workflow-node b').first()
    .evaluate((label) => {
      const viewport = label.closest('.react-flow__viewport');
      return viewport && parseFloat(getComputedStyle(label).fontSize) * new DOMMatrix(getComputedStyle(viewport).transform).a;
    });
  expect(mobileGraphLabelSize).toBeGreaterThanOrEqual(7);
  await page.getByRole('button', { name: 'Approvals', exact: true }).click();
  await expect(page.locator('#workflow-mobile-run-approvals')).toBeInViewport();
  for (const text of ['Run #8821', '78%', 'Platform Lead', 'Ship AI code review v2']) {
    await expect(page.locator('.workflow-page')).not.toContainText(text);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'the Live phone layout has no horizontal scroll').toBe(true);
});

test('Live workflows report failed loads, empty lists, and failed saves without fixtures or stray writes', async ({ page }) => {
  await page.addInitScript(() => {
    if (!crypto.randomUUID) Object.defineProperty(Crypto.prototype, 'randomUUID', {
      value: () => crypto.getRandomValues(new Uint32Array(4)).join('-'),
    });
  });
  await useLocalSession(page);
  const saved = {
    id: 'a'.repeat(32), name: 'Release checks', description: 'Gate a release.', status: 'draft', version: 3,
    updated_at: '2026-11-02T10:00:00Z',
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', description: 'Start this workflow' } },
      { id: 'gate', type: 'merge-gate', position: { x: 0, y: 0 }, data: { label: 'Merge Gate', description: 'Apply policy checks' } },
    ],
    edges: [{ id: 'e-trigger-gate', source: 'trigger', target: 'gate', label: '' }],
  };
  let list: { status: number; body: string } = { status: 500, body: 'store unavailable' };
  const writes: string[] = [];
  await page.route('**/api/v1/workflows**', (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ ...list, contentType: 'application/json' });
    writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return request.method() === 'POST'
      ? route.fulfill({ status: 400, body: 'workflow name or description is invalid' })
      : route.fulfill({ status: 400, body: 'workflow graph is invalid' });
  });
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#workflows');
  await expect(page.locator('.workflow-page').getByRole('alert')).toHaveText('Workflow list failed: 500', { timeout: 30_000 });
  await expect(page.locator('.workflow-canvas')).toHaveCount(0);
  await expect(page.locator('.workflow-page')).not.toContainText(seededWorkflow);

  list = { status: 200, body: '[]' };
  await page.reload();
  await expect(page.locator('.workflow-page').getByRole('alert')).toHaveText('No workflows available');
  await expect(page.locator('.workflow-canvas')).toHaveCount(0);

  list = { status: 200, body: JSON.stringify([saved]) };
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Workflow Builder — Release checks' })).toBeVisible();
  await expect(page.locator('.workflow-version')).toHaveText(/^v3 \(Draft\)/);
  await expect(page.locator('.workflow-canvas .workflow-node')).toHaveCount(2);
  await expect(page.getByText('Select a node on the canvas to edit it.'), 'a graph without an Agent Router opens unselected').toBeVisible();
  await expect(page.locator('.workflow-canvas .workflow-preview-edge-merge-gate')).toHaveCount(1);
  for (const text of fixtureOnlyText) await expect(page.locator('.workflow-page')).not.toContainText(text);

  await page.locator('.workflow-canvas .workflow-node.merge-gate').click();
  await page.getByRole('button', { name: 'Component options' }).click();
  await page.getByRole('menuitem', { name: 'Delete component' }).click();
  await expect(page.locator('.workflow-canvas .workflow-node')).toHaveCount(1);
  await expect(page.locator('.workflow-canvas .react-flow__edge')).toHaveCount(0);
  await page.locator('.workflow-canvas .workflow-node.trigger').click();
  await page.getByRole('button', { name: 'Component options' }).click();
  await page.getByRole('menuitem', { name: 'Delete component' }).click();
  await page.getByRole('button', { name: 'Validate', exact: true }).click();
  await expect(page.locator('.workflow-status')).toContainText('Add a Trigger and connect every edge to an existing node');
  await expect(page.locator('.workflow-status')).toHaveClass(/workflow-status-error/);
  expect(writes).toEqual([]);

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const status = page.locator('.workflow-status');
  await expect(status).toContainText('workflow graph is invalid');
  await expect(status).toHaveClass(/workflow-status-error/);
  await expect(status.locator('span')).toHaveCSS('white-space', 'normal');
  await expect(page.locator('.workflow-version')).toHaveText(/^v3 \(Draft\)/);
  expect(writes).toEqual([`PUT /api/v1/workflows/${saved.id}`]);

  await chooseFromWorkflowMenu(page, 'New workflow…');
  const createDialog = page.getByRole('dialog', { name: 'New Workflow' });
  await createDialog.getByLabel('Workflow name').fill('Rejected');
  await createDialog.getByRole('button', { name: 'Create workflow' }).click();
  await expect(createDialog.getByRole('alert')).toHaveText('workflow name or description is invalid');
  await expect(createDialog).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workflow Builder — Release checks' })).toBeVisible();
  expect(writes).toEqual([`PUT /api/v1/workflows/${saved.id}`, 'POST /api/v1/workflows']);
});
