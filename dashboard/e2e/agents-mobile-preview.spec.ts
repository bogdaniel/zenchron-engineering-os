import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:4173' });

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
  await page.getByRole('button', { name: /Run Agent/ }).click();
  await expect(page.getByRole('dialog', { name: 'Queue agent run' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: /New Review/ }).click();
  await expect(page).toHaveURL(/#reviews$/);
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible();
});
