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
  await page.route('**/api/v1/workers', (route) => route.fulfill(json([{ id: workerID, name: 'dev-laptop', status: 'online',
    last_seen: now, providers: [] }])));
  await page.route('**/api/v1/work-graphs', (route) => state.graphsStatus
    ? route.fulfill({ status: state.graphsStatus, body: 'unavailable' }) : route.fulfill(json(state.graphs ?? [])));
  await page.route(`**/api/v1/objectives/${objectiveID}/plans`, (route) => route.request().method() === 'GET'
    ? route.fulfill(json(state.plans ?? [])) : route.fallback());
}

test('plan tab shows the work graph of the latest plan revision when older graphs exist', async ({ page }) => {
  const older = { ...graph, id: '55'.repeat(16), plan_revision: 1, status: 'completed' };
  const newer = { ...graph, id: '66'.repeat(16), plan_revision: 2, status: 'active' };
  await mockOrchestration(page, { graphs: [older, newer], plans: [plan, { ...plan, revision: 2, graph_id: newer.id }] });
  const panel = await openPlan(page);
  await expect(panel).toContainText('plan revision 2');
  await expect(panel).not.toContainText('plan revision 1 ·');
});

async function openPlan(page: Page) {
  await page.goto(`/?objective=${objectiveID}#objectives`);
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();
  return page.getByRole('tabpanel');
}

for (const viewport of viewports) {
  test(`plan revisions link planned records without calling them executed (${viewport.name})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const workflowID = 'wf-plan';
    const planned = { ...plan, status: 'proposed', workflow_id: workflowID, workflow_version: 4,
      units: [{ ...planUnits[0], profile_version: 2, persona_id: 'persona-plan', persona_version: 3 }] };
    await mockOrchestration(page, { plans: [planned] });
    await page.route('**/api/v1/workflows', (route) => route.fulfill(json([{ id: workflowID, name: 'Feature delivery',
      description: '', status: 'draft', version: 5, nodes: [], edges: [], updated_at: now }])));
    await page.goto(`/?mode=live&objective=${objectiveID}#objectives`);
    await page.getByRole('tab', { name: 'Plan', exact: true }).click();

    const revision = page.locator('.plan-revision').first();
    await expect(revision.getByRole('link', { name: workflowID })).toHaveAttribute(
      'href', `/?workflow=${workflowID}&mode=live#workflows`);
    await expect(revision.getByRole('link', { name: 'Codex engineer' })).toHaveAttribute(
      'href', `/?profile=${writerID}&mode=live#agents`);
    await expect(revision).toContainText('Planned profile v2');
    await expect(revision).toContainText('Planned persona persona-plan · v3');
    await expect(revision).not.toContainText(/executed (version|profile|persona)/i);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('planned-record-navigation.png'), fullPage: true });
    await revision.getByRole('link', { name: workflowID }).click();
    if (viewport.width === 390) {
      await expect(page.getByRole('img', { name: 'Key workflow stages for Feature delivery; 0 stages summarize 0 components' })).toBeVisible();
    } else {
      await expect(page.getByRole('heading', { name: 'Workflow Builder — Feature delivery' })).toBeVisible();
    }
    await expect(page).toHaveURL(new RegExp(`workflow=${workflowID}&mode=live#workflows$`));
    await page.goto(`/?mode=live&objective=${objectiveID}#objectives`);
    await page.getByRole('tab', { name: 'Plan', exact: true }).click();
    await page.locator('.plan-revision').first().getByRole('link', { name: 'Codex engineer' }).click();
    await expect(page.locator('.agents-detail-heading')).toContainText('Codex engineer');
    await expect(page).toHaveURL(new RegExp(`profile=${writerID}&mode=live#agents$`));
  });
}

test('plan proposal refuses unknown workflow and unlinked checkout address selections', async ({ page }) => {
  await mockOrchestration(page, {});
  await page.goto(`/?objective=${objectiveID}&tab=plan&project=unlinked&workflow=missing#objectives`);
  await expect(page.getByRole('button', { name: 'Propose plan', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Repository checkout' })).toBeVisible();
});

for (const viewport of viewports) {
  test(`delivery report distinguishes observed GitHub PR state from a changed candidate (${viewport.name})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mockOrchestration(page, { graphs: [graph], plans: [plan] });
    await page.route(`**/api/v1/work-graphs/${graphID}/report`, (route) => route.fulfill(json({
      graph_id: graphID, graph_revision: 12, objective_id: objectiveID,
      objective_title: objective.title, plan_revision: 1,
      status: 'completed', approved_plan: { revision: 1, status: 'approved', hash: 'h', summary: 'One producer, one review.' },
      units: [{ key: 'integrate', kind: 'integrate', agent_name: 'Zenchron integration', state: 'completed',
        candidate: 'c'.repeat(40), run_ids: ['publish-run'], attempts: 2, providers: [],
        executions: [{ run_id: 'publish-run', status: 'succeeded', attempts: 2, candidate_commit: 'c'.repeat(40),
          publication: 'published' }] },
      { key: 'final-review', kind: 'review', agent_name: 'Independent reviewer', state: 'completed',
        run_ids: ['review-run'], attempts: 1, providers: [],
        executions: [{ run_id: 'review-run', result_attempt: 1, updated_at: now, status: 'succeeded', attempts: 1,
          profile_name: 'Independent reviewer', profile_version: 2, provider: 'claude-code',
          base_commit_sha: 'c'.repeat(40), review_verdict: 'accept' }] }], handoffs: [], decisions: [], outstanding_steps: [],
      measurements: { unit_count: 2, run_count: 2, attempt_count: 3, failed_attempts: 0, review_rounds: 1, findings: 0,
        remediation_passes: 0, decisions_requested: 0, decisions_resolved: 0, human_actions: 2,
        human_actions_complete: false, max_concurrency: 1, runs_with_usage: 0, runs_with_cost: 0,
        unknown: ['cost_usd', 'input_tokens', 'output_tokens', 'supervision_minutes', 'unrecorded_human_actions'] },
      unknown_evidence: ['candidate_tree_sha', 'policy_backed_assurance'],
      publication_authority: { source_run_id: 'publish-run', graph_id: graphID, graph_revision: 12,
        plan_revision: 1, plan_hash: 'h', commit_sha: 'c'.repeat(40), by: 'operator', at: now, attempt: 2 },
      pull_request_url: 'https://github.com/acme/platform/pull/23',
      pull_request_external_state: { number: 23, state: 'open', draft: true, merged: false,
        head_sha: 'd'.repeat(40), candidate_matches_head: false, observed_at: now,
        candidate_checks: { head_sha: 'c'.repeat(40), observed_at: now,
          runs: [{ id: 101, name: 'go', status: 'completed', conclusion: 'success' }] } },
    })));
    await page.goto(`/?mode=live&objective=${objectiveID}#objectives`);
    await page.getByRole('tab', { name: 'Plan', exact: true }).click();
    const report = page.getByRole('region', { name: 'Objective delivery report' });
    await report.getByRole('button', { name: 'View delivery report' }).click();
    await expect(report.getByLabel('Observed GitHub pull request state')).toContainText('pull request #23 open as a draft');
    await expect(report.getByLabel('Observed GitHub pull request state')).toContainText('differs from the integrated candidate');
    await expect(report.getByLabel('Observed GitHub pull request state')).toContainText('observed');
    await expect(report.getByLabel('GitHub checks for integrated candidate')).toContainText('Check #101 · go · completed · success');
    await expect(report).toContainText('Model: unknown');
    await expect(report).toContainText(`WorkGraph ${graphID} · revision 12`);
    await expect(report).toContainText(`Reviewed candidate: ${'c'.repeat(40)}`);
    await expect(report.getByLabel('Recorded publication authorization')).toContainText('authorization attempt 2');
    await expect(report).toContainText('Unknown evidence: candidate tree SHA, independent policy-backed assurance.');
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`delivery-report-${viewport.name}.png`), fullPage: true });
  });
}

for (const viewport of viewports) {
  test(`delivery report identifies missing run records and partial measurements (${viewport.name})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mockOrchestration(page, { graphs: [graph], plans: [plan] });
    await page.route(`**/api/v1/work-graphs/${graphID}/report`, (route) => route.fulfill(json({
      graph_id: graphID, graph_revision: 4, objective_id: objectiveID, objective_title: objective.title,
      plan_revision: 1, status: 'failed',
      units: [{ key: 'api', kind: 'produce', agent_name: 'Engineer', state: 'failed', run_ids: ['lost-run'],
        attempts: 0, providers: [], executions: [] }],
      handoffs: [], decisions: [], outstanding_steps: [{ key: 'api', state: 'failed' }],
      measurements: { unit_count: 1, run_count: 1, attempt_count: 0, failed_attempts: 0, review_rounds: 0, findings: 0,
        remediation_passes: 0, decisions_requested: 0, decisions_resolved: 0, human_actions: 0,
        human_actions_complete: false, max_concurrency: 0, runs_with_usage: 0, runs_with_cost: 0,
        unknown: ['attempt_count_for_some_runs', 'failed_attempts_for_some_runs', 'max_concurrency_for_some_runs',
          'remediation_passes_for_some_runs', 'input_tokens', 'output_tokens', 'cost_usd', 'supervision_minutes',
          'unrecorded_human_actions'] },
      unknown_evidence: ['approved_plan', 'missing_run_records', 'policy_backed_assurance', 'publication_authority'],
    })));
    await page.goto(`/?mode=live&objective=${objectiveID}#objectives`);
    await page.getByRole('tab', { name: 'Plan', exact: true }).click();
    const report = page.getByRole('region', { name: 'Objective delivery report' });
    await report.getByRole('button', { name: 'View delivery report' }).click();
    await expect(report).toContainText('Run lost-run details unavailable: its durable record is missing.');
    await expect(report).toContainText('Approved plan revision unavailable: its durable record is missing.');
    await expect(report).not.toContainText('Approved plan revision 0');
    await expect(report).toContainText('Unknown evidence:');
    await expect(report).toContainText('details for one or more referenced runs');
    await expect(report).toContainText('the approved plan revision');
    await expect(report).toContainText('attempt totals for some runs');
    await expect(report).toContainText('remediation totals for some runs');
    await expect(report).toContainText('1 / 1 / 0 (incomplete)');
    await expect(report).toContainText('0 (incomplete) / 0 (incomplete)');
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`delivery-report-missing-run-${viewport.name}.png`), fullPage: true });
  });
}

test('delivery report shows an unknown result attempt while a run is active', async ({ page }) => {
  await mockOrchestration(page, { graphs: [graph], plans: [plan] });
  await page.route(`**/api/v1/work-graphs/${graphID}/report`, (route) => route.fulfill(json({
    graph_id: graphID, graph_revision: 3, objective_id: objectiveID, objective_title: objective.title,
    plan_revision: 1, status: 'active',
    approved_plan: { revision: 1, status: 'approved', hash: 'h', summary: 'One producer, one review.' },
    units: [{ key: 'api', kind: 'produce', agent_name: 'Engineer', state: 'running', run_ids: ['run-active'],
      attempts: 1, providers: ['codex-cli'], executions: [{ run_id: 'run-active', updated_at: now,
        status: 'running', attempts: 1 }] }],
    handoffs: [], decisions: [], outstanding_steps: [{ key: 'api', state: 'running' }],
    measurements: { unit_count: 1, run_count: 1, attempt_count: 1, failed_attempts: 0, review_rounds: 0, findings: 0,
      remediation_passes: 0, decisions_requested: 0, decisions_resolved: 0, human_actions: 1,
      human_actions_complete: false, max_concurrency: 1, runs_with_usage: 0, runs_with_cost: 0,
      unknown: ['input_tokens', 'output_tokens', 'cost_usd', 'supervision_minutes', 'unrecorded_human_actions'] },
    unknown_evidence: ['policy_backed_assurance', 'publication_authority'],
  })));
  await page.goto(`/?mode=live&objective=${objectiveID}#objectives`);
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();
  const report = page.getByRole('region', { name: 'Objective delivery report' });
  await report.getByRole('button', { name: 'View delivery report' }).click();
  const execution = report.locator('.objective-delivery-run');
  await expect(execution).toContainText('result attempt unknown');
  await expect(execution).not.toContainText('result attempt 0');
});

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

test('proposed plan approval stays disabled while its repository worker is offline', async ({ page }) => {
  await page.setViewportSize(viewports[0]);
  const proposed = { ...plan, status: 'proposed', graph_id: undefined, approved_by: undefined };
  await mockOrchestration(page, { plans: [proposed] });
  await page.route('**/api/v1/workers', (route) => route.fulfill(json([{
    id: workerID, name: 'dev-laptop', status: 'offline', last_seen: now, providers: [],
  }])));
  await page.route('**/api/v1/projects', (route) => route.fulfill(json(projects.map((project) => ({
    ...project, worker_status: 'offline',
  })))));
  const panel = await openPlan(page);
  const approval = panel.getByRole('button', { name: 'Approve plan and start' });
  await expect(approval).toBeDisabled();
  await expect(approval).toHaveAttribute('title',
    'The plan’s repository worker is offline; bring it online before approval.');
  await expect(panel).toContainText('Plan approval is unavailable');
});

test('plan revisions show planning, invalid problems, and a refused approval; proposing names a planner and workflow', async ({ page }) => {
  await page.setViewportSize(viewports[0]);
  const revisions = [
    { ...plan, revision: 3, status: 'proposed', graph_id: undefined, approved_by: undefined,
      workflow_id: 'wf-1', workflow_version: 1, workflow_mode: 'guidance' },
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

  await expect(panel).toContainText('Guided by workflow wf-1 · version 1');
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
  await expect(page.getByRole('option', { name: 'platform · main' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'unrelated · main' })).toHaveCount(0);
  await page.getByRole('option', { name: 'platform · main' }).click();
  await form.getByRole('combobox', { name: 'Planning strategy' }).click();
  await page.getByRole('option', { name: 'Ask a read-only CLI agent to plan' }).click();
  await form.getByRole('combobox', { name: 'Planning agent' }).click();
  // Only the read-only profile may plan.
  await expect(page.getByRole('option', { name: 'Codex engineer' })).toHaveCount(0);
  await page.getByRole('option', { name: 'Claude reviewer' }).click();
  await form.getByRole('combobox', { name: 'Workflow guidance (optional)' }).click();
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

  await mockOrchestration(page, {});
  let planStatus = 500;
  let planRequests = 0;
  await page.route(`**/api/v1/objectives/${objectiveID}/plans`, async (route) => {
    planRequests += 1;
    await route.fulfill(planStatus === 200 ? json([]) : { status: 500, body: 'plans unavailable' });
  });
  panel = await openPlan(page);
  await expect(panel.getByRole('alert')).toHaveText('Could not load the plan and its work graph.');
  const failedPlanRequests = planRequests;
  planStatus = 200;
  await panel.getByRole('button', { name: 'Retry loading the plan' }).click();
  await expect.poll(() => planRequests).toBeGreaterThan(failedPlanRequests);
  await expect(panel).toContainText('No plan yet. Propose one to turn this objective into reviewed, integrated work.');

  // Mock shows sample data and sends nothing.
  const writes: string[] = [];
  page.on('request', (request) => { if (request.method() !== 'GET') writes.push(request.url()); });
  await page.goto(`http://127.0.0.1:${dashboardPort}/?mode=mock&objective=OBJ-1510#objectives`);
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();
  const mock = page.getByRole('tabpanel');
  await expect(mock).toContainText('Illustrative data: plans are proposed, approved, and executed in Live mode only.');
  const previewRevision = mock.locator('.plan-revision').first();
  await expect(previewRevision).toContainText('Compiled from workflow preview-workflow · version 1');
  await expect(previewRevision.getByRole('link', { name: 'preview-workflow' })).toHaveCount(0);
  await expect(previewRevision).toContainText('Planned profile v1');
  await expect(previewRevision.getByRole('link', { name: 'Test Generator' })).toHaveCount(0);
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

for (const viewport of viewports) {
  test(`product execution links retain workflow and assignment identity (${viewport.name})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const configured = { ...graph, workflow_id: 'product-flow', workflow_version: 7,
      units: graph.units.map((unit) => unit.kind === 'integrate' ? unit
        : ({ ...unit, profile_version: 2, persona_id: 'product-persona', persona_version: 3 })) };
    await mockOrchestration(page, { graphs: [configured], plans: [plan] });
    await page.goto('/#workspace');
    await page.getByRole('navigation', { name: 'Product sections' }).getByRole('button', { name: 'Objectives' }).click();
    const configuration = page.getByLabel(`Execution configuration for ${objective.title}`);
    await expect(configuration).toContainText('executed version 7');
    await expect(configuration).toContainText('recorded profile v2');
    await expect(configuration).toContainText('persona product-persona v3');
    await expect(configuration.getByRole('link', { name: 'product-flow' }))
      .toHaveAttribute('href', '/?workflow=product-flow&mode=live#workflows');
    await expect(configuration.getByRole('link', { name: 'Codex engineer' }))
      .toHaveAttribute('href', `/?profile=${writerID}&mode=live#agents`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('product-execution.png'), fullPage: true });
    await page.getByRole('heading', { name: objective.title, exact: true }).getByRole('link').click();
    await expect(page.getByRole('tab', { name: 'Plan', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('region', { name: `Work graph for ${objective.title}` })).toBeVisible();
  });
}

test('an objective plan approved in the dashboard runs through decision, review, remediation, and integration', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize(viewports[0]);
  await page.route('**/api/v1/auth/session', (route) => route.fulfill(json({ authenticated: true, local: true, login: 'E2E' })));
  await page.goto('/#objectives');
  // Seed reusable configuration through real APIs; create and execute the objective from Product Workspace.
  const created = await page.evaluate(async () => {
    const post = async (path: string, body: unknown) => {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const persona = await post('/api/v1/personas', { name: 'E2E CSV specialist', role: 'Implement CSV exports',
      responsibilities: ['Build compatible exports'], instructions: 'Keep CSV headers stable.', behavior: 'Be precise.',
      review_specialization: '', status: 'active' });
    const profile = (name: string, tools: string[], personaID = '') => post('/api/v1/agents', {
      name, provider: 'codex-cli', model: 'default', tools, persona_id: personaID,
      system_prompt: `System prompt for ${name}.`, goal_prompt: 'Complete the assigned work.',
    });
    const [first, second, reviewer] = await Promise.all([profile('Orchestration writer one', ['code.write'], persona.body.id),
      profile('Orchestration writer two', ['code.write']), profile('Orchestration reviewer', ['git.diff'])]);
    const projects = await fetch('/api/v1/projects').then((response) => response.json());
    const product = await post('/api/v1/products', { name: 'E2E product', description: '',
      repository_ids: projects.map((project: { id: string }) => project.id) });
    const workflow = await post('/api/v1/workflows', { name: 'E2E executable flow', description: 'Two producers with review and integration.' });
    const node = (id: string, type: string, label: string, description: string, agentID = '', personaID = '') => ({
      id, type, position: { x: 0, y: 0 }, data: { label, description, agent_id: agentID, persona_id: personaID,
        acceptance: type === 'integrate' ? [] : [`${label} is done`] },
    });
    const nodes = [node('trigger', 'trigger', 'Start', 'Start the objective'),
      node('api', 'agent-task', 'API producer', 'E2E: ask for a decision', first.body.id, persona.body.id),
      node('ui', 'test-generator', 'UI producer', 'Write the page.', second.body.id),
      node('review-ui', 'code-reviewer', 'Independent review', 'E2E: block this review', reviewer.body.id),
      node('integrate', 'integrate', 'Integrate', 'Combine reviewed candidates')];
    const edges = [['trigger', 'api'], ['trigger', 'ui'], ['ui', 'review-ui'], ['api', 'integrate'],
      ['review-ui', 'integrate']].map(([source, target], index) => ({ id: `e${index}`, source, target, label: '' }));
    const saved = await fetch(`/api/v1/workflows/${workflow.body.id}`, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        name: workflow.body.name, description: workflow.body.description, status: workflow.body.status, nodes, edges,
      }) });
    const savedWorkflow = await saved.json();
    if (persona.status !== 201 || first.status !== 201 || second.status !== 201 || reviewer.status !== 201 ||
      product.status !== 201 || workflow.status !== 201 || saved.status !== 200) {
      throw new Error(JSON.stringify({ persona: persona.status, first: first.status, second: second.status,
        reviewer: reviewer.status, product: product.status, workflow: workflow.status,
        saved: saved.status }));
    }
    return { objectiveID: '', workflowID: workflow.body.id as string,
      workflowVersion: savedWorkflow.version as number, personaID: persona.body.id as string, productID: product.body.id as string,
      writerID: first.body.id as string };
  });
  await page.goto('/?mode=live#workspace');
  await page.locator('.workspace-mock-product').filter({ hasText: 'E2E product' }).click();
  await page.getByRole('combobox', { name: 'Objective repository' }).click();
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByRole('combobox', { name: 'Objective workflow' }).click();
  await page.getByRole('option', { name: `E2E executable flow · v${created.workflowVersion}` }).click();
  await page.getByRole('link', { name: 'Create objective for E2E product' }).click();
  const objectiveDialog = page.getByRole('dialog');
  await expect(objectiveDialog.getByRole('combobox', { name: 'Product' })).toHaveValue('E2E product');
  await objectiveDialog.getByLabel('Objective title').fill('Orchestrated export');
  await objectiveDialog.getByLabel('Description').fill('Deliver the export.');
  const savedObjective = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/objectives');
  await objectiveDialog.getByRole('button', { name: 'Create objective' }).click();
  const objectiveResponse = await savedObjective;
  expect(objectiveResponse.status()).toBe(201);
  const saved: { id: string } = await objectiveResponse.json();
  created.objectiveID = saved.id;
  const apiStatus = await page.evaluate(async (id) => Promise.all([
    '/api/v1/work-graphs', `/api/v1/objectives/${id}/plans`, '/api/v1/projects', '/api/v1/products',
  ].map(async (path) => {
    const response = await fetch(path);
    return { path, status: response.status, body: await response.text() };
  })), created.objectiveID);
  expect(apiStatus.filter((item) => item.status !== 200), JSON.stringify(apiStatus)).toEqual([]);

  await page.reload();
  await expect(page.getByRole('tab', { name: 'Plan', exact: true })).toHaveAttribute('aria-selected', 'true');
  const workerSnapshot = await page.evaluate(async () => {
    const response = await fetch('/api/v1/workers');
    if (!response.ok) throw new Error(`Worker list failed (${response.status})`);
    return response.json() as Promise<{ providers?: { id: string; ready: boolean; reason?: string }[] }[]>;
  });
  await page.route('**/api/v1/workers', async (route) => {
    await route.fulfill({ json: workerSnapshot.map((worker) => ({ ...worker, providers: worker.providers?.map((provider) =>
      provider.id === 'codex-cli' ? { ...provider, ready: false, reason: 'CLI unavailable in this readiness snapshot' }
        : provider) })) });
  });
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Plan', exact: true })).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByRole('tabpanel');
  const proposeForm = panel.getByRole('form', { name: 'Propose a plan' });
  await expect(proposeForm.getByRole('combobox', { name: 'Repository checkout' })).toBeVisible({ timeout: 30_000 });
  await expect(proposeForm.getByRole('combobox', { name: 'Executable workflow' }))
    .toHaveValue(`E2E executable flow · v${created.workflowVersion}`);
  await proposeForm.getByRole('button', { name: 'Propose plan' }).click();
  const revision = panel.getByRole('list', { name: 'Units of revision 1' });
  await expect(revision.locator(':scope > li')).toHaveCount(4);
  const plannedUnits = revision.locator(':scope > li');
  await expect(plannedUnits.locator('.work-unit-title')).toHaveText([
    'step-1API producer', 'step-2UI producer', 'step-3Independent review', 'step-4Integrate',
  ]);
  await expect(plannedUnits.nth(0)).toContainText('Orchestration writer one');
  await expect(plannedUnits.nth(1)).toContainText('Orchestration writer two');
  await expect(plannedUnits.nth(2)).toContainText('Orchestration reviewer');
  await expect(plannedUnits.nth(2)).toContainText('after step-2');
  await expect(plannedUnits.nth(3)).toContainText('after step-1, step-3');
  await expect(panel).toContainText(`Compiled from workflow ${created.workflowID} · version ${created.workflowVersion}`);
  await expect(panel).toContainText('Orchestration writer one');
  await expect(revision).toContainText(`Planned persona ${created.personaID} · v1`);
  const readiness = panel.getByRole('status', { name: 'CLI readiness for revision 1' });
  await expect(readiness).toContainText('codex-cli not ready');
  await expect(readiness).toContainText('runs wait until ready');
  await page.goto('/?mode=live#overview');
  const pendingPlan = page.getByRole('region', { name: 'Action Required' }).getByRole('link');
  await expect(pendingPlan).toContainText('Plan revision 1 · Plan approval');
  await expect(pendingPlan).toContainText('Plan subject');
  await expect(pendingPlan).toContainText('WorkUnit not started · Run not started');
  await expect(pendingPlan).toHaveAttribute('href', new RegExp(`objective=${created.objectiveID}.*tab=plan`));
  await pendingPlan.click();
  await expect(page.getByRole('button', { name: 'Approve plan and start' })).toBeVisible();
  await panel.getByRole('button', { name: 'Approve plan and start' }).click();
  const units = panel.getByRole('list', { name: 'Work units' });
  await expect(units.getByRole('listitem')).toHaveCount(4);
  await expect(units.getByRole('listitem').nth(3)).toContainText('waiting');

  // From here the worker must forward typed results: the producer asks, a person answers in the page.
  const decisionForm = panel.getByRole('form', { name: 'Decision for step-1' });
  await expect(decisionForm).toContainText('E2E: which format?', { timeout: 90_000 });
  await page.goto('/?mode=live#overview');
  const actionRequired = page.getByRole('region', { name: 'Action Required' });
  await expect(actionRequired).toContainText('1 waiting');
  await expect(actionRequired).toContainText('Plan revision 1 · produce: API producer');
  await expect(actionRequired).toContainText('E2E: which format?');
  await expect(actionRequired).toContainText(/Run [a-f0-9]{32}/);
  const exactDecision = actionRequired.getByRole('link');
  await expect(exactDecision).toHaveAttribute('href', new RegExp(`objective=${created.objectiveID}.*graph_id=.*decision=`));
  await exactDecision.click();
  await expect(page.getByRole('form', { name: 'Decision for step-1' })).toContainText('E2E: which format?');
  const deliveryReport = panel.getByRole('region', { name: 'Objective delivery report' });
  const initialReport = page.waitForResponse((response) => response.request().method() === 'GET'
    && /\/api\/v1\/work-graphs\/[a-f0-9]{32}\/report$/.test(new URL(response.url()).pathname));
  await deliveryReport.getByRole('button', { name: 'View delivery report' }).click();
  expect((await initialReport).ok()).toBe(true);
  await page.getByRole('button', { name: 'CSV' }).click();
  const refreshedReport = page.waitForResponse((response) => response.request().method() === 'GET'
    && /\/api\/v1\/work-graphs\/[a-f0-9]{32}\/report$/.test(new URL(response.url()).pathname));
  await page.getByRole('button', { name: 'Resolve decision' }).click();
  expect((await refreshedReport).ok()).toBe(true);
  const messages = panel.getByRole('list', { name: 'Handoffs, findings, and decisions' });
  await expect(messages).toContainText('by local operator');
  await expect(messages).toContainText('E2E finding', { timeout: 120_000 });
  await expect(panel.getByRole('region', { name: 'Work graph for Orchestrated export' })).toContainText('4 of 4 units done', { timeout: 180_000 });
  await expect(units.getByRole('listitem').nth(0)).toContainText('completed');
  await expect(units.getByRole('listitem').nth(1)).toContainText('completed');
  await expect(units.getByRole('listitem').nth(2)).toContainText('verdict: accept');
  await expect(units.getByRole('listitem').nth(3)).toContainText('GitHub publication is not configured');
  const report = panel.getByRole('region', { name: 'Objective delivery report' });
  await expect(report).toContainText('Approved plan revision 1');
  await expect(report.getByRole('heading', { name: 'Execution and publication' })).toBeVisible();
  await expect(report).toContainText(/WorkGraph execution: (active|blocked|completed|failed|cancelled)/);
  await expect(report).toContainText('Recorded pull request: GitHub publication is not configured');
  await expect(report).toContainText('WorkGraph completion does not establish publication.');
  await expect(report).toContainText(`Compiled from workflow ${created.workflowID} · version ${created.workflowVersion}`);
  await expect(report.getByRole('link', { name: created.workflowID, exact: true }))
    .toHaveAttribute('href', `/?workflow=${created.workflowID}&mode=live#workflows`);
  await expect(report.getByRole('link', { name: 'Agent profile', exact: true }).first())
    .toHaveAttribute('href', `/?profile=${created.writerID}&mode=live#agents`);
  await expect(report).toContainText('E2E CSV specialist v1');
  await expect(report).toContainText('Model: default');
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

  await page.setViewportSize(viewports[0]);
  await page.goto(`/?product=${created.productID}&mode=live#workspace`);
  await page.getByRole('navigation', { name: 'Product sections' }).getByRole('button', { name: 'Objectives' }).click();
  const findingKnowledge = page.getByRole('region', { name: 'Curate findings from Orchestrated export' });
  await findingKnowledge.getByRole('button', { name: 'Curate as product knowledge' }).first().click();
  await findingKnowledge.getByRole('textbox').first().fill('Keep CSV headers stable for product imports.');
  const savedKnowledge = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/v1/products/${created.productID}/knowledge`);
  await findingKnowledge.getByRole('button', { name: 'Save knowledge' }).first().click();
  expect((await savedKnowledge).status()).toBe(201);
  await page.getByRole('navigation', { name: 'Product sections' }).getByRole('button', { name: 'Knowledge' }).click();
  await expect(page.locator('.workspace-mock-card.knowledge')).toContainText('Keep CSV headers stable for product imports.');
  await expect(page.locator('.workspace-mock-card.knowledge').getByRole('link', { name: 'Open source objective and WorkGraph' }))
    .toHaveAttribute('href', new RegExp(`objective=${saved.id}.*tab=plan.*graph_id=`));
  await page.reload();
  await page.getByRole('navigation', { name: 'Product sections' }).getByRole('button', { name: 'Knowledge' }).click();
  await expect(page.locator('.workspace-mock-card.knowledge')).toContainText('Keep CSV headers stable for product imports.');
});
