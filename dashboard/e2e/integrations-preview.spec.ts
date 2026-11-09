import { expect, test } from '@playwright/test';

test('local Integrations mock uses static content and keeps controls read only', async ({ page }) => {
  const apiRequests: { method: string; path: string }[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    apiRequests.push({ method: request.method(), path: new URL(request.url()).pathname });
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"preview fixture expected"}' });
  });
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#integrations');

  await expect(page.getByRole('heading', { name: 'Good morning, Alex' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Settings & Integrations' })).toBeVisible();
  await expect(page.getByText('All Systems Operational')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Integrations Overview' })).toBeVisible();
  await expect(page.locator('.system-preview-provider')).toHaveCount(10);
  await expect(page.locator('.system-preview-provider .system-preview-status')).toHaveCount(10);
  await expect(page.locator('.system-integration-filters span')).toHaveCount(6);
  await expect(page.locator('.system-preview-settings-grid > .system-preview-card')).toHaveCount(8);
  await expect(page.locator('.system-preview-policy')).toContainText('Human Approval (Prod)');
  await expect(page.locator('.system-preview-secrets')).toContainText('OPENAI_API_KEY');
  await expect(page.locator('.system-preview-audit tbody tr')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Test Connections' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Organization Name' })).toHaveValue('Zenchron Engineering');

  const columns = await page.locator('.system-preview-service-grid').evaluate((grid) =>
    getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length);
  const settingsColumns = await page.locator('.system-preview-settings-grid').evaluate((grid) =>
    getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length);
  expect(columns).toBe(4);
  expect(settingsColumns).toBe(3);
  expect(apiRequests.filter(({ path }) => path !== '/api/v1/auth/session')).toEqual([]);
  expect(apiRequests.filter(({ method }) => method !== 'GET')).toEqual([]);
});
