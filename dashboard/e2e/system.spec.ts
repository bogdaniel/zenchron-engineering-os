import { expect, test } from '@playwright/test';

test('settings and integrations routes show live runtime and honest provider states', async ({ page }) => {
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/');
  const runtimeHeartbeat = await page.evaluate(async () => {
    const response = await fetch('/api/v1/workers/ffffffffffffffffffffffffffffffff/heartbeat', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'model-runtime-test-worker', agent_runtime_enabled: true }),
    });
    const workers = await fetch('/api/v1/workers').then((result) => result.json());
    const legacyResponse = await fetch('/api/v1/workers/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/heartbeat', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'legacy-runtime-test-worker' }),
    });
    const updatedWorkers = await fetch('/api/v1/workers').then((result) => result.json());
    return {
      status: response.status,
      configured: workers.filter((worker: { id: string; agent_runtime_enabled: boolean }) =>
        worker.agent_runtime_enabled).length,
      legacyStatus: legacyResponse.status,
      unknown: updatedWorkers.filter((worker: { agent_runtime_enabled?: boolean }) =>
        worker.agent_runtime_enabled === undefined).length,
    };
  });
  expect(runtimeHeartbeat.status).toBe(200);
  expect(runtimeHeartbeat.configured).toBeGreaterThan(0);
  expect(runtimeHeartbeat.legacyStatus).toBe(200);
  expect(runtimeHeartbeat.unknown).toBeGreaterThan(0);
  await page.reload();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Integrations' }).click();
  await expect(page.getByRole('heading', { name: 'Settings & Integrations' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Local workers' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Configuration categories' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Integrations overview' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent audit log' })).toBeVisible();
  await expect(page.locator('.system-operation-card')).toHaveCount(8);
  await expect(page.locator('.system-operation-card .shared-panel-heading h3').first()).toHaveCSS('font-size', '14px');
  await expect(page.locator('.system-config-nav > a.active')).toHaveCSS('font-size', '10px');
  await expect(page.locator('.system-service-copy h4').first()).toHaveCSS('font-size', '13px');
  await expect(page.locator('.system-service-copy p').first()).toHaveCSS('font-size', '10px');
  await expect(page.locator('.system-operation-card p').first()).toHaveCSS('font-size', '11px');
  const integrationGrid = page.locator('.system-service-grid');
  const serviceCards = page.locator('.system-service-card');
  const configRail = await page.locator('.system-config-nav').boundingBox();
  const settingsTabs = await page.locator('.system-tabs').boundingBox();
  const integrationBounds = await integrationGrid.boundingBox();
  const operationsGrid = page.locator('.system-operations-grid');
  const geometry = await serviceCards.evaluateAll((cards) => cards.map((card) => {
    const { x, y, height } = card.getBoundingClientRect();
    return { x, y, height };
  }));
  const columns = await integrationGrid.evaluate((grid) =>
    getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length);
  const operationColumns = await operationsGrid.evaluate((grid) =>
    getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length);
  expect(columns).toBe(4);
  expect(operationColumns).toBe(3);
  expect(settingsTabs?.y).toBeCloseTo(140, 0);
  expect(configRail?.x).toBe(226);
  expect(configRail?.y).toBeCloseTo(177, 0);
  expect(configRail?.width).toBe(176);
  expect(integrationBounds?.x).toBe(configRail!.x + configRail!.width + 10);
  expect(geometry).toHaveLength(5);
  expect(geometry[0].y).toBe(geometry[3].y);
  expect(geometry[4].y).toBeGreaterThan(geometry[0].y);
  expect(geometry[0].height).toBeLessThanOrEqual(100);
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await expect(page.getByText('No GitHub repo', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Model endpoint' })).toBeVisible();
  await expect(page.getByText('Configured', { exact: true })).toBeVisible();
  const configuredWorkers = `${runtimeHeartbeat.configured} online worker${runtimeHeartbeat.configured === 1 ? '' : 's'}`;
  const unknownWorkers = `${runtimeHeartbeat.unknown} other online worker${runtimeHeartbeat.unknown === 1 ? '' : 's'}`;
  await expect(page.getByText(
    `OpenAI-compatible endpoint configured on ${configuredWorkers}. Status is unreported by ${unknownWorkers}.`
  )).toBeVisible();

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Settings' }).click();
  await expect(page.locator('.system-setting-card').filter({ hasText: 'Dashboard auth' })).toContainText('Local preview');
  await expect(page.getByText('Roles and permissions')).toBeVisible();
  const workerSettings = page.locator('.system-setting-card').filter({ hasText: 'Workers & projects' });
  await expect(workerSettings).toContainText('Local checkouts');
  await expect(page.getByText(
    `${runtimeHeartbeat.configured} configured · ${runtimeHeartbeat.unknown} unknown`, { exact: true }
  )).toBeVisible();
  await page.evaluate(() => { window.location.hash = '#integrations'; });
  await expect(page.getByRole('heading', { name: 'Integrations overview' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.system-health')).toContainText('API online');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Settings reflects an authenticated GitHub session', async ({ page }) => {
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: false, login: 'engineer' }),
  }));
  await page.goto('/');
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByText('GitHub OAuth', { exact: true })).toBeVisible();
  await expect(page.getByText('Allowlisted GitHub users')).toBeVisible();
  await expect(page.getByText('GitHub OAuth identifies users; organization roles and permissions are not enforced.')).toBeVisible();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Integrations' }).click();
  await expect(page.getByText('Authenticated API for workspace state and worker commands.')).toBeVisible();
  await expect(page.locator('.system-operation-card').filter({ hasText: 'Controller configuration' })).toContainText('GitHub OAuth');
});
