import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:4173' });

test('local Reviews mock uses its fixture without provider reads or review writes', async ({ page }) => {
  await page.setViewportSize({ width: 1672, height: 941 });
  const apiRequests: { method: string; path: string }[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    apiRequests.push({ method: request.method(), path: new URL(request.url()).pathname });
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"preview fixture expected"}' });
  });

  await page.goto('/#reviews');

  await expect(page.locator('.reviews-page')).toHaveAttribute('data-preview', 'mock');
  await expect(page.locator('.reviews-metric').nth(0)).toContainText('428');
  await expect(page.locator('.reviews-metric').nth(5)).toContainText('99.2%');
  await expect(page.getByRole('button', { name: 'All Repos' })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'GitHub repository' })).toHaveCount(0);
  await expect(page.locator('.reviews-provider-card')).toHaveCount(5);
  await expect(page.locator('.reviews-detail-heading')).toContainText('#4827 Add AI feedback signals and evidence capture');
  await expect(page.locator('.reviews-pr-diff')).toContainText('collectArtifacts');
  await expect(page.locator('.reviews-summary-stats')).toContainText('+427');
  await expect(page.locator('.reviews-detail-tabs button')).toHaveCount(6);
  await expect(page.locator('.reviews-context-card')).toHaveCount(6);
  await expect(page.locator('.reviews-context-panels')).toContainText('Trusted-main Readiness');
  await expect(page.locator('.reviews-summary')).toContainText('Squash & Merge');
  await expect(page.locator('.reviews-summary')).toContainText('trusted-main');
  await expect(page.getByRole('switch', { name: 'Auto-merge when ready' })).toBeDisabled();
  const workspaceBounds = await page.locator('.reviews-workspace').boundingBox();
  expect(workspaceBounds!.y + workspaceBounds!.height).toBeLessThanOrEqual(900);
  const summaryLayout = await page.evaluate(() => {
    const copy = document.querySelector('.reviews-summary-copy')!.getBoundingClientRect();
    const stats = document.querySelector('.reviews-summary-stats')!.getBoundingClientRect();
    return { copyBottom: copy.bottom, statsTop: stats.top };
  });
  expect(summaryLayout.copyBottom).toBeLessThanOrEqual(summaryLayout.statsTop);
  const checksFit = await page.evaluate(() => {
    const checks = document.querySelector('.reviews-preview-checks')!.getBoundingClientRect();
    const actions = document.querySelector('.reviews-summary-actions')!.getBoundingClientRect();
    const merge = document.querySelector('.reviews-merge-button')!.getBoundingClientRect();
    const summary = document.querySelector('.reviews-summary')!.getBoundingClientRect();
    return checks.bottom <= actions.top && merge.bottom <= summary.bottom;
  });
  expect(checksFit).toBe(true);
  await expect(page.locator('.reviews-summary-review-actions').getByRole('button', { name: 'Approve' })).toBeDisabled();
  await expect(page.locator('.reviews-summary-review-actions').getByRole('button', { name: 'Request changes' })).toBeDisabled();
  expect(apiRequests.filter(({ path }) => path !== '/api/v1/auth/session')).toEqual([]);
  expect(apiRequests.filter(({ method }) => method !== 'GET')).toEqual([]);
});
