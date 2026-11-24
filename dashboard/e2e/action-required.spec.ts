import { expect, test, type Page } from '@playwright/test';

const objectiveID = '11111111111111111111111111111111';
const oldGraphID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const currentGraphID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const cancelledGraphID = 'cccccccccccccccccccccccccccccccc';
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

function graph(id: string, unit: string, question: string, created: string, status = 'blocked') {
  return {
    id, objective_id: objectiveID, objective_title: 'Ship usage export', plan_revision: 1, revision: 1,
    status, project_name: 'platform', base_branch: 'main', max_parallel: 1,
    created_at: created, updated_at: created,
    units: [{ key: unit, kind: 'produce', title: `Produce ${unit}`, instructions: '', acceptance: [], depends_on: [],
      capabilities: [], agent_id: 'a'.repeat(32), state: 'blocked', reason: 'Waiting for a person to choose.',
      run_ids: [] as string[], candidate: '', publication_authorization_required: false }],
    messages: [{ id: `decision-${unit}`, type: 'decision_request', from: unit, run_id: `run-${unit}`,
      body: question, notes: ['allow', 'decline'], created_at: created }],
  };
}

function decisionAction(unit: string, question: string, graphID: string) {
  return { id: `decision-${unit}`, kind: 'work_graph_decision', objective_id: objectiveID,
    objective_title: 'Ship usage export', plan_revision: 1, graph_id: graphID, unit_key: unit,
    stage: 'produce', unit_title: `Produce ${unit}`, run_id: `run-${unit}`, subject: question,
    reason: 'Waiting for a person to choose.', options: ['allow', 'decline'], can_act: true };
}

function publicationAction(graphID: string, candidate: string) {
  return { id: `publication:${graphID}:${candidate}`, kind: 'publication_authorization', objective_id: objectiveID,
    objective_title: 'Ship usage export', plan_revision: 2, graph_id: graphID, unit_key: 'integrate',
    stage: 'Publication authorization', unit_title: 'Integrate candidate', run_id: 'run-integrate', subject: candidate,
    reason: 'The current candidate passed its assigned independent review; a person must authorize PR creation.',
    options: ['Authorize pull request creation'], can_act: true };
}

async function useLiveSession(page: Page, graphs: unknown[], actions?: unknown[]) {
  await page.route('**/api/v1/**', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/auth/session', (route) => route.fulfill(json({ authenticated: true, local: true, login: 'Local workspace' })));
  await page.route('**/api/v1/work-graphs', (route) => route.fulfill(json(graphs)));
  await page.route('**/api/v1/action-required', (route) => route.fulfill(json(actions ?? graphs.flatMap((item) => {
    const current = item as { id: string; status: string; units: { key: string; }[]; messages: { body: string; from: string; type: string; }[] };
    if (current.status === 'cancelled') return [];
    return current.messages.filter((message) => message.type === 'decision_request')
      .map((message) => decisionAction(message.from, message.body, current.id));
  }))));
  await page.route('**/api/v1/objectives', (route) => route.fulfill(json([{
    id: objectiveID, title: 'Ship usage export', description: '', owner: 'Alex', product: '', product_id: '',
    status: 'in_progress', progress: 50, due_date: '', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z',
  }])));
  await page.route(`**/api/v1/objectives/${objectiveID}/plans`, (route) => route.fulfill(json([])));
}

for (const viewport of [{ name: 'desktop', width: 1672, height: 941 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`Action Required opens the exact WorkGraph decision (${viewport.name})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await useLiveSession(page, [
      graph(currentGraphID, 'api-current', 'Which serialization should ship?', '2026-11-02T00:00:00Z'),
      graph(oldGraphID, 'api-old', 'Should this export include archived records?', '2026-11-01T00:00:00Z'),
      graph(cancelledGraphID, 'api-cancelled', 'Should a cancelled run continue?', '2026-10-31T00:00:00Z', 'cancelled'),
    ]);
    await page.goto('/?mode=live#overview');
    const queue = page.getByRole('region', { name: 'Action Required' });
    await expect(queue).toContainText('2 waiting');
    await expect(queue.getByRole('link')).toHaveCount(2);
    await expect(queue).not.toContainText('api-cancelled');
    const exactAction = queue.getByRole('link').filter({ hasText: 'Decision decision-api-old' });
    await expect(exactAction).toContainText('Plan revision 1 · produce: Produce api-old');
    await expect(exactAction).toContainText('Decision decision-api-old · Should this export include archived records?');
    await expect(exactAction).toContainText('Waiting reason: Waiting for a person to choose.');
    await expect(exactAction).toContainText('Options: allow · decline');
    await expect(exactAction).toContainText('Available action: resolve this decision in Objective Workspace');
    await expect(exactAction).toContainText('Run run-api-old');
    await expect(exactAction).toHaveAttribute('href', new RegExp(`graph_id=${oldGraphID}.*decision=decision-api-old`));
    await page.screenshot({ path: testInfo.outputPath(`action-required-${viewport.name}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await exactAction.click();
    const decision = page.getByRole('form', { name: 'Decision for api-old' });
    await expect(decision).toBeVisible();
    await expect(decision.getByText('Should this export include archived records?')).toBeVisible();
    await expect(page.getByText('Which serialization should ship?')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Decision for api-old' })).toBeFocused();
  });
}

for (const viewport of [{ name: 'desktop', width: 1672, height: 941 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`Action Required opens exact reviewed-candidate authorization (${viewport.name})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const current = graph(currentGraphID, 'integrate', '', '2026-11-02T00:00:00Z', 'active');
    current.units = [{ ...current.units[0], kind: 'integrate', title: 'Integrate candidate', state: 'waiting',
      reason: 'A person must authorize pull request creation for this reviewed candidate.', run_ids: ['run-integrate'],
      candidate: 'd'.repeat(40), publication_authorization_required: true }];
    current.messages = [];
    await useLiveSession(page, [current], [publicationAction(currentGraphID, 'd'.repeat(40))]);
    await page.goto('/?mode=live#overview');
    const action = page.getByRole('region', { name: 'Action Required' }).getByRole('link');
    await expect(action).toContainText('Publication authorization');
    await expect(action).toContainText('d'.repeat(40));
    await expect(action).toContainText('authorize PR creation for this exact candidate');
    await expect(action).toHaveAttribute('href', new RegExp(`graph_id=${currentGraphID}.*publication_graph=${currentGraphID}`));
    await action.click();
    await expect(page).toHaveURL(new RegExp(`#objectives$`));
    await expect(page.getByRole('region', { name: 'Work graph for Ship usage export' })).toBeVisible();
    const authorize = page.getByRole('button', { name: `Authorize PR creation for ${'d'.repeat(7)}` });
    await expect(authorize).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`publication-authorization-${viewport.name}.png`), fullPage: true });
    let authorizationBody: unknown;
    await page.route('**/api/v1/agent-runs/run-integrate/publish', (route) => {
      authorizationBody = route.request().postDataJSON();
      return route.fulfill({ status: 202 });
    });
    await authorize.click();
    await expect.poll(() => authorizationBody).toEqual({ candidate_sha: 'd'.repeat(40) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('Action Required omits an empty queue and reports an unavailable queue honestly', async ({ page }) => {
  let releaseInitialLoad!: () => void;
  const initialLoad = new Promise<void>((resolve) => { releaseInitialLoad = resolve; });
  let unavailable = false;
  await page.route('**/api/v1/auth/session', (route) => route.fulfill(json({ authenticated: true, local: true, login: 'Local workspace' })));
  await page.route('**/api/v1/action-required', async (route) => {
    if (unavailable) return route.fulfill({ status: 503, body: 'temporarily unavailable' });
    await initialLoad;
    return route.fulfill(json([]));
  });
  await page.goto('/?mode=live#overview');
  const queue = page.getByRole('region', { name: 'Action Required' });
  await expect(queue).toContainText('Checking for human actions…');
  releaseInitialLoad();
  await expect(queue).toHaveCount(0);
  unavailable = true;
  await page.reload();
  await expect(queue).toContainText('Human actions unavailable (503)');
  await expect(queue.getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('Mock Overview never requests the Live Action Required projection', async ({ page }, testInfo) => {
  let requests = 0;
  await page.route('**/api/v1/action-required', (route) => {
    requests += 1;
    return route.fulfill(json([]));
  });
  const preview = new URL(testInfo.project.use.baseURL ?? 'http://127.0.0.1:4173');
  preview.hostname = '127.0.0.1';
  preview.pathname = '/';
  preview.searchParams.set('mode', 'mock');
  preview.hash = 'overview';
  await page.goto(preview.toString());
  await expect(page.getByRole('region', { name: 'Action Required' })).toHaveCount(0);
  expect(requests).toBe(0);
});

test('Action Required leaves absent decision details unknown', async ({ page }) => {
  const partial = graph(currentGraphID, 'api-partial', 'Which serialization should ship?', '2026-11-02T00:00:00Z');
  partial.units[0].reason = '';
  partial.messages[0].body = '';
  partial.messages[0].notes = [];
  partial.messages[0].run_id = '';
  const action = decisionAction('api-partial', '', currentGraphID);
  action.reason = '';
  action.options = [];
  action.run_id = '';
  await useLiveSession(page, [partial], [action]);
  await page.goto('/?mode=live#overview');
  const actionLink = page.getByRole('region', { name: 'Action Required' }).getByRole('link');
  await expect(actionLink).toContainText('Subject not recorded');
  await expect(actionLink).toContainText('Waiting reason: Not recorded');
  await expect(actionLink).toContainText('Options not recorded');
  await expect(actionLink).toContainText('Run not recorded');
});

for (const viewport of [{ name: 'desktop', width: 1672, height: 941 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`Action Required links to the current proposed plan (${viewport.name})`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const plan = { objective_id: objectiveID, revision: 3, status: 'proposed', project_id: 'repository',
      summary: 'Prepare and review the usage export', max_parallel: 1, units: [], problems: [], created_at: '2026-11-03T00:00:00Z' };
    const planAction = { id: `plan:${objectiveID}:3`, kind: 'plan_approval', objective_id: objectiveID,
      objective_title: 'Ship usage export', plan_revision: 3, stage: 'Plan approval', unit_title: '', run_id: '',
      subject: plan.summary, reason: 'This proposed revision needs approval before work can start.', options: [], can_act: true };
    await useLiveSession(page, [], [planAction]);
    await page.route(`**/api/v1/objectives/${objectiveID}/plans`, (route) => route.fulfill(json([plan])));
    await page.goto('/?mode=live#overview');
    const queue = page.getByRole('region', { name: 'Action Required' });
    const action = queue.getByRole('link');
    await expect(queue).toContainText('1 waiting');
    await expect(action).toContainText('Plan revision 3 · Plan approval');
    await expect(action).toContainText('Plan subject · Prepare and review the usage export');
    await expect(action).toContainText('Available action: review the plan and approve it in Objective Workspace');
    await expect(action).toContainText('WorkUnit not started · Run not started');
    await expect(action).toHaveAttribute('href', new RegExp(`objective=${objectiveID}.*tab=plan`));
    await page.screenshot({ path: testInfo.outputPath(`action-required-plan-${viewport.name}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await action.click();
    await expect(page.getByRole('button', { name: 'Approve plan and start' })).toBeVisible();
    await expect(page.getByText(plan.summary)).toBeVisible();
  });
}

test('Action Required deep links stay selected until their action is complete', async ({ page }) => {
  await useLiveSession(page, [graph(cancelledGraphID, 'api-cancelled', 'Old graph decision', '2026-11-02T00:00:00Z', 'cancelled')]);
  const plan = { objective_id: objectiveID, revision: 2, status: 'proposed', project_id: 'repository', summary: 'Replacement plan',
    max_parallel: 1, units: [], problems: [], created_at: '2026-11-03T00:00:00Z' };
  let graphs = [graph(cancelledGraphID, 'api-cancelled', 'Old graph decision', '2026-11-02T00:00:00Z', 'cancelled')];
  let plans: unknown[] = [plan];
  await page.route('**/api/v1/work-graphs', (route) => route.fulfill(json(graphs)));
  await page.route(`**/api/v1/objectives/${objectiveID}/plans`, (route) => route.fulfill(json(plans)));
  await page.route(`**/api/v1/objectives/${objectiveID}/plans/2/approve`, (route) => {
    graphs = [graph(currentGraphID, 'api-replacement', 'Replacement graph decision', '2026-11-04T00:00:00Z', 'active')];
    plans = [{ ...plan, status: 'approved', graph_id: currentGraphID, approved_by: 'Local operator' }];
    return route.fulfill(json({ status: 'approved' }));
  });
  await page.goto(`/?mode=live&objective=${objectiveID}&tab=plan&graph_id=${cancelledGraphID}&decision=decision-api-cancelled#objectives`);
  await expect(page.getByRole('form', { name: 'Decision for api-cancelled' })).toContainText('Old graph decision');
  await expect(page).toHaveURL(new RegExp(`objective=${objectiveID}.*tab=plan.*graph_id=${cancelledGraphID}.*decision=decision-api-cancelled`));
  await page.getByRole('button', { name: 'Approve plan and start' }).click();
  await expect(page).toHaveURL(new RegExp(`objective=${objectiveID}.*tab=plan`));
  await expect(page).not.toHaveURL(/graph_id=|decision=/);
  const messages = page.getByRole('list', { name: 'Handoffs, findings, and decisions' });
  await expect(messages).toContainText('Replacement graph decision');
  await expect(messages).not.toContainText('Old graph decision');
  await page.locator('.sidebar nav a[href="#overview"]').click();
  await page.locator('.sidebar nav a[href="#objectives"]').click();
  await expect(page).not.toHaveURL(/objective=|tab=|graph_id=|decision=/);
});

for (const viewport of [{ name: 'desktop', width: 1672, height: 941 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`Action Required explains when worker permissions block an action (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const decision = { ...decisionAction('api-private', 'Which export format should ship?', currentGraphID),
      can_act: false, action_blocker: "Your current access cannot dispatch work to this graph's worker." };
    const plan = { id: `plan:${objectiveID}:3`, kind: 'plan_approval', objective_id: objectiveID,
      objective_title: 'Ship usage export', plan_revision: 3, stage: 'Plan approval', subject: 'Prepare export',
      reason: 'This proposed revision needs approval before work can start.', options: [], can_act: false,
      action_blocker: "Your current access cannot dispatch work to the plan's worker." };
    await useLiveSession(page, [], [decision, plan]);
    await page.goto('/?mode=live#overview');
    const rows = page.getByRole('region', { name: 'Action Required' }).getByRole('link');
    const decisionRow = rows.filter({ hasText: 'Decision decision-api-private' });
    const planRow = rows.filter({ hasText: 'Prepare export' });
    await expect(decisionRow).toContainText("Action unavailable: Your current access cannot dispatch work to this graph's worker.");
    await expect(decisionRow).toHaveAttribute('href', new RegExp(`graph_id=${currentGraphID}.*decision=decision-api-private`));
    await expect(planRow).toContainText("Action unavailable: Your current access cannot dispatch work to the plan's worker.");
    await expect(planRow).toHaveAttribute('href', new RegExp(`objective=${objectiveID}.*tab=plan`));
  });
}
