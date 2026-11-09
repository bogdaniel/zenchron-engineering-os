import { expect, test } from '@playwright/test';

test('dashboard displays the connected control plane and local worker', async ({ page }) => {
  await page.setViewportSize({ width: 1490, height: 829 });
  await page.route((url) => url.hostname === 'zenchron.test'
    && (url.pathname === '/healthz' || url.pathname.startsWith('/api/v1/')),
  async (route) => {
    const upstream = route.request().url().replace('zenchron.test:4173', '127.0.0.1:8083');
    const response = await page.request.get(upstream);
    await route.fulfill({ response });
  });
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.goto('/');
  await expect(page.locator('.search-box')).toBeVisible();
  const overviewIconsLeadLabels = await page.locator('.metric-card .metric-top').evaluateAll((headers) =>
    headers.every((header) => {
      const icon = header.querySelector('svg')?.getBoundingClientRect();
      const label = header.querySelector('span')?.getBoundingClientRect();
      return icon !== undefined && label !== undefined && icon.right <= label.left;
    }),
  );
  expect(overviewIconsLeadLabels, 'Overview KPI icons sit before their labels').toBe(true);
  const headerRegions = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return { greetingRight: rect('.greeting').right, search: rect('.search-box'), actionsLeft: rect('.top-actions').left };
  });
  expect(headerRegions.search.left).toBeGreaterThanOrEqual(headerRegions.greetingRight);
  expect(headerRegions.search.right).toBeLessThanOrEqual(headerRegions.actionsLeft);
  await page.setViewportSize({ width: 1360, height: 829 });
  await expect(page.locator('.search-box')).toBeHidden();
  await page.setViewportSize({ width: 1490, height: 829 });
  await expect(page.getByRole('heading', { name: /Good morning/ })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search' })).toHaveAttribute('placeholder', 'Search Zenchron…');
  await expect(page.getByRole('heading', { name: 'Workflow Orchestration' })).toBeVisible();
  await expect(page.locator('.plan-panel .panel-actions')).toHaveCount(0);
  await expect(page.locator('.workflow-overview-canvas .workflow-node')).toHaveCount(6);
  await expect(page.locator('.workflow-overview-canvas .react-flow__edge')).toHaveCount(6);
  await expect(page.locator('.workflow-overview-canvas .react-flow__attribution')).toBeVisible();
  const workflowSummary = page.locator('.workflow-overview-canvas');
  await expect(workflowSummary).toHaveAttribute('aria-label', /6 stages summarize 9 components/);
  await expect(workflowSummary).toContainText('Run agents');
  await expect(workflowSummary).toContainText('Run test suite');
  await expect(workflowSummary).toContainText('AI + human review');
  await expect(workflowSummary).toContainText('Gated release');
  await expect(page.locator('.workflow-overview-status')).toContainText('Execution unavailable');
  await expect(page.locator('.activity-list')).toContainText('Control plane is responding');
  await expect(page.getByText('Running Agents', { exact: true })).toBeVisible();
  await expect(page.getByText('Approval data unavailable', { exact: true })).toBeVisible();
  await expect(page.locator('.evidence-health-list')).toContainText('Trusted-main');
  await expect(page.locator('.evidence-health-list')).toContainText('Evidence');
  await expect(page.locator('.evidence-health-list .muted-tag .health-status-dot').first()).toHaveCSS('background-color', 'rgb(170, 160, 192)');
  await expect(page.getByText('No pending approvals', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No runs', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Worker “.+” is online/)).toBeVisible();
  await expect(page.locator('.activity-list')).toContainText('zenchron-engineering-os');
  await expect(page.locator('.metric-unavailable')).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'Code Review' })).toBeVisible();
  await expect(page.getByText('No local branch diffs yet', { exact: true })).toBeVisible();
  await expect(page.getByText('No pull requests yet', { exact: true })).toHaveCount(0);
  await expect(page.locator('.page-footer')).toBeHidden();
  await page.getByRole('link', { name: 'Product Workspace' }).click();
  await page.getByRole('link', { name: 'Open repository inventory' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
});

test('Overview PR queue and CI health use complete GitHub history', async ({ page }) => {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const projectID = 'a'.repeat(32);
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, local: true, login: '' }),
  }));
  await page.route('**/api/v1/projects', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([{
      id: projectID, name: 'Platform', branch: 'main', git_remote: 'github.com/acme/platform',
      worker_id: 'b'.repeat(32), worker_name: 'Mac', worker_status: 'online', last_seen: ago(0),
    }]),
  }));
  await page.route('**/api/v1/projects/*/pull-request-history*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ complete: true, items: [
      { created_at: ago(120), closed_at: null, merged_at: null },
      { created_at: ago(60), closed_at: null, merged_at: null },
      { created_at: ago(180), closed_at: ago(30), merged_at: ago(30) },
    ] }),
  }));
  await page.route('**/api/v1/projects/*/workflow-run-history*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ complete: true, items: [
      { created_at: ago(60), status: 'completed', conclusion: 'success', run_started_at: ago(12), updated_at: ago(2) },
      { created_at: ago(60), status: 'completed', conclusion: 'failure', run_started_at: ago(12), updated_at: ago(2) },
      { created_at: ago(60), status: 'completed', conclusion: 'success', run_started_at: ago(12), updated_at: ago(2) },
    ] }),
  }));

  await page.goto('/');
  const queue = page.locator('.metric-card.pr-queue-metric');
  await expect(queue.locator('strong')).toHaveText('2');
  await expect(queue.locator('small')).toHaveText('2 open GitHub pull requests');
  const ci = page.locator('.metric-card.green');
  await expect(ci.locator('strong')).toHaveText('67%');
  await expect(ci.locator('small')).toHaveText('2 of 3 completed runs passed');
  await expect(page.getByRole('img', { name: 'Merged pull requests by period' })).toBeVisible();
  await expect(page.locator('.overview-delivery-summary')).toContainText('1');
});

test('unauthenticated local users can review the latest Overview and reach sign-in', async ({ page }) => {
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 401, body: '' }));
  await page.goto('http://127.0.0.1:4173/');
  await expect(page.getByRole('heading', { name: 'Good morning, Alex' })).toBeVisible();
  await expect(page.locator('.overview-design-preview')).toBeVisible();
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('http://127.0.0.1:4173/#login');
  await expect(page.getByRole('heading', { name: 'Zenchron Engineering' })).toBeVisible();
});

test('local root keeps the approved Overview mock for authenticated sessions without a preview query', async ({ page }) => {
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: route.request().url().endsWith('/api/v1/auth/session')
      ? JSON.stringify({ authenticated: true, local: false, login: 'engineer' }) : '[]' }));
  await page.goto('http://127.0.0.1:4173/');
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  await expect(page.getByRole('heading', { name: 'Good morning, Alex' })).toBeVisible();
  await expect(page.locator('.overview-design-preview')).toBeVisible();
  await expect(page.locator('.metric-grid .metric-card').first()).toContainText('12');
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(1);
});

test('Overview design preview renders the supplied mock content without replacing live data', async ({ page }) => {
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 401, body: '' }));
  await page.goto('http://127.0.0.1:4173/');
  await expect(page.locator('.design-preview-label')).toHaveCount(0);
  await expect(page.locator('.sidebar-bottom')).toContainText('The AI-native engineering operating system.');
  await expect(page.locator('.sidebar-bottom .brand-mark')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Good morning, Alex' })).toBeVisible();
  expect((await page.locator('.greeting h1').boundingBox())?.x).toBe(266);
  await expect(page.getByRole('button', { name: 'Core Product' })).toBeVisible();
  await expect(page.locator('.user-chip')).toContainText('Alex Chen');
  await expect(page.locator('.user-profile-chevron')).toBeVisible();
  await expect(page.locator('.workspace-glyph')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.user-chip')).toHaveCSS('font-size', '13px');
  await expect(page.locator('.user-chip .avatar')).toHaveCSS('width', '38px');
  await expect(page.locator('.workspace-glyph .tabler-icon-stack-2')).toBeVisible();
  await expect(page.locator('.nav-link[href="#workspace"] .tabler-icon-stack-2')).toBeVisible();
  await expect(page.locator('.sidebar > .brand')).toHaveCSS('font-size', '18px');
  expect((await page.locator('.sidebar > .brand .brand-mark').boundingBox())?.width).toBe(34);
  await expect(page.locator('.notification-indicator')).toBeVisible();
  await expect(page.locator('.notification-button')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.notification-indicator')).toHaveCSS('top', '-4px');
  await expect(page.locator('.workflow-panel .overview-heading-info')).toBeVisible();
  await expect(page.locator('.workflow-panel')).toHaveCSS('background-image', /radial-gradient/);
  const workflowBackground = await page.locator('.workflow-panel').evaluate((panel) => getComputedStyle(panel).backgroundImage);
  expect(workflowBackground).toContain('linear-gradient');
  expect(workflowBackground.match(/radial-gradient/g)).toHaveLength(2);
  expect(workflowBackground).toContain('130% 180% at 15% 0%');
  expect(workflowBackground).toContain('rgba(239, 232, 255, 0.04)');
  await expect(page.locator('.workflow-overview-canvas .react-flow__edge-path').first()).toHaveCSS('filter', /0px 0px 2px/);
  await expect(page.locator('.workflow-overview-canvas .react-flow__attribution')).toBeHidden();
  await expect(page.locator('.workflow-node.trigger .workflow-node-icon svg')).toHaveCSS('width', '28px');
  await expect(page.locator('.workflow-node.trigger .workflow-node-icon svg path').first()).toHaveCSS('fill', 'rgb(125, 185, 255)');
  const triggerIconAlignment = await page.locator('.workflow-node.trigger .workflow-node-icon').evaluate((icon) => {
    const circle = icon.getBoundingClientRect();
    const glyph = icon.querySelector('svg path')!.getBoundingClientRect();
    return {
      left: glyph.left >= circle.left,
      right: glyph.right <= circle.right,
      top: glyph.top >= circle.top,
      bottom: glyph.bottom <= circle.bottom,
      centerX: Math.abs(circle.x + circle.width / 2 - glyph.x - glyph.width / 2),
      centerY: Math.abs(circle.y + circle.height / 2 - glyph.y - glyph.height / 2),
    };
  });
  expect(triggerIconAlignment.left).toBe(true);
  expect(triggerIconAlignment.right).toBe(true);
  expect(triggerIconAlignment.top).toBe(true);
  expect(triggerIconAlignment.bottom).toBe(true);
  expect(triggerIconAlignment.centerX).toBeLessThanOrEqual(1);
  expect(triggerIconAlignment.centerY).toBeLessThanOrEqual(1);
  await expect(page.locator('.metric-card').nth(0).locator('.mock-trend circle')).toHaveCount(8);
  await expect(page.locator('.metric-card').nth(1).locator('.mock-trend circle')).toHaveCount(8);
  const sidebarBackground = await page.locator('.sidebar').evaluate((sidebar) => getComputedStyle(sidebar).backgroundPosition);
  expect(sidebarBackground).toContain('91px');
  const statusBadgeAlignment = await page.locator('.workflow-node.test-generator').evaluate((node) => {
    const title = node.querySelector('b')!.getBoundingClientRect();
    const badge = getComputedStyle(node, '::after');
    const nodeBox = node.getBoundingClientRect();
    const badgeCenterY = nodeBox.top + parseFloat(badge.top)
      + new DOMMatrixReadOnly(badge.transform).m42 + parseFloat(badge.height) / 2;
    return Math.abs(title.top + title.height / 2 - badgeCenterY);
  });
  expect(statusBadgeAlignment).toBeLessThanOrEqual(1);
  await expect(page.locator('.workflow-overview-canvas')).toHaveCSS('border-top-width', '0px');
  await expect(page.locator('.workflow-overview-canvas .react-flow__background')).toHaveCSS('display', 'none');
  await expect(page.locator('.workflow-overview-actions')).toHaveCSS('gap', '8px');
  await expect(page.locator('.preview-running-badge')).toHaveCSS('height', '32px');
  await expect(page.locator('.workflow-overview-actions .subtle-button')).toHaveCSS('height', '32px');
  await expect(page.locator('.evidence-panel .overview-heading-info')).toBeVisible();
  await expect(page.locator('.user-chip img')).toHaveJSProperty('naturalWidth', 128);
  await expect(page.locator('.nav-link.active')).toHaveCSS('height', '42px');
  await expect(page.locator('.nav-link[href="#objectives"]')).toHaveCSS('height', '42px');
  expect((await page.locator('.nav-link.active').boundingBox())?.width).toBe(221);
  expect((await page.locator('.nav-link.active .nav-label').boundingBox())?.x).toBe(80);
  expect((await page.locator('.nav-link[href="#settings"]').boundingBox())?.y).toBeCloseTo(452, 0);
  const sidebarFooterBrand = await page.locator('.sidebar-bottom strong').boundingBox();
  expect(sidebarFooterBrand?.x).toBe(71);
  expect(sidebarFooterBrand?.y).toBeCloseTo(816, 0);
  await expect(page.locator('.metric-grid .metric-card')).toHaveCount(5);
  await expect(page.locator('.metric-grid .metric-card').nth(0)).toContainText('12');
  await expect(page.locator('.metric-grid .metric-card').nth(1)).toContainText('7');
  await expect(page.locator('.metric-grid .metric-card').nth(2)).toContainText('18');
  await expect(page.locator('.metric-grid .metric-card').nth(3)).toContainText('99.4%');
  await expect(page.locator('.metric-grid .metric-card').nth(4)).toContainText('68%');
  await expect(page.locator('.metric-grid .metric-card').nth(4)).toHaveClass(/purple/);
  await expect(page.locator('.metric-grid .metric-card').first().locator('.metric-top span')).toHaveCSS('font-weight', '600');
  await expect(page.locator('.activity-list > div').nth(2).locator('svg')).toHaveClass(/tabler-icon-file-text/);
  await expect(page.locator('.activity-list > div').first()).toHaveCSS('font-size', '14px');
  expect((await page.locator('.activity-list > div').first().locator('svg').boundingBox())?.width).toBe(24);
  await expect(page.locator('.activity-list > div').first().locator('svg')).toHaveCSS('border-radius', '50%');
  await expect(page.locator('.activity-list > div').first().locator('svg')).toHaveCSS('background-color', 'rgb(20, 57, 47)');
  expect((await page.locator('.activity-list > div').first().locator('span').boundingBox())?.x).toBe(1316);
  await page.setViewportSize({ width: 1668, height: 749 });
  const lastActivityLabel = await page.locator('.activity-list > div').last().locator('span').evaluate((span) => ({
    scrollWidth: span.scrollWidth, clientWidth: span.clientWidth,
  }));
  expect(lastActivityLabel.scrollWidth).toBe(lastActivityLabel.clientWidth);
  await page.setViewportSize({ width: 1672, height: 941 });
  await expect(page.locator('.preview-agent-list > div svg').nth(0)).toHaveClass(/tabler-icon-stack-2/);
  await expect(page.locator('.preview-agent-list > div svg').nth(1)).toHaveClass(/tabler-icon-stack-2/);
  await expect(page.locator('.preview-agent-list > div svg').nth(2)).toHaveClass(/tabler-icon-shield-check/);
  await expect(page.locator('.evidence-panel .evidence-health-list > div > svg').nth(1)).toHaveClass(/tabler-icon-stack-2/);
  await expect(page.locator('.evidence-panel .evidence-health-list > div > span').first()).toHaveCSS('font-size', '13px');
  await expect(page.locator('.evidence-panel .mock-health-tag').first()).toHaveCSS('font-size', '11px');
  await expect(page.locator('.evidence-panel .mock-health-tag .health-status-dot')).toHaveCount(2);
  await expect(page.locator('.evidence-panel .mock-health-tag .health-status-dot').first()).toHaveCSS('background-color', 'rgb(84, 224, 169)');
  await expect(page.locator('.evidence-panel .mock-health-tag .mantine-Badge-label').first()).toHaveCSS('align-items', 'center');
  await expect(page.locator('.metric-grid .metric-card').nth(0).locator('small')).toHaveCount(0);
  const metricCards = await page.locator('.metric-grid .metric-card').evaluateAll((cards) => cards.map((card) => {
    const bounds = (selector: string) => card.querySelector(selector)!.getBoundingClientRect().toJSON();
    return { card: card.getBoundingClientRect().toJSON(), icon: bounds('.metric-top svg'), value: bounds('.metric-value-row > strong') };
  }));
  [263, 549, 831, 1113, 1399].forEach((x, index) => expect(metricCards[index].card.x).toBeCloseTo(x, 0));
  expect(metricCards[0].icon.width).toBe(28);
  expect(metricCards[0].value.y).toBe(135);
  const middlePanels = await page.locator('.overview-middle-grid > .panel').evaluateAll((panels) => panels.map((panel) => {
    const { x, width } = panel.getBoundingClientRect();
    return { x, width };
  }));
  [263, 619, 945, 1287].forEach((x, index) => expect(middlePanels[index].x).toBe(x));
  [342, 312, 328, 371].forEach((width, index) => expect(middlePanels[index].width).toBe(width));
  await expect(page.locator('.metric-card').nth(0).locator('.mock-trend .mantine-Badge-root')).toHaveText('↑ +3');
  await expect(page.locator('.metric-card').nth(1).locator('.mock-trend .mantine-Badge-root')).toHaveText('● Live');
  await expect(page.locator('.metric-card').nth(2).locator('.mock-trend .mantine-Badge-root')).toHaveText('↑ +4');
  const kpiGaps = await page.evaluate(() => {
    const metric = (index: number) => document.querySelectorAll('.metric-card')[index];
    const gap = (card: Element, selector: string) => {
      const value = card.querySelector('.metric-value-row > strong')!.getBoundingClientRect();
      return card.querySelector(selector)!.getBoundingClientRect().left - value.right;
    };
    return { trend: gap(metric(0), '.mock-trend'), health: gap(metric(3), '.mantine-Badge-root') };
  });
  expect(kpiGaps.trend).toBeGreaterThanOrEqual(10);
  expect(kpiGaps.trend).toBeLessThanOrEqual(24);
  expect(kpiGaps.health).toBeGreaterThanOrEqual(40);
  expect(kpiGaps.health).toBeLessThanOrEqual(58);
  await expect(page.locator('.mock-budget-summary')).toContainText('$13.6K / $20K');
  await expect(page.locator('.pr-queue-metric .mock-bars i')).toHaveCount(5);
  await expect(page.locator('.workflow-overview-status')).toHaveCount(0);
  await expect(page.locator('.workflow-overview-actions .preview-running-badge')).toHaveText('● Running');
  await expect(page.locator('.activity-panel .text-link')).toContainText('All Activity');
  await expect(page.locator('.workflow-overview-canvas .workflow-node')).toHaveCount(6);
  await expect(page.locator('.workflow-overview-canvas .react-flow__edge-path').first()).toHaveAttribute('marker-end', /url/);
  expect(await page.locator('.workflow-overview-canvas .react-flow__edge-path').first().boundingBox()).not.toBeNull();
  await expect(page.locator('.workflow-overview-canvas .react-flow__attribution')).toBeHidden();
  await expect(page.getByRole('link', { name: 'View Runs' })).toHaveAttribute('href', '#workflows');
  await page.getByRole('button', { name: 'Workflow options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Open workflow editor' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.workflow-overview-canvas')).toHaveAttribute('aria-label', /6 stages summarize 10 components/);
  const workflowNodeGaps = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return {
      triggerPlan: bounds('.workflow-node.trigger').right - bounds('.workflow-node.planner').left,
      testReview: bounds('.workflow-node.test-generator').bottom - bounds('.workflow-node.code-reviewer').top,
    };
  });
  expect(workflowNodeGaps.triggerPlan).toBeLessThanOrEqual(-20);
  expect(workflowNodeGaps.testReview).toBeLessThanOrEqual(-20);
  const graphStages = await page.evaluate(() => Object.fromEntries(
    ['trigger', 'planner', 'agent-router', 'test-generator', 'code-reviewer', 'merge-gate'].map((kind) => {
      const rect = document.querySelector(`.workflow-node.${kind}`)!.getBoundingClientRect();
      return [kind, { x: rect.x, y: rect.y }];
    }),
  ));
  expect(graphStages.trigger.x).toBeGreaterThanOrEqual(288);
  expect(graphStages.trigger.x).toBeLessThanOrEqual(290);
  expect(graphStages.trigger.y).toBeGreaterThanOrEqual(298.5);
  expect(graphStages.trigger.y).toBeLessThanOrEqual(301);
  expect(graphStages.planner.x).toBeGreaterThanOrEqual(496);
  expect(graphStages.planner.x).toBeLessThanOrEqual(498);
  expect(graphStages['agent-router'].x).toBeGreaterThanOrEqual(676);
  expect(graphStages['agent-router'].x).toBeLessThanOrEqual(678);
  expect(graphStages['test-generator'].x).toBeGreaterThanOrEqual(851);
  expect(graphStages['test-generator'].x).toBeLessThanOrEqual(854);
  expect(graphStages['test-generator'].y).toBeGreaterThanOrEqual(257);
  expect(graphStages['test-generator'].y).toBeLessThanOrEqual(259);
  expect(graphStages['code-reviewer'].x).toBeGreaterThanOrEqual(851);
  expect(graphStages['code-reviewer'].x).toBeLessThanOrEqual(854);
  expect(graphStages['code-reviewer'].y).toBeGreaterThanOrEqual(333);
  expect(graphStages['code-reviewer'].y).toBeLessThanOrEqual(335);
  expect(graphStages['merge-gate'].x).toBeGreaterThanOrEqual(1062);
  expect(graphStages['merge-gate'].x).toBeLessThanOrEqual(1065);
  await expect(page.locator('.preview-objective-list')).toContainText('Ship AI code review v2');
  await expect(page.locator('.preview-objective-list > div').first()).toContainText('On Track');
  await expect(page.locator('.preview-objective-list > div').first().locator('b')).toHaveText('78%');
  await expect(page.locator('.preview-approval-list .mantine-Badge-root').first()).toHaveText('Approved');
  await expect(page.locator('.preview-approval-list .mantine-Badge-root').first()).toHaveCSS('flex-shrink', '0');
  await expect(page.locator('.preview-approval-list > div:last-child > svg')).toHaveClass(/tabler-icon-file-time/);
  await expect(page.locator('.preview-agent-list')).toContainText('2m ago');
  await expect(page.locator('.preview-agent-list')).toContainText('4m ago');
  await expect(page.locator('.preview-agent-list')).toContainText('7m ago');
  const middleRowOffsets = await page.evaluate(() => {
    const rows = (selector: string) => [...document.querySelectorAll(selector)].map(row => row.getBoundingClientRect().y);
    return { approvals: rows('.preview-approval-list > div'), agents: rows('.preview-agent-list > div') };
  });
  for (const rows of [middleRowOffsets.approvals, middleRowOffsets.agents]) {
    expect(rows).toHaveLength(3);
    expect(rows[1] - rows[0]).toBe(36);
    expect(rows[2] - rows[1]).toBe(36);
  }
  const objectiveMarkers = await page.evaluate(() => [
    getComputedStyle(document.querySelector('.preview-objective-list small')!, '::before').content,
    getComputedStyle(document.querySelector('.preview-objective-list small[data-risk="true"]')!, '::before').content,
  ]);
  expect(objectiveMarkers).toEqual(['"●"', '"▲"']);
  await expect(page.locator('.preview-approval-list .mantine-Badge-root').first().locator('svg')).toHaveClass(/tabler-icon-circle-check/);
  await expect(page.locator('.preview-approval-list [data-pending="true"] svg')).toHaveClass(/tabler-icon-clock-hour-4/);
  await expect(page.locator('.preview-agent-list .preview-chip-dot')).toHaveCount(3);
  await expect(page.getByText('PR #41827', { exact: true })).toBeVisible();
  await expect(page.locator('.preview-review-meta a')).toHaveCSS('width', '16px');
  await expect(page.locator('.preview-review-meta a')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.preview-timeline-row')).toHaveCount(5);
  await expect(page.locator('.preview-timeline-done')).toHaveCount(2);
  await expect(page.locator('.preview-today-marker')).toBeVisible();
  const timelineMockAlignment = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return {
      today: bounds('.preview-today-marker b'),
      dates: bounds('.preview-timeline-dates'),
      firstRow: bounds('.preview-timeline-row'),
      labelGridGaps: [...document.querySelectorAll('.preview-timeline-row')].map(row => {
        const label = row.querySelector('span')!;
        const range = document.createRange();
        range.selectNodeContents(label);
        return row.querySelector('div')!.getBoundingClientRect().left - range.getBoundingClientRect().right;
      }),
      headingIcon: bounds('.timeline-panel .panel-heading .section-icon svg'),
      headingTitle: bounds('.timeline-panel .panel-heading h3'),
      headingDescriptionGap: bounds('.timeline-panel .panel-heading p').y - bounds('.timeline-panel .panel-heading h3').bottom,
      headingIconCenterY: (() => { const box = bounds('.timeline-panel .panel-heading .section-icon svg'); return box.y + box.height / 2; })(),
      headingTitleCenterY: (() => { const box = bounds('.timeline-panel .panel-heading h3'); return box.y + box.height / 2; })(),
      bars: [...document.querySelectorAll('.preview-timeline-row')].map(row => {
        const grid = row.querySelector('div')!;
        const bar = row.querySelector('.timeline-bar')!;
        const gridStart = grid.getBoundingClientRect().left + parseFloat(getComputedStyle(grid).borderLeftWidth);
        const bounds = bar.getBoundingClientRect();
        return { start: bounds.left - gridStart, width: bounds.width, center: bounds.x + bounds.width / 2 - gridStart,
          track: grid.clientWidth / 8 };
      }),
      labelX: (() => {
        const label = document.querySelector('.preview-timeline-row > span')!;
        const text = label.lastChild!;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, text.textContent!.length);
        const bounds = range.getBoundingClientRect();
        return { x: bounds.x, height: bounds.height };
      })(),
    };
  });
  expect(Math.abs(timelineMockAlignment.dates.y - 659)).toBeLessThanOrEqual(1);
  expect(Math.abs(timelineMockAlignment.today.y - 678)).toBeLessThanOrEqual(1);
  expect(Math.abs(timelineMockAlignment.firstRow.y - 686)).toBeLessThanOrEqual(1);
  expect(Math.abs(timelineMockAlignment.headingIcon.x - 789)).toBeLessThanOrEqual(2);
  expect(Math.abs(timelineMockAlignment.headingTitle.x - 830)).toBeLessThanOrEqual(4);
  expect(timelineMockAlignment.headingTitle.x - timelineMockAlignment.headingIcon.right).toBeCloseTo(13, 0);
  expect(timelineMockAlignment.headingDescriptionGap).toBeCloseTo(2, 0);
  await expect(page.locator('.preview-timeline-dates')).toHaveCSS('color', 'rgb(228, 223, 237)');
  expect(timelineMockAlignment.headingIconCenterY).toBeCloseTo(timelineMockAlignment.headingTitleCenterY, 0);
  expect(timelineMockAlignment.labelX.x).toBeCloseTo(812, 0);
  const [plan, agent, tests, reviewBar, merge] = timelineMockAlignment.bars;
  expect(plan.start).toBeCloseTo(0, 0);
  expect(plan.width).toBeCloseTo(2 * plan.track - 13, 0);
  expect(agent.start).toBeCloseTo(agent.track + 24, 0);
  expect(agent.width).toBeCloseTo(3 * agent.track, 0);
  expect(tests.start).toBeCloseTo(3 * tests.track + 47, 0);
  expect(tests.width).toBeCloseTo(2 * tests.track - 13, 0);
  expect(reviewBar.start).toBeCloseTo(4 * reviewBar.track + 70, 0);
  expect(reviewBar.width).toBeCloseTo(2 * reviewBar.track - 14, 0);
  expect(merge.center).toBeCloseTo(7 * merge.track + 26, 0);
  expect(Math.min(...timelineMockAlignment.labelGridGaps)).toBeGreaterThanOrEqual(0);
  expect(await page.locator('.preview-timeline-row svg').first().evaluate(icon => getComputedStyle(icon).width)).toBe('22px');
  expect(timelineMockAlignment.labelX.height).toBeLessThan(18);
  expect(timelineMockAlignment.today.x + timelineMockAlignment.today.width / 2).toBeGreaterThanOrEqual(1079);
  expect(timelineMockAlignment.today.x + timelineMockAlignment.today.width / 2).toBeLessThanOrEqual(1087);
  expect(timelineMockAlignment.today.y - timelineMockAlignment.firstRow.y).toBeGreaterThanOrEqual(-14);
  expect(timelineMockAlignment.today.y - timelineMockAlignment.firstRow.y).toBeLessThanOrEqual(-8);
  await page.setViewportSize({ width: 1672, height: 749 });
  const compactTimelineDates = await page.locator('.preview-timeline-dates').boundingBox();
  expect(Math.abs((compactTimelineDates?.y ?? 0) - 666)).toBeLessThanOrEqual(2);
  const compactHeadingAlignment = await page.evaluate(() => {
    const icon = document.querySelector('.timeline-panel .section-icon svg')!.getBoundingClientRect();
    const title = document.querySelector('.timeline-panel h3')!.getBoundingClientRect();
    return icon.y + icon.height / 2 - title.y - title.height / 2;
  });
  expect(compactHeadingAlignment).toBeCloseTo(0, 0);
  await page.setViewportSize({ width: 1672, height: 941 });
  await expect(page.locator('.preview-analytics-summary > span')).toHaveText('PRs Merged (7d)');
  await expect(page.locator('.preview-analytics-summary strong')).toHaveText('42');
  const analyticsChange = await page.locator('.preview-analytics-summary b').boundingBox();
  const analyticsTextRight = await page.locator('.preview-analytics-summary strong').evaluate((value) => {
    const range = document.createRange();
    range.selectNodeContents(value);
    return range.getBoundingClientRect().right;
  });
  expect(analyticsChange!.x - analyticsTextRight).toBeCloseTo(12, 0);
  await expect(page.locator('.mock-analytics-filter')).toHaveText('Delivery Velocity');
  await expect(page.locator('.preview-analytics-panel .recharts-area-curve')).toHaveCount(1);
  const analyticsPlot = await page.locator('.preview-analytics-panel .recharts-cartesian-grid').boundingBox();
  expect(analyticsPlot?.y).toBeGreaterThanOrEqual(703);
  expect(analyticsPlot?.y).toBeLessThanOrEqual(710);
  const analyticsTicks = await page.locator('.preview-analytics-panel .recharts-cartesian-axis-tick-value').allTextContents();
  expect(analyticsTicks).toContain('Jan 25');
  expect(analyticsTicks).toContain('40');
  const overviewTypography = await page.evaluate(() => ({
    metricLabel: getComputedStyle(document.querySelector('.metric-card .metric-top')!).fontSize,
    metricValue: getComputedStyle(document.querySelector('.metric-card strong')!).fontSize,
    panelHeading: getComputedStyle(document.querySelector('.workflow-panel h3')!).fontSize,
  }));
  expect(overviewTypography).toEqual({ metricLabel: '15px', metricValue: '30px', panelHeading: '16px' });
  const mockDetails = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const icon = document.querySelector('.objective-panel .section-icon')!;
    return {
      middleHeadingY: bounds('.objective-panel .panel-heading h3').y,
      iconBorder: getComputedStyle(icon).borderTopWidth,
      iconBackground: getComputedStyle(icon).backgroundColor,
      reviewMeta: bounds('.preview-review-meta').toJSON(),
      reviewDiff: bounds('.preview-diff').toJSON(),
      timelineSubtitleFont: getComputedStyle(document.querySelector('.timeline-panel .panel-heading p')!).fontSize,
    };
  });
  expect(mockDetails.middleHeadingY).toBeCloseTo(426, 0);
  expect(mockDetails.iconBorder).toBe('0px');
  expect(mockDetails.iconBackground).toBe('rgba(0, 0, 0, 0)');
  expect(mockDetails.reviewMeta.y).toBe(637);
  expect(mockDetails.reviewMeta.height).toBeCloseTo(27, 0);
  expect(mockDetails.reviewDiff.y).toBeCloseTo(742, 0);
  expect(mockDetails.reviewDiff.height).toBe(106);
  expect(mockDetails.timelineSubtitleFont).toBe('11px');
  const metrics = await page.locator('.metric-grid').boundingBox();
  const sidebar = await page.locator('.sidebar').boundingBox();
  const workflow = await page.locator('.workflow-panel').boundingBox();
  const activity = await page.locator('.activity-panel').boundingBox();
  const objectives = await page.locator('.objective-panel').boundingBox();
  const review = await page.locator('.review-panel').boundingBox();
  const timeline = await page.locator('.timeline-panel').boundingBox();
  const analytics = await page.locator('.analytics-panel').boundingBox();
  const search = await page.locator('.search-box').boundingBox();
  const topActions = await page.locator('.top-actions').boundingBox();
  expect(search?.x).toBe(778.5);
  expect(search?.width).toBe(410);
  expect(topActions?.x).toBe(1216);
  expect(sidebar?.width).toBe(247);
  expect(metrics?.x).toBe(263);
  expect(metrics?.y).toBe(84);
  expect(metrics?.width).toBe(1395);
  expect(metrics?.height).toBe(100);
  expect(workflow?.y).toBe(198);
  expect(workflow?.height).toBe(204);
  expect(activity?.height).toBe(204);
  expect(activity?.x).toBe(1244);
  expect(objectives?.height).toBe(158);
  expect(review?.width).toBeCloseTo(495, 0);
  expect(timeline?.x).toBe(772);
  expect(timeline?.width).toBe(498);
  expect(analytics?.x).toBe(1284);
  expect(analytics?.width).toBe(374);
  await expect(page.locator('.workflow-node.merge-gate')).toContainText('To trusted-main');
  await expect(page.locator('.preview-review-meta')).toContainText('Approved');
  await expect(page.locator('.preview-review-meta a')).toHaveAttribute('aria-label', 'Open pull request review');
  await expect(page.locator('.preview-diff')).toContainText('+ const evidence = await captureEvidence');
  await expect(page.locator('.preview-diff')).toContainText('+   artifacts: run.artifacts,');

  await page.setViewportSize({ width: 1672, height: 749 });
  const compactViewport = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return {
      workflow: bounds('.workflow-panel'), activity: bounds('.activity-panel'),
      objectives: bounds('.objective-panel'), review: bounds('.review-panel'),
      timeline: bounds('.timeline-panel'), analytics: bounds('.analytics-panel'),
    };
  });
  expect(compactViewport.workflow.y).toBe(198);
  expect(compactViewport.workflow.height).toBe(204);
  expect(compactViewport.activity.x).toBe(1244);
  expect(compactViewport.objectives.y).toBe(416);
  expect(compactViewport.review.y).toBe(590);
  expect(compactViewport.review.height).toBe(280);
  expect(compactViewport.timeline.x).toBe(772);
  expect(compactViewport.analytics.x).toBe(1284);
  expect(compactViewport.analytics.y + compactViewport.analytics.height).toBeGreaterThan(749);
});

test('Overview matches the supplied tall desktop mockup proportions', async ({ page }) => {
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('http://127.0.0.1:4173/');
  const layout = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
    return {
      greeting: bounds('.greeting'), topActions: bounds('.top-actions'),
      metrics: bounds('.metric-grid'), workflow: bounds('.workflow-panel'), activity: bounds('.activity-panel'),
      objectives: bounds('.objective-panel'), review: bounds('.review-panel'), footerDisplay:
        getComputedStyle(document.querySelector('.page-footer')!).display,
      timeline: bounds('.preview-timeline'), analyticsChart: bounds('.preview-analytics-panel .recharts-surface'),
      reviewDiff: bounds('.preview-review-panel .preview-diff'),
      brandMark: bounds('.brand-mark'), overviewLink: bounds('.nav-link[href="#overview"]'),
      search: bounds('.search-box'),
    };
  });
  expect(layout.metrics?.x).toBe(263);
  expect(layout.metrics?.y).toBe(84);
  expect(layout.metrics?.width).toBe(1395);
  expect(layout.metrics?.height).toBe(100);
  expect(layout.workflow?.y).toBe(198);
  expect(layout.workflow?.height).toBeGreaterThanOrEqual(203);
  expect(layout.workflow?.height).toBeLessThanOrEqual(205);
  expect(layout.activity?.y).toBe(198);
  expect(layout.activity?.height).toBe(204);
  const workflowNode = await page.locator('.workflow-overview-canvas .workflow-node').first().boundingBox();
  expect(workflowNode?.width).toBeGreaterThanOrEqual(80);
  expect(workflowNode?.height).toBeGreaterThanOrEqual(30);
  const overviewCanvas = await page.locator('.workflow-overview-canvas').boundingBox();
  const overviewGraphLabelSize = await page.evaluate(() => {
    const node = document.querySelector('.workflow-overview-canvas .workflow-node');
    const viewport = document.querySelector('.workflow-overview-canvas .react-flow__viewport');
    if (!node || !viewport) return 0;
    const zoom = new DOMMatrix(getComputedStyle(viewport).transform).a;
    return parseFloat(getComputedStyle(node.querySelector('b')!).fontSize) * zoom;
  });
  expect(overviewGraphLabelSize).toBeGreaterThanOrEqual(8);
  expect(layout.activity?.x).toBe(1244);
  expect(layout.objectives?.y).toBeCloseTo(416, 0);
  expect(layout.review?.y).toBeCloseTo(590, 0);
  expect(layout.review?.height).toBe(280);
  expect(layout.timeline?.height).toBeGreaterThanOrEqual(170);
  expect(layout.analyticsChart?.height).toBeGreaterThanOrEqual(160);
  expect(layout.reviewDiff?.height).toBeGreaterThanOrEqual(100);
  expect(layout.footerDisplay).toBe('none');
  expect(layout.brandMark?.x).toBe(39);
  expect(layout.overviewLink?.x).toBe(14);
  expect(layout.overviewLink?.y).toBeCloseTo(92, 0);
  expect(layout.search?.width).toBe(410);
  expect(layout.search?.x).toBeGreaterThanOrEqual(layout.greeting!.x! + layout.greeting!.width!);
  expect(layout.search!.x! + layout.search!.width!).toBeLessThanOrEqual(layout.topActions!.x!);
  await expect(page.locator('.greeting h1')).toHaveText(/Good morning, .+ 👋/);
  await expect(page.locator('.greeting-desktop-copy')).toBeVisible();
});

test('Overview matches the supplied desktop display crop', async ({ page }) => {
  await page.setViewportSize({ width: 1522, height: 856 });
  await page.goto('http://127.0.0.1:4173/');
  await expect(page.locator('.metric-grid')).toBeVisible();
  const sidebarBackground = await page.locator('.sidebar').evaluate((sidebar) => getComputedStyle(sidebar).backgroundPosition);
  expect(sidebarBackground).toContain('91px');
  const timelineHeadingAlignment = await page.evaluate(() => {
    const icon = document.querySelector('.timeline-panel .section-icon svg')!.getBoundingClientRect();
    const title = document.querySelector('.timeline-panel h3')!.getBoundingClientRect();
    return icon.y + icon.height / 2 - title.y - title.height / 2;
  });
  expect(Math.abs(timelineHeadingAlignment)).toBeLessThanOrEqual(1);
  const headerIconTitleGaps = await page.evaluate(() => ['review', 'timeline'].map((panel) => {
    const root = document.querySelector(`.${panel}-panel .panel-heading`)!;
    const icon = root.querySelector('.section-icon svg')!.getBoundingClientRect();
    const title = root.querySelector('h3')!.getBoundingClientRect();
    return title.left - icon.right;
  }));
  expect(headerIconTitleGaps[1]).toBeCloseTo(headerIconTitleGaps[0], 0);
  const layout = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
    return {
      greeting: bounds('.greeting'), search: bounds('.search-box'), topActions: bounds('.top-actions'),
      metrics: bounds('.metric-grid'), workflow: bounds('.workflow-panel'), activity: bounds('.activity-panel'),
      objectives: bounds('.objective-panel'), review: bounds('.review-panel'), timeline: bounds('.timeline-panel'),
      footerDisplay: getComputedStyle(document.querySelector('.page-footer')!).display,
    };
  });
  expect(layout.metrics?.x).toBe(263);
  expect(layout.metrics?.y).toBe(84);
  expect(layout.workflow?.y).toBeCloseTo(189, 0);
  expect(layout.workflow?.height).toBe(202);
  expect(layout.activity?.x).toBeCloseTo(1142.9, 1);
  expect(layout.objectives?.y).toBeCloseTo(403, 0);
  expect(layout.review?.y).toBeCloseTo(573, 0);
  expect(layout.review?.height).toBe(220);
  expect(layout.timeline?.y).toBeCloseTo(573, 0);
  expect(layout.footerDisplay).toBe('none');
  expect(layout.search?.x).toBeGreaterThanOrEqual(layout.greeting!.x! + layout.greeting!.width!);
  expect(layout.search!.x! + layout.search!.width!).toBeLessThanOrEqual(layout.topActions!.x!);
});

test('mobile Overview keeps to the supplied phone summary', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, local: true, login: '' }),
  }));
  await page.goto('http://127.0.0.1:4173/');
  await expect(page.locator('.metric-grid .metric-card:visible')).toHaveCount(4);
  expect(await page.locator('.metric-card:visible .metric-top > span').evaluateAll((labels) =>
    labels.every((label) => getComputedStyle(label).whiteSpace === 'nowrap'))).toBe(true);
  await expect(page.locator('.mock-budget-summary small')).toBeVisible();
  await expect(page.locator('.metric-card:visible .mock-trend .mantine-Badge-root').nth(0)).toHaveText('↑ +3');
  await expect(page.locator('.metric-card:visible .mock-trend .mantine-Badge-root').nth(1)).toHaveText('● Live');
  expect(await page.locator('.metric-grid .metric-card:not(.pr-queue-metric) .mantine-Badge-label').evaluateAll((labels) =>
    labels.every((label) => label.scrollWidth <= label.clientWidth))).toBe(true);
  await expect(page.locator('.activity-list')).toContainText('Objective “Improve review velocity” updated');
  await expect(page.locator('.activity-panel')).toBeVisible();
  expect(await page.locator('.activity-list span').evaluateAll(labels =>
    labels.every(label => label.scrollWidth <= label.clientWidth))).toBe(true);
  const mobileOverviewLayout = await page.evaluate(() => {
    const brand = document.querySelector('.brand')!.getBoundingClientRect();
    const greeting = document.querySelector('.greeting')!.getBoundingClientRect();
    const metrics = document.querySelector('.metric-grid')!.getBoundingClientRect();
    const activity = document.querySelector('.activity-panel')!.getBoundingClientRect();
    const metricCard = document.querySelector('.metric-grid .metric-card:not(.pr-queue-metric)')!.getBoundingClientRect();
    return {
      brandTop: brand.top, greetingTop: greeting.top, metricTop: metrics.top, activityTop: activity.top,
      activityGap: activity.top - metrics.bottom, activityHeight: activity.height, metricCardHeight: metricCard.height,
    };
  });
  expect(mobileOverviewLayout.brandTop).toBeCloseTo(57, 0);
  expect(mobileOverviewLayout.greetingTop).toBeCloseTo(127, 0);
  expect(mobileOverviewLayout.metricTop).toBeCloseTo(272, 0);
  expect(mobileOverviewLayout.metricCardHeight).toBe(100);
  expect(mobileOverviewLayout.activityTop).toBeCloseTo(502, 0);
  expect(mobileOverviewLayout.activityGap).toBeCloseTo(18, 0);
  expect(mobileOverviewLayout.activityHeight).toBeGreaterThanOrEqual(245);
  await expect(page.locator('.greeting-mobile-copy')).toHaveText('Your engineering mission at a glance.');
  await expect(page.locator('.greeting-desktop-copy')).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Overview shortcuts' }).getByRole('link'))
    .toHaveText(['Overview', 'My Work', 'Alerts']);
  expect(await page.locator('.sidebar nav .nav-label[data-mobile-label]').first().evaluate(label =>
    getComputedStyle(label, '::after').fontSize)).toBe('12px');
  for (const selector of [
    '.workflow-panel', '.objective-panel', '.plan-panel', '.agents-panel', '.evidence-panel',
    '.review-panel', '.timeline-panel', '.analytics-panel',
  ]) await expect(page.locator(selector)).toBeHidden();
  await expect(page.locator('.sidebar nav')).toHaveCSS('position', 'fixed');
  await page.getByRole('navigation', { name: 'Overview shortcuts' }).getByRole('link', { name: 'My Work' }).click();
  await expect(page).toHaveURL(/#objectives$/);
  await page.getByRole('link', { name: 'Overview' }).first().click();
  await page.getByRole('navigation', { name: 'Overview shortcuts' }).getByRole('link', { name: 'Alerts' }).click();
  await expect(page).toHaveURL(/#activity$/);
  await expect(page.locator('.activity-panel')).toBeVisible();
});

