import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: true, login: 'Reports E2E' }),
  }));
});

test('Reports panel rows match the desktop mockup proportions', async ({ page }) => {
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: true, login: 'Reports E2E' }),
  }));
  const projectID = 'a'.repeat(32);
  await page.route('**/api/v1/products', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.route('**/api/v1/projects', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify([{ id: projectID, name: 'Platform', branch: 'main', git_remote: 'github.com/acme/platform',
      worker_id: 'b'.repeat(32), worker_name: 'Mac', worker_status: 'online', last_seen: new Date().toISOString() }]),
  }));
  await page.route('**/api/v1/projects/*/pull-request-history*', (route) => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({ complete: true, items: Array.from({ length: 4 }, () => ({
      created_at: new Date().toISOString(), closed_at: null, merged_at: null,
    })) }),
  }));
  const runFinished = Date.now();
  await page.route('**/api/v1/projects/*/workflow-run-history*', (route) => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({ complete: true, items: Array.from({ length: 20 }, (_, index) => {
      const runStartedAt = new Date(runFinished - (index + 1) * 60_000).toISOString();
      return { created_at: runStartedAt, status: 'completed', conclusion: 'success', run_started_at: runStartedAt,
        updated_at: new Date(runFinished).toISOString() };
    }) }),
  }));
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#reports');
  await expect(page.locator('.reports-panel-heading > div > svg')).toHaveCount(10);
  await expect(page.locator('.reports-metric')).toHaveText([
    /Delivery Velocity/, /Cycle Time/, /CI Duration/, /Review Latency/, /Agent Spend/, /Acceptance Rate/,
    /Autonomous Completion/,
  ]);
  await expect(page.getByRole('heading', { name: 'Work outcomes' })).toBeVisible();
  const insightsHeading = page.locator('.reports-summary .reports-panel-heading h3');
  await expect(insightsHeading).toHaveText('Insights & Narrative');
  expect(await insightsHeading.evaluate((heading) =>
    heading.scrollHeight <= parseFloat(getComputedStyle(heading).lineHeight) + 1,
  ), 'Insights heading stays on one line at the mock viewport').toBe(true);
  await expect(page.getByRole('combobox', { name: 'Insights view' })).toBeVisible();
  await expect(page.locator('.reports-chart-legend')).toHaveCount(3);
  await expect(page.locator('.report-outcome-legend')).toBeVisible();
  await expect(page.locator('.reports-outcomes-layout .report-chart-label')).toHaveText('4');
  await expect(page.getByRole('heading', { name: 'Workspace summary' })).toBeVisible();
  await expect(page.locator('.product-summary-panel .report-summary-table tbody tr td')).toHaveText([
    'Unassigned repositories', '0 / wk', 'N/A', '10.5 min', 'N/A', 'N/A',
  ]);
  await expect(page.getByRole('group', { name: 'CI duration percentiles' }).locator('span'))
    .toHaveText(['p50 10.0m', 'p95 19.0m']);
  const percentileBounds = await page.getByRole('group', { name: 'CI duration percentiles' }).boundingBox();
  const ciPanelBounds = await page.locator('.ci-distribution-panel').boundingBox();
  expect(percentileBounds && ciPanelBounds).toBeTruthy();
  expect(percentileBounds!.x + percentileBounds!.width).toBeLessThanOrEqual(
    ciPanelBounds!.x + ciPanelBounds!.width - 8,
  );
  expect(await page.locator('.reports-metric .metric-top svg').first().evaluate((icon) => getComputedStyle(icon).order)).toBe('-1');
  await expect(page.locator('.downloadable-report')).toHaveCount(4);
  const downloadableFormats = await page.locator('.downloadable-report-format').evaluateAll((formats) =>
    formats.map((format) => format.getAttribute('aria-label')),
  );
  expect(downloadableFormats).toEqual(['CSV file', 'CSV file', 'CSV file', 'CSV file']);
  await expect(page.locator('.downloadable-report-format').first()).toHaveCSS('width', '30px');
  await expect(page.locator('.downloadable-report-format').first()).toHaveCSS('height', '30px');
  await expect(page.locator('.downloadable-reports-panel .shared-panel-heading p')).toHaveCount(0);
  await expect(page.locator('.downloadable-report-list')).toHaveCSS('row-gap', '0px');
  await expect(page.locator('.downloadable-report').first()).toHaveCSS('min-height', '34px');
  await expect(page.locator('.downloadable-report-copy b').first()).toHaveCSS('font-size', '11px');
  await expect(page.locator('.downloadable-report-copy span').first()).toHaveCSS('font-size', '9px');
  await expect(page.getByRole('button', { name: 'Download Agent Spend & Utilization CSV' })).toBeEnabled();
  await expect(page.locator('.reports-empty-chart')).toHaveCount(4);
  await expect(page.locator('.reports-empty-chart').first()).toHaveAttribute('role', 'status');
  await expect(page.locator('.reports-empty-chart').first())
    .toHaveAccessibleName('No merged pull requests in this period.');
  await expect(page.locator('.reports-empty-chart').first()).toContainText('No merged pull requests in this period.');
  const acceptanceTitle = page.locator('.acceptance-panel .reports-panel-heading h3');
  expect(await acceptanceTitle.evaluate((title) => title.scrollWidth <= title.clientWidth),
    'acceptance title stays on one line').toBe(true);
  const sectionBounds = await page.evaluate(() => Object.fromEntries(
    ['.reports-scope-bar', '.reports-metrics', '.reports-content-grid'].map((selector) => {
      const { y, height } = document.querySelector(selector)!.getBoundingClientRect();
      return [selector, { y, height }];
    }),
  ));
  expect(sectionBounds['.reports-scope-bar'].y).toBeCloseTo(94, 0);
  expect(sectionBounds['.reports-scope-bar'].height).toBeCloseTo(57, 0);
  expect(sectionBounds['.reports-metrics'].y).toBeCloseTo(163, 0);
  expect(sectionBounds['.reports-metrics'].height).toBe(88);
  expect(sectionBounds['.reports-content-grid'].y).toBeCloseTo(265, 0);
  const rows = await page.locator('.reports-content-grid > *').evaluateAll((panels) => panels.map((panel) => {
    const { x, y, width, height } = panel.getBoundingClientRect();
    return { classes: Array.from(panel.classList), x, y, width, height };
  }));
  expect(rows).toHaveLength(10);
  const panel = (name: string) => rows.find((row) => row.classes.includes(name))!;
  const delivery = panel('delivery-velocity-panel');
  const ci = panel('ci-distribution-panel');
  const outcomes = panel('work-outcomes-panel');
  const review = panel('review-latency-panel');
  const spend = panel('agent-spend-panel');
  const acceptance = panel('acceptance-panel');
  const coverage = panel('reports-summary');
  const product = panel('product-summary-panel');
  const inventory = panel('inventory-panel');
  const downloads = panel('downloadable-reports-panel');
  expect(delivery.x).toBe(263);
  expect(Math.abs(delivery.height - 175)).toBeLessThanOrEqual(2);
  expect(Math.abs(outcomes.height - 175)).toBeLessThanOrEqual(2);
  expect(Math.abs(product.height - 188)).toBeLessThanOrEqual(2);
  expect(delivery.y).toBe(ci.y);
  expect(ci.y).toBe(outcomes.y);
  expect(Math.abs(review.height - 168)).toBeLessThanOrEqual(1);
  expect(review.y).toBe(spend.y);
  expect(review.y).toBe(acceptance.y);
  expect(acceptance.y).toBe(coverage.y);
  expect(Math.abs(product.y - (review.y + review.height + 11))).toBeLessThanOrEqual(1);
  expect(product.y).toBe(inventory.y);
  expect(inventory.y).toBe(downloads.y);
  expect(delivery.width).toBeGreaterThan(ci.width);
  expect(ci.width).toBeGreaterThan(outcomes.width);
  expect(spend.width).toBeGreaterThan(review.width);
  expect(acceptance.width).toBeGreaterThanOrEqual(review.width);
  expect(coverage.width).toBeLessThan(acceptance.width);
  expect(downloads.width).toBeLessThan(inventory.width);
  expect(coverage.width).toBeCloseTo(downloads.width, 0);
  expect(coverage.height).toBeGreaterThan(product.y + product.height - coverage.y - 1);
  const acceptanceChart = page.locator('.acceptance-panel .reports-empty-chart');
  const acceptanceLayout = await acceptanceChart.evaluate((chart) => {
    const panel = chart.closest('.acceptance-panel')!;
    return { bottom: chart.getBoundingClientRect().bottom, panelBottom: panel.getBoundingClientRect().bottom,
      paddingBottom: parseFloat(getComputedStyle(panel).paddingBottom) };
  });
  expect(acceptanceLayout.bottom).toBeLessThanOrEqual(acceptanceLayout.panelBottom - acceptanceLayout.paddingBottom);
  await expect(page.locator('.reports-summary')).toContainText('Key takeaway');
  await expect(page.locator('.reports-key-takeaway')).toContainText(
    'Pull-request outcomes in this scope: 0 merged · 0 closed unmerged · 4 open.',
  );
  await expect(page.locator('.reports-insight').filter({ hasText: 'Delivery sources' }))
    .toContainText('0 merged pull requests from 1 GitHub repository.');
  await expect(page.locator('.reports-summary')).toContainText('Worker availability');
  await page.getByRole('combobox', { name: 'Insights view' }).click();
  await page.getByRole('option', { name: 'Delivery' }).click();
  await expect(page.locator('.reports-insight')).toHaveCount(1);
  await expect(page.locator('.reports-insight')).toContainText('Delivery sources');

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.locator('.reports-content-grid > *').evaluateAll((panels) => panels.map((panel) => {
    const { x, y, width, height } = panel.getBoundingClientRect();
    return { x, y, width, height };
  }));
  expect(mobile).toHaveLength(10);
  expect(Math.max(...mobile.map(({ x, width }) => x + width))).toBeLessThanOrEqual(390);
  expect(mobile.every((panel, index) => index === 0 || panel.y > mobile[index - 1].y)).toBe(true);
});

test('Reports headings fit the mock display viewport', async ({ page }) => {
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: true, login: 'Reports E2E' }),
  }));
  await page.setViewportSize({ width: 1505, height: 847 });
  await page.goto('/#reports');

  const pageDescription = page.locator('.reports-greeting .page-heading p');
  expect(await pageDescription.evaluate((description) => description.scrollWidth <= description.clientWidth),
    'Reports subtitle remains fully readable').toBe(true);

  const acceptanceTitle = page.locator('.acceptance-panel .reports-panel-heading h3');
  const acceptanceBounds = await acceptanceTitle.evaluate((title) => {
    const { right } = title.getBoundingClientRect();
    const panel = title.closest('.acceptance-panel')!.getBoundingClientRect();
    return { right, panelRight: panel.right };
  });
  expect(acceptanceBounds.right).toBeLessThanOrEqual(acceptanceBounds.panelRight - 8);

  const insightsTitle = page.locator('.reports-summary .reports-panel-heading h3');
  const filter = page.locator('.reports-insight-filter');
  const [titleBounds, filterBounds] = await Promise.all([insightsTitle.boundingBox(), filter.boundingBox()]);
  expect(titleBounds && filterBounds).toBeTruthy();
  expect(Math.abs(titleBounds!.y - filterBounds!.y)).toBeLessThanOrEqual(1);
  await expect(filter).toHaveCSS('width', '122px');
  await expect(filter.locator('input')).toHaveCSS('font-size', '8px');
  await expect(filter.locator('input')).toHaveValue('Executive Summary');

  const reportTitlesFit = await page.locator('.downloadable-report-copy b').evaluateAll((titles) =>
    titles.every((title) => title.scrollWidth <= title.clientWidth &&
      title.getBoundingClientRect().height <= parseFloat(getComputedStyle(title).lineHeight) + 1),
  );
  expect(reportTitlesFit, 'download report names remain fully readable').toBe(true);
  const reportDetailsFit = await page.locator('.downloadable-report-copy span').evaluateAll((details) =>
    details.every((detail) => detail.scrollHeight <= detail.clientHeight &&
      detail.getBoundingClientRect().height <= parseFloat(getComputedStyle(detail).lineHeight) + 1),
  );
  expect(reportDetailsFit, 'download report source details remain fully readable').toBe(true);
  const lastReportBounds = await page.locator('.downloadable-report').last().boundingBox();
  const reportsPanelBounds = await page.locator('.downloadable-reports-panel').boundingBox();
  expect(lastReportBounds && reportsPanelBounds).toBeTruthy();
  expect(lastReportBounds!.y + lastReportBounds!.height).toBeLessThanOrEqual(
    reportsPanelBounds!.y + reportsPanelBounds!.height - 6,
  );
});

test('30-day run metrics exclude future and invalid timestamps', async ({ page }) => {
  const now = Date.now();
  const run = (id: string, created_at: string) => ({
    id, agent_id: 'a'.repeat(32), agent_name: 'Reviewer', project_id: 'b'.repeat(32), project_name: 'Platform',
    worker_id: 'c'.repeat(32), worker_name: 'Mac', branch: `agent/${id}`, prompt: 'Review changes.',
    status: 'succeeded', attempts: 1, created_at, updated_at: created_at,
  });
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      run('recent', new Date(now - 24 * 60 * 60 * 1000).toISOString()),
      run('future', new Date(now + 24 * 60 * 60 * 1000).toISOString()),
      run('invalid', 'not-a-date'),
    ]),
  }));

  await page.goto('/#reports');
  const agentActivity = page.locator('.reports-insight').filter({ hasText: 'Agent activity' });
  await expect(agentActivity).toContainText('1 recorded run in this period');
  await expect(agentActivity).toContainText('100% terminal success');
  await page.goto('/#agents');
  await expect(page.locator('.agents-metric').filter({ hasText: 'Total runs (30d)' }).locator('strong')).toHaveText('1');
});

test('work outcomes count merged, closed unmerged, and open pull requests in range', async ({ page }) => {
  const now = Date.now();
  const stamp = (hoursAgo: number) => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString();
  const projectID = 'a'.repeat(32);
  await page.route('**/api/v1/projects', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify([{ id: projectID, name: 'Platform', branch: 'main', git_remote: 'github.com/acme/platform',
      worker_id: 'b'.repeat(32), worker_name: 'Mac', worker_status: 'online', last_seen: stamp(0) }]),
  }));
  await page.route('**/api/v1/projects/*/pull-request-history*', (route) => route.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({ complete: true, items: [
      { created_at: stamp(24), closed_at: stamp(3), merged_at: stamp(3) },
      { created_at: stamp(24), closed_at: stamp(2), merged_at: null },
      { created_at: stamp(1), closed_at: null, merged_at: null },
      { created_at: stamp(-1), closed_at: null, merged_at: null },
      { created_at: stamp(31 * 24), closed_at: stamp(32 * 24), merged_at: stamp(32 * 24) },
    ] }),
  }));

  await page.goto('/#reports');
  await expect(page.locator('.reports-outcomes-layout .report-chart-label')).toHaveText('3');
  const legend = page.locator('.report-outcome-legend');
  await expect(legend.locator('> div')).toHaveText([
    /Merged\s*1/, /Closed unmerged\s*1/, /Open\s*1/,
  ]);
  await expect(page.locator('.work-outcomes-panel .shared-panel-heading p'))
    .toHaveText('Pull request status · last 30 days');
});

test('workspace summary does not infer autonomy when agent runs fail to load', async ({ page }) => {
  await page.route('**/api/v1/objectives', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.route('**/api/v1/projects', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/#reports');
  await expect(page.locator('.inventory-panel .report-summary-table tbody tr td')).toHaveText([
    'Local workspace', '0', 'N/A', 'N/A', 'N/A', 'N/A',
  ]);
});

test('Reports derives GitHub delivery metrics from complete pull-request history', async ({ page }) => {
  const now = Date.now();
  const stamp = (hoursAgo: number) => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString();
  const stampMinutes = (minutesAgo: number) => new Date(now - minutesAgo * 60 * 1000).toISOString();
  const projectID = 'a'.repeat(32);
  await page.route('**/api/v1/projects', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      {
        id: projectID, name: 'Platform', branch: 'main', git_remote: 'github.com/acme/platform',
        worker_id: 'b'.repeat(32), worker_name: 'Mac', worker_status: 'online', last_seen: stamp(0),
      },
      {
        id: 'e'.repeat(32), name: 'Local Only', branch: 'main', git_remote: '',
        worker_id: 'b'.repeat(32), worker_name: 'Mac', worker_status: 'online', last_seen: stamp(0),
      },
    ]),
  }));
  await page.route('**/api/v1/projects/*/pull-request-history*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      complete: true,
      items: [
        { state: 'closed', created_at: stamp(72), updated_at: stamp(24), closed_at: stamp(24), merged_at: stamp(24) },
        { state: 'closed', created_at: stamp(48), updated_at: stamp(12), closed_at: stamp(12), merged_at: stamp(12) },
        { state: 'closed', created_at: stamp(36), updated_at: stamp(6), closed_at: stamp(6), merged_at: null },
      ],
    }),
  }));
  await page.route('**/api/v1/projects/*/workflow-run-history*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ complete: true, items: [
      { created_at: stampMinutes(80), status: 'completed', run_started_at: stampMinutes(80), updated_at: stampMinutes(72) },
      { created_at: stampMinutes(60), status: 'completed', run_started_at: stampMinutes(60), updated_at: stampMinutes(48) },
      { created_at: stampMinutes(1), status: 'in_progress', run_started_at: stampMinutes(1), updated_at: stampMinutes(0) },
      { created_at: stamp(31 * 24), status: 'completed', run_started_at: stamp(31 * 24), updated_at: stampMinutes(0) },
    ] }),
  }));
  await page.goto('/#reports');
  await expect(page.locator('.reports-metric').filter({ hasText: /Delivery Velocity/i }).locator('strong')).toHaveText('0.5');
  await expect(page.locator('.reports-metric').filter({ hasText: /Cycle Time/i }).locator('strong')).toHaveText('42');
  await expect(page.locator('.reports-metric').filter({ hasText: /Acceptance Rate/i }).locator('strong')).toHaveText('67%');
  await expect(page.locator('.reports-metric').filter({ hasText: /CI Duration/i }).locator('strong')).toHaveText('10');
  for (const label of ['Delivery Velocity', 'Cycle Time', 'CI Duration', 'Acceptance Rate']) {
    await expect(page.getByRole('img', { name: `${label} trend` })).toBeVisible();
  }
  await expect(page.locator('.reports-ci-chart')).toBeVisible();
  await expect(page.locator('.reports-ci-chart .recharts-rectangle')).toHaveCount(2);
  const acceptanceChart = page.locator('.acceptance-panel .reports-acceptance-chart');
  const chartBounds = await acceptanceChart.evaluate((chart) => {
    const panel = chart.closest('.acceptance-panel')!;
    return { chart: chart.getBoundingClientRect().bottom, panel: panel.getBoundingClientRect().bottom,
      padding: parseFloat(getComputedStyle(panel).paddingBottom) };
  });
  expect(chartBounds.chart).toBeLessThanOrEqual(chartBounds.panel - chartBounds.padding);
  await expect(page.locator('.reports-ci-chart .recharts-cartesian-axis-tick-value').first())
    .toHaveCSS('fill', 'rgb(150, 145, 168)');
  const trend = page.locator('.reports-pull-request-chart');
  await expect(trend).toBeVisible();
  await expect(page.locator('.delivery-velocity-panel .reports-chart-legend')).toContainText('Delivery Velocity (PRs/week)');
  await expect(page.locator('.delivery-velocity-panel .reports-chart-legend')).toContainText('Cycle Time (hours)');
  await expect(trend.locator('.recharts-line')).toHaveCount(2);
  await expect(trend.locator('.recharts-cartesian-axis-tick-value').first())
    .toHaveCSS('fill', 'rgb(150, 145, 168)');
  await expect(page.locator('.reports-insight').filter({ hasText: 'Delivery sources' }))
    .toContainText('1 checkout has no remote');
});

test('Reports explains complete provider histories with no chart events', async ({ page }) => {
  const projectID = 'a'.repeat(32);
  await page.route('**/api/v1/projects', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{
      id: projectID, name: 'Platform', branch: 'main', git_remote: 'github.com/acme/platform',
      worker_id: 'b'.repeat(32), worker_name: 'Mac', worker_status: 'online', last_seen: new Date().toISOString(),
    }]),
  }));
  await page.route('**/api/v1/projects/*/pull-request-history*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ complete: true, items: [] }),
  }));
  await page.route('**/api/v1/projects/*/workflow-run-history*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ complete: true, items: [] }),
  }));
  await page.goto('/#reports');
  await expect(page.locator('.delivery-velocity-panel .reports-empty-chart'))
    .toContainText('No merged pull requests in this period.');
  await expect(page.locator('.ci-distribution-panel .reports-empty-chart'))
    .toContainText('No completed GitHub Actions runs in this period.');
  await expect(page.locator('.work-outcomes-panel .reports-empty'))
    .toHaveText('No pull requests match this report scope.');
  await expect(page.locator('.reports-key-takeaway')).toContainText('No pull-request activity was recorded in this scope.');
  await expect(page.locator('.reports-metric').filter({ hasText: /Delivery Velocity/i }).locator('strong')).toHaveText('0');
  await expect(page.locator('.reports-metric').filter({ hasText: /CI Duration/i }).locator('strong')).toHaveText('Unavailable');
});

test('Reports suppresses GitHub delivery metrics when PR history is truncated', async ({ page }) => {
  const projectID = 'c'.repeat(32);
  await page.route('**/api/v1/projects', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{
      id: projectID, name: 'Platform', branch: 'main', git_remote: 'github.com/acme/platform',
      worker_id: 'd'.repeat(32), worker_name: 'Mac', worker_status: 'online', last_seen: new Date().toISOString(),
    }]),
  }));
  await page.route('**/api/v1/projects/*/pull-request-history*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ complete: false, items: [] }),
  }));
  await page.route('**/api/v1/projects/*/workflow-run-history*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ complete: false, items: [
      { created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), status: 'completed', run_started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString() },
    ] }),
  }));
  await page.goto('/#reports');
  await expect(page.locator('.reports-metric').filter({ hasText: /Delivery Velocity/i }).locator('strong')).toHaveText('Unavailable');
  await expect(page.locator('.reports-metric').filter({ hasText: /Cycle Time/i }).locator('strong')).toHaveText('Unavailable');
  await expect(page.locator('.reports-metric').filter({ hasText: /CI Duration/i }).locator('strong')).toHaveText('Unavailable');
  await expect(page.locator('.ci-distribution-panel .reports-empty-chart'))
    .toContainText('Waiting for complete GitHub Actions history.');
  await expect(page.locator('.delivery-velocity-panel .reports-empty-chart'))
    .toContainText('Waiting for complete GitHub pull-request history.');
  await expect(page.locator('.reports-metric .metric-sparkline')).toHaveCount(0);
  await expect(page.locator('.reports-insight').filter({ hasText: 'Delivery sources' }))
    .toContainText('2,000 pull-request report limit');
  await expect(page.locator('.reports-key-takeaway')).toContainText('2,000 pull-request report limit');
});

test('report scope filters live snapshots by product and resets them', async ({ page }) => {
  const now = Date.now();
  const stamp = (daysAgo: number) => new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  const productID = 'a'.repeat(32);
  const firstProjectID = 'b'.repeat(32);
  const secondProjectID = 'c'.repeat(32);
  const workerID = 'd'.repeat(32);
  const objective = (id: string, product_id: string, owner: string, created_at: string) => ({
    id, title: `Objective ${id[0]}`, description: '', owner, product: 'Nova Platform', product_id,
    status: 'in_progress', progress: 40, due_date: '', created_at, updated_at: created_at,
  });
  const project = (id: string, name: string) => ({
    id, name, branch: 'main', git_remote: '', worker_id: workerID, worker_name: 'Mac',
    worker_status: 'online', last_seen: new Date(now).toISOString(),
  });
  const run = (id: string, project_id: string) => ({
    id, agent_id: 'e'.repeat(32), agent_name: 'Reviewer', project_id, project_name: 'Nova Platform',
    worker_id: workerID, worker_name: 'Mac', branch: `agent/${id}`, prompt: 'Review changes.',
    status: 'succeeded', attempts: 1, created_at: stamp(2), updated_at: stamp(2),
  });
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/v1/objectives', (route) => route.fulfill(json([
    objective('f'.repeat(32), productID, 'Platform', stamp(2)),
    objective('1'.repeat(32), '2'.repeat(32), 'Data', stamp(2)),
  ])));
  await page.route('**/api/v1/projects', (route) => route.fulfill(json([
    project(firstProjectID, 'nova-api'), project(secondProjectID, 'data-pipeline'),
  ])));
  await page.route('**/api/v1/workers', (route) => route.fulfill(json([{
    id: workerID, name: 'Mac', status: 'online', last_seen: new Date(now).toISOString(), agent_runtime_enabled: false,
  }])));
  await page.route('**/api/v1/products', (route) => route.fulfill(json([{
    id: productID, name: 'Nova Platform', description: '', repository_ids: [firstProjectID],
    created_at: stamp(20), updated_at: stamp(2),
  }])));
  await page.route('**/api/v1/agents', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill(json([
    run('3'.repeat(32), firstProjectID), run('4'.repeat(32), secondProjectID),
  ])));
  await page.addInitScript(() => {
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download.endsWith('.csv')) {
        (window as Window & { downloadedCSV?: Promise<string> }).downloadedCSV = fetch(this.href)
          .then((response) => response.text());
      }
      originalClick.call(this);
    };
  });

  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#reports');
  await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
  await expect(page.getByLabel('Workflow filter unavailable because runs are not linked to workflows')).toBeDisabled();
  await expect(page.locator('.work-outcomes-panel .reports-empty'))
    .toHaveText('Connect a supported GitHub repository to view pull-request outcomes.');
  await expect(page.locator('.work-outcomes-panel .shared-panel-heading p'))
    .toHaveText('Pull request status · last 30 days');
  await page.getByRole('combobox', { name: 'Time range' }).click();
  await page.getByRole('option', { name: 'Last 90 days' }).click();
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.locator('.work-outcomes-panel .shared-panel-heading p'))
    .toHaveText('Pull request status · last 90 days');
  const workspaceItems = page.locator('.inventory-panel .report-summary-table tbody tr td').nth(1);
  await expect(workspaceItems).toHaveText('2');
  await page.getByRole('combobox', { name: 'Objective owner' }).click();
  await page.getByRole('option', { name: 'Platform', exact: true }).click();
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(workspaceItems).toHaveText('1');
  await expect(page.locator('.reports-insight').filter({ hasText: 'Agent activity' })).toContainText('2 recorded runs');
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(workspaceItems).toHaveText('2');
  await page.getByRole('combobox', { name: 'Product' }).click();
  await page.getByRole('option', { name: 'Nova Platform' }).click();
  await expect(workspaceItems).toHaveText('2');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(workspaceItems).toHaveText('1');
  await expect(page.locator('.reports-insight').filter({ hasText: 'Agent activity' }))
    .toContainText('1 recorded run in this period');
  await expect(page.locator('.reports-insight').filter({ hasText: 'Delivery sources' }))
    .toContainText('No Git remotes are configured for these checkouts.');
  const productRow = page.locator('.product-summary-panel .report-summary-table tbody tr')
    .filter({ hasText: 'Nova Platform' });
  await expect(productRow.locator('td')).toHaveText([
    'Nova Platform', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A',
  ]);
  await expect(productRow.locator('td abbr').first()).toHaveAttribute('aria-label', 'Unavailable');
  expect(await page.locator('.report-summary-table-wrap').first().evaluate((table) =>
    table.scrollWidth <= table.clientWidth,
  ), 'product summary table fits its desktop card').toBe(true);
  const downloadCsv = async (name: string) => {
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: `Download ${name} CSV` }).click();
    const download = await downloadPromise;
    const csv = await page.evaluate(async () =>
      await (window as Window & { downloadedCSV?: Promise<string> }).downloadedCSV,
    );
    return { filename: download.suggestedFilename(), csv };
  };
  const executive = await downloadCsv('Executive Summary');
  expect(executive.filename).toMatch(/^zenchron-executive-summary-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(executive.csv).toContain('"Objectives","1"');
  expect(executive.csv).toContain('"Local checkouts","1"');
  const detailed = await downloadCsv('Detailed Metrics');
  expect(detailed.filename).toMatch(/^zenchron-detailed-metrics-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(detailed.csv).toContain('"Delivery velocity","Unavailable","No Git remotes are configured for these checkouts."');
  const spend = await downloadCsv('Agent Spend & Utilization');
  expect(spend.filename).toMatch(/^zenchron-agent-spend-utilization-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(spend.csv).toContain('"Spend (USD)","Usage","Source"');
  expect(spend.csv).toContain('"Reviewer","Nova Platform"');
  expect(spend.csv).toContain('"Provider usage records are not connected"');
  const workspace = await downloadCsv('Product & Workspace Report');
  expect(workspace.filename).toMatch(/^zenchron-product-workspace-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(workspace.csv).toContain('"Velocity (PRs/week)"');
  expect(workspace.csv).toContain('"Product","Nova Platform","1","1","1"');
  expect(workspace.csv).toContain('"Workspace","Local workspace"');
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(workspaceItems).toHaveText('2');
});
