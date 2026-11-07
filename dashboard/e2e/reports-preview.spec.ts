import { expect, test } from '@playwright/test';

test('local Reports mock renders its fixture without protected reads or exports', async ({ page }) => {
  const apiRequests: { method: string; path: string }[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    apiRequests.push({ method: request.method(), path: new URL(request.url()).pathname });
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"preview fixture expected"}' });
  });
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/?preview=mock#reports');

  await expect(page.getByText('Mock data')).toBeVisible();
  await expect(page.locator('.reports-metric')).toHaveCount(7);
  await expect(page.locator('.reports-metric').nth(0)).toContainText('42');
  await expect(page.locator('.reports-metric').nth(6)).toContainText('68.4%');
  await expect(page.locator('.reports-empty-chart')).toHaveCount(0);
  await expect(page.locator('.report-outcome-legend > div')).toHaveCount(4);
  await expect(page.locator('.reports-outcomes-layout .report-chart-label')).toHaveText('17,842');
  await expect(page.locator('.product-summary-panel tbody tr')).toHaveCount(5);
  await expect(page.locator('.inventory-panel tbody tr')).toHaveCount(5);
  await expect(page.locator('.reports-insight')).toHaveCount(5);
  await expect(page.getByRole('combobox', { name: 'Insights view' })).toHaveValue('Executive summary');
  await expect(page.locator('.downloadable-report')).toHaveCount(4);
  await expect(page.locator('.downloadable-report-format').evaluateAll((formats) =>
    formats.map((format) => format.getAttribute('aria-label')))).resolves.toEqual([
    'PDF file', 'XLSX file', 'CSV file', 'PDF file',
  ]);
  await expect(page.getByRole('button', { name: 'Apply filters' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Executive Summary unavailable' })).toBeDisabled();
  expect(apiRequests.filter(({ path }) => path !== '/api/v1/auth/session')).toEqual([]);
  expect(apiRequests.filter(({ method }) => method !== 'GET')).toEqual([]);
});
