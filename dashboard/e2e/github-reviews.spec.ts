import { expect, test } from '@playwright/test';

test('Reviews replaces the loading overlay after an empty GitHub response', async ({ page }) => {
  const projectID = 'fedcbafedcbafedcbafedcbafedcbafe';
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
    body: JSON.stringify({ diff: 'diff --git a/retry.go b/retry.go\n+return retry(ctx)\n' }),
  }));
  await page.route(`**/api/v1/projects/${projectID}/pull-requests/*/reviews`, async (route) => {
    const review = route.request().postDataJSON() as { body: string; event: string };
    submittedReviews.push(review);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      status: 'submitted', agent_run_linked: true,
      agent_run_queued: review.event === 'REQUEST_CHANGES' && canQueue,
    }) });
  });
  await page.goto('/#reviews');
  const metrics = await page.locator('.reviews-metrics').boundingBox();
  const workspace = await page.locator('.reviews-workspace').boundingBox();
  expect(metrics?.y).toBe(92);
  expect(workspace?.y).toBeCloseTo(238, 0);
  expect(workspace?.height).toBe(635);
  expect((workspace?.y ?? 0) + (workspace?.height ?? 0)).toBeLessThanOrEqual(874);
  const paneWidths = await page.locator('.reviews-pane').evaluateAll((panes) => panes.map((pane) => pane.getBoundingClientRect().width));
  expect(paneWidths[0]! / workspace!.width).toBeGreaterThan(0.22);
  expect(paneWidths[0]! / workspace!.width).toBeLessThan(0.26);
  expect(await page.locator('.reviews-resize-handle').first().evaluate((handle) => getComputedStyle(handle, '::before').width)).toBe('2px');
  await expect(page.locator('.reviews-metric').nth(1).locator('svg')).toHaveCSS('color', 'rgb(121, 185, 255)');
  await expect(page.locator('.reviews-metric').nth(3)).toHaveCSS('border-top-color', 'rgb(40, 102, 78)');
  await expect(page.getByText('GitHub · Nova Platform')).toBeVisible();
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
  await expect(page.getByLabel('GitHub pull request review')).toBeVisible();
  await detailTabs.getByRole('button', { name: 'Conversations' }).click();
  await expect(page.locator('.reviews-detail-tab-panel')).toContainText('Existing GitHub conversation history is not synchronized yet.');
  await detailTabs.getByRole('button', { name: 'Evidence' }).click();
  await expect(page.locator('.reviews-detail-tab-panel')).toContainText('Evidence unavailable');
  await detailTabs.getByRole('button', { name: 'Checklist' }).click();
  await expect(page.locator('.reviews-detail-tab-panel')).toContainText('Required checks unavailable');
  await detailTabs.getByRole('button', { name: 'Code changes' }).click();
  await expect(page.locator('.reviews-pr-diff')).toBeVisible();
  await expect(page.locator('.reviews-context-panels')).toContainText('AI Suggestions');
  await expect(page.locator('.reviews-context-panels')).toContainText('Evidence Artifacts');
  await expect(page.locator('.reviews-context-panels')).toContainText('Review Checklist');
  await expect(page.locator('.reviews-context-panels')).toContainText('Artifact data is unavailable.');
  await expect(detailTabs.getByRole('button', { name: 'Code changes' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.reviews-metric .metric-top').first()).toHaveCSS('font-size', '12px');
  await expect(page.locator('.reviews-metric strong').first()).toHaveCSS('font-size', '26px');
  await expect(page.locator('.reviews-provider-card')).toContainText('Improve agent review flow');
  await expect(page.locator('.reviews-detail-heading p')).toHaveCSS('font-size', '11px');
  const search = page.getByRole('textbox', { name: 'Search pull requests' });
  await search.fill('42');
  await expect(page.locator('.reviews-provider-card')).toContainText('Improve agent review flow');
  await search.fill('no matching result');
  await expect(page.locator('.reviews-grid-wrap')).toContainText('No pull requests match this search.');
  await search.fill('');
  await expect(page.locator('.reviews-code-editor[aria-label="Pull request diff"]')).toBeVisible();
  await expect(page.locator('.reviews-pr-diff .view-lines')).toContainText('+return retry(ctx)');
  await page.getByRole('button', { name: 'Issues' }).click();
  await expect(page.getByRole('textbox', { name: 'Search issues' })).toBeVisible();
  await expect(page.locator('.reviews-grid-wrap')).toContainText('Add setup instructions');
  await expect(page.locator('.reviews-provider-detail')).toContainText('Document local worker setup.');
  await expect(page.locator('.reviews-summary .reviews-panel-heading p')).toHaveText('GitHub issue context');
  await expect(page.getByRole('link', { name: 'Open issue on GitHub' })).toHaveAttribute('href', 'https://github.com/acme/platform/issues/51');
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
});
