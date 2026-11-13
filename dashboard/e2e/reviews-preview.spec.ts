import { expect, test } from '@playwright/test';

const dashboardPort = Number((globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env?.ZENCHRON_E2E_DASHBOARD_PORT) || 4173;
test.use({ baseURL: `http://127.0.0.1:${dashboardPort}` });

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
  const sectionTabs = page.getByRole('navigation', { name: 'Review sections' });
  const filterInset = await page.evaluate(() => {
    const nav = document.querySelector('.reviews-tabs')!.getBoundingClientRect();
    const more = document.querySelector('.reviews-preview-filter[aria-label="More review filters"]')!.getBoundingClientRect();
    return nav.right - more.right;
  });
  expect(filterInset, 'the mock scope controls align with the right edge of the section bar').toBeLessThanOrEqual(6);
  await expect(sectionTabs.locator('button[aria-pressed] svg')).toHaveCount(6);
  const pullRequestsTab = sectionTabs.getByRole('button', { name: 'Pull Requests 428' });
  await expect(pullRequestsTab.locator('svg')).toHaveClass(/tabler-icon-git-pull-request/);
  await expect(pullRequestsTab.locator('small')).toHaveText('428');
  const selectedStatus = page.locator('.reviews-detail-heading .reviews-required');
  await expect(selectedStatus).toHaveText('In Review');
  await expect(selectedStatus).toHaveCSS('text-transform', 'none');
  const summaryCopy = page.locator('.reviews-summary-copy');
  await expect(summaryCopy).toContainText('end-to-end evidence capture');
  await expect(page.locator('.reviews-summary-stats .reviews-preview-summary-metric')).toHaveCount(6);
  await expect(page.locator('.reviews-preview-summary-metric > span')).toHaveText([
    'Files Changed', 'Lines Added', 'Commits', 'Lines Removed', 'Risk Score', 'Evidence Completeness',
  ]);
  await expect(page.locator('.reviews-summary-stats svg')).toHaveCount(6);
  await expect(page.getByRole('progressbar', { name: 'Evidence completeness' })).toHaveAttribute('aria-valuenow', '94');
  await expect(page.locator('.reviews-preview-summary-metric.risk svg')).toHaveCSS('color', 'rgb(250, 100, 103)');
  await expect(page.locator('.reviews-preview-summary-metric.evidence svg')).toHaveCSS('color', 'rgb(72, 221, 176)');
  const summaryLayout = await page.evaluate(() => {
    const copy = document.querySelector('.reviews-summary-copy')!.getBoundingClientRect();
    const paragraph = document.querySelector('.reviews-summary-copy p')!.getBoundingClientRect();
    const metrics = document.querySelector('.reviews-summary-stats')!.getBoundingClientRect();
    const actions = [...document.querySelector('.reviews-summary-actions')!.children].map((child) =>
      child.classList.contains('reviews-summary-review-actions') ? 'review'
        : child.classList.contains('reviews-merge-button') ? 'merge' : 'export');
    return { copy: { top: copy.top, bottom: copy.bottom, height: copy.height }, paragraphBottom: paragraph.bottom,
      metricsTop: metrics.top, actions };
  });
  expect(summaryLayout.copy.height, 'the selected PR description has reserved space on initial render').toBeGreaterThan(24);
  expect(summaryLayout.paragraphBottom).toBeLessThanOrEqual(summaryLayout.copy.bottom);
  expect(summaryLayout.copy.bottom).toBeLessThanOrEqual(summaryLayout.metricsTop);
  expect(summaryLayout.actions).toEqual(['review', 'merge', 'export']);
  await expect(page.getByRole('button', { name: 'Merge to Trusted-main' })).toHaveCSS('background-image', /linear-gradient/);
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
  await expect(page.getByRole('button', { name: 'Review date range' })).toHaveText('Last 14 Days');
  await expect(page.getByRole('button', { name: 'Review repository' })).toHaveText('All Repos');
  await expect(page.getByRole('button', { name: 'More review filters' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'GitHub repository' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Review date range' }).click();
  await page.getByRole('menuitem', { name: 'Last 7 Days' }).click();
  await expect(page.getByRole('button', { name: 'Review date range' })).toHaveText('Last 7 Days');
  await page.getByRole('button', { name: 'Review date range' }).click();
  await page.getByRole('menuitem', { name: 'Last 30 Days' }).click();
  await expect(page.getByRole('button', { name: 'Review date range' })).toHaveText('Last 30 Days');
  await page.getByRole('button', { name: 'Review repository' }).click();
  await page.getByRole('menuitem', { name: 'Nova Platform' }).click();
  await expect(page.getByRole('button', { name: 'Review repository' })).toHaveText('Nova Platform');
  await expect(page.locator('.reviews-provider-card')).toHaveCount(5);
  await page.getByRole('button', { name: 'Review date range' }).click();
  await page.getByRole('menuitem', { name: 'Last 14 Days' }).click();
  await page.getByRole('button', { name: 'Review repository' }).click();
  await page.getByRole('menuitem', { name: 'All Repos' }).click();
  await expect(page.locator('.reviews-provider-card')).toHaveCount(5);
  const previewCards = page.locator('.reviews-provider-card');
  await expect(previewCards.nth(0).locator('.reviews-preview-category')).toHaveText('Feature');
  await expect(previewCards.nth(1).locator('.reviews-preview-category')).toHaveText('Fix');
  await expect(previewCards.nth(1).locator('.reviews-provider-state')).toHaveText('Changes Requested');
  await expect(previewCards.nth(1)).toContainText('R 42');
  await expect(previewCards.nth(2).locator('.reviews-provider-state')).toHaveText('Approved');
  await expect(previewCards.nth(3).locator('.reviews-provider-state')).toHaveText('Blocked');
  await expect(previewCards.nth(3)).toContainText('CI ✕');
  await expect(previewCards.nth(4).locator('.reviews-preview-category')).toHaveText('Chore');
  await page.getByRole('button', { name: 'Approved 276' }).click();
  await expect(page.locator('.reviews-provider-card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Changes Req. 12' }).click();
  await expect(page.locator('.reviews-provider-card')).toHaveCount(1);
  await expect(page.locator('.reviews-provider-card')).toContainText('#4819');
  await page.getByRole('button', { name: 'All 428' }).click();
  await expect(page.locator('.reviews-provider-card')).toHaveCount(5);
  await page.getByRole('button', { name: 'Approved 276' }).click();
  await expect(page.locator('.reviews-provider-card')).toHaveCount(2);
  const reviewSearch = page.getByRole('textbox', { name: 'Search pull requests' });
  await reviewSearch.fill('no matching fixture PR');
  await expect(page.locator('.reviews-provider-card')).toHaveCount(0);
  await page.getByRole('button', { name: 'More review filters' }).click();
  await page.getByRole('menuitem', { name: 'Reset queue filters' }).click();
  await expect(page.locator('.reviews-provider-card')).toHaveCount(5);
  await expect(reviewSearch).toHaveValue('');
  await expect(page.getByRole('button', { name: 'All 428' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Review date range' })).toHaveText('Last 14 Days');
  await expect(page.getByRole('button', { name: 'Review repository' })).toHaveText('All Repos');
  await expect(page.getByRole('status')).toContainText('Review filters reset in this preview.');
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
  const bookmark = page.getByRole('button', { name: 'Bookmark pull request' });
  await expect(bookmark).toHaveAttribute('aria-pressed', 'false');
  await bookmark.click();
  await expect(page.getByRole('button', { name: 'Remove pull request bookmark' })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.reviews-provider-card').filter({ hasText: '#4819' }).click();
  await expect(page.getByRole('button', { name: 'Bookmark pull request' })).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.reviews-provider-card').filter({ hasText: '#4827' }).click();
  await expect(page.getByRole('button', { name: 'Remove pull request bookmark' })).toHaveAttribute('aria-pressed', 'true');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy pull request link' }).click();
  await expect(page.locator('.reviews-preview-action-message')).toHaveText('Pull request link copied');
  const copiedPRLink = await page.evaluate(() => navigator.clipboard.readText());
  expect(copiedPRLink).toContain('?pull=4827#reviews');
  await page.locator('.reviews-provider-card').filter({ hasText: '#4819' }).click();
  await page.goto(copiedPRLink);
  await expect(page.locator('.reviews-detail-heading')).toContainText('#4827 Add AI feedback signals and evidence capture');
  await page.getByRole('button', { name: 'More pull request actions' }).click();
  await page.getByRole('menuitem', { name: 'View evidence' }).click();
  const detailTabs = page.locator('.reviews-detail-tabs');
  await expect(detailTabs.getByRole('button', { name: /Evidence/ })).toHaveAttribute('aria-pressed', 'true');
  await detailTabs.getByRole('button', { name: /Code changes/i }).click();
  await page.getByRole('button', { name: 'More pull request actions' }).click();
  await page.getByRole('menuitem', { name: 'Copy branch name' }).click();
  await expect(page.locator('.reviews-preview-action-message')).toHaveText('Branch name copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('feat/review-ai-evidence');
  const selectedPRMetadata = page.locator('.reviews-preview-pr-metadata');
  await expect(selectedPRMetadata).toHaveText('Opened by Maya Patel · 2h ago · 12 commits · +427 −68 · Updated 18m ago');
  expect(await selectedPRMetadata.evaluate((line) => line.scrollWidth <= line.clientWidth),
    'the selected PR header metadata fits on one line').toBe(true);
  await expect(page.locator('.reviews-preview-branch-meta')).toHaveText('feat/review-ai-evidence → main');
  await expect(page.locator('.reviews-provider-detail > .reviews-diff-meta')).toHaveCount(0);
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
  await expect(page.locator('.reviews-code-editor .minimap')).toBeVisible();
  // Monaco repeats the label on its inner edit surface once it has loaded, so the label alone matches one element
  // before the editor loads and two after. Name the editor container, as github-reviews.spec.ts does.
  await expect(page.locator('.reviews-code-editor[aria-label="Pull request diff"]')).toBeVisible();
  await expect.poll(() => page.locator('.reviews-code-editor .margin-view-overlays .line-numbers').allTextContents())
    .toEqual(['118\u00a0118', '119\u00a0\u00a0\u00a0\u00a0', '\u00a0\u00a0\u00a0\u00a0119',
      '\u00a0\u00a0\u00a0\u00a0120', '\u00a0\u00a0\u00a0\u00a0121',
      '\u00a0\u00a0\u00a0\u00a0122', '\u00a0\u00a0\u00a0\u00a0123',
      '\u00a0\u00a0\u00a0\u00a0124', '\u00a0\u00a0\u00a0\u00a0125',
      '120\u00a0126', '121\u00a0127']);
  expect(await page.locator('.reviews-code-editor .margin-view-overlays .line-numbers').first()
    .evaluate((line) => line.getBoundingClientRect().height)).toBeLessThanOrEqual(17);
  const unifiedDiffLines = page.locator('.reviews-code-editor .view-lines');
  await expect(unifiedDiffLines).toContainText('artifacts: await collectArtifacts(ctx),');
  await expect(unifiedDiffLines).not.toContainText('diff --git');
  await expect.poll(() => page.evaluate(() => {
    const lines = [...document.querySelectorAll('.reviews-code-editor .view-line')];
    const added = lines.find((line) => {
      const text = line.textContent?.replaceAll('\u00a0', ' ').trimStart() ?? '';
      return text.startsWith('+') && text.includes('collectArtifacts');
    });
    const removed = lines.find((line) => (line.textContent?.replaceAll('\u00a0', ' ').trimStart() ?? '')
      .startsWith('-'));
    if (!added || !removed) return null;
    const token = (line: Element) => line.querySelector('[class^="mtk"]')!;
    return {
      addedBackground: getComputedStyle(document.querySelector('.reviews-code-editor .zenchron-diff-added-line')!).backgroundColor,
      addedColor: getComputedStyle(token(added)).color,
      removedBackground: getComputedStyle(document.querySelector('.reviews-code-editor .zenchron-diff-removed-line')!).backgroundColor,
      removedColor: getComputedStyle(token(removed)).color,
    };
  })).toEqual({
    addedBackground: 'rgb(18, 50, 34)', addedColor: 'rgb(125, 228, 170)',
    removedBackground: 'rgb(58, 27, 36)', removedColor: 'rgb(255, 154, 154)',
  });
  const finalDiffLine = page.locator('.reviews-code-editor .view-line').filter({ hasText: 'return evidence;' }).last();
  const finalDiffLineFits = await page.evaluate(() => {
    const line = document.querySelectorAll('.reviews-code-editor .view-line');
    const target = [...line].find((row) => row.textContent?.replaceAll('\u00a0', ' ').trim() === '}');
    const pane = document.querySelector('.reviews-provider-detail')!;
    if (!target) return false;
    return target.getBoundingClientRect().bottom <= pane.getBoundingClientRect().bottom;
  });
  await expect(finalDiffLine).toBeAttached();
  expect(finalDiffLineFits, 'the whole illustrative code hunk fits in the desktop diff pane').toBe(true);
  await expect(page.locator('.reviews-preview-thread')).toContainText('artifact schema version for traceability');
  expect(await page.locator('.reviews-preview-thread').evaluate((thread) => thread.getBoundingClientRect().width),
    'the inline discussion stays compact like the mock').toBeLessThanOrEqual(210);
  expect(await page.evaluate(() => {
    const thread = document.querySelector('.reviews-preview-thread')!.getBoundingClientRect();
    const minimap = document.querySelector('.reviews-code-editor .minimap')!.getBoundingClientRect();
    return thread.right <= minimap.left;
  }), 'the inline discussion stays clear of the diff minimap').toBe(true);
  const previewThreadVisible = await page.evaluate(() => {
    const thread = document.querySelector('.reviews-preview-thread')!.getBoundingClientRect();
    const detail = document.querySelector('.reviews-provider-detail')!.getBoundingClientRect();
    return thread.top >= detail.top && thread.bottom <= detail.bottom;
  });
  expect(previewThreadVisible).toBe(true);
  await expect(page.locator('.reviews-provider-detail .reviews-pr-description')).toHaveCount(0);
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
  await expect(page.locator('.reviews-preview-action-message')).toHaveText('PR #4827 approved in this preview only');
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
  await expect(page.locator('.reviews-preview-action-message')).toHaveText('PR #4827 merged in this preview only');
  await expect(page.getByLabel('GitHub pull request review')).toBeDisabled();
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
  expect(await page.locator('.reviews-code-editor .margin-view-overlays .line-numbers').first()
    .evaluate((line) => line.getBoundingClientRect().height)).toBeLessThanOrEqual(17);
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
  const mobileDateRange = page.getByRole('button', { name: 'Review date range' });
  await mobileDateRange.scrollIntoViewIfNeeded();
  await expect(mobileDateRange).toBeInViewport();
  await mobileDateRange.click();
  await page.getByRole('menuitem', { name: 'Last 7 Days' }).click();
  await expect(mobileDateRange).toHaveText('Last 7 Days');
  const mobileRepository = page.getByRole('button', { name: 'Review repository' });
  await mobileRepository.scrollIntoViewIfNeeded();
  await expect(mobileRepository).toBeInViewport();
  await mobileRepository.click();
  await page.getByRole('menuitem', { name: 'Nova Platform' }).click();
  await expect(mobileRepository).toHaveText('Nova Platform');
  const mobileReset = page.getByRole('button', { name: 'More review filters' });
  await mobileReset.scrollIntoViewIfNeeded();
  await expect(mobileReset).toBeInViewport();
  await mobileReset.click();
  await page.getByRole('menuitem', { name: 'Reset queue filters' }).click();
  await expect(mobileDateRange).toHaveText('Last 14 Days');
  await expect(mobileRepository).toHaveText('All Repos');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
