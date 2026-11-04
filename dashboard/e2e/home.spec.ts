import { expect, test } from '@playwright/test';

test('dashboard displays the connected control plane and local worker', async ({ page }) => {
  await page.setViewportSize({ width: 1490, height: 829 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Good morning/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workflow orchestration' })).toBeVisible();
  await expect(page.locator('.workflow-overview-canvas .workflow-node')).toHaveCount(9);
  await expect(page.locator('.workflow-overview-canvas .react-flow__edge')).toHaveCount(10);
  await expect(page.locator('.workflow-overview-status')).toContainText('Execution unavailable');
  await expect(page.locator('.activity-list')).toContainText('Control plane is responding');
  await expect(page.getByText('Running agents', { exact: true })).toBeVisible();
  await expect(page.getByText(/Worker “.+” is online/)).toBeVisible();
  await expect(page.locator('.activity-list')).toContainText('zenchron-engineering-os');
  await expect(page.locator('.metric-unavailable')).toHaveCount(3);
  await expect(page.getByText('Local branch diffs and feedback', { exact: true })).toBeVisible();
  await expect(page.getByText('No local branch diffs yet', { exact: true })).toBeVisible();
  await expect(page.getByText('No pull requests yet', { exact: true })).toHaveCount(0);
  const footer = await page.locator('.page-footer').boundingBox();
  expect(footer).not.toBeNull();
  expect(footer!.y + footer!.height).toBeLessThanOrEqual(829);
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
});

test('Overview matches the supplied tall desktop mockup proportions', async ({ page }) => {
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/');
  await expect(page.locator('.activity-list')).toContainText('Control plane is responding');
  await expect(page.locator('.workflow-overview-status')).toContainText('Execution unavailable');
  const layout = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
    return {
      metrics: bounds('.metric-grid'), workflow: bounds('.workflow-panel'), activity: bounds('.activity-panel'),
      objectives: bounds('.objective-panel'), review: bounds('.review-panel'), footerDisplay:
        getComputedStyle(document.querySelector('.page-footer')!).display,
      brandMark: bounds('.brand-mark'), overviewLink: bounds('.nav-link[href="#overview"]'),
    };
  });
  expect(layout.metrics?.x).toBe(265);
  expect(layout.metrics?.y).toBe(84);
  expect(layout.metrics?.width).toBe(1393);
  expect(layout.metrics?.height).toBe(100);
  expect(layout.workflow?.y).toBe(198);
  expect(layout.workflow?.height).toBeGreaterThanOrEqual(203);
  expect(layout.workflow?.height).toBeLessThanOrEqual(205);
  expect(layout.activity?.y).toBe(198);
  expect(layout.activity?.height).toBe(204);
  const workflowNode = await page.locator('.workflow-overview-canvas .workflow-node').first().boundingBox();
  expect(workflowNode?.width).toBeGreaterThanOrEqual(80);
  expect(workflowNode?.height).toBeGreaterThanOrEqual(30);
  const overviewCanvas = await page.locator('.workflow-overview-canvas').boundingBox();
  const overviewAttribution = await page.locator('.workflow-overview-canvas .react-flow__attribution').boundingBox();
  await expect(page.locator('.workflow-overview-canvas .react-flow__attribution')).toBeVisible();
  expect(overviewAttribution?.y).toBeGreaterThan(overviewCanvas!.y + overviewCanvas!.height / 2);
  const overviewGraphLabelSize = await page.evaluate(() => {
    const node = document.querySelector('.workflow-overview-canvas .workflow-node');
    const viewport = document.querySelector('.workflow-overview-canvas .react-flow__viewport');
    if (!node || !viewport) return 0;
    const zoom = new DOMMatrix(getComputedStyle(viewport).transform).a;
    return parseFloat(getComputedStyle(node.querySelector('b')!).fontSize) * zoom;
  });
  expect(overviewGraphLabelSize).toBeGreaterThanOrEqual(8);
  expect(layout.activity?.x).toBeGreaterThan(1235);
  expect(layout.objectives?.y).toBeCloseTo(416, 0);
  expect(layout.review?.y).toBeCloseTo(590, 0);
  expect(layout.review?.height).toBe(280);
  expect(layout.footerDisplay).toBe('none');
  expect(layout.brandMark?.x).toBe(38);
  expect(layout.overviewLink?.x).toBe(14);
  expect(layout.overviewLink?.y).toBeCloseTo(92, 0);
});

test('Overview matches the supplied desktop display crop', async ({ page }) => {
  await page.setViewportSize({ width: 1522, height: 856 });
  await page.goto('/');
  const layout = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
    return {
      metrics: bounds('.metric-grid'), workflow: bounds('.workflow-panel'), activity: bounds('.activity-panel'),
      objectives: bounds('.objective-panel'), review: bounds('.review-panel'), timeline: bounds('.timeline-panel'),
      footerDisplay: getComputedStyle(document.querySelector('.page-footer')!).display,
    };
  });
  expect(layout.metrics?.x).toBe(265);
  expect(layout.metrics?.y).toBe(84);
  expect(layout.workflow?.y).toBe(189);
  expect(layout.workflow?.height).toBe(202);
  expect(layout.activity?.x).toBeCloseTo(1143.5, 1);
  expect(layout.objectives?.y).toBe(403);
  expect(layout.review?.y).toBe(573);
  expect(layout.review?.height).toBe(220);
  expect(layout.timeline?.y).toBe(573);
  expect(layout.footerDisplay).toBe('none');
});

test('Reviews matches the supplied desktop workspace frame', async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 874 });
  await page.goto('/#reviews');
  const layout = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
    return {
      sidebar: bounds('.sidebar'), metrics: bounds('.reviews-metrics'), title: bounds('.reviews-title-copy h2'),
      titleIcon: bounds('.reviews-title-icon'), tabs: bounds('.reviews-tabs'), workspace: bounds('.reviews-workspace'),
    };
  });
  expect(layout.sidebar?.width).toBe(247);
  expect(layout.metrics?.x).toBe(265);
  expect(layout.metrics?.y).toBe(92);
  expect(layout.titleIcon?.x).toBe(265);
  expect(layout.title?.x).toBe(293);
  expect(layout.tabs?.y).toBeCloseTo(205, 0);
  expect(layout.workspace?.y).toBeCloseTo(238, 0);
  expect(layout.workspace?.height).toBe(635);
});

test('overview lists only agent runs with captured local diffs', async ({ page }) => {
  const now = new Date().toISOString();
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      {
        id: '0123456789abcdef0123456789abcdef', agent_id: 'abcdefabcdefabcdefabcdefabcdefab',
        agent_name: 'Code Reviewer', project_id: 'fedcbafedcbafedcbafedcbafedcbafe', project_name: 'Nova Platform',
        worker_id: 'abcdefabcdefabcdefabcdefabcdefab', worker_name: 'Mac', branch: 'zenchron/agent-run/reviewable',
        prompt: 'Update the README', status: 'succeeded', attempts: 1, created_at: now, updated_at: now,
        diff_attempt: 1, diff_available: true, can_request_changes: true,
        review_comments: [{ body: 'Explain the API behavior.', request_changes: false, created_at: now }],
      },
      {
        id: 'fedcbafedcbafedcbafedcbafedcbafe', agent_id: 'abcdefabcdefabcdefabcdefabcdefab',
        agent_name: 'Test Generator', project_id: 'fedcbafedcbafedcbafedcbafedcbafe', project_name: 'Nova Platform',
        worker_id: 'abcdefabcdefabcdefabcdefabcdefab', worker_name: 'Mac', branch: 'zenchron/agent-run/no-diff',
        prompt: 'Inspect tests', status: 'succeeded', attempts: 1, created_at: now, updated_at: now,
        diff_available: false, review_comments: [],
      },
    ]),
  }));
  await page.goto('/');
  await expect(page.locator('.overview-review-list')).toContainText('zenchron/agent-run/reviewable');
  await expect(page.locator('.overview-review-list')).toContainText('1 comments');
  await expect(page.locator('.overview-review-list')).not.toContainText('zenchron/agent-run/no-diff');
});

test('objectives can be created and updated from the dashboard', async ({ page }) => {
  const title = `Review workflow ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('link', { name: 'Objectives' }).click();
  await expect(page.getByRole('heading', { name: 'Objectives' })).toBeVisible();
  await page.getByRole('button', { name: 'New Objective' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Objective title').fill(title);
  await dialog.getByLabel('Description').fill('Make objective progress visible to the team.');
  await dialog.getByLabel('Owner').fill('Platform team');
  await dialog.getByRole('button', { name: 'Create objective', exact: true }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.locator('.objective-detail-head h3')).toHaveCSS('font-size', '18px');
  await expect(page.locator('.objective-detail-head h3')).toHaveCSS('font-weight', '650');
  await page.getByLabel('Progress').fill('45');
  await page.getByRole('button', { name: 'Save updates' }).click();
  await expect(page.getByText('45% complete')).toBeVisible();
});

test('Objectives dashboard matches the planning mock at the reference viewport', async ({ page }) => {
  await page.route('**/api/v1/objectives', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.route('**/api/v1/products', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#objectives');
  await expect(page.getByRole('heading', { name: 'Objectives' })).toBeVisible();
  await expect(page.locator('.objective-detail-empty').getByRole('button', { name: 'Create objective' }))
    .toHaveCSS('border-color', 'rgb(128, 80, 204)');
  await expect(page.getByRole('region', { name: 'Objective metrics' }).locator('.objective-metric')).toHaveCount(6);
  const layout = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
    return {
      sidebar: bounds('.sidebar'), metrics: bounds('.objective-metrics'), content: bounds('.objective-content-grid'),
      table: bounds('.objective-table-panel'), detail: bounds('.objective-detail-panel'), capacity: bounds('.objective-capacity'),
    };
  });
  expect(layout.sidebar?.width).toBe(247);
  expect(layout.metrics?.x).toBe(265);
  expect(layout.metrics?.y).toBeCloseTo(157.5, 0);
  expect(layout.content?.y).toBeCloseTo(263.5, 0);
  expect(layout.content?.height).toBe(603);
  await expect(page.locator('.objective-grid-wrap .ag-header-cell').last()).toBeVisible();
  await expect(page.locator('.objective-grid-wrap .ag-header-cell-text').last()).toHaveText('Due date');
  expect((layout.table?.width ?? 0) / (layout.detail?.width ?? 1)).toBeGreaterThan(0.94);
  expect((layout.table?.width ?? 0) / (layout.detail?.width ?? 1)).toBeLessThan(0.98);
  expect(layout.capacity?.bottom).toBeLessThanOrEqual(867);
});

test('Objectives grid keeps product names while the catalog loads', async ({ page }) => {
  const productID = 'a'.repeat(32);
  const createdAt = new Date().toISOString();
  await page.route('**/api/v1/products', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify([{
        id: productID, name: 'Nova Platform', description: 'Developer platform', repository_ids: [],
        created_at: createdAt, updated_at: createdAt,
      }]),
    });
  });
  await page.route('**/api/v1/objectives', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([{
      id: 'b'.repeat(32), title: 'Ship Platform v3.0', description: '', owner: 'Alex Chen',
      product: 'Nova Platform', product_id: productID, status: 'on_track', progress: 78,
      due_date: '2026-12-15', created_at: createdAt, updated_at: createdAt,
    }]),
  }));
  await page.setViewportSize({ width: 1522, height: 856 });
  await page.goto('/#objectives');
  const productCell = page.locator('.ag-row').first().locator('.ag-cell[col-id="product"]');
  await expect(productCell).toHaveText('Nova Platform');
  await page.getByRole('textbox', { name: 'Search objectives' }).fill('Nova Platform');
  await expect(page.locator('.ag-row')).toHaveCount(1);
});

test('Projects page shows the live local worker inventory', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(page.locator('.project-detail-heading h3')).toHaveCSS('font-size', '18px');
  await expect(page.locator('.project-detail-heading h3')).toHaveCSS('font-weight', '650');
  await expect(
    page.locator('.projects-grid-wrap').getByText('zenchron-engineering-os', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.project-detail-fields')).toContainText('example.invalid/zenchron/zenchron-engineering-os');
  await expect(page.locator('.project-detail-fields')).not.toContainText('secret');
  await expect(page.locator('.project-detail-fields')).not.toContainText('hidden');
  const branch = page.locator('.project-detail-fields > div').filter({ hasText: 'Current branch' }).locator('b');
  await expect(branch).toHaveText(/\S+/);
  await expect(branch).not.toHaveText('Unknown');
  await expect(page.locator('.project-detail-fields > div').filter({ hasText: 'Worker' }).locator('b')).toHaveText(/\S+/);
  await expect(page.locator('.project-detail-note')).toContainText('remote credentials stay here');
});

test('worker prepares an isolated Git branch without moving the source checkout', async ({ page }) => {
  const branch = `zenchron/e2e-${Date.now()}`;
  await page.goto('/');
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare isolated branch' }).click();
  const dialog = page.getByRole('dialog', { name: 'Prepare isolated branch' });
  await dialog.getByLabel('Branch name').fill(branch);
  await dialog.getByRole('button', { name: 'Prepare branch' }).click();
  const request = page.locator('.project-worktree-row').filter({ hasText: branch });
  await expect(request.getByText('ready', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.project-detail-fields > div').first().locator('b')).toHaveText('main');
});

test('Reviews page shows unavailable provider data without invented pull requests', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Reviews', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible();
  await expect(page.getByText('GitHub repository not connected')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Local branches' })).toBeVisible();
  await page.getByRole('button', { name: 'Local branches' }).click();
  await expect(page.locator('.reviews-change-empty')).toContainText('Choose a completed agent run');
  await expect(page.getByRole('region', { name: 'Review metrics' }).getByText('Unavailable')).toHaveCount(6);
  await expect(page.locator('.reviews-metric strong.metric-unavailable')).toHaveCount(6);
  await expect(page.locator('.reviews-metric strong.metric-unavailable').first()).toHaveCSS('font-size', '14px');
  await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Request changes' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Merge to protected branch' })).toBeDisabled();
  await expect(page.getByText('No pull requests yet', { exact: true })).toHaveCount(0);
  const queue = page.locator('#queue');
  const separator = page.getByRole('separator', { name: 'Resize pull request queue and review detail' });
  const initialWidth = (await queue.boundingBox())?.width ?? 0;
  await separator.focus();
  await separator.press('ArrowRight');
  await expect.poll(async () => (await queue.boundingBox())?.width ?? 0).toBeGreaterThan(initialWidth);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.reviews-workspace')).toHaveCSS('flex-direction', 'column');
  await expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
});

test('Reviews page shows an isolated local branch diff without treating it as a pull request', async ({ page }) => {
  const runID = '0123456789abcdef0123456789abcdef';
  let status = 'succeeded';
  const comments: { body: string; request_changes: boolean; created_at: string }[] = [];
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{
      id: runID, agent_id: 'abcdefabcdefabcdefabcdefabcdefab', agent_name: 'Code Reviewer',
      project_id: 'fedcbafedcbafedcbafedcbafedcbafe', project_name: 'Nova Platform',
      worker_id: 'abcdefabcdefabcdefabcdefabcdefab', worker_name: 'Mac',
      branch: 'zenchron/agent-run/0123456789abcdef0123456789abcdef', base_branch: 'main',
      pull_request_enabled: true, pull_request_number: 4827,
      pull_request_url: 'https://github.com/zenchron/nova-platform/pull/4827',
      prompt: 'Update the README', status, attempts: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      diff_attempt: 1, diff_available: true, diff_truncated: false,
      can_request_changes: status === 'succeeded', review_comments: comments,
    }]),
  }));
  for (const action of ['comments', 'request-changes']) {
    await page.route(`**/api/v1/agent-runs/*/${action}`, async (route) => {
      const body = route.request().postDataJSON() as { comment: string };
      comments.push({ body: body.comment, request_changes: action === 'request-changes', created_at: new Date().toISOString() });
      if (action === 'request-changes') status = 'queued';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
  }
  await page.route('**/api/v1/agent-runs/*/diff', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      run_id: runID,
      diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-Old line\n+Local change\n',
      truncated: false,
    }),
  }));
  await page.goto('/');
  await page.getByRole('link', { name: 'Reviews', exact: true }).click();
  await page.getByRole('button', { name: 'Local branches' }).click();
  await expect(page.getByRole('heading', { name: 'zenchron/agent-run/0123456789abcdef0123456789abcdef' })).toBeVisible();
  await expect(page.locator('.reviews-code-editor[aria-label="Local branch diff"]')).toBeVisible();
  await expect(page.locator('.reviews-code-editor .view-lines')).toContainText('+Local change');
  await expect(page.getByRole('link', { name: 'Open pull request #4827' }))
    .toHaveAttribute('href', 'https://github.com/zenchron/nova-platform/pull/4827');
  const diffSummary = page.locator('.reviews-summary-stats > div');
  await expect(diffSummary.nth(0).locator('b')).toHaveText('1');
  await expect(diffSummary.nth(1).locator('b')).toHaveText('+1');
  await expect(diffSummary.nth(2).locator('b')).toHaveText('−1');
  await expect(page.getByText('GitHub repository not connected')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Review comment' }).fill('Please explain the new API behavior.');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(page.getByLabel('Review comments')).toContainText('Please explain the new API behavior.');
  await page.getByRole('textbox', { name: 'Review comment' }).fill('Update the response to address the review.');
  await page.getByRole('button', { name: 'Request changes' }).click();
  await expect(page.locator('.reviews-detail-heading .reviews-required')).toHaveText('queued');
  await expect(page.getByLabel('Review comments')).toContainText('Changes requested');
  await expect(page.getByRole('button', { name: 'Merge to protected branch' })).toBeDisabled();
});

test('Reports page summarizes live API records and leaves delivery metrics unavailable', async ({ page }) => {
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#reports');
  const objective = await page.evaluate(async () => {
    const response = await fetch('/api/v1/objectives', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Report chart objective', owner: 'Platform' }),
    });
    return response.status;
  });
  expect(objective).toBe(201);
  const objectiveCount = await page.evaluate(async () => {
    const response = await fetch('/api/v1/objectives');
    if (!response.ok) throw new Error(`Objective list failed: ${response.status}`);
    return (await response.json()).length;
  });
  const run = await page.evaluate(async () => {
    const agentResponse = await fetch('/api/v1/agents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Report agent', provider: 'custom', model: 'review-v1', tools: [] }),
    });
    const agent = await agentResponse.json();
    const projects = await fetch('/api/v1/projects').then((response) => response.json());
    const project = projects.find((item: { worker_status: string }) => item.worker_status === 'online');
    if (!agentResponse.ok || !project) return { status: 0, id: '' };
    const response = await fetch('/api/v1/agent-runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agent.id, project_id: project.id, prompt: 'Create a report record.' }),
    });
    return { status: response.status, id: (await response.json()).id };
  });
  expect(run.status).toBe(202);
  await expect.poll(() => page.evaluate(async (runID) => {
    const response = await fetch('/api/v1/agent-runs');
    const runs = await response.json();
    return runs.find((item: { id: string }) => item.id === runID)?.status;
  }, run.id), { timeout: 15_000 }).toBe('succeeded');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Objective status' })).toBeVisible();
  await expect(page.locator('.objective-chart-layout [role="application"]')).toBeVisible();
  await expect(page.locator('.objective-chart-layout .objective-chart-label')).toHaveText(String(objectiveCount));
  await expect(page.locator('.objective-legend')).toContainText('In progress');
  await expect(page.getByRole('heading', { name: 'Agent run outcomes' })).toBeVisible();
  await expect(page.locator('.run-chart-layout [role="application"]')).toBeVisible();
  await expect(page.locator('.run-chart-layout .objective-chart-label')).toHaveText('1');
  await expect(page.locator('.run-outcome-legend')).toContainText('Succeeded');
  await expect(page.locator('.run-outcome-legend')).toContainText('1');
  await expect(page.locator('.reports-metric').filter({ hasText: 'Agent runs (30d)' })).toContainText('1');
  await expect(page.locator('.reports-metric').filter({ hasText: 'Run success rate' })).toContainText('100%');
  await expect(page.getByRole('heading', { name: 'Workspace inventory' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Delivery velocity & cycle time' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'CI duration distribution' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review latency & agent spend' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Acceptance & autonomous completion' })).toBeVisible();
  await expect(page.locator('.reports-metric').filter({ hasText: 'Delivery velocity' })).toContainText('Unavailable');
  await expect(page.locator('.reports-metric').filter({ hasText: 'Delivery velocity' }).locator('strong'))
    .toHaveCSS('font-size', '14px');
  await expect(page.getByRole('heading', { name: 'Reporting coverage' })).toBeVisible();
  const layout = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
    return { sidebar: bounds('.sidebar'), metrics: bounds('.reports-metrics'), content: bounds('.reports-content-grid'),
      objectiveChart: bounds('.objective-distribution'), runChart: bounds('.run-outcomes-panel'),
      inventory: bounds('.inventory-panel'),
      delivery: bounds('.delivery-velocity-panel'), coverage: bounds('.reports-summary'),
      productWorkspaceLabelHeight: document.querySelector('.nav-link[href="#workspace"] .nav-label')?.getBoundingClientRect().height };
  });
  expect(layout.sidebar?.width).toBe(247);
  expect(layout.metrics?.x).toBe(265);
  expect(layout.content?.y).toBeLessThan(290);
  expect(layout.content?.bottom).toBeLessThanOrEqual(941);
  expect(layout.objectiveChart?.width).toBeGreaterThan(layout.runChart?.width ?? 0);
  expect(layout.coverage?.x).toBeGreaterThan(layout.runChart?.x ?? 0);
  expect(layout.coverage?.y).toBeCloseTo(layout.objectiveChart?.y ?? -100, 0);
  expect(layout.inventory?.y).toBeGreaterThan(layout.delivery?.y ?? -100);
  expect(layout.productWorkspaceLabelHeight).toBeLessThan(24);
});

test('Product Workspace groups live repositories into persisted products', async ({ page }) => {
  const objectiveTitle = `Product objective ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('link', { name: 'Product Workspace' }).click();
  await expect(page.locator('.page-heading h2')).toHaveText('Product Workspace');
  await expect(page.getByText('No products yet. Add a product to group repositories.')).toBeVisible();
  await page.getByRole('button', { name: '+ Add Product' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Product name').fill('Core Product');
  await dialog.getByLabel('Description').fill('Shared platform and APIs');
  await dialog.getByLabel('Repositories').click();
  await page.getByRole('option', { name: /zenchron-engineering-os/ }).click();
  await dialog.getByLabel('Repositories').press('Escape');
  await dialog.getByRole('button', { name: 'Save product' }).click();
  await expect(page.getByRole('heading', { name: 'Core Product' })).toBeVisible();
  await expect(page.locator('.workspace-project-option').filter({ hasText: 'Core Product' }))
    .toContainText('1 linked repositories');

  await page.getByRole('link', { name: 'Objectives' }).click();
  await page.getByRole('button', { name: 'New Objective' }).click();
  const objectiveDialog = page.getByRole('dialog');
  await objectiveDialog.getByLabel('Objective title').fill(objectiveTitle);
  await objectiveDialog.getByLabel('Product').click();
  await page.getByRole('option', { name: 'Core Product' }).click();
  await objectiveDialog.getByRole('button', { name: 'Create objective' }).click();
  await expect(page.locator('.detail-meta-grid').getByText('Core Product', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Product Workspace' }).click();
  await expect(page.getByText(objectiveTitle, { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Workspace sections' }).getByRole('button', { name: 'Objectives' }).click();
  await expect(page.getByText(objectiveTitle, { exact: true })).toBeVisible();

  await page.getByRole('navigation', { name: 'Workspace sections' }).getByRole('button', { name: 'Repos' }).click();
  await expect(page.getByText('zenchron-engineering-os', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Core Product' })).toBeVisible();
  await expect(page.locator('.workspace-project-option').filter({ hasText: 'Core Product' }))
    .toContainText('1 linked repositories');

  await expect(page.getByRole('heading', { name: 'Open objectives' })).toBeVisible();
  await expect(page.locator('.workspace-metric').filter({ hasText: 'Open objectives' })
    .getByText('Assigned to this product', { exact: true })).toBeVisible();

  await page.getByRole('navigation', { name: 'Workspace sections' }).getByRole('button', { name: 'Files' }).click();
  await expect(page.getByRole('heading', { name: 'Files & evidence' })).toBeVisible();
  await expect(page.getByText(/storage integration and agent runs exist/)).toBeVisible();
});
