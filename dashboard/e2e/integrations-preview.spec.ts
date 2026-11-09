import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:4173' });

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
  await expect(page.locator('.system-preview-settings-badge')).toHaveCount(7);
  await expect(page.locator('.system-preview-provider-link-row button[aria-label*="options unavailable"]')).toHaveCount(10);
  await expect(page.locator('.system-preview-provider-link-row button[aria-label*="Reveal"]')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'More integration categories unavailable' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Last 24 hours' })).toBeDisabled();
  await expect(page.locator('.system-preview-add-integration')).toHaveCSS('border-top-style', 'dashed');
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

test('local Integrations preview keeps tabs on one line and audit table scrolls on phone', async ({ page }) => {
  await page.route('**/api/v1/**', async (route) => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"preview fixture expected"}' });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#integrations');

  await expect(page.getByRole('heading', { name: 'Integrations Overview' })).toBeVisible();
  await expect(page.locator('.system-tabs button')).toHaveCSS('white-space', 'nowrap');
  const mobileGrid = await page.locator('.system-preview-service-grid').evaluate((grid) => ({
    columns: getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length,
    grid: (() => { const { x, width } = grid.getBoundingClientRect(); return { x, width }; })(),
    firstCard: (() => { const { x, width } = grid.firstElementChild!.getBoundingClientRect(); return { x, width }; })(),
  }));
  expect(mobileGrid.columns, 'mobile providers use one full-width column').toBe(1);
  expect(mobileGrid.firstCard.x).toBeGreaterThanOrEqual(mobileGrid.grid.x);
  expect(mobileGrid.firstCard.x + mobileGrid.firstCard.width).toBeLessThanOrEqual(mobileGrid.grid.x + mobileGrid.grid.width);
  const auditScroller = page.locator('.system-preview-audit .system-preview-table-scroll');
  await expect(auditScroller).toBeVisible();
  expect(await auditScroller.evaluate((element) => element.scrollWidth > element.clientWidth),
    'audit table scrolls inside its card at phone width').toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'phone layout has no page-level horizontal overflow').toBe(true);
});

test('local Settings section shares the preview cards and marks its navigation active', async ({ page }) => {
  await page.route('**/api/v1/**', async (route) => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"preview fixture expected"}' });
  });
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#settings');

  await expect(page.locator('.system-tabs a.active')).toHaveText(/Settings/);
  await expect(page.locator('.system-config-nav a[aria-current="page"]')).toHaveText('Organization Profile');
  await expect(page.locator('.system-preview-settings-grid > .system-preview-card')).toHaveCount(8);
  await expect(page.locator('.system-preview-service-grid')).toHaveCount(0);
});
