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
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Zenchron Engineering' })).toBeVisible();
  const signIn = page.getByRole('link', { name: 'Continue with GitHub' });
  await expect(signIn).toHaveAttribute('href', '/auth/github');
  expect(dashboardRequests).toBe(0);
});
