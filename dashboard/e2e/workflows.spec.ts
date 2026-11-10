import { expect, test } from '@playwright/test';

test('local Workflow Builder mock preview uses its fixture without API reads or writes', async ({ page }) => {
  const workflowRequests: string[] = [];
  await page.route('**/api/v1/workflows**', (route) => {
    workflowRequests.push(route.request().method());
    return route.fulfill({ status: 401, body: 'authentication required' });
  });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 401, body: 'authentication required' }));
  await page.setViewportSize({ width: 1672, height: 941 });
  const previewURL = new URL('/#workflows', test.info().project.use.baseURL ?? 'http://127.0.0.1:4173');
  previewURL.hostname = '127.0.0.1';
  await page.goto(previewURL.toString());

  await expect(page.getByRole('heading', { name: /Workflow Builder — PR Review & Release Orchestration/ })).toBeVisible();
  await expect(page.locator('.workflow-page-heading .eyebrow')).toContainText('Workflows');
  await expect(page.getByRole('group', { name: 'Canvas tools' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Workflow' })).toBeHidden();
  await expect(page.getByRole('button', { name: /Custom Block/ })).toBeEnabled();
  await expect(page.locator('.workflow-canvas .workflow-node')).toHaveCount(11);
  await expect(page.locator('.workflow-canvas .workflow-node.condition')).toContainText('Coverage ≥ 80% and tests pass');
  await expect(page.locator('.workflow-canvas .workflow-node.condition .workflow-node-icon')).toHaveCSS('color', 'rgb(67, 221, 166)');
  const retry = page.locator('.workflow-canvas .workflow-node.loop');
  await expect(retry).toContainText('Retry (max 2)');
  await expect(retry).toContainText('On failure');
  const retryBounds = await retry.boundingBox();
  const buildBounds = await page.locator('.workflow-canvas .workflow-node.agent-router').boundingBox();
  expect(retryBounds && buildBounds && retryBounds.y).toBeLessThan(buildBounds!.y);
  const retryEdges = page.locator('.workflow-canvas .workflow-loop-edge .react-flow__edge-path');
  await expect(retryEdges).toHaveCount(4);
  expect(await retryEdges.first().evaluate((path) => getComputedStyle(path).strokeDasharray)).not.toBe('none');
  const canvas = page.locator('.workflow-canvas .react-flow');
  await expect(canvas).toHaveCSS('background-color', 'rgb(11, 11, 20)');
  await expect(canvas).toHaveCSS('background-image', /radial-gradient/);
  await expect(canvas).toHaveCSS('background-size', '20px 20px');
  await expect(page.locator('.workflow-canvas .react-flow__background')).toHaveCount(0);
  const branchNodes = await Promise.all(['code-reviewer', 'test-generator', 'coverage-analyzer']
    .map((kind) => page.locator(`.workflow-canvas .workflow-node.${kind}`).boundingBox()));
  expect(branchNodes.every(Boolean)).toBe(true);
  expect(branchNodes[0]!.y).toBeLessThan(branchNodes[1]!.y);
  expect(branchNodes[1]!.y).toBeLessThan(branchNodes[2]!.y);
  await expect(page.getByRole('textbox', { name: 'Node Name' })).toHaveValue('Agent Router');
  await expect(page.locator('.workflow-status')).toContainText('Design preview · changes are not saved');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New Workflow' })).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Agent Router settings' })).toContainText('Properties');
  await expect(page.getByRole('region', { name: 'Routing Parameters' })).toContainText('Code Reviewer');
  await expect(page.getByRole('region', { name: 'Budgets and limits' })).toContainText('$ 0.020');
  await expect(page.getByRole('region', { name: 'Retry Rules' })).toContainText('Exponential');
  await expect(page.getByRole('region', { name: 'Execution Conditions' })).toContainText('pr.changed_files_count');
  await expect(page.getByRole('region', { name: 'Simulated run timeline' })).toContainText('PR #4827');
  await expect(page.locator('.workflow-simulated-summary')).toContainText('$0.038');
  await page.getByRole('tab', { name: 'Logs' }).click();
  await expect(page.getByRole('region', { name: 'Illustrative run logs' })).toContainText('Trigger received');
  await page.getByRole('tab', { name: 'Outputs' }).click();
  await expect(page.getByRole('region', { name: 'Illustrative run outputs' })).toContainText('coverage.percent');
  await page.getByRole('tab', { name: 'Artifacts' }).click();
  await expect(page.getByRole('region', { name: 'Illustrative run artifacts' })).toContainText('coverage-summary.json');
  await page.getByRole('tab', { name: 'Execution Graph' }).click();
  const inspectorFits = await page.locator('.workflow-properties').evaluate((panel) =>
    panel.scrollHeight <= panel.clientHeight);
  expect(inspectorFits).toBe(true);
  const retrySwitch = page.getByRole('switch', { name: 'Retry Rules' });
  await retrySwitch.click();
  await expect(retrySwitch).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.workflow-preview-retry')).toContainText('Off');
  const conditionsSwitch = page.getByRole('switch', { name: 'Execution Conditions' });
  await conditionsSwitch.click();
  await expect(conditionsSwitch).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.workflow-preview-expression')).toHaveText('Execution conditions disabled');
  const addRule = page.getByRole('button', { name: 'Add Rule' });
  await addRule.click();
  await expect(page.getByRole('textbox', { name: 'New routing condition 1' })).toBeVisible();
  await page.getByRole('textbox', { name: 'New routing condition 1' }).fill('changes.contains("*.ts")');
  await addRule.click();
  await expect(page.getByRole('textbox', { name: 'New routing condition 2' })).toBeVisible();
  await page.getByRole('button', { name: /Custom Block/ }).click();
  await expect(page.locator('.workflow-canvas .workflow-node')).toHaveCount(12);
  const sections = [
    ['Runs', 'Run History & Execution Monitoring'],
    ['Versions', 'Workflow Versions'],
    ['Schedules', 'Schedules & Triggers'],
    ['Permissions', 'Workflow Permissions'],
    ['Settings', 'Workflow Settings'],
  ];
  for (const [section, title] of sections) {
    const tab = page.getByRole('navigation', { name: 'Workflow sections' })
      .getByRole('button', { name: section, exact: true });
    await expect(tab).toBeEnabled();
    await tab.click();
    await expect(page.locator('.workflow-section-preview-title h2')).toHaveText(title);
    await expect(page.locator('.workflow-section-concept')).toHaveText('CONCEPT · ILLUSTRATIVE DATA');
    await expect(tab).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.workflow-section-meta')).toContainText('v2.4.0');
    await expect(page.locator('.workflow-section-meta')).toContainText('11 Nodes');
    await expect(page.locator('.workflow-section-meta')).toContainText('3 Agent Profiles');
    await expect(page.getByRole('button', { name: 'Validate', exact: true })).toHaveCount(0);
    if (section === 'Runs') {
      expect((await page.locator('.workflow-run-columns').boundingBox())?.height).toBe(404);
      const runWorkflow = page.getByRole('button', { name: 'Run Workflow' });
      const reviewApproval = page.getByRole('button', { name: 'Review Approval' });
      await expect(runWorkflow).toBeDisabled();
      await expect(reviewApproval).toBeDisabled();
      await expect(runWorkflow).toHaveCSS('background-image', /linear-gradient/);
      await expect(reviewApproval).toHaveCSS('background-image', /linear-gradient/);
    }
    if (section === 'Permissions') await expect(page.locator('.workflow-collaborator')).toHaveCount(4);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [section, title] of sections) {
    await page.getByRole('navigation', { name: 'Workflow sections' })
      .getByRole('button', { name: section, exact: true }).click();
    await expect(page.locator('.workflow-section-preview-title h2')).toHaveText(title);
    if (section === 'Runs') {
      await expect(page.locator('.workflow-table-row').first()).toHaveCSS('font-size', '9px');
      const status = page.locator('.workflow-table-row .mantine-Badge-root').first();
      await expect(status).toHaveCSS('font-size', '8px');
      expect(await status.evaluate((badge) => badge.scrollWidth <= badge.clientWidth),
        'phone status badge stays fully visible').toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${section} preview fits the phone viewport`).toBe(true);
  }
  expect(workflowRequests).toEqual([]);
});

test('workflow graph can be edited and saved to the control plane', async ({ page }) => {
  await page.addInitScript(() => {
    if (!crypto.randomUUID) Object.defineProperty(Crypto.prototype, 'randomUUID', {
      value: () => crypto.getRandomValues(new Uint32Array(4)).join('-'),
    });
  });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: true, login: 'Local workspace' }),
  }));
  await page.route('**/api/v1/workflows**', (route) => {
    const apiURL = new URL(route.request().url());
    apiURL.port = '8083';
    return route.continue({ url: apiURL.toString() });
  });
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/');
  await page.getByRole('link', { name: 'Workflows' }).click();
  await expect(page.getByRole('heading', { name: /Workflow Builder — PR Review & Release Orchestration/ })).toBeVisible();
  await expect(page.locator('.workflow-mobile-details')).toBeHidden();
  const mockTitleBox = await page.locator('.workflow-page-heading .page-heading h2').boundingBox();
  const mockToolbarBox = await page.locator('.workflow-toolbar').boundingBox();
  expect(mockTitleBox?.height).toBeLessThan(30);
  expect(mockTitleBox && mockToolbarBox && Math.abs(mockTitleBox.y - mockToolbarBox.y)).toBeLessThan(16);
  await expect(page.getByRole('combobox', { name: 'Workflow' })).toHaveValue('PR Review & Release Orchestration');
  await expect(page.getByRole('textbox', { name: 'Node Name' })).toHaveValue('Agent Router');
  await expect(page.getByRole('textbox', { name: 'Type' })).toHaveValue('Agent Router');
  await expect(page.getByRole('textbox', { name: 'Type' })).toHaveAttribute('readonly', '');
  await expect(page.getByRole('region', { name: 'Basic configuration' })).toBeVisible();
  await expect(page.locator('.workflow-properties .workflow-subheading h3')).toHaveText('Agent Router');
  await expect(page.getByLabel('Name', { exact: true })).toBeHidden();
  await page.getByText('Workflow settings', { exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('PR Review & Release Orchestration');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCSS('background-color', 'rgb(103, 65, 217)');
  await expect(page.locator('.workflow-run-preview')).toContainText('Execution preview unavailable');
  await expect(page.locator('.workflow-preview-summary')).toContainText('Components 9');
  await expect(page.locator('.workflow-preview-summary')).toContainText('Connections 10');
  await expect(page.locator('.workflow-component-add').filter({ hasText: 'Trigger' }))
    .toContainText('Start on a pull request or event');
  await expect(page.locator('.workflow-component-icon.trigger svg')).toBeVisible();
  await expect(page.locator('.workflow-component-icon.trigger')).toHaveCSS('color', 'rgb(84, 216, 208)');
  expect((await page.locator('.workflow-component-row').first().boundingBox())?.height).toBeGreaterThanOrEqual(46);
  expect(await page.locator('.workflow-component-copy small').first().evaluate((description) =>
    description.scrollHeight <= description.clientHeight)).toBe(true);
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
  const workflowNode = await page.locator('.workflow-canvas .workflow-node').first().boundingBox();
  await expect(page.locator('.workflow-canvas .workflow-node.trigger .workflow-node-icon')).toHaveCSS('color', 'rgb(84, 216, 208)');
  await expect(page.locator('.workflow-canvas .workflow-node.planner .workflow-node-icon')).toHaveCSS('color', 'rgb(125, 185, 255)');
  await expect(page.locator('.workflow-canvas .workflow-node.human-approval .workflow-node-icon')).toHaveCSS('color', 'rgb(67, 221, 166)');
  expect(await page.locator('.workflow-canvas .workflow-node.trigger').evaluate((node) => getComputedStyle(node).boxShadow))
    .toContain('84, 216, 208');
  await expect(page.locator('.workflow-canvas .react-flow__node.selected .workflow-node'))
    .toHaveCSS('outline-color', 'rgb(195, 139, 255)');
  await expect(page.locator('.workflow-canvas .react-flow__edge-path').first())
    .toHaveCSS('stroke', 'rgb(201, 154, 255)');
  const miniMap = await page.locator('.workflow-canvas .react-flow__minimap').boundingBox();
  const flowControls = await page.locator('.workflow-canvas .react-flow__controls').boundingBox();
  const attribution = page.locator('.workflow-canvas .react-flow__attribution');
  const attributionBox = await attribution.boundingBox();
  await expect(attribution).toBeVisible();
  expect(attributionBox && canvasPanel && attributionBox.y).toBeGreaterThan(canvasPanel!.y + canvasPanel!.height / 2);
  expect(attributionBox && miniMap && attributionBox.x + attributionBox.width).toBeLessThan(miniMap!.x);
  expect(workflowNode?.height).toBeGreaterThanOrEqual(54);
  expect(workflowNode?.height).toBeLessThanOrEqual(72);
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
  expect(flowControls?.x).toBeGreaterThan((workflowNode?.x ?? 0) + (workflowNode?.width ?? 0));
  const editorStatus = await page.locator('.workflow-status').boundingBox();
  expect(canvasPanel && editorStatus && editorStatus.y + editorStatus.height)
    .toBeLessThanOrEqual(canvasPanel!.y + canvasPanel!.height);
  await page.getByRole('button', { name: 'Auto layout' }).click();
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
  await expect(page.getByRole('navigation', { name: 'Workflow sections' })
    .getByRole('button', { name: 'Runs' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
  const paletteSearch = page.getByRole('textbox', { name: 'Search blocks' });
  await paletteSearch.fill('coverage');
  await expect(page.locator('.workflow-component-row')).toHaveCount(1);
  await expect(page.locator('.workflow-component-row')).toContainText('Coverage Analyzer');
  await paletteSearch.fill('no matching block');
  await expect(page.locator('.workflow-palette-empty')).toHaveText('No blocks match your search.');
  await paletteSearch.fill('');
  await expect(page.locator('.workflow-component-list button').filter({ hasText: 'Trigger' })).toBeVisible();
  await expect.poll(() => page.locator('.workflow-canvas .workflow-node').evaluateAll((nodes) => nodes.every((node) => {
    const box = node.getBoundingClientRect();
    const canvas = node.closest('.workflow-canvas')?.getBoundingClientRect();
    return canvas && box.right > canvas.left && box.left < canvas.right &&
      box.bottom > canvas.top && box.top < canvas.bottom;
  }))).toBe(true);
  const addAgentTask = page.locator('.workflow-component-add').filter({ hasText: 'Agent Task' });
  await addAgentTask.click();
  await expect(page.locator('.workflow-canvas .workflow-node')).toHaveCount(10);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/Saved v\d+/)).toBeVisible();
  await page.locator('.workflow-canvas .workflow-node').filter({ hasText: 'Trigger' }).click();
  const workflowName = `E2E workflow ${Date.now()}`;
  await page.getByRole('button', { name: 'New Workflow' }).click();
  const createDialog = page.getByRole('dialog', { name: 'New Workflow' });
  await createDialog.getByLabel('Workflow name').fill(workflowName);
  await createDialog.getByLabel('Description').fill('Created from the workflow builder.');
  await createDialog.getByRole('button', { name: 'Create workflow' }).click();
  await expect(page.getByRole('combobox', { name: 'Workflow' })).toHaveValue(workflowName);
  await expect(page.getByText('Version  1  · saved to local control plane')).toBeVisible();
  await expect(page.getByText('Select a node on the canvas to edit it.')).toBeVisible();
  await expect(page.locator('.workflow-canvas .workflow-node')).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Workflow' }).click();
  await page.getByRole('option', { name: 'PR Review & Release Orchestration' }).click();
  await expect(page.getByRole('combobox', { name: 'Workflow' })).toHaveValue('PR Review & Release Orchestration');
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
  await expect(page.getByRole('navigation', { name: 'Workflow mobile sections' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workflow Orchestration' })).toBeVisible();
  await expect(page.locator('.topbar .greeting')).toBeHidden();
  await expect(page.locator('.workflow-editor')).toBeHidden();
  await expect(page.locator('.workflow-properties')).toBeHidden();
  await expect(page.locator('.workflow-save')).toBeVisible();
  await expect(page.locator('.workflow-mobile-overview .workflow-overview-canvas')).toBeVisible();
  await expect(page.locator('.workflow-mobile-overview .panel-heading')).toBeHidden();
  await expect(page.locator('.workflow-mobile-overview .workflow-overview-status')).toBeHidden();
  await expect(page.locator('.workflow-mobile-details')).toBeVisible();
  const mobileNodes = page.locator('.workflow-mobile-overview .workflow-node');
  await expect(mobileNodes).toHaveCount(6);
  expect(await mobileNodes.locator('b').allTextContents()).toEqual(['Trigger', 'Plan', 'Build', 'Test', 'Review', 'Merge']);
  await expect(page.locator('.workflow-mobile-overview .workflow-overview-canvas'))
    .toHaveAttribute('aria-label', /6 stages summarize 10 components/);
  expect(await mobileNodes.evaluateAll((nodes) => {
    const canvas = nodes[0].closest('.workflow-overview-canvas')!.getBoundingClientRect();
    const boxes = nodes.map((node) => node.getBoundingClientRect());
    return boxes.every((box, index) => box.left >= canvas.left && box.right <= canvas.right &&
      box.top >= canvas.top && box.bottom <= canvas.bottom && boxes.slice(index + 1).every((other) =>
        box.right <= other.left || box.left >= other.right || box.bottom <= other.top || box.top >= other.bottom));
  })).toBe(true);
  await expect(page.getByRole('region', { name: 'Task progress' })).toContainText('Not run');
  await expect(page.locator('.workflow-mobile-task-row')).toHaveCount(6);
  await expect(page.getByRole('region', { name: 'Approvals' })).toContainText('Human approval');
  await expect(page.getByRole('region', { name: 'Approvals' })).toContainText('Not requested');
  const approvalsRegion = page.getByRole('region', { name: 'Approvals' });
  await approvalsRegion.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  const approvals = await approvalsRegion.boundingBox();
  const mobileNavigation = await page.locator('.sidebar nav').boundingBox();
  if (!approvals || !mobileNavigation) throw new Error('Mobile approval or navigation bounds are unavailable');
  expect(approvals.y + approvals.height).toBeLessThanOrEqual(mobileNavigation.y);
  const mobileGraphLabelSize = await page.locator('.workflow-mobile-overview .workflow-overview-canvas .workflow-node b').first()
    .evaluate((label) => {
      const viewport = label.closest('.react-flow__viewport');
      return viewport && parseFloat(getComputedStyle(label).fontSize) * new DOMMatrix(getComputedStyle(viewport).transform).a;
    });
  expect(mobileGraphLabelSize).toBeGreaterThanOrEqual(7);
  await expect(page.locator('.workflow-mobile-summary')).toContainText('Not run');
  await expect(page.locator('.workflow-mobile-summary')).toContainText('Runner not connected');
  const toolbarFits = await page.locator('.workflow-toolbar').evaluate((toolbar) =>
    toolbar.getBoundingClientRect().right <= window.innerWidth && toolbar.scrollWidth <= toolbar.clientWidth,
  );
  expect(toolbarFits).toBe(true);
});
