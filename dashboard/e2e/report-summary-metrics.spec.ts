import { expect, test } from '@playwright/test';

test('product and workspace summaries use scoped GitHub PR and Actions evidence', async ({ page }) => {
  const now = Date.now();
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const firstProject = 'a'.repeat(32);
  const secondProject = 'b'.repeat(32);
  const worker = 'c'.repeat(32);
  const product = (id: string, name: string, projectID: string) => ({
    id, name, description: '', repository_ids: [projectID], created_at: ago(2000), updated_at: ago(20),
  });
  const project = (id: string, name: string, remote: string) => ({
    id, name, branch: 'main', git_remote: remote, worker_id: worker, worker_name: 'Mac',
    worker_status: 'online', last_seen: new Date(now).toISOString(),
  });
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/healthz', (route) => route.fulfill(json({ status: 'ok' })));
  await page.route('**/api/v1/objectives', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/projects', (route) => route.fulfill(json([
    project(firstProject, 'alpha', 'github.com/acme/alpha'),
    project(secondProject, 'beta', 'github.com/acme/beta'),
  ])));
  await page.route('**/api/v1/workers', (route) => route.fulfill(json([{
    id: worker, name: 'Mac', status: 'online', last_seen: new Date(now).toISOString(), agent_runtime_enabled: false,
  }])));
  await page.route('**/api/v1/workflows', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/agents', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/products', (route) => route.fulfill(json([
    product('d'.repeat(32), 'Alpha', firstProject),
    product('e'.repeat(32), 'Beta', secondProject),
  ])));
  await page.route('**/api/v1/projects/*/pull-request-history*', (route) => {
    const isAlpha = route.request().url().includes(firstProject);
    return route.fulfill(json({ complete: true, items: isAlpha ? [
      { created_at: ago(2880), closed_at: ago(1440), merged_at: ago(1440) },
      { created_at: ago(2880), closed_at: ago(1200), merged_at: null },
    ] : [{ created_at: ago(60), closed_at: null, merged_at: null }] }));
  });
  await page.route('**/api/v1/projects/*/workflow-run-history*', (route) => {
    const isAlpha = route.request().url().includes(firstProject);
    const minutes = isAlpha ? 4 : 8;
    return route.fulfill(json({ complete: true, items: [{
      created_at: ago(60), status: 'completed', run_started_at: ago(minutes + 1), updated_at: ago(1),
    }] }));
  });

  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#reports');
  const productRows = page.locator('.product-summary-panel .report-summary-table tbody tr');
  await expect(productRows).toHaveCount(2);
  await expect(productRows.nth(0).locator('td')).toHaveText([
    'Alpha', '0.2 / wk', '24 h', '4 min', '50%', 'N/A',
  ]);
  await expect(productRows.nth(1).locator('td')).toHaveText([
    'Beta', '0 / wk', 'N/A', '8 min', 'N/A', 'N/A',
  ]);
  await expect(productRows.nth(0).locator('td abbr')).toHaveAttribute('aria-label', 'Unavailable');
  await expect(page.locator('.inventory-panel .report-summary-table tbody tr td')).toHaveText([
    'Local workspace', '0', '0.2 / wk', '24 h', '50%', 'N/A',
  ]);
});
