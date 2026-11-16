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

const noHorizontalScroll = (page: Page) => page.evaluate(() =>
  document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const viewport of viewports) {
  test(`objective plan tab shows unit states, reasons, messages, and resolves a decision (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockOrchestration(page, { graphs: [graph], plans: [plan] });
    const posted: { url: string; body: unknown }[] = [];
    await page.route('**/api/v1/work-graphs/**', (route) => {
      posted.push({ url: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
      return route.fulfill(json(graph));
    });
    const panel = await openPlan(page);

    const units = panel.getByRole('list', { name: 'Work units' });
    await expect(units.getByRole('listitem')).toHaveCount(3);
    await expect(units.getByRole('listitem').nth(0)).toContainText('api');
    await expect(units.getByRole('listitem').nth(0)).toContainText('Codex engineer');
    await expect(units.getByRole('listitem').nth(0)).toContainText('blocked');
    await expect(units.getByRole('listitem').nth(0)).toContainText('Waiting for a decision from a person.');
    await expect(units.getByRole('listitem').nth(0)).toContainText('candidate aaaaaaa');
    await expect(units.getByRole('listitem').nth(1)).toContainText('The unit used all 6 of its runs.');
    await expect(units.getByRole('listitem').nth(1)).toContainText('verdict: block');
    await expect(units.getByRole('listitem').nth(2)).toContainText('Zenchron (deterministic merge)');
    await expect(units.getByRole('link', { name: /Open pull request/ })).toHaveAttribute('href', 'https://github.com/acme/platform/pull/23');
    const messages = panel.getByRole('list', { name: 'Handoffs, findings, and decisions' });
    await expect(messages).toContainText('Header row is missing');
    await expect(messages).toContainText('review-api → api');
    await expect(messages).toContainText('api.go:12');
    expect(await noHorizontalScroll(page)).toBe(true);

    // The decision is answered in the page; nobody copies it into an agent session.
    const form = panel.getByRole('form', { name: 'Decision for api' });
    await expect(form).toContainText('Comma or semicolon as the separator?');
    await expect(form.getByRole('button', { name: 'Resolve decision' })).toBeDisabled();
    await form.getByRole('button', { name: 'comma' }).click();
    await expect(form.getByRole('textbox', { name: 'Decision for api' })).toHaveValue('comma');
    await form.getByRole('button', { name: 'Resolve decision' }).click();
    await units.getByRole('button', { name: 'Retry review-api' }).click();
    await panel.getByRole('button', { name: 'Cancel work' }).click();
    await expect.poll(() => posted).toEqual([
      { url: `/api/v1/work-graphs/${graphID}/decisions/m-3`, body: { resolution: 'comma' } },
      { url: `/api/v1/work-graphs/${graphID}/units/review-api/retry`, body: null },
      { url: `/api/v1/work-graphs/${graphID}/cancel`, body: null },
    ]);
  });
}

test('plan revisions show planning, invalid problems, and a refused approval; proposing names a planner and workflow', async ({ page }) => {
  await page.setViewportSize(viewports[0]);
  const revisions = [
    { ...plan, revision: 3, status: 'proposed', graph_id: undefined, approved_by: undefined },
    { objective_id: objectiveID, revision: 2, status: 'invalid', project_id: projectID, units: null, created_at: now,
      problems: ['unit "check" reviews code but "Codex engineer" may write code; assign a read-only profile'] },
    { objective_id: objectiveID, revision: 1, status: 'planning', project_id: projectID, units: null, created_at: now },
  ];
  await mockOrchestration(page, { plans: revisions });
  await page.route('**/api/v1/workflows', (route) => route.fulfill(json([{ id: 'wf-1', name: 'Feature delivery', description: '',
    status: 'draft', version: 1, nodes: [], edges: [], updated_at: now }])));
  let proposed: unknown;
  await page.route(`**/api/v1/objectives/${objectiveID}/plans`, (route) => {
    if (route.request().method() === 'GET') return route.fallback();
    proposed = route.request().postDataJSON();
    return route.fulfill({ status: 409, body: 'planner_agent_id must name an active, read-only Codex or Claude Code profile' });
  });
  await page.route(`**/api/v1/objectives/${objectiveID}/plans/3/approve`, (route) => route.fulfill({ status: 409,
    body: 'this objective already has a plan executing; cancel its work graph before approving a changed plan' }));
  const panel = await openPlan(page);

  await expect(panel.getByRole('list', { name: 'Units of revision 3' }).getByRole('listitem').first()).toContainText('GET /usage returns totals');
  await expect(panel.getByRole('list', { name: 'Units of revision 3' })).toContainText('needs code.write');
  await expect(panel.getByRole('list', { name: 'Units of revision 3' })).toContainText('after api');
  await expect(panel.getByRole('list', { name: 'Problems in revision 2' })).toContainText('assign a read-only profile');
  await expect(panel).toContainText('A planning agent is reading the repository.');
  await expect(panel.getByRole('button', { name: 'Approve plan and start' })).toHaveCount(1);
  await panel.getByRole('button', { name: 'Approve plan and start' }).click();
  await expect(panel.getByRole('alert')).toHaveText('this objective already has a plan executing; cancel its work graph before approving a changed plan');

  const form = panel.getByRole('form', { name: 'Propose a plan' });
  await expect(form.getByRole('button', { name: 'Propose plan' })).toBeDisabled();
  await form.getByRole('combobox', { name: 'Repository checkout' }).click();
  await page.getByRole('option', { name: 'platform · main' }).click();
  await form.getByRole('combobox', { name: 'Planning agent' }).click();
  // Only the read-only profile may plan.
  await expect(page.getByRole('option', { name: 'Codex engineer' })).toHaveCount(0);
  await page.getByRole('option', { name: 'Claude reviewer' }).click();
  await form.getByRole('combobox', { name: 'Workflow (optional guidance)' }).click();
  await page.getByRole('option', { name: 'Feature delivery' }).click();
  await form.getByRole('button', { name: 'Propose plan' }).click();
  await expect(form.getByRole('alert')).toHaveText('planner_agent_id must name an active, read-only Codex or Claude Code profile');
  expect(proposed).toEqual({ project_id: projectID, planner_agent_id: reviewerID, workflow_id: 'wf-1' });
});

test('plan tab reports an empty objective, a failed load, and Mock keeps operations off', async ({ page }) => {
  await page.setViewportSize(viewports[0]);
  await mockOrchestration(page, {});
  let panel = await openPlan(page);
  await expect(panel).toContainText('No plan yet. Propose one to turn this objective into reviewed, integrated work.');

  await mockOrchestration(page, { graphsStatus: 500 });
  panel = await openPlan(page);
  await expect(panel.getByRole('alert')).toHaveText('Could not load the plan and its work graph.');
  await expect(panel.getByRole('button', { name: 'Retry loading the plan' })).toBeVisible();

  // Mock shows sample data and sends nothing.
  const writes: string[] = [];
  page.on('request', (request) => { if (request.method() !== 'GET') writes.push(request.url()); });
  await page.goto(`http://127.0.0.1:${dashboardPort}/?mode=mock&objective=OBJ-1510#objectives`);
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();
  const mock = page.getByRole('tabpanel');
  await expect(mock).toContainText('Illustrative data: plans are proposed, approved, and executed in Live mode only.');
  await expect(mock.getByRole('button', { name: 'Resolve decision' })).toBeDisabled();
  await expect(mock.getByRole('button', { name: 'Cancel work' })).toBeDisabled();
  expect(writes).toEqual([]);
});

test('workspace, agents, reviews, and workflows project the same work graph', async ({ page }) => {
  await page.setViewportSize(viewports[0]);
  await mockOrchestration(page, { graphs: [graph], plans: [plan] });
  const integration = { id: runID, agent_id: '0'.repeat(32), agent_name: 'Zenchron integrator', project_id: projectID,
    project_name: 'platform', worker_id: workerID, worker_name: 'dev-laptop', branch: `zenchron/agent-run/${runID}`, base_branch: 'main',
    prompt: objective.title, status: 'succeeded', attempts: 1, created_at: now, updated_at: now, diff_available: true, diff_attempt: 1,
    commit_sha: 'c'.repeat(40), graph_id: graphID, unit_key: 'integrate',
    merge: [{ branch: 'zenchron/agent-run/x', commit: 'a'.repeat(40) }] };
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill(json([integration])));
  await page.route(`**/api/v1/agent-runs/${runID}/diff`, (route) => route.fulfill(json({ run_id: runID, diff: '+++ b/api.go\n+header\n', truncated: false })));

  await page.goto('/#workspace');
  await page.getByRole('navigation', { name: 'Product sections' }).getByRole('button', { name: 'Objectives' }).click();
  const execution = page.getByRole('region', { name: `Work graph for ${objective.title}` });
  await expect(execution.getByRole('list', { name: 'Work units' }).getByRole('listitem')).toHaveCount(3);
  await expect(execution).toContainText('after review-api');
  await expect(execution).toContainText('Header row is missing');
  await expect(execution.getByRole('link', { name: /Open pull request/ })).toBeVisible();

  await page.goto('/#agents');
  await page.getByRole('tab', { name: 'Run History' }).click();
  const assigned = page.getByRole('region', { name: 'Assigned work units' });
  await expect(assigned.getByRole('listitem')).toHaveCount(1);
  await expect(assigned.getByRole('listitem')).toContainText('Ship usage export');
  await expect(assigned.getByRole('listitem')).toContainText('api');
  await expect(assigned.getByRole('listitem')).toContainText('blocked');

  await page.goto('/#reviews');
  await page.getByRole('button', { name: /Local branches/ }).click();
  const context = page.getByRole('region', { name: 'Objective context of this run' });
  await expect(context).toContainText('Integrated candidate of "Ship usage export"');
  await expect(context).toContainText('Combines aaaaaaa.');
  await expect(context).toContainText('review-api block');
  await expect(context).toContainText('Header row is missing');
});

test('an objective plan approved in the dashboard runs through decision, review, remediation, and integration', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize(viewports[0]);
  await page.route('**/api/v1/auth/session', (route) => route.fulfill(json({ authenticated: true, local: true, login: 'E2E' })));
  await page.goto('/#objectives');
  // The plan is submitted through the API; everything after it happens in the page and on the real worker.
  const created = await page.evaluate(async () => {
    const post = async (path: string, body: unknown) => {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const profile = (name: string, tools: string[]) => post('/api/v1/agents', { name, provider: 'codex-cli', model: 'default', tools });
    const [first, second, reviewer] = await Promise.all([profile('Orchestration writer one', ['code.write']),
      profile('Orchestration writer two', ['code.write']), profile('Orchestration reviewer', ['git.diff'])]);
    const objective = await post('/api/v1/objectives', { title: 'Orchestrated export', description: 'Deliver the export.' });
    const projects = await fetch('/api/v1/projects').then((response) => response.json());
    const unit = (key: string, kind: string, instructions: string, agent: string, depends_on: string[]) => ({ key, kind,
      title: `Unit ${key}`, instructions, acceptance: [`${key} is done`], depends_on, capabilities: [], agent_id: agent });
    const plan = await post(`/api/v1/objectives/${objective.body.id}/plans`, { project_id: projects[0].id, plan: {
      summary: 'Two producers, one review, one integration.', max_parallel: 2, units: [
        unit('api', 'produce', 'E2E: ask for a decision', first.body.id, []),
        unit('ui', 'produce', 'Write the page.', second.body.id, []),
        unit('review-ui', 'review', 'E2E: block this review', reviewer.body.id, ['ui']),
        unit('integrate', 'integrate', '', '', ['api', 'review-ui']),
      ] } });
    return { objectiveID: objective.body.id as string, planStatus: plan.status };
  });
  expect(created.planStatus).toBe(201);

  await page.goto(`/?objective=${created.objectiveID}#objectives`);
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByRole('list', { name: 'Units of revision 1' }).locator(':scope > li')).toHaveCount(4);
  await expect(panel).toContainText('Orchestration writer one');
  await panel.getByRole('button', { name: 'Approve plan and start' }).click();
  const units = panel.getByRole('list', { name: 'Work units' });
  await expect(units.getByRole('listitem')).toHaveCount(4);
  await expect(units.getByRole('listitem').nth(3)).toContainText('waiting');

  // From here the worker must forward typed results: the producer asks, a person answers in the page.
  const form = panel.getByRole('form', { name: 'Decision for api' });
  await expect(form).toContainText('E2E: which format?', { timeout: 90_000 });
  await form.getByRole('button', { name: 'CSV' }).click();
  await form.getByRole('button', { name: 'Resolve decision' }).click();
  const messages = panel.getByRole('list', { name: 'Handoffs, findings, and decisions' });
  await expect(messages).toContainText('by local operator');
  await expect(messages).toContainText('E2E finding', { timeout: 120_000 });
  await expect(panel.getByRole('region', { name: 'Work graph for Orchestrated export' })).toContainText('4 of 4 units done', { timeout: 180_000 });
  await expect(units.getByRole('listitem').nth(2)).toContainText('verdict: accept');
  await expect(units.getByRole('listitem').nth(3)).toContainText('GitHub publication is not configured');
});
