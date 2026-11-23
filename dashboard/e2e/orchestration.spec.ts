Warning: truncated output (original token count: 11123)
Total output lines: 625

import { expect, test, type Page } from '@playwright/test';

const dashboardPort = Number((globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env?.ZENCHRON_E2E_DASHBOARD_PORT) || 4173;
const now = new Date().toISOString();
const objectiveID = '11'.repeat(16);
const graphID = '22'.repeat(16);
const writerID = 'aa'.repeat(16);
const reviewerID = 'bb'.repeat(16);
const projectID = 'ef'.repeat(16);
const workerID = 'cd'.repeat(16);
const runID = '33'.repeat(16);
const viewports = [{ name: 'desktop', width: 1672, height: 941 }, { name: 'mobile', width: 390, height: 844 }];
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const objective = { id: objectiveID, title: 'Ship usage export', description: 'Export usage as CSV.', owner: 'Alex Chen',
  product: 'Core Product', product_id: '44'.repeat(16), status: 'in_progress', progress: 10, due_date: '', created_at: now, updated_at: now };
const planUnits = [
  { key: 'api', kind: 'produce', title: 'Expose usage over the API', instructions: 'Add the endpoint.',
    acceptance: ['GET /usage returns totals'], depends_on: [], capabilities: ['code.write'], agent_id: writerID },
  { key: 'review-api', kind: 'review', title: 'Review the API change', instructions: '', acceptance: null, depends_on: ['api'],
    capabilities: null, agent_id: reviewerID },
  { key: 'integrate', kind: 'integrate', title: 'Combine and publish', instructions: '', acceptance: [], depends_on: ['review-api'],
    capabilities: [] },
];
const decision = { id: 'm-3', type: 'decision_request', from: 'api', run_id: runID, attempt: 1, body: 'Comma or semicolon as the separator?',
  notes: ['comma', 'semicolon'], created_at: now };
const graph = {
  id: graphID, objective_id: objectiveID, objective_title: objective.title, plan_revision: 1, plan_hash: 'h', revision: 4,
  status: 'failed', project_id: projectID, project_name: 'platform', worker_id: workerID, worker_name: 'dev-laptop',
  base_branch: 'main', max_parallel: 2, created_at: now, updated_at: now,
  units: [
    { ...planUnits[0], agent_name: 'Codex engineer', state: 'blocked', reason: 'Waiting for a decision from a person.',
      run_ids: [runID], candidate: 'a'.repeat(40) },
    { ...planUnits[1], agent_name: 'Claude reviewer', state: 'failed', failure: 'The unit used all 6 of its runs.', run_ids: [], verdict: 'block' },
    { ...planUnits[2], state: 'completed', run_ids: [runID], candidate: 'c'.repeat(40),
      pull_request_url: 'https://github.com/acme/platform/pull/23' },
  ],
  messages: [
    { id: 'm-1', type: 'handoff', from: 'api', run_id: runID, attempt: 1, commit: 'a'.repeat(40), body: 'Added the endpoint.',
      notes: ['Totals are per run'], created_at: now },
    { id: 'm-2', type: 'finding', from: 'review-api', to: ['api'], commit: 'a'.repeat(40), title: 'Header row is missing',
      body: 'The CSV starts with data. '.repeat(12), file: 'api.go', line: 12, severity: 'high', created_at: now },
    decision,
  ],
};
const plan = { objective_id: objectiveID, revision: 1, status: 'approved', project_id: projectID, summary: 'One producer, one review.',
  max_parallel: 2, units: planUnits, graph_id: graphID, created_at: now, approved_by: 'local operator' };
const agents = [
  { id: writerID, name: 'Codex engineer', description: '', provider: 'codex-cli', model: 'default', status: 'active',
    system_prompt: '', goal_prompt: '', tools: ['code.write'], version: 1, updated_at: now },
  { id: reviewerID, name: 'Claude reviewer', description: '', provider: 'claude-code', model: 'default', status: 'active',
    system_prompt: '', goal_prompt: '', tools: ['git.diff'], version: 1, updated_at: now },
];
const projects = [{ id: projectID, name: 'platform', branch: 'main', git_remote: 'github.com/acme/platform', worker_id: workerID,
  worker_name: 'dev-laptop', last_seen: now, worker_status: 'online' },
{ id: '8a'.repeat(16), name: 'unrelated', branch: 'main', git_remote: 'github.com/acme/unrelated', worker_id: workerID,
  worker_name: 'dev-laptop', last_seen: now, worker_status: 'online' }];

/** A signed-in dashboard whose API is answered here, so each state can be shown exactly. */
async function mockOrchestration(page: Page, state: { graphs?: unknown[]; plans?: unknown[]; graphsStatus?: number }) {
  await page.route('**/api/v1/**', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/auth/session', (route) => route.fulfill(json({ authenticated: true, local: true, login: 'E2E' })));
  await page.route('**/healthz', (route) => route.fulfill(json({ status: 'ok' })));
  await page.route('**/api/v1/objectives', (route) => route.fulfill(json([objective])));
  await page.route('**/api/v1/products', (route) => route.fulfill(json([{ id: objective.product_id, name: 'Core Product',
    description: 'The product.', repository_ids: [projectID], created_at: now, updated_at: now }])));
  await page.route('**/api/v1/agents', (route) => route.fulfill(json(agents)));
  await page.route('**/api/v1/projects', (route) => route.fulfill(json(projects)));
  await page.route('**/api/v1/work-graphs', (route) => state.graphsStatus
    ? route.fulfill({ status: state.graphsStatus, body: 'unavailable' }) : route.fulfill(json(state.graphs ?? [])));
  await page.route(`**/api/v1/objectives/${objectiveID}/plans`, (route) => route.request().method() === 'GET'
    ? route.fulfill(json(state.plans ?? [])) : route.fallback());
}

async function openPlan(page: Page) {
  await page.goto(`/?objective=${objectiveID}#objectives`);
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();
  return page.getByRole('tabpanel');
}

for (const viewport of viewports) {
  test(`plan revisions link planned records without calling them executed (${viewport.name})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const workflowID = 'wf-plan';
    const planned = { ...plan, status: 'proposed', w…8123 tokens truncated…yRole('heading', { name: 'Execution and publication' })).toBeVisible();
  await expect(report).toContainText(/WorkGraph execution: (active|blocked|completed|failed|cancelled)/);
  await expect(report).toContainText('Recorded pull request: GitHub publication is not configured');
  await expect(report).toContainText('WorkGraph completion does not establish publication.');
  await expect(report).toContainText(`Compiled from workflow ${created.workflowID} · version ${created.workflowVersion}`);
  await expect(report.getByRole('link', { name: created.workflowID, exact: true }))
    .toHaveAttribute('href', `/?workflow=${created.workflowID}&mode=live#workflows`);
  await expect(report.getByRole('link', { name: 'Agent profile', exact: true }).first())
    .toHaveAttribute('href', `/?profile=${created.writerID}&mode=live#agents`);
  await expect(report).toContainText('E2E CSV specialist v1');
  await expect(report).toContainText('codex-cli');
  await expect(report).toContainText('Worker-reported verification: not_configured');
  await expect(report).toContainText([
    'Unknown evidence: GitHub checks for the integrated candidate', 'independent policy-backed assurance',
    'publication authority', 'current pull request state',
  ].join(', '));
  await expect(report.locator('.objective-delivery-run').filter({ hasText: /Tree/ }).first()).toBeVisible();
  await expect(report.locator('a[href$="#reviews"]').first()).toHaveAttribute('href', /^\/\?run=.+&mode=live#reviews$/);
  await expect(report).toContainText('CSV');
  await expect(report).toContainText('GitHub publication is not configured');
  await expect(report).toContainText('Unknown');
  await page.evaluate(() => {
    const createObjectURL = URL.createObjectURL.bind(URL);
    const revokeObjectURL = URL.revokeObjectURL.bind(URL);
    const setTimeout = window.setTimeout.bind(window);
    const state = window as typeof window & {
      __deliveryRevokeDelay?: number; __deliveryRevoked?: boolean; __deliveryRevoke?: () => void;
    };
    URL.createObjectURL = (blob: Blob) => {
      void blob.text().then((content) => {
        (window as typeof window & { __deliveryExport?: string }).__deliveryExport = content;
      });
      return createObjectURL(blob);
    };
    URL.revokeObjectURL = (url) => {
      state.__deliveryRevoked = true;
      revokeObjectURL(url);
    };
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof callback === 'function' && callback.toString().includes('revokeObjectURL')) {
        state.__deliveryRevokeDelay = delay;
        state.__deliveryRevoke = callback as () => void;
        return 0;
      }
      return setTimeout(callback, delay, ...args);
    }) as typeof window.setTimeout;
  });
  const [download] = await Promise.all([page.waitForEvent('download'),
    report.getByRole('button', { name: 'Export JSON' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^zenchron-delivery-[a-f0-9]{32}\.json$/);
  expect(await page.evaluate(() => (window as typeof window & { __deliveryRevokeDelay?: number }).__deliveryRevokeDelay)).toBe(1000);
  expect(await page.evaluate(() => (window as typeof window & { __deliveryRevoked?: boolean }).__deliveryRevoked)).toBeUndefined();
  await page.evaluate(() => (window as typeof window & { __deliveryRevoke?: () => void }).__deliveryRevoke?.());
  expect(await page.evaluate(() => (window as typeof window & { __deliveryRevoked?: boolean }).__deliveryRevoked)).toBe(true);
  const exported = await page.evaluate(async () => {
    const getExport = () => (window as typeof window & { __deliveryExport?: string }).__deliveryExport;
    for (let attempt = 0; attempt < 20 && !getExport(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    return getExport();
  });
  if (!exported) throw new Error('Delivery JSON export did not create a download payload');
  const delivery = JSON.parse(exported) as { workflow_id: string; workflow_mode: string; unknown_evidence: string[];
    units: { kind: string; executions: { verification?: string; candidate_commit?: string; candidate_tree_sha?: string }[] }[] };
  expect(delivery.workflow_id).toBe(created.workflowID);
  expect(delivery.workflow_mode).toBe('compiled');
  expect(delivery.unknown_evidence).not.toContain('candidate_tree_sha');
  expect(delivery.units.filter((unit) => unit.kind === 'integrate').flatMap((unit) => unit.executions)
    .some((run) => run.candidate_commit && run.candidate_tree_sha)).toBe(true);
  expect(delivery.units.flatMap((unit) => unit.executions).some((run) => run.verification === 'not_configured')).toBe(true);
  expect(exported).not.toContain('system_prompt');
  await page.screenshot({ path: testInfo.outputPath('objective-report-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('objective-report-mobile.png'), fullPage: true });

  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/?mode=live#workspace');
  await page.locator('.workspace-mock-product').filter({ hasText: 'E2E product' }).click();
  await expect(page.locator('.workspace-mock-metric.decisions strong')).toHaveText('0');
  await expect(page.locator('.workspace-mock-card.decisions')).toContainText('E2E: which format?');
  await expect(page.locator('.workspace-mock-card.decisions')).toContainText('Resolved');
  await expect(page.locator('.workspace-mock-card.analytics')).toContainText('WorkGraphs1 current');
  await expect(page.locator('.workspace-mock-metric.delivery strong')).toHaveText('0');
  await page.screenshot({ path: testInfo.outputPath('workspace-evidence-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workspace-evidence-mobile.png'), fullPage: true });
});
