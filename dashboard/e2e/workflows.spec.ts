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
  for (const component of ['Condition', 'Loop']) {
    await expect(page.locator('.workflow-palette .workflow-component-add').filter({ hasText: component })).toBeVisible();
  }
  const paletteCategories = page.getByRole('group', { name: 'Component categories' });
  await expect(paletteCategories.getByRole('button')).toHaveText(['All', 'Agents', 'Actions', 'Control', 'Integrations']);
  await expect(paletteCategories.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  await paletteCategories.getByRole('button', { name: 'Agents' }).click();
  await expect(page.locator('.workflow-component-row')).toHaveCount(6);
  await expect(page.locator('.workflow-component-add').filter({ hasText: 'Trigger' })).toBeHidden();
  await paletteCategories.getByRole('button', { name: 'Actions' }).click();
  await expect(page.locator('.workflow-component-row')).toHaveCount(4);
  await expect(page.locator('.workflow-component-add').filter({ hasText: 'Trigger' })).toBeVisible();
  await paletteCategories.getByRole('button', { name: 'Control' }).click();
  await expect(page.locator('.workflow-component-row')).toHaveCount(4);
  await expect(page.locator('.workflow-component-add').filter({ hasText: 'Human Approval' })).toBeVisible();
  await paletteCategories.getByRole('button', { name: 'Integrations' }).click();
  await expect(page.locator('.workflow-component-row')).toHaveCount(1);
  await expect(page.locator('.workflow-component-add').filter({ hasText: 'Publish Report' })).toBeVisible();
  await paletteCategories.getByRole('button', { name: 'All' }).click();
  const integrationsGroup = page.getByRole('button', { name: 'Toggle Integrations' });
  const publishReport = page.locator('.workflow-palette .workflow-component-add').filter({ hasText: 'Publish Report' });
  await expect(integrationsGroup).toHaveAttribute('aria-expanded', 'false');
  await expect(publishReport).toBeHidden();
  await integrationsGroup.click();
  await expect(publishReport).toBeVisible();
  await integrationsGroup.click();
  await expect(publishReport).toBeHidden();
  await page.getByRole('textbox', { name: 'Search blocks' }).fill('publish report');
  await expect(publishReport).toBeVisible();
  await expect(integrationsGroup).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('textbox', { name: 'Search blocks' }).fill('');
  await expect(integrationsGroup).toHaveAttribute('aria-expanded', 'false');
  expect(await page.locator('.workflow-palette').evaluate((palette) => palette.scrollHeight <= palette.clientHeight),
    'the reference component list fits in the desktop palette without scrolling').toBe(true);
  await expect(page.locator('.workflow-canvas .workflow-node')).toHaveCount(11);
  await expect(page.locator('.workflow-canvas .workflow-node.publish-report')).toContainText('Publish Report');
  await expect(page.locator('.workflow-canvas .workflow-node.condition')).toContainText('Coverage ≥ 80% and tests pass');
  await expect(page.locator('.workflow-canvas .workflow-node.code-reviewer')).toContainText('Analyze changes & provide review');
  await expect(page.locator('.workflow-canvas .workflow-node.condition .workflow-node-icon')).toHaveCSS('color', 'rgb(67, 221, 166)');
  await expect(page.locator('.workflow-canvas .workflow-node.trigger')).toHaveCSS('border-top-color', 'rgb(84, 216, 208)');
  expect(await page.locator('.workflow-canvas .workflow-node.loop').evaluate((node) => getComputedStyle(node, '::after').content)).toBe('\"✓\"');
  expect(await page.locator('.workflow-canvas .workflow-node.loop').evaluate((node) => getComputedStyle(node, '::after').width)).toBe('20px');
  await expect(page.getByRole('button', { name: 'Reset canvas zoom' })).toHaveText('100%');
  expect(await page.locator('.workflow-canvas .react-flow').evaluate((canvas) => {
    const bounds = canvas.getBoundingClientRect();
    return [...canvas.querySelectorAll('.workflow-node')].every((node) => {
      const box = node.getBoundingClientRect();
      return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
    });
  }), 'all mock workflow nodes fit inside the canvas at 100% zoom').toBe(true);
  const retry = page.locator('.workflow-canvas .workflow-node.loop');
  await expect(retry).toContainText('Retry (max 2)');
  await expect(retry).toContainText('On failure');
  const retryTitleFit = await retry.locator('b').evaluate((title) => {
    const range = document.createRange();
    range.selectNodeContents(title);
    const text = range.getBoundingClientRect();
    const node = title.closest('.workflow-node')!.getBoundingClientRect();
    const marker = { left: node.right - 24, right: node.right - 4, top: node.top + 4, bottom: node.top + 24 };
    return { clears: text.right <= marker.left || text.left >= marker.right || text.bottom <= marker.top || text.top >= marker.bottom,
      width: node.width };
  });
  expect(retryTitleFit.clears, JSON.stringify(retryTitleFit)).toBe(true);
  const retryBounds = await retry.boundingBox();
  expect(retryBounds?.width).toBeGreaterThan(150);
  const buildBounds = await page.locator('.workflow-canvas .workflow-node.agent-router').boundingBox();
  expect(retryBounds && buildBounds && retryBounds.y).toBeLessThan(buildBounds!.y);
  const triggerBounds = await page.locator('.workflow-canvas .workflow-node.trigger').boundingBox();
  const reviewerBounds = await page.locator('.workflow-canvas .workflow-node.code-reviewer').boundingBox();
  const testBounds = await page.locator('.workflow-canvas .workflow-node.test-generator').boundingBox();
  const coverageBounds = await page.locator('.workflow-canvas .workflow-node.coverage-analyzer').boundingBox();
  expect(triggerBounds && triggerBounds.width).toBeGreaterThan(80);
  expect(triggerBounds && triggerBounds.height).toBeGreaterThan(85);
  expect(triggerBounds && triggerBounds.x).toBeGreaterThan(505);
  expect(triggerBounds && triggerBounds.x).toBeLessThan(525);
  expect(triggerBounds && triggerBounds.y).toBeGreaterThan(360);
  expect(triggerBounds && triggerBounds.y).toBeLessThan(378);
  expect(reviewerBounds?.width).toBe(128);
  expect(reviewerBounds && reviewerBounds.height).toBeLessThan(70);
  expect(coverageBounds?.height).toBe(68);
  expect(await page.locator('.workflow-canvas .workflow-node.code-reviewer b, .workflow-canvas .workflow-node.test-generator b')
    .evaluateAll((titles) => titles.every((title) => title.scrollWidth <= title.clientWidth && title.getBoundingClientRect().height < 12)),
  'branch node titles fit on one line like the reference').toBe(true);
  expect(reviewerBounds && testBounds && reviewerBounds.y + reviewerBounds.height).toBeLessThan(testBounds!.y);
  expect(testBounds && coverageBounds && coverageBounds.y - testBounds.y - testBounds.height).toBeGreaterThan(15);
  const retryEdges = page.locator('.workflow-canvas .workflow-loop-edge .react-flow__edge-path');
  await expect(retryEdges).toHaveCount(4);
  expect(await retryEdges.first().evaluate((path) => getComputedStyle(path).strokeDasharray)).not.toBe('none');
  await expect(page.locator('.workflow-canvas .workflow-preview-edge-code-reviewer .react-flow__edge-path').first())
    .toHaveCSS('stroke', 'rgb(195, 139, 255)');
  await expect(page.locator('.workflow-canvas .workflow-preview-edge-test-generator .react-flow__edge-path').first())
    .toHaveCSS('stroke', 'rgb(83, 221, 208)');
  await expect(page.locator('.workflow-canvas .workflow-preview-edge-condition .react-flow__edge-path').first())
    .toHaveCSS('stroke', 'rgb(67, 221, 166)');
  await expect(page.locator('.workflow-canvas .workflow-preview-edge-human-approval .react-flow__edge-path').first())
    .toHaveCSS('stroke', 'rgb(67, 221, 166)');
  await expect(page.locator('.workflow-canvas .workflow-preview-edge-merge-gate .react-flow__edge-path').first())
    .toHaveCSS('stroke', 'rgb(67, 221, 166)');
  await expect(page.locator('.workflow-canvas .workflow-preview-edge-planner .react-flow__edge-path').first())
    .toHaveCSS('stroke', 'rgb(196, 216, 255)');
  const canvas = page.locator('.workflow-canvas .react-flow');
  const palette = await page.locator('.workflow-palette').boundingBox();
  expect(Math.round(palette!.y)).toBe(202);
  expect(Math.round((await page.locator('.workflow-properties').boundingBox())!.y)).toBe(90);
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
  await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue(
    'Route work to the appropriate agents (review, test, coverage) based on the plan and PR context.',
  );
  const executionFlow = page.locator('.workflow-preview-execution-flow');
  await expect(executionFlow).toContainText('Execution Flow (v2.4.0)');
  await expect(executionFlow).toContainText('Ready to run · 7 nodes · Est. 2m 14s · Cost $0.038');
  await expect(executionFlow).toHaveCSS('position', 'absolute');
  await expect(executionFlow).toHaveCSS('pointer-events', 'none');
  const executionFlowBounds = await executionFlow.boundingBox();
  const canvasWrapBounds = await page.locator('.workflow-canvas-wrap').boundingBox();
  expect(executionFlowBounds?.width).toBe(260);
  expect(executionFlowBounds && canvasWrapBounds && executionFlowBounds.y).toBeGreaterThan(canvasWrapBounds!.y);
  expect(executionFlowBounds && canvasWrapBounds && executionFlowBounds.y + executionFlowBounds.height)
    .toBeLessThan(canvasWrapBounds!.y + canvasWrapBounds!.height);
  const attributionBounds = await page.locator('.workflow-canvas .react-flow__attribution').boundingBox();
  expect(attributionBounds && triggerBounds && attributionBounds.y).toBeLessThan(triggerBounds!.y);
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveCSS('background-color', 'rgb(19, 126, 96)');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCSS('background-color', 'rgb(37, 35, 51)');
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveCSS('background-image', /linear-gradient/);
  await page.getByRole('button', { name: 'Validate', exact: true }).click();
  await expect(page.locator('.workflow-status')).toContainText('Graph is valid');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.workflow-status')).toContainText('Simulated run shown');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.workflow-status')).toContainText('Draft acknowledged locally');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.locator('.workflow-status')).toContainText('Published in preview only');
  await page.getByRole('button', { name: 'Workflow version history' }).click();
  await page.getByRole('menuitem', { name: 'Open version history' }).click();
  await expect(page.locator('.workflow-section-preview-title h2')).toHaveText('Workflow Versions');
  await page.getByRole('navigation', { name: 'Workflow sections' }).getByRole('button', { name: 'Builder' }).click();
  await expect(page.getByRole('button', { name: 'New Workflow' })).toBeHidden();
  const routerTabs = page.getByRole('tablist', { name: 'Agent Router settings' });
  const routerTab = (name: string) => routerTabs.getByRole('tab', { name, exact: true });
  await expect(routerTab('Properties')).toHaveAttribute('aria-selected', 'true');
  await expect(routerTabs).toHaveCSS('border-radius', '8px');
  await expect(routerTab('Properties')).toHaveCSS('background-image', /linear-gradient/);
  await expect(routerTab('Properties')).toHaveCSS('border-radius', '5px');
  await expect(routerTab('Prompt')).toBeEnabled();
  await expect(routerTab('Variables')).toBeEnabled();
  await expect(routerTab('Advanced')).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Routing Parameters' })).toContainText('Code Reviewer');
  await expect(page.getByRole('region', { name: 'Budgets and limits' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Retry Rules' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Execution Conditions' })).toBeVisible();
  const propertiesFit = await page.locator('.workflow-properties').evaluate((panel) => panel.scrollHeight <= panel.clientHeight);
  expect(propertiesFit).toBe(true);
  await routerTab('Prompt').click();
  await expect(page.getByRole('region', { name: 'Illustrative router prompt' })).toContainText('best specialized agent');
  await routerTab('Variables').click();
  await expect(page.getByRole('region', { name: 'Illustrative router variables' })).toContainText('changed_files');
  await routerTab('Advanced').click();
  await expect(page.getByRole('region', { name: 'Budgets and limits' })).toContainText('$ 0.020');
  await expect(page.getByRole('region', { name: 'Retry Rules' })).toContainText('Exponential');
  await expect(page.getByRole('region', { name: 'Execution Conditions' })).toContainText('pr.changed_files_count');
  await routerTab('Properties').click();
  const simulateRun = page.getByRole('switch', { name: 'Simulate Run' });
  await expect(simulateRun).toHaveAttribute('aria-checked', 'true');
  await simulateRun.click();
  await expect(simulateRun).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('status').filter({ hasText: 'Simulation paused' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Logs' })).toBeDisabled();
  await simulateRun.click();
  await expect(simulateRun).toHaveAttribute('aria-checked', 'true');
  const runTimeline = page.getByRole('region', { name: 'Simulated run timeline' });
  await expect(runTimeline).toContainText('PR #4827');
  await expect(runTimeline.locator('.workflow-simulated-axis')).toContainText('Status');
  await expect(runTimeline.locator('.workflow-simulated-row')).toHaveCount(9);
  await expect(runTimeline.locator('.workflow-simulated-row-step')).toContainText([
    'Trigger', 'Planner', 'Agent Router', 'Code Reviewer (parallel)', 'Test Generator (parallel)',
    'Coverage Analyzer (parallel)', 'Human Approval', 'Merge Gate', 'Publish Report',
  ]);
  await expect(runTimeline.locator('.workflow-simulated-row-status')).toHaveText([
    '✓ Ready', '✓ Ready', '✓ Ready', '✓ Ready', '✓ Ready', '✓ Ready', '◷ Awaiting (manual)', '✓ Pending', '✓ Pending',
  ]);
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
  await routerTab('Advanced').click();
  const retrySwitch = page.getByRole('switch', { name: 'Retry Rules' });
  await retrySwitch.click();
  await expect(retrySwitch).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.workflow-preview-retry')).toContainText('Off');
  const conditionsSwitch = page.getByRole('switch', { name: 'Execution Conditions' });
  await conditionsSwitch.click();
  await expect(conditionsSwitch).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.workflow-preview-expression')).toHaveText('Execution conditions disabled');
  await routerTab('Properties').click();
  await page.getByRole('button', { name: 'Component options' }).click();
  await page.getByRole('menuitem', { name: 'Reset selection' }).click();
  await expect(page.getByRole('textbox', { name: 'Node Name' })).toHaveValue('Agent Router');
  const canvasWidthWithInspector = (await page.locator('.workflow-canvas-wrap').boundingBox())!.width;
  await page.getByRole('button', { name: 'Close component settings' }).click();
  await expect(page.locator('.workflow-properties')).toBeHidden();
  await expect(page.locator('.workflow-builder-layout')).toHaveClass(/workflow-inspector-closed/);
  const canvasWidthWithoutInspector = (await page.locator('.workflow-canvas-wrap').boundingBox())!.width;
  expect(canvasWidthWithoutInspector).toBeGreaterThan(canvasWidthWithInspector + 200);
  await page.locator('.workflow-canvas .workflow-node.code-reviewer').click();
  await expect(page.locator('.workflow-properties')).toBeVisible();
  await expect(page.locator('.workflow-properties .workflow-subheading h3')).toHaveText('Code Reviewer');
  const addRule = page.getByRole('button', { name: 'Add Rule' });
  await addRule.click();
  await expect(page.getByRole('textbox', { name: 'New routing condition 1' })).toBeVisible();
  await page.getByRole('textbox', { name: 'New routing condition 1' }).fill('changes.contains("*.ts")');
  await addRule.click();
  await expect(page.getByRole('textbox', { name: 'New routing condition 2' })).toBeVisible();
  await routerTab('Advanced').click();
  await expect(page.getByRole('switch', { name: 'Retry Rules' })).toHaveAttribute('aria-checked', 'false');
  await routerTab('Properties').click();
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
    const sectionActionIcon = section === 'Runs' ? 'player-play' : section === 'Versions' ? 'arrow-up' : section === 'Settings' ? '' : 'plus';
    const actionIcon = page.locator('.workflow-section-preview-title .mantine-Button-section svg');
    expect((await page.locator('.workflow-section-preview-title .mantine-Button-root').boundingBox())?.width).toBe(159);
    if (sectionActionIcon) await expect(actionIcon).toHaveClass(new RegExp(`tabler-icon-${sectionActionIcon}`));
    else await expect(actionIcon).toHaveCount(0);
    await expect(page.locator('.workflow-section-concept')).toHaveText('CONCEPT · ILLUSTRATIVE DATA');
    await expect(page.locator('.workflow-section-meta .workflow-section-concept')).toBeVisible();
    await expect(page.locator('.workflow-section-preview .workflow-section-concept')).toHaveCount(0);
    const metaBounds = await page.locator('.workflow-section-meta').boundingBox();
    const conceptBounds = await page.locator('.workflow-section-concept').boundingBox();
    expect(conceptBounds!.x + conceptBounds!.width).toBeGreaterThan(metaBounds!.x + metaBounds!.width - 8);
    await expect(tab).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.workflow-section-meta')).toContainText('v2.4.0');
    await expect(page.locator('.workflow-section-meta')).toContainText('8 Nodes');
    await expect(page.locator('.workflow-section-meta')).toContainText('3 Agent Profiles');
    await expect(page.getByRole('button', { name: 'Validate', exact: true })).toHaveCount(0);
    if (section === 'Runs') {
      const runColumns = await page.locator('.workflow-run-columns').boundingBox();
      const runHistory = await page.locator('.workflow-section-table').boundingBox();
      const runDetail = await page.locator('.workflow-run-detail').boundingBox();
      const runWorkflowBounds = await page.getByRole('button', { name: 'Run Workflow' }).boundingBox();
      expect(runColumns?.height).toBe(397);
      expect(runHistory?.height).toBe(397);
      expect(runDetail?.height).toBe(397);
      expect(runColumns!.y).toBeGreaterThanOrEqual(526);
      expect(runColumns!.y + runColumns!.height).toBeLessThanOrEqual(925);
      expect(runHistory!.width / runDetail!.width).toBeCloseTo(0.88, 1);
      expect(runWorkflowBounds?.width).toBe(159);
      await expect(page.locator('.workflow-run-metric b').first()).toHaveCSS('font-size', '32px');
      const runWorkflow = page.getByRole('button', { name: 'Run Workflow' });
      const exportLogs = page.getByRole('button', { name: /Export logs/ });
      const reviewApproval = page.getByRole('button', { name: 'Review Approval' });
      await expect(runWorkflow).toBeEnabled();
      await expect(exportLogs).toBeEnabled();
      await expect(reviewApproval).toBeEnabled();
      await expect(runWorkflow).toHaveCSS('background-image', /linear-gradient/);
      await expect(reviewApproval).toHaveCSS('background-image', /linear-gradient/);
      const logDownloadPromise = page.waitForEvent('download');
      await exportLogs.click();
      expect((await logDownloadPromise).suggestedFilename()).toBe('run-10428-preview.log');
      await runWorkflow.click();
      await expect(page.locator('.workflow-section-concept')).toHaveText('Run Workflow previewed · no workflow changes were saved');
    }
    if (section === 'Schedules') {
      const scheduleList = await page.locator('.workflow-schedule-list').boundingBox();
      const scheduleCalendar = await page.locator('.workflow-schedule-calendar').boundingBox();
      const firstSchedule = await page.locator('.workflow-schedule-row').first().boundingBox();
      expect(scheduleList!.width / scheduleCalendar!.width).toBeCloseTo(0.47, 1);
      expect(firstSchedule!.x).toBeCloseTo(280, 0);
      expect(firstSchedule!.y).toBeGreaterThanOrEqual(473);
      expect(firstSchedule!.y).toBeLessThanOrEqual(475);
      expect(firstSchedule!.width).toBeGreaterThanOrEqual(414);
      expect(firstSchedule!.height).toBeGreaterThanOrEqual(90);
      const rowIcons = page.locator('.workflow-schedule-row .workflow-section-icon svg');
      await expect(rowIcons).toHaveClass([
        /tabler-icon-file-text/, /tabler-icon-file-text/, /tabler-icon-file-text/, /tabler-icon-diamond/,
      ]);
      const firstScheduleSwitch = page.getByRole('switch', { name: 'Enable Weekday PR Quality Check' });
      await expect(firstScheduleSwitch).toHaveAttribute('aria-checked', 'true');
      await firstScheduleSwitch.click();
      await expect(firstScheduleSwitch).toHaveAttribute('aria-checked', 'false');
      const firstCalendarDay = await page.locator('.workflow-calendar-day').first().boundingBox();
      expect(firstCalendarDay!.x).toBeGreaterThanOrEqual(734);
      expect(firstCalendarDay!.x).toBeLessThanOrEqual(737);
      expect(firstCalendarDay!.y).toBeGreaterThanOrEqual(485);
      expect(firstCalendarDay!.y).toBeLessThanOrEqual(487);
      const firstEvent = await page.locator('.workflow-calendar-day').first().locator('span').first().boundingBox();
      expect(firstEvent!.y).toBeGreaterThanOrEqual(530);
      expect(firstEvent!.y).toBeLessThanOrEqual(533);
      const selectedScheduleName = await page.locator('.workflow-schedule-calendar .workflow-static-fields output').first().boundingBox();
      expect(selectedScheduleName!.y).toBeGreaterThanOrEqual(696);
      expect(selectedScheduleName!.y).toBeLessThanOrEqual(699);
      await expect(page.getByRole('button', { name: 'Save Schedule' })).toHaveCSS('width', '149px');
      await page.getByRole('button', { name: 'Save Schedule' }).click();
      await expect(page.locator('.workflow-section-concept')).toHaveText('Save Schedule previewed · no workflow changes were saved');
    }
    if (section === 'Versions') {
      const versionHistory = await page.locator('.workflow-version-history').boundingBox();
      const versionCompare = await page.locator('.workflow-version-compare').boundingBox();
      expect(versionHistory!.width / versionCompare!.width).toBeCloseTo(0.43, 1);
      const compareGraph = await page.locator('.workflow-compare-graph').first().boundingBox();
      const compareNode = await page.locator('.workflow-compare-graph b').first().boundingBox();
      const summaryHeading = await page.locator('.workflow-version-compare > .workflow-section-kicker').boundingBox();
      const changeRow = await page.locator('.workflow-change-row').first().boundingBox();
      expect(compareGraph!.height).toBeGreaterThanOrEqual(159);
      expect(compareNode!.width).toBeGreaterThanOrEqual(113);
      expect(compareNode!.height).toBeGreaterThanOrEqual(43);
      expect(changeRow!.height).toBeGreaterThanOrEqual(54);
      expect(changeRow!.y - summaryHeading!.y).toBeGreaterThanOrEqual(26);
      await expect(page.locator('.workflow-change-row.added .mantine-Badge-root')).toHaveCSS('background-color', 'rgb(16, 55, 46)');
      await expect(page.locator('.workflow-change-row.updated .mantine-Badge-root')).toHaveCSS('background-color', 'rgb(51, 34, 63)');
      await expect(page.locator('.workflow-change-row.routed .mantine-Badge-root')).toHaveCSS('background-color', 'rgb(28, 52, 69)');
      await expect(page.getByRole('button', { name: 'Restore Draft' })).toHaveCSS('background-color', 'rgb(27, 25, 40)');
    }
    if (section === 'Settings') {
      const lifecycleStates = page.getByRole('img', { name: 'On' });
      await expect(lifecycleStates).toHaveCount(2);
      await expect(lifecycleStates.first()).toHaveCSS('width', '82px');
      await expect(lifecycleStates.first()).toHaveCSS('height', '25px');
      const secondaryAction = page.getByRole('button', { name: 'Archive Workflow' });
      await expect(secondaryAction).toHaveCSS('background-color', 'rgb(27, 25, 40)');
      await expect(secondaryAction).toHaveCSS('border-top-color', 'rgb(57, 51, 74)');
      await expect(page.locator('.workflow-service-row .workflow-section-icon svg')).toHaveClass([
        /tabler-icon-diamond/, /tabler-icon-diamond/, /tabler-icon-diamond/,
      ]);
    }
    if (section === 'Permissions') {
      const permissionPanels = await page.locator('.workflow-permission-columns').boundingBox();
      const permissionsLeft = await page.locator('.workflow-permission-left').boundingBox();
      const protectionsPanel = await page.locator('.workflow-protection').boundingBox();
      expect(permissionPanels!.height).toBeLessThanOrEqual(523);
      expect(permissionPanels!.y + permissionPanels!.height).toBeLessThanOrEqual(931);
      expect(permissionsLeft!.width / protectionsPanel!.width).toBeCloseTo(1.6, 1);
    }
    if (section === 'Permissions') {
      await expect(page.locator('.workflow-collaborator')).toHaveCount(4);
      const publicSharing = page.getByRole('switch', { name: 'Allow public sharing' });
      await expect(publicSharing).toHaveAttribute('aria-checked', 'false');
      await publicSharing.click();
      await expect(publicSharing).toHaveAttribute('aria-checked', 'true');
      await page.getByRole('button', { name: 'Save Permissions' }).click();
      await expect(page.locator('.workflow-section-concept')).toHaveText('Save Permissions previewed · no workflow changes were saved');
    }
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

test('Workflow Builder preview canvas tools operate on the local graph', async ({ page }) => {
  const workflowRequests: string[] = [];
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 401, body: 'authentication required' }));
  await page.route('**/api/v1/workflows**', (route) => {
    workflowRequests.push(route.request().method());
    return route.fulfill({ status: 401, body: 'authentication required' });
  });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 401, body: 'authentication required' }));
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('http://127.0.0.1:4173/#workflows');

  const select = page.getByRole('button', { name: 'Select nodes' });
  const pan = page.getByRole('button', { name: 'Pan canvas' });
  await expect(select).toHaveAttribute('aria-pressed', 'true');
  await pan.click();
  await expect(pan).toHaveAttribute('aria-pressed', 'true');
  await expect(select).toHaveAttribute('aria-pressed', 'false');

  const zoom = page.getByRole('button', { name: 'Reset canvas zoom' });
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(zoom).not.toHaveText('100%');
  await zoom.click();
  await expect(zoom).toHaveText('100%');
  await page.getByRole('button', { name: 'Fit graph to canvas' }).click();

  const miniMap = page.getByRole('button', { name: 'Toggle minimap' });
  await expect(page.locator('.workflow-canvas .react-flow__minimap')).toBeVisible();
  await miniMap.click();
  await expect(miniMap).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.workflow-canvas .react-flow__minimap')).toHaveCount(0);
  await miniMap.click();
  await expect(page.locator('.workflow-canvas .react-flow__minimap')).toBeVisible();

  const canvas = page.locator('.workflow-canvas-wrap');
  const fullscreen = page.getByRole('button', { name: 'Toggle canvas fullscreen' });
  await fullscreen.click();
  await expect.poll(() => canvas.evaluate((element) => document.fullscreenElement === element)).toBe(true);
  await fullscreen.click();
  await expect.poll(() => canvas.evaluate((element) => document.fullscreenElement === element)).toBe(false);

  await expect(page.locator('.workflow-canvas .workflow-node')).toHaveCount(11);
  await page.getByRole('button', { name: 'Add custom block' }).click();
  await expect(page.locator('.workflow-canvas .workflow-node')).toHaveCount(12);
  await expect(page.locator('.workflow-status')).toContainText('Block added locally');
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
