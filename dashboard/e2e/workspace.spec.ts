import { expect, test, type Page } from '@playwright/test';

const novaID = 'a'.repeat(32);
const orionID = 'b'.repeat(32);
const projectID = 'c'.repeat(32);
const createdAt = '2026-01-01T00:00:00Z';
const nova = { id: novaID, name: 'Nova Platform', description: 'Developer platform', repository_ids: [projectID], created_at: createdAt, updated_at: createdAt };
const orion = { id: orionID, name: 'Orion Analytics', description: 'Data tools', repository_ids: [], created_at: createdAt, updated_at: createdAt };
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/** Serves the Live workspace from fixtures and records every write the page attempts. */
async function useLiveFixtures(page: Page, products: (typeof nova)[] = [nova, orion]) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  await page.route('**/api/v1/**', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/auth/session', (route) => route.fulfill(json({ authenticated: true, local: true, login: 'Local workspace' })));
  await page.route('**/api/v1/products**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill(json(products));
    const body = request.postDataJSON() as { name: string; description: string; repository_ids: string[] };
    writes.push({ method: request.method(), path: new URL(request.url()).pathname, body });
    const saved = { ...nova, ...body };
    products.splice(0, 1, saved);
    return route.fulfill(json(saved));
  });
  await page.route('**/api/v1/projects', (route) => route.fulfill(json([{
    id: projectID, name: 'nova-platform', branch: 'main', git_remote: 'github.com/zenchron/nova-platform',
    worker_id: 'c'.repeat(32), worker_name: 'Mac Studio', last_seen: createdAt, worker_status: 'online',
  }])));
  await page.route('**/api/v1/objectives', (route) => route.fulfill(json([
    { id: '1'.repeat(32), title: 'Ship Platform v3.0', description: '', owner: 'Alex', product: 'Nova Platform', product_id: novaID, status: 'on_track', progress: 78, due_date: '2026-12-15', created_at: createdAt, updated_at: createdAt },
    { id: '2'.repeat(32), title: 'Launch Agent SDK', description: '', owner: 'Priya', product: 'Nova Platform', product_id: novaID, status: 'at_risk', progress: 34, due_date: '2027-02-10', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
    { id: '4'.repeat(32), title: 'Retire legacy API', description: '', owner: '', product: 'Nova Platform', product_id: novaID, status: 'completed', progress: 100, due_date: '', created_at: createdAt, updated_at: createdAt },
    { id: '3'.repeat(32), title: 'Improve CI cycle time', description: '', owner: 'Marcus', product: 'Orion Analytics', product_id: orionID, status: 'in_progress', progress: 52, due_date: '2026-11-20', created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-03T00:00:00Z' },
  ])));
  await page.route('**/api/v1/workflows', (route) => route.fulfill(json([
    { id: 'release', name: 'Release train', description: '', status: 'draft', version: 1, nodes: [], edges: [], updated_at: createdAt },
  ])));
  await page.route('**/api/v1/agents', (route) => route.fulfill(json([{
    id: 'd'.repeat(32), name: 'Code Reviewer', description: '', provider: 'custom', model: 'review-v1', status: 'active',
    system_prompt: '', goal_prompt: '', tools: [], version: 1, updated_at: createdAt,
  }])));
  return writes;
}

test('Product Workspace matches its desktop frame and filters products', async ({ page }) => {
  await page.setViewportSize({ width: 1672, height: 856 });
  await useLiveFixtures(page);
  await page.goto('/#workspace');
  await expect(page.locator('.workspace-mock-directory').getByRole('heading', { name: 'Product Workspace' })).toBeVisible();
  const productName = page.locator('.workspace-mock-heading h1');
  await expect(productName).toHaveText('Nova Platform');
  await expect(productName).toHaveCSS('font-size', '23px');
  await expect(page.locator('.workspace-mock-product-copy b').first()).toHaveCSS('font-size', '12px');
  const firstMetric = page.locator('.workspace-mock-metric').first();
  const [metricIcon, metricLabel] = await Promise.all([
    firstMetric.locator('.metric-top > svg').boundingBox(),
    firstMetric.locator('.metric-top > span').boundingBox(),
  ]);
  expect(metricIcon && metricLabel).toBeTruthy();
  expect(metricIcon!.x + metricIcon!.width).toBeLessThan(metricLabel!.x);
  expect(metricLabel!.x - metricIcon!.x - metricIcon!.width).toBeCloseTo(5, 0);
  const repositoryRows = page.locator('.workspace-mock-card.repositories .workspace-mock-list > div');
  await expect(repositoryRows).toHaveCount(1);
  await expect(repositoryRows).toContainText('nova-platform · Mac Studio · online');
  await expect(repositoryRows.locator('.workspace-mock-repo-branch')).toHaveText('main');
  await expect(page.getByRole('heading', { name: 'Product Roadmap' })).toBeVisible();
  await expect(page.locator('.workspace-mock-roadmap-row')).toHaveCount(2);
  await expect(page.locator('.workspace-mock-quarter-labels > span'))
    .toHaveText(['', 'Q4 ’26', 'Q1 ’27', 'Q2 ’27', 'Q3 ’27', 'Q4 ’27']);
  await expect(page.locator('.workspace-mock-track > span.green')).toHaveText('On track');
  await expect(page.locator('.workspace-mock-track > span.amber')).toHaveText('At risk');

  const layout = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
    return {
      directory: bounds('.workspace-mock-directory'),
      detail: bounds('.workspace-mock-heading'),
      metrics: bounds('.workspace-mock-metrics'),
      tabs: bounds('.workspace-mock-tabs'),
      content: bounds('div.workspace-mock-grid'),
      bottom: bounds('.workspace-mock-bottom'),
    };
  });
  // The same frame the approved fixtures render in: Live changes values, not geometry.
  expect(layout.directory?.x).toBe(263);
  expect(layout.directory?.y).toBe(100);
  expect(layout.directory?.width).toBe(250);
  expect(layout.detail?.x).toBe(529);
  expect(layout.metrics?.y).toBe(192);
  expect(layout.tabs?.y).toBe(283);
  expect(layout.content?.y).toBe(334);
  expect(layout.content?.height).toBe(348);
  expect(layout.bottom?.y).toBe(694);
  expect((layout.bottom?.y ?? 0) + (layout.bottom?.height ?? 0)).toBeLessThanOrEqual(856);
  const clippedCards = await page.locator('.workspace-mock-card').evaluateAll((cards) =>
    cards.filter((card) => card.scrollHeight > card.clientHeight + 1).map((card) => card.textContent?.trim()));
  expect(clippedCards).toEqual([]);

  await page.getByRole('textbox', { name: 'Search products' }).fill('Orion');
  await expect(page.locator('.workspace-mock-product')).toContainText('Orion Analytics');
  await expect(page.locator('.workspace-mock-product')).toHaveCount(1);
  await page.locator('.workspace-mock-product').click();
  await expect(productName).toHaveText('Orion Analytics');
  await expect(page.locator('.workspace-mock-roadmap-row')).toHaveCount(1);
  await expect(page.locator('.workspace-mock-roadmap-row')).toContainText('Improve CI cycle time');
  await page.getByRole('textbox', { name: 'Search products' }).fill('no match');
  await expect(page.locator('.workspace-mock-directory')).toContainText('No products match your search.');
  await page.getByRole('button', { name: /All Products \(2\)/ }).click();
  await page.getByRole('button', { name: 'Filter products: All' }).click();
  await page.getByRole('menuitem', { name: 'No repos' }).click();
  await expect(page.locator('.workspace-mock-product')).toHaveText(/Orion Analytics.*0 linked repositories.*No repos/);

  await page.setViewportSize({ width: 1672, height: 749 });
  await expect(page.getByRole('button', { name: '＋ Add Product', exact: true })).toHaveCount(1);
  expect(await page.locator('.sidebar').evaluate((element) => element.getBoundingClientRect().width)).toBe(247);
  expect(await page.locator('.workspace-mock-directory').evaluate((element) => element.getBoundingClientRect().x)).toBe(263);
});

test('Live Product Workspace shows real data, honest gaps, and saves product edits', async ({ page }) => {
  await page.setViewportSize({ width: 1672, height: 941 });
  const writes = await useLiveFixtures(page);
  await page.goto('/#workspace');

  await expect(page.locator('.workspace-mock-meta')).toContainText('Healthy');
  await expect(page.locator('.workspace-mock-meta')).toContainText('1 of 1 repositories online');
  const metrics = page.locator('.workspace-mock-metric');
  await expect(metrics.filter({ hasText: 'Product Health' })).toContainText('1 of 1');
  await expect(metrics.filter({ hasText: 'Open Objectives' }).locator('strong')).toHaveText('2');
  await expect(metrics.filter({ hasText: 'Delivery Metrics' }).locator('strong')).toHaveText('Unavailable');
  await expect(metrics.filter({ hasText: 'Recent Decisions' }).locator('strong')).toHaveText('Unavailable');
  await expect(page.getByRole('img', { name: 'Active initiative trend' })).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Delivery metrics trend' })).toHaveCount(0);

  await expect(page.getByRole('heading', { name: 'Open Objectives (2)' })).toBeVisible();
  await expect(page.locator('.workspace-mock-objectives > div').first()).toContainText('Ship Platform v3.0 · On track · Alex');
  await expect(page.getByRole('heading', { name: 'Available Workflows (1)' })).toBeVisible();
  await expect(page.locator('.workspace-mock-card.linked-workflows')).toContainText('Release train');
  await expect(page.locator('.workspace-mock-card.files')).toContainText('Unavailable: files and evidence');
  await expect(page.locator('.workspace-mock-card.people')).toContainText('Unavailable: workspace membership');
  await expect(page.locator('.workspace-mock-card.release')).toContainText('Unavailable: release streams');
  await expect(page.locator('.workspace-mock-card.decisions')).toContainText('Unavailable: decisions require');
  await expect(page.locator('.workspace-mock-card.analytics')).toContainText('Unavailable: delivery metrics require PR and run history.');
  await expect(page.getByRole('img', { name: /Delivery trend/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose delivery metrics time range' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add Nova Platform to favorites' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add Nova Platform to favorites' }))
    .toHaveAttribute('title', 'Favorites are not stored by the control plane');
  for (const fixtureValue of ['zenchron/agent-sdk', 'Alex Chen', 'AI Agent SDK', '99.4%', 'Stable (v3.x)']) {
    await expect(page.locator('.workspace-mock')).not.toContainText(fixtureValue);
  }

  const sections = page.getByRole('navigation', { name: 'Product sections' });
  await sections.getByRole('button', { name: 'Objectives' }).click();
  await expect(page.getByRole('heading', { name: 'Objectives (3)' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Completed objective' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Timeline' }).click();
  await expect(page.locator('.workspace-mock-timeline-row').first()).toContainText('On track · Due Dec 15, 2026 · 78%');
  await page.getByRole('button', { name: 'Roadmap', exact: true }).click();
  await page.getByRole('button', { name: 'Choose roadmap quarter' }).click();
  await page.getByRole('menuitem', { name: 'Q1 ’27' }).click();
  await expect(page.locator('.workspace-mock-quarter-labels > span').nth(1)).toHaveText('Q1 ’27');
  await expect(page.locator('.workspace-mock-roadmap-row')).toHaveCount(1);
  await expect(page.locator('.workspace-mock-roadmap-row')).toContainText('Launch Agent SDK');
  await sections.getByRole('button', { name: 'Templates' }).click();
  await expect(page.getByRole('heading', { name: 'Workflow and Agent Templates (2)' })).toBeVisible();
  await expect(page.locator('.workspace-mock-card.linked-workflows')).toContainText('Code ReviewerAgent profile');
  await sections.getByRole('button', { name: 'Overview' }).click();
  await page.locator('.workspace-mock-card.people').getByRole('button', { name: /Manage/ }).click();
  await expect(page.getByRole('dialog', { name: 'Stakeholders' })).toContainText('not configured in the control plane');
  await page.keyboard.press('Escape');
  expect(writes, 'reading the workspace sends no write').toEqual([]);

  await page.getByRole('button', { name: 'Product actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit product' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit product' });
  await expect(dialog.getByLabel('Product name')).toHaveValue('Nova Platform');
  // Blank passes the browser's required check, so the schema's own validation has to reject it.
  await dialog.getByLabel('Product name').fill('   ');
  await dialog.getByRole('button', { name: 'Save product' }).click();
  await expect(dialog).toContainText('Add a product name');
  expect(writes).toEqual([]);
  await dialog.getByLabel('Product name').fill('Nova Core');
  await dialog.getByRole('button', { name: 'Save product' }).click();
  await expect(page.locator('.workspace-mock-heading h1')).toHaveText('Nova Core');
  expect(writes).toEqual([{ method: 'PUT', path: `/api/v1/products/${novaID}`,
    body: { name: 'Nova Core', description: 'Developer platform', repository_ids: [projectID] } }]);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.workspace-mock-directory')).toBeHidden();
  await page.getByRole('button', { name: 'Product actions' }).click();
  await page.getByRole('menuitem', { name: 'Orion Analytics' }).click();
  await expect(page.locator('.workspace-mock-heading h1')).toHaveText('Orion Analytics');
  await expect(page.locator('.workspace-mock-card.repositories')).toContainText('No repositories linked yet.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('Live Product Workspace reports failed and empty product lists without fixtures', async ({ page }) => {
  await useLiveFixtures(page, []);
  await page.goto('/#workspace');
  await expect(page.getByText('No products yet. Add a product to group repositories.')).toBeVisible();
  await expect(page.locator('.workspace-mock-heading h1')).toHaveText('No product selected');
  await expect(page.locator('.workspace-mock-product')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose roadmap quarter' })).toBeDisabled();

  await page.route('**/api/v1/products**', (route) => route.fulfill({ status: 500, body: 'store offline' }));
  await page.route('**/api/v1/workflows', (route) => route.fulfill({ status: 500, body: 'store offline' }));
  await page.reload();
  // TanStack Query retries a failed read three times with backoff before it reports the error.
  await expect(page.getByRole('alert').filter({ hasText: 'Product list unavailable.' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('alert').filter({ hasText: 'Workflow definitions unavailable.' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.workspace-mock-product')).toHaveCount(0);
  await expect(page.locator('.workspace-mock')).not.toContainText('Nova Platform');
});
