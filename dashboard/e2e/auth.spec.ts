import { expect, test } from '@playwright/test';

test('shows GitHub sign-in and keeps dashboard data gated without a session', async ({ page }) => {
  let dashboardRequests = 0;
  await page.route('**/api/v1/**', (route) => {
    if (route.request().url().endsWith('/api/v1/auth/session')) {
      return route.fulfill({ status: 401, body: 'authentication required' });
    }
    dashboardRequests += 1;
    return route.continue();
  });
  await page.goto('/#login');
  await expect(page.getByRole('heading', { name: 'Zenchron Engineering' })).toBeVisible();
  const signIn = page.getByRole('link', { name: 'Continue with GitHub' });
  await expect(signIn).toHaveAttribute('href', '/auth/github');
  expect(dashboardRequests).toBe(0);
});

test('keeps the selected Live dashboard destination through sign-in', async ({ page }) => {
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ status: 401, body: 'authentication required' }));
  await page.goto('/?mode=live&objective=objective-1&tab=plan&graph_id=graph-2&token=private#objectives');
  const signIn = page.getByRole('link', { name: 'Continue with GitHub' });
  await expect(signIn).toHaveAttribute('href',
    '/auth/github?return=%2F%3Fmode%3Dlive%26objective%3Dobjective-1%26tab%3Dplan%26graph_id%3Dgraph-2%23objectives');
});

test('drops an oversized selection but keeps the valid page and mode through sign-in', async ({ page }) => {
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ status: 401, body: 'authentication required' }));
  const oversizedTab = 'a'.repeat(257);
  await page.goto(`/?mode=live&tab=${oversizedTab}#agents`);
  await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toHaveAttribute('href',
    '/auth/github?return=%2F%3Fmode%3Dlive%23agents');
});

test('keeps the dashboard shell visible until a failed session check can be retried', async ({ page }) => {
  let sessionChecks = 0;
  let protectedRequests = 0;
  await page.route('**/api/v1/**', (route) => {
    if (route.request().url().endsWith('/api/v1/auth/session')) {
      sessionChecks += 1;
      return route.fulfill({ status: sessionChecks === 1 ? 503 : 200, contentType: 'application/json',
        body: JSON.stringify({ authenticated: true, local: true, login: 'Local workspace' }) });
    }
    protectedRequests += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Session check unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry session check' })).toBeVisible();
  expect(protectedRequests).toBe(0);

  await page.getByRole('button', { name: 'Retry session check' }).click();
  await expect(page.locator('.session-preview-card')).toHaveCount(0);
  await expect(page.locator('.metric-grid')).toBeVisible();
  await expect(page.locator('.topbar').getByText('Local workspace').first()).toBeVisible();
  await expect(page.locator('.topbar').getByText('Administrator')).toHaveCount(0);
  expect(sessionChecks).toBe(2);
  expect(protectedRequests).toBeGreaterThan(0);
});

test('local dashboard has a direct sign-in screen and explains when OAuth is unconfigured', async ({ page, baseURL }) => {
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: true, login: 'Local workspace' }) }));
  // The local origin on the suite's own port, so this never tests another checkout's server.
  const local = new URL(baseURL!);
  local.hostname = '127.0.0.1';
  await page.goto(`${local.origin}/`);
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${local.origin}/#login`);
  await expect(page.getByRole('heading', { name: 'Zenchron Engineering' })).toBeVisible();
  await expect(page.getByText(/GitHub sign-in is optional and is not configured for this installation/)).toBeVisible();
  await expect(page.getByText('zenchron-engineering auth setup', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toHaveCount(0);
});

test('local workspace explains that menu status does not need a Dashboard grant', async ({ page, baseURL }) => {
  let grantRequests = 0;
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/auth/session') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        authenticated: true, local: true, login: 'Local workspace',
      }) });
    }
    if (url.pathname.startsWith('/api/v1/system/status/credentials')) grantRequests += 1;
    if (url.pathname === '/api/v1/system/update') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        running_revision: 'local', latest_revision: 'local', state: 'idle', worker_compatible: true, active_runs: 0,
      }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  const local = new URL(baseURL!);
  local.hostname = '127.0.0.1';
  await page.goto(`${local.origin}/?mode=live#settings`);
  await expect(page.getByRole('heading', { name: 'Local workspace and GitHub sign-in' })).toBeVisible();
  await expect(page.getByText('zenchron-engineering auth setup', { exact: true })).toBeVisible();
  await expect(page.getByText(/managed updater uses separate GitHub credentials for protected-main verification/)).toBeVisible();
  await expect(page.getByText('Menu bar status already uses the managed local credential; pairing is not needed for local status.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pair this Mac' })).toHaveCount(0);
  expect(grantRequests).toBe(0);
});

test('local settings creates and revokes a one-time menu companion grant', async ({ page, baseURL }) => {
  const grants = ['existing-1', 'existing-2'].map((id) => ({ id, user: 'admin',
    created_at: '2026-11-22T00:00:00Z', expires_at: '2027-11-22T00:00:00Z' }));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/auth/session') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        authenticated: true, local: false, login: 'admin', admin: true,
      }) });
    }
    if (url.pathname === '/api/v1/system/status/credentials' && request.method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ grants }) });
    }
    if (url.pathname === '/api/v1/system/status/credentials' && request.method() === 'POST') {
      grants.push({ id: 'new-device', user: 'Local workspace', created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString() });
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ credential: 'one-time-status-grant' }) });
    }
    if (url.pathname === '/api/v1/system/status/credentials/new-device' && request.method() === 'DELETE') {
      grants.splice(2, 1);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  const local = new URL(baseURL!);
  local.hostname = '127.0.0.1';
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: local.origin });
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto(`${local.origin}/?mode=live#settings`);
  const pairButton = page.getByRole('button', { name: 'Pair this Mac' });
  const panel = page.locator('.system-companion-panel');
  const companionHeading = panel.locator('.system-update-heading h2');
  const updateHeading = page.locator('.system-update-panel:not(.system-companion-panel) .system-update-heading h2');
  expect(await companionHeading.evaluate((element) => getComputedStyle(element).fontSize))
    .toBe(await updateHeading.evaluate((element) => getComputedStyle(element).fontSize));
  const pairButtonBounds = await pairButton.boundingBox();
  const panelBounds = await panel.boundingBox();
  expect(pairButtonBounds?.width).toBeLessThan((panelBounds?.width ?? 0) / 2);
  expect(pairButtonBounds!.x + pairButtonBounds!.width).toBeGreaterThan(panelBounds!.x + panelBounds!.width / 2);
  await pairButton.click();
  await expect(page.getByText('one-time-status-grant')).toBeVisible();
  await expect(page.getByText(/Copy it, then choose Pair with Dashboard/i)).toBeVisible();
  const credentialBounds = await page.locator('.system-companion-credential').boundingBox();
  expect(credentialBounds?.width).toBeLessThan((panelBounds?.width ?? 0) / 2);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobilePanelBounds = await panel.boundingBox();
  expect(mobilePanelBounds?.width).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Copy for Menu Bar' }).click();
  await expect(page.getByText(/Credential copied/i)).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('one-time-status-grant');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async () => { throw new Error('clipboard denied'); } } });
    document.execCommand = () => true;
  });
  await page.getByRole('button', { name: 'Copy for Menu Bar' }).click();
  await expect(page.getByText(/Credential copied/i)).toBeVisible();
  await page.evaluate(() => { document.execCommand = () => false; });
  await page.getByRole('button', { name: 'Copy for Menu Bar' }).click();
  await expect(page.getByRole('alert')).toHaveText('Clipboard access failed; select the credential and press ⌘C.');
  await page.getByRole('button', { name: 'Revoke' }).last().click();
  await expect(page.getByText(/expires/i)).toHaveCount(2);
});
