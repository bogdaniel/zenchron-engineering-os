import { expect, test } from '@playwright/test';

test('Reviews replaces the loading overlay after an empty GitHub response', async ({ page }) => {
  const projectID = 'fedcbafedcbafedcbafedcbafedcbafe';
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: true, login: 'Local workspace' }) }));
  await page.route('**/api/v1/projects', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{
      id: projectID, name: 'Nova Platform', branch: 'main', git_remote: 'github.com/acme/platform',
      worker_id: '0123456789abcdef0123456789abcdef', worker_name: 'Mac', last_seen: new Date().toISOString(),
      worker_status: 'online',
    }]),
  }));
  await page.route(`**/api/v1/projects/${projectID}/pull-requests`, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.route(`**/api/v1/projects/${projectID}/issues`, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.goto('/#reviews');
  await expect(page.locator('.reviews-grid-wrap')).toContainText('No open pull requests in this repository.');
  await expect(page.locator('.reviews-grid-wrap')).not.toContainText('Loading GitHub items');
});

test('Reviews syncs provider queues and submits GitHub PR reviews', async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 874 });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: true, login: 'Local workspace' }) }));
  const projectID = 'fedcbafedcbafedcbafedcbafedcbafe';
  const runID = 'abcdefabcdefabcdefabcdefabcdefab';
  const submittedReviews: { body: string; event: string }[] = [];
  const issueComments: { body: string; number: number }[] = [];
  const issueStates: string[] = [];
  let issueState = 'open';
  let canQueue = true;
  await page.route('**/api/v1/projects', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{
      id: projectID, name: 'Nova Platform', branch: 'main', git_remote: 'github.com/acme/platform',
      worker_id: '0123456789abcdef0123456789abcdef', worker_name: 'Mac', last_seen: new Date().toISOString(),
      worker_status: 'online',
    }]),
  }));
  await page.route(`**/api/v1/projects/${projectID}/pull-requests`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([
      {
        number: 42, title: 'Improve agent review flow across multiple projects and the local control plane', state: 'open', html_url: 'https://github.com/acme/platform/pull/42',
        body: '<details><summary>Release notes</summary><p>Version <strong>0.12.1</strong> <a href="https://example.com/releases">release notes</a><img src="https://example.com/pixel" onerror="alert(1)"></p></details>', draft: false, updated_at: new Date().toISOString(),
        user: { login: 'maya' }, head: { ref: `zenchron/agent-run/${runID}` }, base: { ref: 'main' },
      },
      {
        number: 43, title: 'Add review checklist coverage', state: 'open', html_url: 'https://github.com/acme/platform/pull/43',
        body: '', draft: true, updated_at: new Date().toISOString(),
        user: { login: 'alex' }, head: { ref: 'feature/review-checklist' }, base: { ref: 'main' },
      },
    ]),
  }));
  await page.route(`**/api/v1/projects/${projectID}/issues`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{
      number: 51, title: 'Add setup instructions', state: issueState, html_url: 'https://github.com/acme/platform/issues/51',
      body: 'Document local worker setup.', updated_at: new Date().toISOString(), user: { login: 'alex' }, labels: [{ name: 'docs' }],
    }]),
  }));
  await page.route(`**/api/v1/projects/${projectID}/issues/*/comments`, async (route) => {
    const match = route.request().url().match(/issues\/(\d+)\/comments$/);
    const comment = route.request().postDataJSON() as { body: string };
    issueComments.push({ body: comment.body, number: Number(match?.[1]) });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'submitted' }) });
  });
  await page.route(`**/api/v1/projects/${projectID}/issues/*`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    issueState = (route.request().postDataJSON() as { state: string }).state;
    issueStates.push(issueState);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'updated', state: issueState }) });
  });
  await page.route(`**/api/v1/projects/${projectID}/pull-requests/42/diff`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ diff: 'diff --git a/retry.go b/retry.go\n--- a/retry.go\n+++ b/retry.go\n@@ -1 +1 @@\n-old\n+return retry(ctx)\n' }),
  }));
  await page.route(`**/api/v1/projects/${projectID}/pull-requests/43/diff`, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ diff: 'diff --git a/README.md b/README.md' }),
  }));
  await page.route(`**/api/v1/projects/${projectID}/pull-requests/*/reviews`, async (route) => {
    const review = route.request().postDataJSON() as { body: string; event: string };
    submittedReviews.push(review);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      status: 'submitted', agent_run_linked: true,
      agent_run_queued: review.event === 'REQUEST_CHANGES' && canQueue,
    }) });
  });
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/v1/')) writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page.goto('/#reviews');
  await expect(page.locator('.reviews-page')).not.toHaveAttribute('data-preview');
  const metrics = await page.locator('.reviews-metrics').boundingBox();
  const workspace = await page.locator('.reviews-workspace').boundingBox();
  expect(metrics?.y).toBe(92);
  expect(workspace?.y).toBeCloseTo(238, 0);
  expect(workspace?.height).toBe(584);
  expect((workspace?.y ?? 0) + (workspace?.height ?? 0)).toBeLessThanOrEqual(874);
  const paneWidths = await page.locator('.reviews-pane').evaluateAll((panes) => panes.map((pane) => pane.getBoundingClientRect().width));
  expect(paneWidths[0]! / workspace!.width).toBeGreaterThan(0.22);
  expect(paneWidths[0]! / workspace!.width).toBeLessThan(0.26);
  expect(await page.locator('.reviews-resize-handle').first().evaluate((handle) => getComputedStyle(handle, '::before').width)).toBe('2px');
  await expect(page.locator('.reviews-metric').nth(1).locator('svg')).toHaveCSS('color', 'rgb(121, 185, 255)');
  await expect(page.locator('.reviews-metric').nth(3)).toHaveCSS('border-top-color', 'rgb(40, 102, 78)');
  // The approved frame, fed by the control plane: real counts, and Unavailable where it holds nothing.
  const sections = page.getByRole('navigation', { name: 'Review sections' });
  await expect(sections.locator('button[aria-pressed]')).toHaveText([
    'Pull Requests2', 'Issues1', 'Local branches0', 'Code Review', 'Evidence', 'Merge Governance', 'Policies', 'Trusted-main']);
  await expect(page.locator('.reviews-metric .metric-top')).toHaveText([
    'Pull Requests', 'In Review', 'Review Queue', 'Avg. Review Time', 'Merge Success Rate', 'Policy Gate Pass']);
  await expect(page.locator('.reviews-metric strong')).toHaveText(['2', '1', '0', 'Unavailable', 'Unavailable', 'Unavailable']);
  await expect(page.locator('.reviews-preview-metric-trend, .reviews-preview-metric-change')).toHaveCount(0);
  const repository = page.getByRole('button', { name: 'Review repository' });
  await expect(repository).toHaveText('Nova Platform');
  await expect(repository).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Review date range' })).toHaveText('All Dates');
  await expect(page.getByRole('button', { name: 'Review date range' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Pull Requests (2)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New PR' })).toBeDisabled();
  await expect(page.locator('.reviews-preview-pagination')).toContainText('2 open pull requests');
  await expect(page.locator('.reviews-preview-category, .reviews-preview-signals')).toHaveCount(0);
  await expect(page.locator('.reviews-detail-heading')).toContainText('#42 Improve agent review flow');
  await expect(page.locator('.reviews-detail-heading .reviews-required')).toHaveText('Open');
  await expect(page.locator('.reviews-preview-pr-metadata')).toHaveText('Nova Platform · opened by maya');
  await expect(page.locator('.reviews-preview-branch-meta')).toHaveText(`zenchron/agent-run/${runID} → main`);
  await expect(page.getByRole('button', { name: 'Bookmark pull request' })).toBeDisabled();
  await page.getByRole('button', { name: 'More pull request actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Open pull request on GitHub' }))
    .toHaveAttribute('href', 'https://github.com/acme/platform/pull/42');
  await page.keyboard.press('Escape');
  await expect(page.locator('.reviews-stage small')).toHaveText(['Open', 'Unavailable', 'Unavailable', 'Unavailable', 'Unavailable']);
  await expect(page.getByRole('group', { name: 'Review detail sections' }).getByRole('button')).toHaveText([
    'Code changes', 'Conversations', 'AI Suggestions', 'Evidence', 'Checklist', 'Approvals']);
  await expect(page.locator('.reviews-design-diff > .reviews-diff-meta')).toContainText('retry.go');
  await expect(page.locator('.reviews-preview-diff-controls')).toContainText('+1−1');
  await expect(page.locator('.reviews-preview-thread')).toHaveCount(0);
  await expect(page.locator('.reviews-summary-stats > div')).toHaveText([
    'Files Changed1', 'Lines Added+1', 'CommitsUnavailable', 'Lines Removed−1', 'Risk ScoreUnavailable',
    'Evidence CompletenessUnavailable']);
  await expect(page.getByRole('progressbar', { name: 'Evidence completeness' })).toHaveCount(0);
  await expect(page.locator('.reviews-checks-heading')).toHaveText('Required checksUnavailable');
  await expect(page.locator('.reviews-governance-row b')).toHaveText(['Unavailable', 'main', 'Unavailable']);
  await expect(page.getByRole('switch', { name: 'Auto-merge when ready' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Merge to protected branch' })).toBeDisabled();
  expect(await page.locator('.reviews-summary-actions').evaluate((actions) => [...actions.children].map((child) =>
    child.classList.contains('reviews-summary-review-actions') ? 'review'
      : child.classList.contains('reviews-merge-button') ? 'merge' : 'export'))).toEqual(['review', 'merge', 'export']);
  await expect(page.locator('.reviews-summary .reviews-panel-heading p')).toHaveText('GitHub pull request context');
  await expect(page.locator('.reviews-summary-copy details summary')).toHaveText('Release notes');
  await expect(page.locator('.reviews-summary-copy')).not.toContainText('<details>');
  await expect(page.locator('.reviews-summary-copy a')).toHaveAttribute('href', 'https://example.com/releases');
  await expect(page.locator('.reviews-summary-copy [onerror]')).toHaveCount(0);
  await expect(page.locator('.reviews-summary-copy img')).toHaveCount(0);
  const pullRequestCard = page.locator('.reviews-provider-card').first();
  await expect(pullRequestCard.locator('.reviews-provider-number')).toHaveText('#42');
  await expect(pullRequestCard.locator('strong')).toContainText('Improve agent review flow across multiple projects');
  await expect(pullRequestCard).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Draft 1' }).click();
  await expect(page.locator('.reviews-provider-card')).toHaveCount(1);
  await expect(page.locator('.reviews-provider-card')).toContainText('#43');
  await page.getByRole('button', { name: 'Open 1' }).click();
  await expect(page.locator('.reviews-provider-card')).toContainText('#42');
  await expect(page.locator('.reviews-summary-actions').getByRole('button', { name: 'Export evidence' })).toBeDisabled();
  await expect(page.locator('.reviews-summary-review-actions').getByRole('button', { name: 'Approve' })).toBeDisabled();
  await page.locator('.reviews-summary-review-actions').getByRole('button', { name: 'Request changes' }).click();
  const detailTabs = page.getByRole('group', { name: 'Review detail sections' });
  await expect(detailTabs.getByRole('button', { name: 'Conversations' })).toHaveAttribute('aria-pressed', 'true');
  const reviewInput = page.getByLabel('GitHub pull request review');
  await expect(reviewInput).toBeVisible();
  const inputBounds = await reviewInput.boundingBox();
  const composerBounds = await page.locator('.reviews-github-composer').boundingBox();
  expect(inputBounds && composerBounds).toBeTruthy();
  expect(inputBounds!.width).toBeGreaterThan(composerBounds!.width * 0.9);
  await detailTabs.getByRole('button', { name: 'Conversations' }).click();
  await expect(page.locator('.reviews-detail-tab-panel')).toContainText('Existing GitHub conversation history is not synchronized yet.');
  await detailTabs.getByRole('button', { name: 'Evidence' }).click();
  await expect(page.locator('.reviews-detail-tab-panel')).toContainText('Evidence unavailable');
  await detailTabs.getByRole('button', { name: 'Checklist' }).click();
  await expect(page.locator('.reviews-detail-tab-panel')).toContainText('Required checks unavailable');
  await detailTabs.getByRole('button', { name: 'AI Suggestions' }).click();
  await expect(page.locator('.reviews-detail-tab-panel')).toContainText('AI suggestions unavailable');
  await detailTabs.getByRole('button', { name: 'Approvals' }).click();
  await expect(page.locator('.reviews-detail-tab-panel')).toContainText('Approvals unavailable');
  await sections.getByRole('button', { name: 'Policies' }).click();
  await expect(detailTabs.getByRole('button', { name: 'Checklist' })).toHaveAttribute('aria-pressed', 'true');
  // Opening a queue starts it unfiltered on its code changes.
  await sections.getByRole('button', { name: 'Pull Requests' }).click();
  await expect(page.locator('.reviews-provider-card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Open 1' }).click();
  await detailTabs.getByRole('button', { name: 'Code changes' }).click();
  await expect(page.locator('.reviews-pr-diff')).toBeVisible();
  await expect(page.locator('.reviews-context-panels')).toContainText('AI Suggestions');
  await expect(page.locator('.reviews-context-panels')).toContainText('Evidence Artifacts');
  await expect(page.locator('.reviews-context-panels')).toContainText('Review Checklist');
  await expect(page.locator('.reviews-context-panels')).toContainText('Artifact data is unavailable.');
  await expect(page.locator('.reviews-context-card')).toHaveCount(6);
  await expect(page.locator('.reviews-context-card h4')).toHaveText([
    'AI Suggestions', 'Evidence Artifacts', 'Review Checklist', 'Approvals', 'Policy Gate Status', 'Trusted-main Readiness']);
  await expect(page.locator('.reviews-preview-card-list')).toHaveCount(0);
  await expect(detailTabs.getByRole('button', { name: 'Code changes' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.reviews-metric .metric-top').first()).toHaveCSS('font-size', '12px');
  await expect(page.locator('.reviews-metric strong').first()).toHaveCSS('font-size', '26px');
  await expect(page.locator('.reviews-provider-card')).toContainText('Improve agent review flow');
  await expect(page.locator('.reviews-detail-heading p')).toHaveCSS('font-size', '11px');
  const search = page.getByRole('textbox', { name: 'Search pull requests' });
  await search.fill('42');
  await expect(page.locator('.reviews-provider-card')).toContainText('Improve agent review flow');
  await search.fill(`agent-run/${runID}`);
  await expect(page.locator('.reviews-provider-card'), 'search matches the source branch').toHaveText(/#42/);
  await search.fill('no matching result');
  await expect(page.locator('.reviews-grid-wrap')).toContainText('No pull requests match this search.');
  await page.getByRole('button', { name: 'More review filters' }).click();
  await page.getByRole('menuitem', { name: 'Reset queue filters' }).click();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('status')).toHaveText('Review filters reset.');
  await expect(page.locator('.reviews-provider-card')).toHaveCount(2);
  expect(writes, 'reading and filtering sends no write').toEqual([]);
  await expect(page.locator('.reviews-code-editor[aria-label="Pull request diff"]')).toBeVisible();
  await expect(page.locator('.reviews-pr-diff .view-lines')).toContainText('+return retry(ctx)');
  await page.getByRole('button', { name: 'Draft 1' }).click();
  await page.locator('.reviews-provider-card').filter({ hasText: '#43' }).click();
  await expect(page.locator('.reviews-pr-diff-empty')).toHaveText(
    'No readable text patch was returned. Review file changes on GitHub.',
  );
  await page.getByRole('button', { name: 'Open 1' }).click();
  await page.getByRole('button', { name: 'Issues' }).click();
  await expect(page.getByRole('textbox', { name: 'Search issues' })).toBeVisible();
  await expect(page.locator('.reviews-grid-wrap')).toContainText('Add setup instructions');
  await expect(page.locator('.reviews-provider-detail')).toContainText('Document local worker setup.');
  await expect(page.locator('.reviews-summary .reviews-panel-heading p')).toHaveText('GitHub issue context');
  await expect(page.getByRole('link', { name: 'Open issue on GitHub' })).toHaveAttribute('href', 'https://github.com/acme/platform/issues/51');
  await expect(page.getByRole('heading', { name: 'Issues (1)' })).toBeVisible();
  await expect(page.locator('.reviews-provider-detail .reviews-pr-description')).toBeVisible();
  await expect(page.locator('.reviews-detail-heading .reviews-required')).toHaveText('Open');
  await page.locator('.reviews-summary-review-actions').getByRole('button', { name: 'Add comment' }).click();
  await expect(page.getByLabel('GitHub issue comment')).toBeVisible();
  await page.getByRole('button', { name: 'Conversations' }).click();
  await page.getByLabel('GitHub issue comment').fill('I will add the setup instructions.');
  await page.locator('.reviews-detail-tab-panel').getByRole('button', { name: 'Add comment' }).click();
  await expect(page.getByRole('status')).toHaveText('Comment submitted to GitHub.');
  expect(issueComments).toEqual([{ body: 'I will add the setup instructions.', number: 51 }]);
  await page.getByRole('button', { name: 'Close issue' }).click();
  await expect(page.getByText('Issue closed on GitHub.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reopen issue' }).click();
  await expect(page.getByText('Issue open on GitHub.', { exact: true })).toBeVisible();
  expect(issueStates).toEqual(['closed', 'open']);
  await page.getByRole('button', { name: 'Pull requests' }).click();
  await expect(page.locator('.reviews-detail-heading')).toContainText('#43 Add review checklist coverage');
  await page.getByRole('button', { name: 'Conversations' }).click();
  await page.getByLabel('GitHub pull request review').fill('Thanks for adding the API coverage.');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Comment submitted to GitHub and attached to the agent run.');
  await page.getByLabel('GitHub pull request review').fill('Please add retry coverage before merging.');
  await page.locator('.reviews-detail-tab-panel').getByRole('button', { name: 'Request changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Changes requested on GitHub; agent run queued.');
  canQueue = false;
  await page.getByLabel('GitHub pull request review').fill('Keep this feedback until the worker is available.');
  await page.locator('.reviews-detail-tab-panel').getByRole('button', { name: 'Request changes' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Changes requested on GitHub; run feedback stored, but the agent is not eligible for another pass yet.',
  );
  expect(submittedReviews).toEqual([
    { body: 'Thanks for adding the API coverage.', event: 'COMMENT' },
    { body: 'Please add retry coverage before merging.', event: 'REQUEST_CHANGES' },
    { body: 'Keep this feedback until the worker is available.', event: 'REQUEST_CHANGES' },
  ]);
  // #43 was the last pull request selected, so returning to the queue reviews that one.
  expect(writes).toEqual([
    `POST /api/v1/projects/${projectID}/issues/51/comments`, `PATCH /api/v1/projects/${projectID}/issues/51`,
    `PATCH /api/v1/projects/${projectID}/issues/51`, ...Array(3).fill(`POST /api/v1/projects/${projectID}/pull-requests/43/reviews`),
  ]);
  await detailTabs.getByRole('button', { name: 'Code changes' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.reviews-workspace')).toHaveCSS('flex-direction', 'column');
  await expect(detailTabs).toHaveCSS('flex-wrap', 'nowrap');
  expect(await page.locator('.reviews-context-panels').evaluate((panels) =>
    getComputedStyle(panels).gridTemplateColumns.trim().split(/\s+/).length,
  )).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Reviews reports a failed GitHub load in the same frame without fixtures', async ({ page }) => {
  const projectID = 'fedcbafedcbafedcbafedcbafedcbafe';
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: true, login: 'Local workspace' }) }));
  await page.route('**/api/v1/projects', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{
      id: projectID, name: 'Nova Platform', branch: 'main', git_remote: 'github.com/acme/platform',
      worker_id: '0123456789abcdef0123456789abcdef', worker_name: 'Mac', last_seen: new Date().toISOString(),
      worker_status: 'online',
    }]),
  }));
  await page.route(`**/api/v1/projects/${projectID}/pull-requests`, (route) => route.fulfill({ status: 502, body: 'GitHub is unreachable' }));
  await page.route(`**/api/v1/projects/${projectID}/issues`, (route) => route.fulfill({ status: 502, body: 'GitHub is unreachable' }));
  await page.goto('/?pull=4827#reviews');
  await expect(page.locator('.reviews-grid-wrap').getByRole('alert'))
    .toHaveText('GitHub data unavailable. Check the connection and try again.', { timeout: 15_000 });
  await expect(page.locator('.reviews-change-empty')).toContainText('GitHub data unavailable');
  await expect(page.locator('.reviews-provider-card')).toHaveCount(0);
  await expect(page.locator('.reviews-page')).not.toContainText('4827');
  await expect(page.locator('.reviews-page')).not.toContainText('Maya Patel');
  await expect(page.locator('.reviews-metric strong').first()).toHaveText('Unavailable');
  await expect(page.getByRole('heading', { name: 'Pull Requests', exact: true })).toBeVisible();
  await expect(page.locator('.reviews-summary-review-actions').getByRole('button', { name: 'Approve' })).toBeDisabled();
});

test('a copied pull request link opens that pull request in Live', async ({ page, baseURL }) => {
  const projectID = 'fedcbafedcbafedcbafedcbafedcbafe';
  const otherProjectID = '0123456789abcdef0123456789abcdef';
  const pullRequest = (number: number, title: string) => ({
    number, title, state: 'open', html_url: `https://github.com/acme/platform/pull/${number}`, body: '', draft: false,
    updated_at: new Date().toISOString(), user: { login: 'maya' }, head: { ref: `feature/${number}` }, base: { ref: 'main' },
  });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: true, login: 'Local workspace' }) }));
  await page.route('**/api/v1/projects', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(['Nova Platform', 'Orbit API'].map((name, index) => ({
      id: index ? otherProjectID : projectID, name, branch: 'main', git_remote: `github.com/acme/${index ? 'orbit' : 'platform'}`,
      worker_id: '0123456789abcdef0123456789abcdef', worker_name: 'Mac', last_seen: new Date().toISOString(),
      worker_status: 'online',
    }))),
  }));
  await page.route(`**/api/v1/projects/${otherProjectID}/pull-requests`, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([pullRequest(7, 'Orbit change')]),
  }));
  await page.route(`**/api/v1/projects/${otherProjectID}/issues`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route(`**/api/v1/projects/${projectID}/pull-requests`, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([pullRequest(42, 'First change'), pullRequest(43, 'Second change')]),
  }));
  await page.route(`**/api/v1/projects/${projectID}/issues`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/v1/projects/*/pull-requests/*/diff', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ diff: 'diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b.go b/b.go\n--- a/b.go\n+++ b/b.go\n@@ -1 +1,2 @@\n same\n+more\n' }),
  }));
  // The clipboard needs a secure context, which a local address is and the plain-HTTP test host is not.
  const local = new URL(baseURL!);
  local.hostname = '127.0.0.1';
  await page.goto(`${local.origin}/?mode=live&pull=43#reviews`);
  await expect(page.locator('.reviews-detail-heading')).toContainText('#43 Second change');
  await expect(page.locator('.reviews-provider-card[aria-pressed="true"]')).toContainText('#43');
  // A patch that spans files keeps its file headers and reports how many files it touches.
  await expect(page.locator('.reviews-design-diff > .reviews-diff-meta')).toContainText('2 files changed');
  await expect(page.locator('.reviews-preview-diff-controls')).toContainText('+2−1');
  await expect(page.locator('.reviews-pr-diff .view-lines')).toContainText('diff --git a/b.go b/b.go');
  await page.locator('.reviews-preview-diff-controls').getByRole('button', { name: 'Split' }).click();
  await expect(page.getByRole('region', { name: 'Split diff view' })).toContainText('diff --git a/b.go b/b.go');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy pull request link' }).click();
  await expect(page.getByRole('status')).toHaveText('Pull request link copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${local.origin}/?mode=live&pull=43#reviews`);
  // The repository menu replaces the old select: choosing another checkout lists its pull requests.
  const repository = page.getByRole('button', { name: 'Review repository' });
  await expect(repository).toHaveText('Nova Platform');
  await repository.click();
  await page.getByRole('menuitem', { name: 'Orbit API' }).click();
  await expect(repository).toHaveText('Orbit API');
  await expect(page.getByRole('heading', { name: 'Pull Requests (1)' })).toBeVisible();
  await expect(page.locator('.reviews-detail-heading')).toContainText('#7 Orbit change');
  await expect(page.locator('.reviews-preview-pr-metadata')).toHaveText('Orbit API · opened by maya');
});
