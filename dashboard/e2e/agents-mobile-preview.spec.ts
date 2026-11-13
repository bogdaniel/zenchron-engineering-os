import { expect, test } from '@playwright/test';

const dashboardPort = Number((globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } })
  .process?.env?.ZENCHRON_E2E_DASHBOARD_PORT) || 4173;
// A local address, so the page opens in Mock; the port follows the suite so this never tests another checkout's server.
test.use({ baseURL: `http://127.0.0.1:${dashboardPort}` });

test('Agents phone preview matches the compact mobile reference and keeps profile management reachable', async ({ page }) => {
  const protectedReads: string[] = [];
  for (const endpoint of ['agents', 'agent-runs']) await page.route(`**/api/v1/${endpoint}`, (route) => {
    protectedReads.push(endpoint);
    return route.fulfill({ status: 401, body: 'authentication required' });
  });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 401, body: 'authentication required' }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#agents');

  await expect(page.locator('.agents-mobile-preview')).toBeVisible();
  await expect(page.locator('.notification-button')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.greeting')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Agents & Reviews' })).toBeVisible();
  await expect(page.locator('.agents-mobile-preview-label')).toHaveText('ILLUSTRATIVE DATA');
  await expect(page.locator('.agents-mobile-metrics')).toContainText('18');
  await expect(page.locator('.agents-mobile-metrics')).toContainText('42');
  await expect(page.locator('.agents-mobile-metrics')).toContainText('99.4%');
  await expect(page.locator('.agents-mobile-run')).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'Pull Request Reviews' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Evidence Health' })).toBeVisible();
  const quickActionsClearNavigation = await page.evaluate(() =>
    document.querySelector('.agents-mobile-quick-actions')!.getBoundingClientRect().bottom
      <= document.querySelector('.sidebar nav')!.getBoundingClientRect().top,
  );
  expect(quickActionsClearNavigation).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(protectedReads).toEqual([]);

  await page.getByRole('button', { name: /All Runs/ }).click();
  await expect(page.locator('.agent-row')).toHaveCount(6);
  await expect(page.getByRole('tab', { name: 'Run History' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '← Agents & Reviews' }).click();
  await expect(page.locator('.agents-mobile-preview')).toBeVisible();
});

test('Agents phone dashboard tabs and quick actions respond locally', async ({ page }) => {
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 401, body: 'authentication required' }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#agents');

  await page.getByRole('tab', { name: 'Reviews' }).click();
  await expect(page.getByRole('heading', { name: 'Pull Request Reviews' })).toBeVisible();
  await page.getByRole('tab', { name: 'Evidence' }).click();
  await expect(page.getByRole('heading', { name: 'Evidence Health' })).toBeVisible();
  await page.getByRole('tab', { name: 'Agents' }).click();
  // In Mock, Run Agent records a labelled simulated run and opens the profile's run history; nothing is queued.
  await page.getByRole('button', { name: /Run Agent/ }).click();
  await expect(page.getByRole('dialog', { name: 'Queue agent run' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Run History' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.agents-runs-list')).toContainText('SIMULATED · local preview run');
  await page.getByRole('button', { name: '← Agents & Reviews' }).click();
  await page.getByRole('button', { name: /New Review/ }).click();
  await expect(page).toHaveURL(/#reviews$/);
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible();
});
