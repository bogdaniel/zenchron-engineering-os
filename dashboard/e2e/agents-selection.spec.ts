import { expect, test } from '@playwright/test';

const environment = (
  globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }
).process?.env ?? {};
const localDashboardURL = `http://127.0.0.1:${Number(environment.ZENCHRON_E2E_DASHBOARD_PORT) || 4173}`;

test('Filtering preserves the selected profile and its unsaved edits', async ({ page }) => {
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, local: true, login: 'E2E' }),
  }));
  const profile = (id: string, name: string) => ({
    id, name, description: '', provider: 'custom', model: 'default', status: 'active',
    system_prompt: 'System prompt.', goal_prompt: 'Goal prompt.', tools: [], version: 1,
    updated_at: new Date().toISOString(),
  });
  await page.route('**/api/v1/agents', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([
      profile('01'.repeat(16), 'Selected profile'), profile('02'.repeat(16), 'Other profile'),
    ]),
  }));
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.goto(`${localDashboardURL}/?mode=live#agents`);
  await expect(page.locator('.agent-row')).toHaveCount(2);
  const selectedName = await page.locator('.agents-detail-heading h3').innerText();
  const otherName = selectedName === 'Selected profile' ? 'Other profile' : 'Selected profile';
  await expect(page.getByRole('heading', { name: selectedName })).toBeVisible();
  await page.getByRole('button', { name: 'More agent actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit profile' }).click();
  const model = page.getByLabel('Model', { exact: true });
  await model.fill('unsaved-model');
  await page.getByRole('textbox', { name: 'Search agents' }).fill(otherName);
  await expect(page.getByRole('heading', { name: selectedName })).toBeVisible();
  await expect(model).toHaveValue('unsaved-model');
  await expect(page.getByRole('button', { name: 'Save profile' })).toBeVisible();
});
