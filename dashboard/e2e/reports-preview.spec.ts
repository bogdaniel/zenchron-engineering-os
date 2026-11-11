import { expect, test } from '@playwright/test';

const dashboardPort = Number((globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env?.ZENCHRON_E2E_DASHBOARD_PORT) || 4173;
test.use({ baseURL: `http://127.0.0.1:${dashboardPort}` });

test('local Reports mock renders its fixture without protected reads or exports', async ({ page }) => {
  const apiRequests: { method: string; path: string }[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    apiRequests.push({ method: request.method(), path: new URL(request.url()).pathname });
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"preview fixture expected"}' });
  });
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#reports');

  await expect(page.locator('.reports-page')).toHaveClass(/reports-design-preview/);
  await expect(page.getByRole('textbox', { name: 'Search pages' })).toHaveAttribute('placeholder', 'Search Zenchron…');
  await expect(page.locator('.reports-scope-bar [data-position="left"] svg')).toHaveCount(5);
  await expect(page.locator('.reports-page .mantine-Select-section[data-position="right"] .tabler-icon-chevron-down')).toHaveCount(6);
  await expect(page.locator('.reports-metric')).toHaveCount(7);
  await expect(page.locator('.reports-metric').nth(0)).toContainText('42');
  await expect(page.locator('.reports-metric').nth(6)).toContainText('68.4%');
  await expect(page.locator('.reports-metric').nth(0).locator(':scope > small')).toHaveText('PRs / week');
  for (let index = 1; index < 7; index++) {
    await expect(page.locator('.reports-metric').nth(index).locator(':scope > small')).toBeHidden();
  }
  await expect(page.locator('.reports-empty-chart')).toHaveCount(0);
  await expect(page.locator('.ci-distribution-panel .reports-chart-legend')).toHaveCount(0);
  for (const panel of ['.delivery-velocity-panel', '.review-latency-panel', '.acceptance-panel']) {
    const areas = page.locator(`${panel} .recharts-area-area`);
    expect(await areas.count(), `${panel} renders its shaded area series`).toBeGreaterThan(0);
    expect(await areas.evaluateAll((fills) => fills.every((fill) => Number(getComputedStyle(fill).fillOpacity) > 0)),
      `${panel} retains the mock's visible area fill`).toBe(true);
  }
  expect(await page.locator('.delivery-velocity-panel .recharts-area-area')
    .evaluateAll((fills) => new Set(fills.map((fill) => getComputedStyle(fill).fill)).size),
  'Delivery Velocity and Cycle Time keep their separate violet and teal areas').toBe(2);
  await expect(page.locator('.reports-pull-request-chart .recharts-dot').first()).toBeVisible();
  const mockDates = ['Jan 1', 'Jan 4', 'Jan 7', 'Jan 10', 'Jan 13', 'Jan 16', 'Jan 19', 'Jan 22', 'Jan 25', 'Jan 28', 'Jan 30'];
  for (const chart of ['reports-pull-request-chart', 'reports-latency-chart', 'reports-spend-chart', 'reports-acceptance-chart']) {
    const dates = (await page.locator(`.${chart} text`).allTextContents()).filter((label) => label.startsWith('Jan'));
    expect(dates, `${chart} date labels`).toEqual(mockDates);
  }
  const deliveryAxisLabels = await page.locator('.reports-pull-request-chart text').allTextContents();
  expect(deliveryAxisLabels).toContain('PRs / week');
  expect(deliveryAxisLabels).toContain('Cycle time (h)');
  expect(deliveryAxisLabels).toContain('Jan 28');
  await page.locator('.reports-pull-request-chart .recharts-dot').nth(10).hover();
  const deliveryTooltip = page.locator('.reports-pull-request-chart .recharts-tooltip-wrapper');
  await expect(deliveryTooltip).toContainText('Jan 30');
  await expect(deliveryTooltip).toContainText('13.6');
  await expect(deliveryTooltip).toContainText('42');
  await page.mouse.move(10, 10);
  const ciChartLabels = await page.locator('.reports-ci-chart text').allTextContents();
  expect(ciChartLabels).toEqual(expect.arrayContaining(['Runs', '0', '500', '1K', '1.5K', '2K', '2.5K']));
  await expect(page.locator('.reports-ci-axis-title')).toHaveText('CI Duration (minutes)');
  await expect(page.locator('.reports-ci-chart')).toHaveAttribute('aria-label',
    'Mock CI duration distribution by run count and CI duration in minutes');
  const ciBarColors = await page.locator('.reports-ci-chart .recharts-bar-rectangle path').evaluateAll((bars) =>
    [...new Set(bars.map((bar) => getComputedStyle(bar).fill))]);
  expect(ciBarColors.length, 'CI duration buckets use the mock color bands').toBeGreaterThan(1);
  const spendAxisLabels = await page.locator('.reports-spend-chart text').allTextContents();
  expect(spendAxisLabels, `spend chart axes: ${spendAxisLabels.join(', ')}`).toEqual(expect.arrayContaining([
    '$0', '$4K', '$8K', '$12K', '$16K', '$20K', '40%', '50%', '60%', '70%', '80%', '90%',
  ]));
  await expect(page.locator('.reports-latency-chart .recharts-dot').first()).toBeVisible();
  const latencyAxisLabels = await page.locator('.reports-latency-chart text').allTextContents();
  expect(latencyAxisLabels, `P50 latency axis: ${latencyAxisLabels.join(', ')}`)
    .toEqual(expect.arrayContaining(['0h', '4h', '8h', '12h', '16h', '20h']));
  await expect(page.locator('.report-outcome-legend > div')).toHaveCount(4);
  await expect(page.locator('.reports-outcomes-label b')).toHaveText('17,842');
  await expect(page.locator('.reports-outcomes-label')).toContainText('Work Items');
  const insightsHeading = page.locator('.reports-summary .reports-panel-heading h3');
  await expect(insightsHeading).toHaveCSS('white-space', 'nowrap');
  const insightsView = page.getByRole('combobox', { name: 'Insights view' });
  await expect(insightsView).toHaveCSS('width', '126px');
  expect(await insightsView.evaluate((input) => input.scrollWidth <= input.clientWidth),
    'the full Insights view value fits in the mock selector').toBe(true);
  const widths = await page.evaluate(() => Object.fromEntries(
    ['delivery-velocity-panel', 'ci-distribution-panel', 'review-latency-panel', 'agent-spend-panel',
      'acceptance-panel', 'reports-summary', 'product-summary-panel', 'inventory-panel', 'downloadable-reports-panel']
      .map((name) => [name, document.querySelector(`.${name}`)!.getBoundingClientRect().width]),
  ));
  expect(widths['delivery-velocity-panel']! / widths['ci-distribution-panel']!).toBeCloseTo(1.25, 1);
  expect(widths['review-latency-panel']! / widths['agent-spend-panel']!).toBeCloseTo(6 / 7, 1);
  expect(widths['reports-summary']! / widths['acceptance-panel']!).toBeCloseTo(5 / 6, 1);
  expect(widths['product-summary-panel']).toBeCloseTo(widths['inventory-panel'], 0);
  expect(widths['downloadable-reports-panel']! / widths['inventory-panel']!).toBeCloseTo(5 / 7, 1);
  await expect(page.locator('.product-summary-panel tbody tr')).toHaveCount(5);
  await expect(page.locator('.inventory-panel tbody tr')).toHaveCount(5);
  await expect(page.locator('.product-summary-panel tbody .reports-preview-row-icon')).toHaveCount(4);
  await expect(page.locator('.inventory-panel tbody .reports-preview-row-icon')).toHaveCount(4);
  await expect(page.locator('.reports-insight')).toHaveCount(5);
  await expect(page.locator('.reports-insight').first()).toHaveCSS('border-top-color', 'rgb(40, 83, 67)');
  await expect(page.locator('.reports-insight').first()).toHaveCSS('background-color', 'rgb(20, 36, 31)');
  await expect(page.locator('.reports-insight').nth(0).locator('> svg')).toHaveCSS('color', 'rgb(53, 214, 177)');
  await expect(page.locator('.reports-insight').nth(2).locator('> svg')).toHaveCSS('color', 'rgb(53, 214, 177)');
  await expect(page.locator('.reports-key-takeaway b')).toHaveCSS('display', 'inline');
  await expect(page.locator('.work-outcomes-panel .reports-panel-heading h3')).toHaveText('Work Outcomes (All Workflows)');
  await expect(page.locator('.work-outcomes-panel .reports-panel-heading p')).toHaveCount(0);
  const insightsFit = await page.locator('.reports-summary').evaluate((panel) => panel.scrollHeight <= panel.clientHeight);
  expect(insightsFit).toBe(true);
  await expect(page.getByRole('combobox', { name: 'Insights view' })).toHaveValue('Executive Summary');
  const latencyPercentiles = page.getByRole('group', { name: 'Illustrative review latency percentile' });
  await expect(latencyPercentiles.getByRole('button')).toHaveCount(3);
  await expect(latencyPercentiles.getByRole('button', { name: 'P50' })).toHaveAttribute('aria-pressed', 'true');
  await latencyPercentiles.getByRole('button', { name: 'P95' }).click();
  await expect(latencyPercentiles.getByRole('button', { name: 'P95' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.reports-latency-chart')).toHaveAttribute('aria-label', 'Illustrative P95 review latency trend');
  const p95LatencyAxisLabels = await page.locator('.reports-latency-chart text').allTextContents();
  expect(p95LatencyAxisLabels, `P95 latency axis: ${p95LatencyAxisLabels.join(', ')}`)
    .toEqual(expect.arrayContaining(['0h', '5h', '10h', '15h', '20h', '25h']));
  await expect(page.locator('.downloadable-report')).toHaveCount(4);
  await expect(page.locator('.downloadable-report-copy span').evaluateAll((details) =>
    details.every((detail) => getComputedStyle(detail).whiteSpace === 'normal'
      && detail.scrollWidth <= detail.clientWidth && detail.scrollHeight <= detail.clientHeight))).resolves.toBe(true);
  const downloadsFit = await page.locator('.downloadable-reports-panel').evaluate((panel) => {
    const panelBottom = panel.getBoundingClientRect().bottom;
    const lastReportBottom = panel.querySelector('.downloadable-report:last-child')!.getBoundingClientRect().bottom;
    return lastReportBottom <= panelBottom - 6;
  });
  expect(downloadsFit).toBe(true);
  const reportDetailsFit = await page.locator('.downloadable-report-copy span').evaluateAll((details) =>
    details.every((detail) => detail.scrollHeight <= detail.clientHeight));
  expect(reportDetailsFit).toBe(true);
  await expect(page.locator('.downloadable-report-format').evaluateAll((formats) =>
    formats.map((format) => format.getAttribute('aria-label')))).resolves.toEqual([
    'PDF file unavailable', 'XLSX file unavailable', 'CSV file unavailable', 'PDF file unavailable',
  ]);
  const previewDownloads = page.locator('.downloadable-report-button');
  await expect(previewDownloads).toHaveCount(4);
  expect(await previewDownloads.evaluateAll((buttons) => buttons.every((button) => (button as HTMLButtonElement).disabled))).toBe(true);
  await expect(previewDownloads.first()).toHaveAttribute('title', 'No download is available in this view');
  await expect(page.getByRole('button', { name: 'Apply Filters' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Reset' })).toBeEnabled();
  await expect(page.getByRole('combobox', { name: 'Repository' })).toBeEnabled();
  await expect(page.getByRole('combobox', { name: 'Workflow' })).toBeEnabled();

  await page.getByRole('combobox', { name: 'Time Range' }).click();
  await page.getByRole('option', { name: 'Last 90 Days' }).click();
  await page.getByRole('combobox', { name: 'Product' }).click();
  await page.getByRole('option', { name: 'Core Product' }).click();
  await page.getByRole('combobox', { name: 'Team' }).click();
  await page.getByRole('option', { name: 'Platform', exact: true }).click();
  await page.getByRole('combobox', { name: 'Workflow' }).click();
  await page.getByRole('option', { name: 'Nightly Regression Suite' }).click();
  await page.getByRole('combobox', { name: 'Repository' }).click();
  await page.getByRole('option', { name: 'zenchron/engineering-os' }).click();
  await expect(page.locator('.product-summary-panel tbody tr')).toHaveCount(5);
  await page.getByRole('button', { name: 'Apply Filters' }).click();
  await expect(page.locator('.work-outcomes-panel .shared-panel-heading h3'))
    .toHaveText('Work Outcomes (Nightly Regression Suite)');
  await expect(page.locator('.reports-preview-scope-status'))
    .toContainText('Nightly Regression Suite · zenchron/engineering-os');
  await expect(page.locator('.product-summary-panel tbody tr')).toHaveCount(2);
  await expect(page.locator('.product-summary-panel tbody')).toContainText('Core Product');
  await expect(page.locator('.inventory-panel tbody tr')).toHaveCount(2);
  await expect(page.locator('.inventory-panel tbody')).toContainText('Platform');
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByRole('combobox', { name: 'Time Range' })).toHaveValue('Last 30 Days');
  await expect(page.getByRole('combobox', { name: 'Product' })).toHaveValue('All Products');
  await expect(page.getByRole('combobox', { name: 'Team' })).toHaveValue('All Teams');
  await expect(page.getByRole('combobox', { name: 'Workflow' })).toHaveValue('All Workflows');
  await expect(page.getByRole('combobox', { name: 'Repository' })).toHaveValue('All Repositories');
  await expect(page.locator('.work-outcomes-panel .shared-panel-heading h3'))
    .toHaveText('Work Outcomes (All Workflows)');
  await expect(page.locator('.product-summary-panel tbody tr')).toHaveCount(5);
  await expect(page.locator('.inventory-panel tbody tr')).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Executive Summary download unavailable' })).toBeDisabled();
  expect(apiRequests.filter(({ path }) => path !== '/api/v1/auth/session')).toEqual([]);
  expect(apiRequests.filter(({ method }) => method !== 'GET')).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#reports');
  await page.getByRole('button', { name: 'P50' }).click();
  const mobileLatencyAxis = await page.locator('.reports-latency-chart text').allTextContents();
  expect(mobileLatencyAxis, `mobile P50 latency axis: ${mobileLatencyAxis.join(', ')}`)
    .toEqual(expect.arrayContaining(['0h', '4h', '8h', '12h', '16h', '20h']));
  const mobileTables = await page.locator('.report-summary-table-wrap').evaluateAll((wrappers) =>
    wrappers.map((wrapper) => ({
      clientWidth: wrapper.clientWidth,
      scrollWidth: wrapper.scrollWidth,
    })),
  );
  expect(mobileTables).toHaveLength(2);
  expect(mobileTables.every(({ clientWidth, scrollWidth }) => scrollWidth > clientWidth)).toBe(true);
  expect(await page.locator('.report-summary-table th, .report-summary-table td').evaluateAll((cells) =>
    cells.every((cell) => getComputedStyle(cell).whiteSpace === 'nowrap'))).toBe(true);
  const productTableRegion = page.getByRole('region', { name: 'Product delivery summary table' });
  await expect(productTableRegion).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('Tab');
  await productTableRegion.focus();
  await expect(productTableRegion).toHaveCSS('outline-style', 'solid');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
