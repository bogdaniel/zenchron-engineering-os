import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:4173' });

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
  await expect(page.locator('.reports-metric')).toHaveCount(7);
  await expect(page.locator('.reports-metric').nth(0)).toContainText('42');
  await expect(page.locator('.reports-metric').nth(6)).toContainText('68.4%');
  await expect(page.locator('.reports-empty-chart')).toHaveCount(0);
  await expect(page.locator('.report-outcome-legend > div')).toHaveCount(4);
  await expect(page.locator('.reports-outcomes-label b')).toHaveText('17,842');
  await expect(page.locator('.reports-outcomes-label')).toContainText('Work Items');
  const insightsHeading = page.locator('.reports-summary .reports-panel-heading h3');
  await expect(insightsHeading).toHaveCSS('white-space', 'nowrap');
  await expect(page.getByRole('combobox', { name: 'Insights view' })).toHaveCSS('width', '122px');
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
  await expect(page.locator('.reports-insight')).toHaveCount(5);
  const insightsFit = await page.locator('.reports-summary').evaluate((panel) => panel.scrollHeight <= panel.clientHeight);
  expect(insightsFit).toBe(true);
  await expect(page.getByRole('combobox', { name: 'Insights view' })).toHaveValue('Executive Summary');
  await expect(page.locator('.downloadable-report')).toHaveCount(4);
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
    'PDF file', 'XLSX file', 'CSV file', 'PDF file',
  ]);
  await expect(page.getByRole('button', { name: 'Apply filters' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Executive Summary unavailable' })).toBeDisabled();
  expect(apiRequests.filter(({ path }) => path !== '/api/v1/auth/session')).toEqual([]);
  expect(apiRequests.filter(({ method }) => method !== 'GET')).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#reports');
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
  await productTableRegion.focus();
  await expect(productTableRegion).toHaveCSS('outline-style', 'solid');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
