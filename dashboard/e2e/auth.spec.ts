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
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeDisabled();
  await expect(page.getByText('GitHub sign-in is not configured in this local preview.')).toBeVisible();
});
