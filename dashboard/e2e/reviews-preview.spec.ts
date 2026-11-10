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
  const queueLayout = await page.evaluate(() => {
    const viewport = document.querySelector('.reviews-grid-wrap')!.getBoundingClientRect();
    const cards = [...document.querySelectorAll('.reviews-provider-card')].map((card) => card.getBoundingClientRect());
    return cards.every((card) => card.top >= viewport.top && card.bottom <= viewport.bottom);
  });
  expect(queueLayout).toBe(true);
  const pagination = page.locator('.reviews-preview-pagination');
  await expect(pagination).toBeVisible();
  await expect(pagination.getByRole('button')).toHaveCount(8);
  await expect(pagination.locator('[aria-current="page"]')).toHaveText('1');
  await expect(pagination.locator('button:not([disabled])')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New PR' })).toBeDisabled();
  await expect(page.locator('.reviews-detail-heading')).toContainText('#4827 Add AI feedback signals and evidence capture');
  await expect(page.locator('.reviews-pr-diff')).toContainText('collectArtifacts');
  await expect(page.locator('.reviews-design-diff')).toContainText('evidence_capture.ts');
  await expect(page.locator('.reviews-preview-diff-controls')).toContainText('+37');
  const diffControls = page.locator('.reviews-preview-diff-controls button');
  await expect(diffControls).toHaveCount(2);
  expect(await diffControls.evaluateAll((buttons) => buttons.map((button) => (button as HTMLButtonElement).disabled))).toEqual([true, true]);
  await expect(page.locator('.reviews-preview-thread')).toContainText('artifact schema version for traceability');
  const previewThreadVisible = await page.evaluate(() => {
    const thread = document.querySelector('.reviews-preview-thread')!.getBoundingClientRect();
    const detail = document.querySelector('.reviews-provider-detail')!.getBoundingClientRect();
    return thread.top >= detail.top && thread.bottom <= detail.bottom;
  });
  expect(previewThreadVisible).toBe(true);
  await expect(page.locator('.reviews-provider-detail .reviews-pr-description')).toBeHidden();
  await expect(page.locator('.reviews-summary-copy')).toContainText('end-to-end evidence capture');
  const previewDiffBounds = await page.locator('.reviews-pr-diff').boundingBox();
  expect(previewDiffBounds!.height).toBeGreaterThanOrEqual(130);
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

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#reviews');
  const mobileMetrics = await page.locator('.reviews-metric').evaluateAll((cards) => cards.map((card) => ({
    height: card.clientHeight,
    contentHeight: card.scrollHeight,
  })));
  expect(mobileMetrics.every(({ contentHeight, height }) => contentHeight <= height + 1)).toBe(true);
  await expect(page.locator('.reviews-preview-thread')).toBeVisible();
  const mobileThreadFollowsDiff = await page.evaluate(() => {
    const thread = document.querySelector('.reviews-preview-thread')!;
    const editor = document.querySelector('.reviews-code-editor')!;
    const diff = document.querySelector('.reviews-design-diff')!;
    return getComputedStyle(thread).position === 'static' && getComputedStyle(diff).maxHeight === 'none' && thread.getBoundingClientRect().top >= editor.getBoundingClientRect().bottom;
  });
  expect(mobileThreadFollowsDiff).toBe(true);
  await page.locator('.reviews-preview-thread').scrollIntoViewIfNeeded();
  await expect(page.locator('.reviews-preview-thread')).toBeInViewport({ ratio: 0.5 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
