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
  // Live has no settings to persist, so nothing on this page may write to the control plane.
  const writes: string[] = [];
  page.on('request', (request) => { if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`); });
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Integrations' }).click();
  await expect(page.getByRole('heading', { name: 'Settings & Integrations' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Local workers' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Configuration categories' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Integrations Overview' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent Audit Log' })).toBeVisible();
  await expect(page.locator('.system-preview-settings-grid > .system-preview-card')).toHaveCount(8);
  await expect(page.locator('.system-preview-card .shared-panel-heading h3').first()).toHaveCSS('font-size', '12px');
  await expect(page.locator('.system-config-nav > a.active')).toHaveCSS('font-size', '11px');
  await expect(page.locator('.system-config-nav svg')).toHaveCount(10);
  await expect(page.locator('.system-service-copy h4').first()).toHaveCSS('font-size', '12px');
  await expect(page.locator('.system-service-copy p').first()).toHaveCSS('font-size', '9px');
  await expect(page.locator('.system-preview-note').first()).toHaveCSS('font-size', '9px');
  const integrationGrid = page.locator('.system-preview-service-grid');
  const serviceCards = page.locator('.system-preview-provider');
  const configRail = await page.locator('.system-config-nav').boundingBox();
  const settingsTabs = await page.locator('.system-tabs').boundingBox();
  const integrationBounds = await integrationGrid.boundingBox();
  const settingsGrid = page.locator('.system-preview-settings-grid');
  const geometry = await serviceCards.evaluateAll((cards) => cards.map((card) => {
    const { x, y, height } = card.getBoundingClientRect();
    return { x, y, height };
  }));
  const columns = await integrationGrid.evaluate((grid) =>
    getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length);
  const settingsColumns = await settingsGrid.evaluate((grid) =>
    getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length);
  expect(columns).toBe(4);
  expect(settingsColumns).toBe(3);
  expect(settingsTabs?.y).toBeCloseTo(140, 0);
  expect(configRail?.x).toBe(263);
  expect(configRail?.y).toBeCloseTo(177, 0);
  expect(configRail?.width).toBe(176);
  expect(integrationBounds?.x).toBe(configRail!.x + configRail!.width + 10);
  expect(geometry).toHaveLength(12);
  expect(geometry[0].y).toBe(geometry[3].y);
  expect(geometry[4].y).toBeGreaterThan(geometry[0].y);
  expect(geometry[0].height, 'provider cards keep the approved height').toBeLessThanOrEqual(61);
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await expect(page.getByText('No GitHub repo', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Model endpoint' })).toBeVisible();
  await expect(page.getByText('Configured', { exact: true })).toBeVisible();
  const configuredWorkers = `${runtimeHeartbeat.configured} online worker${runtimeHeartbeat.configured === 1 ? '' : 's'}`;
  const unknownWorkers = `${runtimeHeartbeat.unknown} other online worker${runtimeHeartbeat.unknown === 1 ? '' : 's'}`;
  await expect(page.getByText(
    `OpenAI-compatible endpoint configured on ${configuredWorkers}. Status is unreported by ${unknownWorkers}.`
  )).toBeVisible();

  // Services the control plane does not integrate with are never shown as connected, and nothing can be edited.
  const gitlab = serviceCards.filter({ has: page.getByRole('heading', { name: 'GitLab' }) });
  await expect(gitlab).toContainText('Not connected');
  await expect(gitlab).toContainText('Not integrated with the control plane.');
  await expect(page.getByRole('switch', { name: 'GitLab connected' })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'GitLab connected' })).toBeDisabled();
  await expect(page.locator('.system-preview-status').filter({ hasText: /^Connected$/ })).toHaveCount(1);
  await expect(page.locator('.system-preview-add-integration')).toBeDisabled();
  await expect(page.locator('.system-preview-add-integration')).toContainText('Provider setup is not available from the control plane.');
  for (const name of ['Audit log', 'Import / Export', 'Activity & Audit', 'Discard Changes', 'Test Connections', 'Save Changes',
    'Add Policy', 'Add Secret', 'Add Rule', 'View Full Audit Log']) {
    await expect(page.getByRole('button', { name }).first(), `${name} is disabled in Live`).toBeDisabled();
  }
  await expect(page.getByRole('textbox', { name: 'Organization Name' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Organization Name' })).toHaveValue('Unavailable');
  await expect(page.locator('#system-preview-budget')).toContainText('Unavailable');
  await expect(page.locator('#system-preview-budget')).toContainText('Model spend, worker compute, and storage usage are not measured.');
  await expect(page.locator('#system-preview-policy')).toContainText('Merge rules, approval gates, and repository policy are not enforced.');
  await expect(page.locator('#system-preview-secrets tbody tr')).toHaveCount(0);
  await expect(page.locator('#system-preview-notifications')).toContainText('Run alerts and review notifications are not configured.');
  await expect(page.locator('#system-preview-audit')).toContainText('Audit history is unavailable until audit storage is implemented');
  await expect(page.locator('.system-page')).not.toContainText('OPENAI_API_KEY');
  await expect(page.locator('.system-page')).not.toContainText('$13.6k');

  // The design's rail and menus work on real data: filter by category, and read a card's full status.
  await page.getByRole('button', { name: 'Model Providers' }).click();
  await expect(serviceCards).toHaveCount(4);
  await page.getByRole('link', { name: 'Connected Integrations' }).click();
  await expect(serviceCards).toHaveCount(12);
  await page.getByRole('button', { name: 'Local workers options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Disconnect', exact: true })).toBeDisabled();
  await page.getByRole('menuitem', { name: 'View status' }).click();
  await expect(page.getByRole('dialog', { name: 'Local workers · Connected' })).toContainText('workers reporting a recent heartbeat.');
  await page.keyboard.press('Escape');

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Settings' }).click();
  await expect(integrationGrid).toHaveCount(0);
  const controller = page.locator('#system-preview-controller');
  await expect(controller.locator('.system-preview-controller-values').filter({ hasText: 'Dashboard auth' })).toContainText('Local preview');
  await expect(controller.locator('.system-preview-controller-values').filter({ hasText: 'State storage' })).toContainText('Versioned JSON snapshots');
  await expect(page.getByText('Roles and permissions')).toBeVisible();
  await expect(controller).toContainText('Local checkouts');
  await expect(controller).toContainText('Online workers');
  await expect(page.getByText(
    `${runtimeHeartbeat.configured} configured · ${runtimeHeartbeat.unknown} unknown`, { exact: true }
  )).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Auto-scale Runners' })).toBeDisabled();
  await expect(page.getByRole('slider', { name: 'Max Concurrent Runs' })).toBeDisabled();
  await page.evaluate(() => { window.location.hash = '#integrations'; });
  await expect(page.getByRole('heading', { name: 'Integrations Overview' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.system-health')).toContainText('API online');
  expect(await integrationGrid.evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length),
    'phone providers use one column').toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(writes, 'Live Settings & Integrations sends no write request').toEqual([]);
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
  await expect(page.locator('#system-preview-controller')).toContainText('Remote API access requires HTTPS and the configured worker bearer token.');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Settings' }).click();
  await expect(page.locator('#system-preview-controller .system-preview-controller-values').filter({ hasText: 'Dashboard auth' }))
    .toContainText('GitHub OAuth');
});
