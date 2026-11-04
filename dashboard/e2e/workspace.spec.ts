import { expect, test } from '@playwright/test';

test('Product Workspace matches its desktop frame and filters products', async ({ page }) => {
  await page.setViewportSize({ width: 1672, height: 856 });
  const projectID = 'c'.repeat(32);
  await page.route('**/api/v1/products', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      { id: 'a'.repeat(32), name: 'Nova Platform', description: 'Developer platform', repository_ids: [projectID], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      { id: 'b'.repeat(32), name: 'Orion Analytics', description: 'Data tools', repository_ids: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    ]),
  }));
  await page.route('**/api/v1/projects', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{
      id: projectID, name: 'nova-platform', branch: 'main', git_remote: 'github.com/zenchron/nova-platform',
      worker_id: 'c'.repeat(32), worker_name: 'Mac Studio', last_seen: '2026-01-01T00:00:00Z', worker_status: 'online',
    }]),
  }));
  await page.route('**/api/v1/objectives', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      { id: '1'.repeat(32), title: 'Ship Platform v3.0', description: '', owner: 'Alex', product: 'Nova Platform', product_id: 'a'.repeat(32), status: 'on_track', progress: 78, due_date: '2026-12-15', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      { id: '2'.repeat(32), title: 'Launch Agent SDK', description: '', owner: 'Priya', product: 'Nova Platform', product_id: 'a'.repeat(32), status: 'at_risk', progress: 34, due_date: '2027-02-10', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
      { id: '3'.repeat(32), title: 'Improve CI cycle time', description: '', owner: 'Marcus', product: 'Orion Analytics', product_id: 'b'.repeat(32), status: 'in_progress', progress: 52, due_date: '2026-11-20', created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-03T00:00:00Z' },
    ]),
  }));
  await page.goto('/#workspace');
  await expect(page.getByRole('heading', { name: 'Product Workspace' })).toBeVisible();
  await expect(page.locator('.workspace-project-heading h3')).toHaveText('Nova Platform');
  await expect(page.locator('.workspace-project-heading h3')).toHaveCSS('font-size', '18px');
  await expect(page.locator('.workspace-repository-row')).toHaveCount(1);
  await expect(page.locator('.workspace-repository-row')).toContainText('nova-platform');
  await expect(page.locator('.workspace-repository-row')).toContainText('Mac Studio · main');
  await expect(page.getByRole('heading', { name: 'Product roadmap' })).toBeVisible();
  await expect(page.locator('.workspace-roadmap-row')).toHaveCount(2);
  await expect(page.locator('.workspace-roadmap-axis > div > span')).toHaveText(["Q4 '26", "Q1 '27"]);
  await expect(page.locator('.workspace-roadmap-marker.on_track')).toHaveCount(1);

  const layout = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
    return {
      directory: bounds('.workspace-directory'),
      detail: bounds('.workspace-project-heading'),
      metrics: bounds('.workspace-metrics'),
      tabs: bounds('.workspace-tabs'),
      content: bounds('.workspace-content-grid'),
    };
  });
  expect(layout.directory?.x).toBe(168);
  expect(layout.directory?.y).toBe(94);
  expect(layout.directory?.width).toBe(260);
  expect(layout.detail?.x).toBe(445);
  expect(layout.metrics?.y).toBe(182);
  expect(layout.tabs?.y).toBe(270);
  expect(layout.content?.y).toBe(323);
  const repositoryTile = await page.locator('.workspace-repository-row').boundingBox();
  expect(repositoryTile?.height).toBeLessThan(70);
  expect((layout.content?.y ?? 0) + (layout.content?.height ?? 0)).toBeLessThanOrEqual(856);

  await page.getByRole('textbox', { name: 'Search products' }).fill('Orion');
  await expect(page.locator('.workspace-project-option')).toContainText('Orion Analytics');
  await expect(page.locator('.workspace-project-option')).toHaveCount(1);
  await page.locator('.workspace-project-option').click();
  await expect(page.locator('.workspace-project-heading h3')).toHaveText('Orion Analytics');
  await expect(page.locator('.workspace-roadmap-row')).toHaveCount(1);
  await expect(page.locator('.workspace-roadmap-label')).toContainText('Improve CI cycle time');
  await page.getByRole('textbox', { name: 'Search products' }).fill('no match');
  await expect(page.locator('.workspace-directory')).toContainText('No products match your search.');

  await page.setViewportSize({ width: 1672, height: 749 });
  await expect(page.locator('.workspace-title-row')).toBeHidden();
  await expect(page.getByRole('button', { name: '+ Add Product', exact: true })).toHaveCount(1);
  expect(await page.locator('.sidebar').evaluate((element) => element.getBoundingClientRect().width)).toBe(150);
  expect(await page.locator('.workspace-directory').evaluate((element) => element.getBoundingClientRect().x)).toBe(168);
});
