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
    units: [{ key: unit, kind: 'produce', title: unit, instructions: '', acceptance: [], depends_on: [],
      capabilities: [], agent_id: 'a'.repeat(32), state: 'blocked', run_ids: [] }],
    messages: [{ id: `decision-${unit}`, type: 'decision_request', from: unit, body: question, notes: [], created_at: created }],
  };
}

function decisionAction(graphID: string, unit: string, question: string) {
  return { id: `decision-${unit}`, kind: 'work_graph_decision', objective_id: objectiveID,
    objective_title: 'Ship usage export', plan_revision: 1, graph_id: graphID, unit_key: unit,
    stage: 'produce', unit_title: unit, run_id: '1'.repeat(32), subject: question, reason: 'Not recorded',
    options: [], can_act: true };
}

async function useLiveSession(page: Page, graphs: unknown[], actions: unknown[] = []) {
  await page.route('**/api/v1/**', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/auth/session', (route) => route.fulfill(json({ authenticated: true, local: true, login: 'Local workspace' })));
  await page.route('**/api/v1/action-required', (route) => route.fulfill(json(actions)));
  await page.route('**/api/v1/work-graphs', (route) => route.fulfill(json(graphs)));
  await page.route('**/api/v1/objectives', (route) => route.fulfill(json([{
    id: objectiveID, title: 'Ship usage export', description: '', owner: 'Alex', product: '', product_id: '',
    status: 'in_progress', progress: 50, due_date: '', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z',
  }])));
  await page.route(`**/api/v1/objectives/${objectiveID}/plans`, (route) => route.fulfill(json([])));
}

for (const viewport of [{ name: 'desktop', width: 1672, height: 941 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`Action Required opens the exact WorkGraph decision (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await useLiveSession(page, [
      graph(currentGraphID, 'api-current', 'Which serialization should ship?', '2026-11-02T00:00:00Z'),
      graph(oldGraphID, 'api-old', 'Should this export include archived records?', '2026-11-01T00:00:00Z'),
      graph(cancelledGraphID, 'api-cancelled', 'Should a cancelled run continue?', '2026-10-31T00:00:00Z', 'cancelled'),
    ], [decisionAction(currentGraphID, 'api-current', 'Which serialization should ship?'),
      decisionAction(oldGraphID, 'api-old', 'Should this export include archived records?')]);
    await page.goto('/?mode=live#overview');
    const queue = page.getByRole('region', { name: 'Action Required' });
    await expect(queue).toContainText('2 waiting');
    await expect(queue.getByRole('link')).toHaveCount(2);
    await expect(queue).not.toContainText('api-cancelled');
    const exactAction = queue.getByRole('link').filter({ hasText: 'Should this export include archived records?' });
    await expect(exactAction).toHaveAttribute('href', new RegExp(`graph_id=${oldGraphID}.*decision=decision-api-old`));
    await expect(exactAction).toContainText('Waiting reason: Not recorded');
    await expect(exactAction).toContainText(/WorkUnit api-old · Run [a-f0-9]{32}/);
    await page.screenshot({ path: `test-results/action-required-${viewport.name}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await exactAction.click();
    const decision = page.getByRole('form', { name: 'Decision for api-old' });
    await expect(decision).toBeVisible();
    await expect(decision.getByText('Should this export include archived records?')).toBeVisible();
    await expect(page.getByText('Which serialization should ship?')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Decision for api-old' })).toBeFocused();
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

test('Action Required deep links stay selected until their action is complete', async ({ page }) => {
  await useLiveSession(page, [graph(cancelledGraphID, 'api-cancelled', 'Old graph decision', '2026-11-02T00:00:00Z', 'cancelled')]);
  await page.route('**/api/v1/projects', (route) => route.fulfill(json([{ id: 'repository', name: 'platform', branch: 'main',
    git_remote: 'github.com/acme/platform', worker_id: 'online-worker', worker_name: 'dev-laptop',
    last_seen: '2026-11-04T00:00:00Z', worker_status: 'online' }])));
  await page.route('**/api/v1/workers', (route) => route.fulfill(json([{ id: 'online-worker', name: 'dev-laptop', status: 'online',
    last_seen: '2026-11-04T00:00:00Z', providers: [] }])));
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
