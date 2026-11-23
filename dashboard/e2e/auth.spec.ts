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

test('reports failed sign-out and keeps the session available to retry', async ({ page }) => {
  let logoutRequests = 0;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/auth/session') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ authenticated: true, local: false, login: 'Engineer' }) });
    }
    if (path === '/api/v1/auth/logout') {
      logoutRequests += 1;
      if (logoutRequests === 1) return route.fulfill({ status: 503, body: 'session revocation unavailable' });
      return route.abort('failed');
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.goto('/');
  const signOut = page.getByRole('button', { name: 'Sign out' });
  await expect(signOut).toBeVisible();
  await signOut.click();
  const error = page.getByRole('alert').filter({ hasText: 'Sign-out could not be confirmed.' });
  await expect(error).toHaveText('Sign-out could not be confirmed. Please try again.');
  await expect(signOut).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(error).toBeVisible();
  await expect(signOut).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await signOut.click();
  await expect(error).toHaveText('Sign-out could not be confirmed. Please try again.');
  await expect(signOut).toBeVisible();
  expect(logoutRequests).toBe(2);
});
