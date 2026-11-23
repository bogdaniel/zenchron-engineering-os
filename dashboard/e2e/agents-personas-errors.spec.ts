import { expect, test } from '@playwright/test';

test('Persona list reports duplicate validation and update failures', async ({ page }) => {
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, local: true, login: 'E2E' }),
  }));
  const personaID = '01'.repeat(16);
  await page.route('**/api/v1/agents', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.route('**/api/v1/personas', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([{
      id: personaID, name: 'P'.repeat(100), role: 'Reviewer', responsibilities: [], instructions: '', behavior: '',
      review_specialization: '', status: 'active', version: 1, updated_at: new Date().toISOString(),
    }]),
  }));
  await page.route('**/api/v1/personas/*', (route) => route.fulfill({
    status: 403, contentType: 'text/plain', body: 'Persona changes are forbidden by policy.',
  }));
  await page.goto('/?mode=live#agents');
  await page.getByRole('button', { name: 'Personas', exact: true }).click();
  const list = page.getByRole('dialog', { name: 'Agent personas' });
  const row = list.locator('.persona-list-row');
  await row.getByRole('button', { name: 'Duplicate' }).click();
  const alert = list.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('100');
  await row.getByRole('button', { name: 'Disable' }).click();
  await expect(alert).toHaveText('Persona changes are forbidden by policy.');
});
