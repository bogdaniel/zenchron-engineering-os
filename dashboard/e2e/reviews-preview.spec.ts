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
  await expect(page.locator('.reviews-preview-metric-trend')).toHaveCount(4);
  await expect(page.getByRole('img', { name: 'Pull requests trend' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'In review trend' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Review time trend' })).toBeVisible();
  await expect(page.locator('.reviews-metric').nth(0)).toContainText('+14%');
  await expect(page.locator('.reviews-metric').nth(1)).toContainText('Live');
  await expect(page.locator('.reviews-metric').nth(2)).toContainText('+3');
  await expect(page.locator('.reviews-preview-metric-bars i')).toHaveCount(5);
  await expect(page.locator('.reviews-metric').nth(3)).toContainText('-28%');
  await expect(page.locator('.reviews-metric').nth(4)).toContainText('+1.9pp');
  await expect(page.locator('.reviews-metric').nth(5)).toContainText('+0.8pp');
  await expect(page.locator('.reviews-filter-static').filter({ hasText: 'Last 14 Days' }))
    .toHaveAttribute('title', /not date-filtered/);
  await expect(page.locator('.reviews-filter-static').filter({ hasText: 'All Repos' }))
    .toHaveAttribute('title', /one sample repository/);
  await expect(page.getByRole('button', { name: 'All Repos' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'GitHub repository' })).toHaveCount(0);
  await expect(page.locator('.reviews-provider-card')).toHaveCount(5);
  await page.getByRole('button', { name: 'Approved 276' }).click();
  await expect(page.locator('.reviews-provider-card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Changes Req. 12' }).click();
  await expect(page.locator('.reviews-provider-card')).toHaveCount(1);
  await expect(page.locator('.reviews-provider-card')).toContainText('#4819');
  await page.getByRole('button', { name: 'All 428' }).click();
  await expect(page.locator('.reviews-provider-card')).toHaveCount(5);
  await page.getByRole('button', { name: 'Code Review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Code Review', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Evidence', exact: true }).click();
  await expect(page.locator('.reviews-detail-tab-panel')).toContainText('Evidence unavailable');
  await expect(page.getByRole('button', { name: 'Evidence', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Pull Requests 428' }).click();
  await expect(page.locator('.reviews-provider-card')).toHaveCount(5);
  const queueLayout = await page.evaluate(() => {
    const viewport = document.querySelector('.reviews-grid-wrap')!.getBoundingClientRect();
    const cards = [...document.querySelectorAll('.reviews-provider-card')].map((card) => card.getBoundingClientRect());
    return cards.every((card) => card.top >= viewport.top && card.bottom <= viewport.bottom);
  });
  expect(queueLayout).toBe(true);
  const pagination = page.locator('.reviews-preview-pagination');
  await expect(pagination).toBeVisible();
  await expect(pagination.getByRole('button')).toHaveCount(3);
  await expect(pagination.locator('[aria-current="page"]')).toHaveText('1');
  await expect(pagination).toContainText('Sample page · 5 pull requests');
  await expect(pagination.locator('button:not([disabled])')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New PR' })).toBeEnabled();
  await expect(page.locator('.reviews-detail-heading')).toContainText('#4827 Add AI feedback signals and evidence capture');
  await expect(page.locator('.reviews-pr-diff')).toContainText('collectArtifacts');
  await expect(page.locator('.reviews-design-diff')).toContainText('evidence_capture.ts');
  await expect(page.locator('.reviews-preview-diff-controls')).toContainText('+37');
  const diffControls = page.locator('.reviews-preview-diff-controls button');
  await expect(diffControls).toHaveCount(2);
  await expect(diffControls.nth(0)).toBeEnabled();
  await diffControls.nth(0).click();
  await expect(diffControls.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Split diff view' })).toContainText('collectArtifacts');
  await diffControls.nth(1).click();
  await expect(diffControls.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Pull request diff')).toBeVisible();
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
  await expect(page.locator('.reviews-summary-stats > div')).toHaveCount(6);
  await expect(page.locator('.reviews-summary-stats')).toContainText('−68');
  await expect(page.locator('.reviews-summary-stats')).toContainText('12');
  await expect(page.locator('.reviews-preview-checks span')).toHaveCount(8);
  await expect(page.locator('.reviews-detail-tabs button')).toHaveCount(6);
  await expect(page.locator('.reviews-context-card')).toHaveCount(6);
  await expect(page.locator('.reviews-context-panels')).toContainText('Trusted-main Readiness');
  await expect(page.locator('.reviews-preview-suggestions li')).toHaveCount(3);
  await expect(page.locator('.reviews-preview-artifacts li')).toHaveCount(7);
  await expect(page.locator('.reviews-preview-checklist li')).toHaveCount(7);
  const applySuggestion = page.getByRole('button', { name: 'Apply', exact: true });
  await expect(applySuggestion).toBeEnabled();
  await expect(applySuggestion).toHaveAttribute('title', /repository code is unchanged/);
  await applySuggestion.click();
  await expect(page.getByRole('button', { name: 'Applied · preview' })).toBeVisible();
  await expect(page.locator('.reviews-summary')).toContainText('Squash & Merge');
  await expect(page.locator('.reviews-summary')).toContainText('trusted-main');
  await expect(page.getByRole('switch', { name: 'Auto-merge when ready' })).toBeChecked();
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
  await expect(page.locator('.reviews-summary-review-actions').getByRole('button', { name: 'Approve' })).toBeEnabled();
  await expect(page.locator('.reviews-summary-review-actions').getByRole('button', { name: 'Request changes' })).toBeEnabled();

  await page.getByRole('button', { name: 'New PR' }).click();
  const newPR = page.getByRole('dialog', { name: 'New pull request · preview only' });
  await newPR.getByRole('textbox', { name: 'Pull request title' }).fill('Preview evidence improvements');
  await newPR.getByRole('textbox', { name: 'Source branch' }).fill('feature/preview-evidence');
  await newPR.getByRole('button', { name: 'Create preview PR' }).click();
  await expect(page.locator('.reviews-provider-card')).toHaveCount(6);
  await expect(page.locator('.reviews-detail-heading')).toContainText('#4828 Preview evidence improvements');
  const basePR = page.locator('.reviews-provider-card').filter({ hasText: '#4827' });
  await basePR.click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.locator('.reviews-detail-heading .reviews-required')).toHaveText('Approved');
  await page.getByRole('button', { name: 'Request changes' }).click();
  await expect(page.locator('.reviews-detail-tab-panel')).toContainText('Changes requested on PR #4827');
  const autoMerge = page.getByRole('switch', { name: 'Auto-merge when ready' });
  await page.locator('.reviews-governance-row').filter({ hasText: 'Auto-merge (when ready)' }).locator('label').click();
  await expect(autoMerge).not.toBeChecked();
  const evidenceDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export evidence' }).click();
  expect((await evidenceDownload).suggestedFilename()).toBe('pr-4827-preview-evidence.json');
  await page.getByRole('button', { name: 'Merge to Trusted-main' }).click();
  await expect(page.locator('.reviews-detail-heading .reviews-required')).toHaveText('Merged');
  await expect(page.getByRole('button', { name: 'Merged to Trusted-main' })).toBeVisible();
  expect(apiRequests.filter(({ path }) => path !== '/api/v1/auth/session')).toEqual([]);
  expect(apiRequests.filter(({ method }) => method !== 'GET')).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const mobileMetrics = await page.locator('.reviews-metric').evaluateAll((cards) => cards.map((card) => ({
    height: card.clientHeight,
    contentHeight: card.scrollHeight,
  })));
  expect(mobileMetrics.every(({ contentHeight, height }) => contentHeight <= height + 1)).toBe(true);
  expect(await page.locator('.reviews-metrics').evaluate((metrics) => metrics.scrollWidth <= metrics.clientWidth)).toBe(true);
  const mobileDiffControls = page.locator('.reviews-preview-diff-controls button');
  await mobileDiffControls.nth(0).click();
  await expect(page.getByRole('region', { name: 'Split diff view' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await mobileDiffControls.nth(1).click();
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
  const lastMobileArtifact = page.locator('.reviews-preview-artifacts li').last();
  await lastMobileArtifact.scrollIntoViewIfNeeded();
  await expect(lastMobileArtifact).toBeInViewport();
  const lastMobileCheck = page.locator('.reviews-preview-checklist li').last();
  await lastMobileCheck.scrollIntoViewIfNeeded();
  await expect(lastMobileCheck).toBeInViewport();
  const lastMobileRequiredCheck = page.locator('.reviews-preview-checks span').last();
  await lastMobileRequiredCheck.scrollIntoViewIfNeeded();
  await expect(lastMobileRequiredCheck).toBeInViewport();
  const mobileMerge = page.locator('.reviews-merge-button');
  await mobileMerge.scrollIntoViewIfNeeded();
  await expect(mobileMerge).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
