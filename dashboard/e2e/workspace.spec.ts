import { expect, test, type Page } from '@playwright/test';

const novaID = 'a'.repeat(32);
const orionID = 'b'.repeat(32);
const projectID = 'c'.repeat(32);
const personaID = 'e'.repeat(32);
const createdAt = '2026-01-01T00:00:00Z';
type ProductFixture = { id: string; name: string; description: string; repository_ids: string[];
  default_workflow_id?: string; created_at: string; updated_at: string };
const nova: ProductFixture = { id: novaID, name: 'Nova Platform', description: 'Developer platform', repository_ids: [projectID],
  default_workflow_id: 'release', created_at: createdAt, updated_at: createdAt };
const orion: ProductFixture = { id: orionID, name: 'Orion Analytics', description: 'Data tools', repository_ids: [],
  created_at: createdAt, updated_at: createdAt };
const historyEntry = {
  id: '9'.repeat(32), objective_id: '1'.repeat(32), plan_revision: 3, plan_hash: 'a'.repeat(40),
  product_configuration_revision: 2,
  workflow_id: 'release', workflow_version: 2, workflow_mode: 'automatic',
  assignments: [{ unit: 'build', agent_id: 'd'.repeat(32), profile_version: 1,
    persona_id: personaID, persona_version: 4 }], revision: 8, status: 'completed',
  created_at: createdAt, updated_at: createdAt, run_ids: ['run-1', 'run-2'], handoffs: 2, findings: 1,
};
const historyEntries = [historyEntry, ...Array.from({ length: 9 }, (_, index) => ({
  ...historyEntry, id: String(index + 10).repeat(32),
}))];
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/** Serves the Live workspace from fixtures and records every write the page attempts. */
async function useLiveFixtures(
  page: Page, products: ProductFixture[] = [nova, orion], objectivesUnavailable = false, historyCount = 1,
) {
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
  await page.route('**/api/v1/products/*/environment', (route) => route.fulfill(json({
    product_id: route.request().url().includes(novaID) ? novaID : orionID,
    configuration_revision: 7,
    objectives: route.request().url().includes(novaID) ? [{
      graph_id: 'f'.repeat(32), graph_status: 'running', findings: 2, handoffs: 1,
      pull_request_url: 'https://github.com/zenchron/nova-platform/pull/42',
    }] : [],
    decisions: route.request().url().includes(novaID) ? [{
      graph_id: 'f'.repeat(32), message_id: 'decision-1', objective_id: '1'.repeat(32),
      question: 'Publish the revised export?', resolved_by: '',
    }] : [],
    history: route.request().url().includes(novaID) ? historyEntries.slice(0, historyCount) : [],
  })));
  await page.route('**/api/v1/projects', (route) => route.fulfill(json([{
    id: projectID, name: 'nova-platform', branch: 'main', git_remote: 'github.com/zenchron/nova-platform',
    worker_id: 'c'.repeat(32), worker_name: 'Mac Studio', last_seen: createdAt, worker_status: 'online',
  }])));
  await page.route('**/api/v1/workers', (route) => route.fulfill(json([{
    id: 'c'.repeat(32), name: 'Mac Studio', status: 'online', last_seen: createdAt,
    providers: [{ id: 'codex-cli', version: 'codex 1.0', ready: true, sandboxed_commands: true }],
  }])));
  await page.route('**/api/v1/objectives', (route) => objectivesUnavailable
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
    : route.fulfill(json([
    { id: '1'.repeat(32), title: 'Ship Platform v3.0', description: '', owner: 'Alex', product: 'Nova Platform', product_id: novaID, status: 'on_track', progress: 78, due_date: '2026-12-15', created_at: createdAt, updated_at: createdAt },
    { id: '2'.repeat(32), title: 'Launch Agent SDK', description: '', owner: 'Priya', product: 'Nova Platform', product_id: novaID, status: 'at_risk', progress: 34, due_date: '2027-02-10', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
    { id: '4'.repeat(32), title: 'Retire legacy API', description: '', owner: '', product: 'Nova Platform', product_id: novaID, status: 'completed', progress: 100, due_date: '', created_at: createdAt, updated_at: createdAt },
    { id: '3'.repeat(32), title: 'Improve CI cycle time', description: '', owner: 'Marcus', product: 'Orion Analytics', product_id: orionID, status: 'in_progress', progress: 52, due_date: '2026-11-20', created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-03T00:00:00Z' },
  ])));
  await page.route('**/api/v1/workflows', (route) => route.fulfill(json([
    { id: 'release', name: 'Release train', description: '', status: 'draft', version: 1, nodes: [], edges: [], updated_at: createdAt },
  ])));
  await page.route('**/api/v1/agents', (route) => route.fulfill(json([{
    id: 'd'.repeat(32), name: 'Code Reviewer', description: '', provider: 'codex-cli', model: 'gpt-6.1-sol', status: 'active',
    system_prompt: '', goal_prompt: '', tools: [], persona_id: personaID, version: 1, updated_at: createdAt,
  }])));
  await page.route('**/api/v1/personas', (route) => route.fulfill(json([{
    id: personaID, name: 'Review specialist', role: 'Reviewer', responsibilities: [], instructions: '', behavior: '',
    review_specialization: 'Code review', status: 'active', version: 1, updated_at: createdAt,
  }])));
  return writes;
}

for (const viewport of [{ name: 'desktop', width: 1672, height: 941 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`Product Workspace keeps execution scope unknown when its objectives fail (${viewport.name})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await useLiveFixtures(page, [nova, orion], true);
    await page.goto('/#workspace');
    await page.getByRole('navigation', { name: 'Product sections' }).getByRole('button', { name: 'Objectives' }).click();

    await expect(page.getByText('Product objectives could not be loaded. WorkGraph scope is unknown.', { exact: true }))
      .toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('No objective of this product has an approved plan.', { exact: false })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`workspace-objective-scope-${viewport.name}.png`), fullPage: true });
  });
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
  // The frame stays aligned; Live objective configuration can grow the content row.
  expect(layout.directory?.x).toBe(263);
  expect(layout.directory?.y).toBe(100);
  expect(layout.directory?.width).toBe(250);
  expect(layout.detail?.x).toBe(529);
  expect(layout.metrics?.y).toBe(192);
  expect(layout.tabs?.y).toBe(283);
  expect(layout.content?.y).toBe(334);
  expect(layout.bottom?.y).toBe((layout.content?.bottom ?? 0) + 12);
  await expect(page.getByRole('combobox', { name: 'Objective repository' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Objective workflow' })).toBeVisible();
  const objectivesCard = page.locator('.workspace-mock-card.objectives');
  const configurationBounds = await objectivesCard.locator('.workspace-mock-objective-create').boundingBox();
  const cardBounds = await objectivesCard.boundingBox();
  expect(configurationBounds && cardBounds).toBeTruthy();
  expect(configurationBounds!.y + configurationBounds!.height).toBeLessThanOrEqual(cardBounds!.y + cardBounds!.height);
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
  await page.getByRole('button', { name: 'Share' }).click();
  const shareURL = new URL(await page.getByRole('textbox', { name: 'Workspace link' }).inputValue());
  expect(shareURL.searchParams.get('product')).toBe(orionID);
  await page.goto(shareURL.toString());
  await expect(productName).toHaveText('Orion Analytics');
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

test('Live Product Workspace shows real data, honest gaps, and saves product edits', async ({ page }, testInfo) => {
  expect(new Set(historyEntries.map(({ id }) => id)).size).toBe(historyEntries.length);
  await page.setViewportSize({ width: 1672, height: 941 });
  const writes = await useLiveFixtures(page, [nova, orion], false, 10);
  await page.goto('/#workspace');

  await expect(page.locator('.workspace-mock-meta')).toContainText('Healthy');
  await expect(page.locator('.workspace-mock-meta')).toContainText('1 of 1 repositories online');
  const metrics = page.locator('.workspace-mock-metric');
  await expect(metrics.filter({ hasText: 'Product Health' })).toContainText('1 of 1');
  await expect(metrics.filter({ hasText: 'Open Objectives' }).locator('strong')).toHaveText('2');
  await expect(metrics.filter({ hasText: 'Delivery Metrics' }).locator('strong')).toHaveText('1');
  await expect(metrics.filter({ hasText: 'Pending Decisions' }).locator('strong')).toHaveText('1');
  await expect(page.getByRole('img', { name: 'Active initiative trend' })).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Delivery metrics trend' })).toHaveCount(0);

  await expect(page.getByRole('heading', { name: 'Open Objectives (2)' })).toBeVisible();
  await expect(page.locator('.workspace-mock-objectives > div').first()).toContainText('Ship Platform v3.0 · On track · Alex');
  await expect(page.getByRole('heading', { name: 'Available Workflows (1)' })).toBeVisible();
  await expect(page.locator('.workspace-mock-card.linked-workflows')).toContainText('Release train');
  await expect(page.locator('.workspace-mock-card.files')).toContainText('Unavailable: files and evidence');
  await expect(page.locator('.workspace-mock-card.people')).toContainText('Unavailable: workspace membership');
  await expect(page.locator('.workspace-mock-card.release')).toContainText('Unavailable: release streams');
  await expect(page.locator('.workspace-mock-card.decisions')).toContainText('Publish the revised export?');
  await expect(page.locator('.workspace-mock-card.analytics')).toContainText('WorkGraphs1 current');
  await expect(page.locator('.workspace-mock-card.analytics')).toContainText('Findings2 recorded');
  await expect(page.locator('.workspace-mock-card.decisions').getByRole('link', { name: 'Publish the revised export?' }))
    .toHaveAttribute('href', `/?objective=${'1'.repeat(32)}&tab=plan&graph_id=${'f'.repeat(32)}&decision=decision-1&mode=live#objectives`);
  const workGraph = page.locator('.workspace-mock-card.history');
  await expect(workGraph.locator('.history-list > div')).toHaveCount(5);
  await workGraph.getByRole('button', { name: 'View All' }).click();
  await expect(workGraph.locator('.history-list > div')).toHaveCount(10);
  await expect(workGraph).toContainText('Plan r3 · aaaaaaaa · Product config r2 · Graph r8 · release v2 · automatic');
  await expect(workGraph).toContainText('Runs: run-1, run-2 · Handoffs 2 · Findings 1');
  await expect(workGraph.getByRole('link', { name: 'Ship Platform v3.0' }).first())
    .toHaveAttribute('href', `/?objective=${'1'.repeat(32)}&tab=plan&graph_id=${'9'.repeat(32)}&mode=live#objectives`);
  await expect(workGraph).toContainText(`build: ${'d'.repeat(32)} profile v1 · persona v4`);
  await expect(workGraph.locator('.history-list > div').last()).toBeVisible();
  expect(await workGraph.evaluate((card) => card.scrollHeight <= card.clientHeight + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workspace-history-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(await workGraph.evaluate((card) => card.scrollHeight <= card.clientHeight + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workspace-history-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.getByRole('navigation', { name: 'Product sections' }).getByRole('button', { name: 'Overview' }).click();
  await page.screenshot({ path: testInfo.outputPath('workspace-environment-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath('workspace-environment-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1672, height: 941 });
  await expect(page.getByRole('img', { name: /Delivery trend/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose delivery metrics time range' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Choose delivery metrics time range' }))
    .toHaveAttribute('title', 'No time-series delivery data is recorded.');
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
  await expect(page.getByRole('heading', { name: 'Workflows and Agent Profiles (2)' })).toBeVisible();
  await expect(page.locator('.workspace-mock-card.linked-workflows')).toContainText('Code ReviewerReview specialist · codex-cli · gpt-6.1-solcodex-cli ready');
  await expect(page.locator('.workspace-mock-card.linked-workflows').getByRole('link', { name: 'Code Reviewer' }))
    .toHaveAttribute('href', `/?profile=${'d'.repeat(32)}&mode=live#agents`);
  await page.screenshot({ path: testInfo.outputPath('workspace-profiles-desktop.png'), fullPage: true });
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
    body: { name: 'Nova Core', description: 'Developer platform', repository_ids: [projectID],
      default_workflow_id: 'release' } }]);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.workspace-mock-directory')).toBeHidden();
  await page.getByRole('button', { name: 'Product actions' }).click();
  await page.getByRole('menuitem', { name: 'Orion Analytics' }).click();
  await expect(page.locator('.workspace-mock-heading h1')).toHaveText('Orion Analytics');
  await expect(page.locator('.workspace-mock-card.repositories')).toContainText('No repositories linked yet.');
  await expect(page.locator('.workspace-mock-card.history')).toContainText('No WorkGraph history is recorded for this product.');
  await expect(page.locator('.workspace-mock-card.history')).not.toContainText('run-1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('Product Workspace focuses durable cards for each operator role', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1672, height: 941 });
  await useLiveFixtures(page);
  await page.goto('/?mode=live#workspace');
  const focus = page.getByRole('combobox', { name: 'Workspace focus' });
  const tabs = page.getByRole('navigation', { name: 'Product sections' });
  const card = (name: string) => page.locator(`.workspace-mock-card.${name}`);

  await focus.selectOption('Product owner');
  await expect(card('objectives')).toBeVisible();
  await expect(card('decisions')).toBeVisible();
  await expect(card('repositories')).toBeHidden();
  await focus.selectOption('Engineer');
  await expect(tabs.getByRole('button').allTextContents()).resolves.toEqual(['Overview', 'Objectives', 'Repos', 'Templates']);
  await expect(card('repositories')).toBeVisible();
  await expect(card('linked-workflows')).toBeVisible();
  await expect(card('decisions')).toBeHidden();

  await focus.selectOption('Designer');
  await expect(tabs.getByRole('button').allTextContents()).resolves.toEqual(['Overview', 'Objectives', 'Files']);
  await expect(card('files')).toContainText('Unavailable: files and evidence');
  await expect(card('decisions')).toBeHidden();

  await focus.selectOption('Security reviewer');
  await expect(focus).toHaveValue('Security reviewer');
  await expect(tabs.getByRole('button').allTextContents()).resolves.toEqual(['Objectives', 'Decisions']);
  await expect(page.getByRole('heading', { name: 'Objectives (3)' })).toBeVisible();
  await tabs.getByRole('button', { name: 'Decisions' }).click();
  await expect(page.locator('.workspace-mock-grid')).toBeHidden();
  await expect(card('decisions').getByRole('link', { name: 'Publish the revised export?' })).toBeVisible();
  await expect(card('people')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('workspace-security-reviewer-desktop.png'), fullPage: true });

  await focus.selectOption('Platform operator');
  await expect(tabs.getByRole('button').allTextContents()).resolves.toEqual(['Overview', 'Repos', 'Templates', 'Decisions']);
  await tabs.getByRole('button', { name: 'Overview' }).click();
  await expect(card('linked-workflows')).toBeVisible();
  await expect(card('analytics')).toBeVisible();
  await expect(card('files')).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath('workspace-platform-operator-mobile.png'), fullPage: true });
  await focus.selectOption('All sections');
  const mobileTabLayout = await tabs.evaluate((element) => {
    const buttons = [...element.querySelectorAll('button')];
    return {
      count: buttons.length,
      overflowing: buttons.filter((button) => button.scrollWidth > button.clientWidth).length,
    };
  });
  expect(mobileTabLayout).toEqual({ count: 7, overflowing: 0 });
  await page.screenshot({ path: testInfo.outputPath('workspace-all-sections-mobile.png'), fullPage: true });

  await page.setViewportSize({ width: 310, height: 844 });
  const narrowTabLayout = await tabs.evaluate((element) => {
    const buttons = [...element.querySelectorAll('button')];
    const bounds = buttons.map((button) => button.getBoundingClientRect());
    return {
      count: buttons.length,
      overflowing: buttons.filter((button) => button.scrollWidth > button.clientWidth).length,
      undersized: buttons.filter((button) => button.clientHeight < 24 || button.clientWidth < 24).length,
      overlapping: bounds.some((left, index) => bounds.slice(index + 1).some((right) =>
        Math.abs(left.top - right.top) < 1 && left.right > right.left)),
    };
  });
  expect(narrowTabLayout).toEqual({ count: 7, overflowing: 0, undersized: 0, overlapping: false });

});

test('Live Product Workspace saves a default workflow and carries it into objective creation', async ({ page }) => {
  const productWithoutDefault = { ...nova };
  delete productWithoutDefault.default_workflow_id;
  const writes = await useLiveFixtures(page, [productWithoutDefault, orion]);
  await page.goto('/?mode=live#workspace');
  await page.getByRole('button', { name: 'Product actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit product' }).click();

  const dialog = page.getByRole('dialog', { name: 'Edit product' });
  await dialog.getByRole('combobox', { name: 'Default workflow for new objectives' }).click();
  await page.getByRole('option', { name: 'Release train' }).click();
  await dialog.getByRole('button', { name: 'Save product' }).click();
  expect(writes).toEqual([{ method: 'PUT', path: `/api/v1/products/${novaID}`,
    body: { name: 'Nova Platform', description: 'Developer platform', repository_ids: [projectID],
      default_workflow_id: 'release' } }]);

  await page.getByRole('link', { name: 'Create objective for Nova Platform' }).click();
  await expect(page).toHaveURL(/workflow=release/);
});

test('Live Product Workspace rejects another product’s execution projection', async ({ page }) => {
  await useLiveFixtures(page);
  await page.route('**/api/v1/products/*/environment', (route) => route.fulfill(json({
    product_id: orionID, objectives: [{ graph_id: 'f'.repeat(32), pull_request_url: 'https://github.com/example/other/pull/1' }],
    decisions: [{ objective_id: '3'.repeat(32), question: 'Other product decision' }],
  })));
  await page.goto('/#workspace');
  await expect(page.getByRole('alert').filter({ hasText: 'Product execution evidence unavailable.' }).first())
    .toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.workspace-mock-metric.delivery strong')).toHaveText('Unavailable');
  await expect(page.locator('.workspace-mock')).not.toContainText('Other product decision');
});

test('Product Workspace links runs to Reviews and resolves decisions through its governed API action', async ({ page }, testInfo) => {
  await useLiveFixtures(page);
  await page.setViewportSize({ width: 1672, height: 941 });
  const graphID = 'f'.repeat(32);
  const objectiveID = '1'.repeat(32);
  const graph: {
    id: string; objective_id: string; objective_title: string; plan_revision: number; revision: number;
    status: string; project_name: string; base_branch: string; max_parallel: number; created_at: string; updated_at: string;
    units: { key: string; kind: string; title: string; instructions: string; acceptance: string[]; depends_on: string[];
      capabilities: string[]; agent_id: string; agent_name: string; state: string; reason: string; run_ids: string[] }[];
    messages: { id: string; type: string; from: string; to: string[]; run_id?: string; attempt?: number; body: string;
      notes: string[]; created_at: string; resolves?: string; by?: string }[];
  } = {
    id: graphID, objective_id: objectiveID, objective_title: 'Ship Platform v3.0', plan_revision: 2,
    revision: 3, status: 'blocked', project_name: 'nova-platform', base_branch: 'main', max_parallel: 2,
    created_at: createdAt, updated_at: createdAt,
    units: [{ key: 'api', kind: 'produce', title: 'Update export', instructions: 'Implement the API change.',
      acceptance: [], depends_on: [], capabilities: ['code.write'], agent_id: 'd'.repeat(32),
      agent_name: 'Code Reviewer', state: 'blocked', reason: 'Waiting for the operator decision.',
      run_ids: ['9'.repeat(32), '8'.repeat(32)] }],
    messages: [{ id: 'decision-1', type: 'decision_request', from: 'api', to: [], run_id: '9'.repeat(32), attempt: 1,
      body: 'Publish the revised export?', notes: ['publish', 'hold'], created_at: createdAt }],
  };
  let action: { method: string; path: string; body: unknown; status?: number } | undefined;
  await page.route('**/api/v1/work-graphs', (route) => route.fulfill(json([graph])));
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill(json([{
    id: '9'.repeat(32), agent_id: 'd'.repeat(32), agent_name: 'Code Reviewer', project_id: projectID,
    project_name: 'nova-platform', worker_id: 'c'.repeat(32), worker_name: 'Mac Studio', branch: 'feature/export',
    prompt: 'Update export', status: 'succeeded', attempts: 1, created_at: createdAt, updated_at: createdAt,
    graph_id: graphID, unit_key: 'api', usage: { input_tokens: 1234, output_tokens: 567, cost_usd: 0.05 },
  }])));
  await page.route('**/api/v1/work-graphs/*/decisions/*', async (route) => {
    action = { method: route.request().method(), path: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON() };
    graph.messages = [...graph.messages, { id: 'decision-2', type: 'decision_resolution', from: 'local operator', to: ['api'],
      resolves: 'decision-1', by: 'Local workspace', body: 'publish', notes: [], created_at: createdAt }];
    graph.status = 'running';
    await route.fulfill(json(graph));
    action.status = 200;
  });

  await page.goto('/?mode=live#workspace');
  await page.getByRole('navigation', { name: 'Product sections' }).getByRole('button', { name: 'Objectives' }).click();
  const execution = page.getByRole('region', { name: 'Work graph for Ship Platform v3.0' });
  const runID = '9'.repeat(32);
  await expect(page.getByRole('status', { name: 'Provider usage for Ship Platform v3.0' }))
    .toHaveText('Provider-reported usage (1 of 2 runs): 1,234 input / 567 output tokens · $0.05 provider-reported cost for 1 run');
  await expect(execution.getByRole('link', { name: `Open run ${runID} in Reviews` }))
    .toHaveAttribute('href', `/?run=${runID}&mode=live#reviews`);
  await page.screenshot({ path: testInfo.outputPath('workspace-run-links-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath('workspace-run-links-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1672, height: 941 });
  const decision = execution.getByRole('form', { name: 'Decision for api' });
  await expect(decision).toContainText('Publish the revised export?');
  await decision.getByRole('button', { name: 'publish' }).click();
  await decision.getByRole('button', { name: 'Resolve decision' }).click();
  await expect.poll(() => action).toEqual({
    method: 'POST', path: `/api/v1/work-graphs/${graphID}/decisions/decision-1`,
    body: { resolution: 'publish' }, status: 200,
  });
});

test('local Live product navigation stays Live when opening objective creation', async ({ page }, testInfo) => {
  await useLiveFixtures(page);
  const localURL = new URL(testInfo.project.use.baseURL!);
  localURL.hostname = '127.0.0.1';
  localURL.search = '?mode=live';
  localURL.hash = '#workspace';
  await page.goto(localURL.toString());
  await expect(page.getByRole('link', { name: 'Create objective for Nova Platform' })).toBeVisible();
  await page.getByRole('link', { name: 'Create objective for Nova Platform' }).click();
  await expect(page).toHaveURL(/mode=live.*#objectives$/);
  await expect(page).toHaveURL(/workflow=release/);
  await expect(page.getByRole('dialog', { name: 'New objective' }).getByRole('combobox', { name: 'Product' }))
    .toHaveValue('Nova Platform');
});

test('Live Product Workspace explains unavailable profile configuration', async ({ page }, testInfo) => {
  await useLiveFixtures(page);
  await page.route('**/api/v1/personas', (route) => route.fulfill(json([])));
  await page.goto('/#workspace');
  await page.getByRole('navigation', { name: 'Product sections' }).getByRole('button', { name: 'Templates' }).click();
  await expect(page.locator('.workspace-mock-card.linked-workflows')).toContainText('Persona unavailable');

  await page.route('**/api/v1/agents', (route) => route.fulfill(json([{
    id: 'd'.repeat(32), name: 'Code Reviewer', description: '', provider: 'codex-cli', model: 'gpt-6.1-sol',
    status: 'active', system_prompt: '', goal_prompt: '', tools: [], version: 1, updated_at: createdAt,
  }])));
  await page.route('**/api/v1/workers', (route) => route.fulfill(json([])));
  await page.reload();
  await page.getByRole('navigation', { name: 'Product sections' }).getByRole('button', { name: 'Templates' }).click();
  await expect(page.locator('.workspace-mock-card.linked-workflows')).toContainText('Code ReviewerNo persona · codex-cli · gpt-6.1-solNo online worker');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.workspace-mock-card.linked-workflows')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath('workspace-profiles-mobile.png'), fullPage: true });
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
  await page.getByRole('navigation', { name: 'Product sections' }).getByRole('button', { name: 'Templates' }).click();
  await expect(page.locator('.workspace-mock-card.linked-workflows')).toContainText('Code Reviewer');
  await expect(page.locator('.workspace-mock-product')).toHaveCount(0);
  await expect(page.locator('.workspace-mock')).not.toContainText('Nova Platform');
});
