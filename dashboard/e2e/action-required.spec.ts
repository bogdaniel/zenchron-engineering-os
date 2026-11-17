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

async function useLiveSession(page: Page, graphs: unknown[]) {
  await page.route('**/api/v1/**', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/auth/session', (route) => route.fulfill(json({ authenticated: true, local: true, login: 'Local workspace' })));
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
    ]);
    await page.goto('/?mode=live#overview');
    const queue = page.getByRole('region', { name: 'Action Required' });
    await expect(queue).toContainText('2 waiting');
    await expect(queue.getByRole('link')).toHaveCount(2);
    await expect(queue).not.toContainText('api-cancelled');
    const exactAction = queue.getByRole('link', { name: 'Ship usage export Decision requested by api-old' });
    await expect(exactAction).toHaveAttribute('href', new RegExp(`graph_id=${oldGraphID}.*decision=decision-api-old`));
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

test('Action Required reports an empty and unavailable queue honestly', async ({ page }) => {
  await page.route('**/api/v1/auth/session', (route) => route.fulfill(json({ authenticated: true, local: true, login: 'Local workspace' })));
  await page.route('**/api/v1/work-graphs', (route) => route.fulfill(json([])));
  await page.goto('/?mode=live#overview');
  const queue = page.getByRole('region', { name: 'Action Required' });
  await expect(queue).toContainText('No governed decisions are waiting.');
  await page.route('**/api/v1/work-graphs', (route) => route.fulfill({ status: 503, body: 'temporarily unavailable' }));
  await page.reload();
  await expect(queue).toContainText('WorkGraph actions unavailable (503)');
  await expect(queue.getByRole('button', { name: 'Retry' })).toBeVisible();
});
