import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: true, login: 'Reports E2E' }),
  }));
});

test('Reports CSV exports neutralize formula text and preserve number fields', async ({ page }) => {
  const now = Date.now();
  const stamp = (daysAgo: number) => new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  const productID = 'a'.repeat(32);
  const firstProjectID = 'b'.repeat(32);
  const secondProjectID = 'c'.repeat(32);
  const workerID = 'd'.repeat(32);
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/api/v1/objectives', (route) => route.fulfill(json([{
    id: 'e'.repeat(32), title: 'Objective', description: '', owner: 'Platform',
    product: '@SUM(A1)', product_id: productID, status: 'in_progress', progress: 40, due_date: '',
    created_at: stamp(2), updated_at: stamp(2),
  }])));
  await page.route('**/api/v1/projects', (route) => route.fulfill(json([
    {
      id: firstProjectID, name: ' =1+1', branch: 'main', git_remote: '', worker_id: workerID,
      worker_name: 'Zoë "Mac", Jr. 日本', worker_status: 'online', last_seen: stamp(0),
    },
    {
      id: secondProjectID, name: '\t=2+2', branch: 'main', git_remote: '', worker_id: workerID,
      worker_name: 'Zoë "Mac", Jr. 日本', worker_status: 'online', last_seen: stamp(0),
    },
  ])));
  await page.route('**/api/v1/workers', (route) => route.fulfill(json([
    { id: workerID, name: 'Zoë "Mac", Jr. 日本', status: 'online', last_seen: stamp(0) },
  ])));
  await page.route('**/api/v1/products', (route) => route.fulfill(json([{
    id: productID, name: '@SUM(A1)', description: '', repository_ids: [firstProjectID],
    created_at: stamp(20), updated_at: stamp(2),
  }])));
  await page.route('**/api/v1/agents', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill(json([{
    id: 'f'.repeat(32), agent_id: '1'.repeat(32), agent_name: '=HYPERLINK("http://x","y")',
    project_id: firstProjectID, project_name: '+1+1', worker_id: workerID, worker_name: 'Zoë "Mac", Jr. 日本',
    branch: '-2+3', prompt: 'Review changes.', status: 'succeeded', attempts: 1, created_at: stamp(2),
    updated_at: stamp(2), usage: { input_tokens: 1200, output_tokens: 300, cost_usd: 1.25 },
  }])));
  await page.addInitScript(() => {
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download.endsWith('.csv')) {
        (window as Window & { downloadedCSV?: Promise<string> }).downloadedCSV = fetch(this.href)
          .then((response) => response.text());
      }
      originalClick.call(this);
    };
  });

  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#reports');
  await expect(page.locator('.reports-page')).not.toHaveAttribute('data-preview');
  await expect(page.locator('.reports-metric.agent-spend strong')).toHaveText('$1.25');
  await expect(page.locator('.inventory-panel .report-summary-table tbody tr td').nth(1)).toHaveText('1');
  await expect(page.locator('.product-summary-panel .report-summary-table tbody tr')
    .filter({ hasText: '@SUM(A1)' })).toBeVisible();

  const downloadCsv = async (name: string) => {
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: `Download ${name} CSV` }).click();
    const download = await downloadPromise;
    const csv = await page.evaluate(async () =>
      await (window as Window & { downloadedCSV?: Promise<string> }).downloadedCSV,
    );
    return { filename: download.suggestedFilename(), rows: csv!.split('\r\n') };
  };

  const executive = await downloadCsv('Executive Summary');
  expect(executive.filename).toMatch(/^zenchron-executive-summary-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(executive.rows).toContain('"Metric","Value"');
  expect(executive.rows).toContain('"Time range","Last 30 Days"');
  expect(executive.rows).toContain('"Objectives",1');
  expect(executive.rows).toContain('"Agent runs",1');
  expect(executive.rows).toContain('"Local checkouts",2');

  const detailed = await downloadCsv('Detailed Metrics');
  expect(detailed.filename).toMatch(/^zenchron-detailed-metrics-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(detailed.rows).toContain('"Metric","Value","Source"');
  expect(detailed.rows).toContain('"Agent spend","$1.25","Cost reported by providers for 1 of 1 runs."');

  const spend = await downloadCsv('Agent Spend & Utilization');
  expect(spend.filename).toMatch(/^zenchron-agent-spend-utilization-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(spend.rows).toContain('"Agent","Project","Branch","Status","Spend (USD)","Usage","Source"');
  expect(spend.rows).toContain(
    `"'=HYPERLINK(""http://x"",""y"")","'+1+1","'-2+3","succeeded",1.25,"1200 input / 300 output tokens","Reported by the provider"`,
  );

  const workspace = await downloadCsv('Product & Workspace Report');
  expect(workspace.filename).toMatch(/^zenchron-product-workspace-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(workspace.rows).toContain(
    '"Product","\'@SUM(A1)",1,1,1,"Unavailable","Unavailable","Unavailable","Unavailable","Unavailable","",""',
  );
  expect(workspace.rows).toContain(
    '"Repository","\' =1+1",1,"",1,"","","","","","Zoë ""Mac"", Jr. 日本","online"',
  );
  expect(workspace.rows).toContain(
    '"Repository","\'\t=2+2",1,"",0,"","","","","","Zoë ""Mac"", Jr. 日本","online"',
  );
  expect(workspace.rows).toContain(
    '"Workspace","Local workspace","",1,"","Unavailable","Unavailable","Unavailable","Unavailable","Unavailable","",""',
  );

  const exports = [executive, detailed, spend, workspace];
  for (const report of exports) {
    expect(report.rows.some((row) => /(^|,)"\s*[=+\-@]/.test(row))).toBe(false);
  }
  expect(executive.rows[0]).toBe('"Metric","Value"');
  expect(spend.rows[1]).toContain('"succeeded"');
  expect(workspace.rows.some((row) => row.startsWith('"Workspace","Local workspace"')))
    .toBe(true);
});
