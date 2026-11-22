import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 1672, height: 941 }, { width: 390, height: 844 }]) {
  test(`record links select the referenced workflow, profile, and run at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const updated_at = new Date().toISOString();
    await page.route('**/api/v1/**', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/v1/auth/session', (route) => route.fulfill({
      json: { authenticated: true, local: true, login: 'Local workspace' },
    }));
    await page.route('**/api/v1/workflows', (route) => route.fulfill({ json: ['first', 'target'].map((id) => ({
      id, name: `Workflow ${id}`, description: '', status: 'draft', version: 1, nodes: [], edges: [], updated_at,
    })) }));
    await page.route('**/api/v1/agents', (route) => route.fulfill({ json: ['first', 'target'].map((id) => ({
      id, name: `Profile ${id}`, description: '', provider: 'codex-cli', model: 'default', status: 'active',
      system_prompt: '', goal_prompt: '', tools: ['git.read'], version: 1, updated_at,
    })) }));
    await page.route('**/api/v1/agent-runs', (route) => route.fulfill({ json: ['first', 'target'].map((id) => ({
      id, agent_id: 'target', agent_name: 'Profile target', project_id: 'project', project_name: 'Repository',
      worker_id: 'worker', worker_name: 'Local worker', branch: `run-${id}`, prompt: `Review ${id}`,
      status: 'succeeded', attempts: 1, created_at: updated_at, updated_at, diff_available: false,
    })) }));
    await page.goto('/?workflow=target#workflows');
    if (viewport.width === 390) {
      await expect(page.getByRole('img', { name: 'Key workflow stages for Workflow target; 0 stages summarize 0 components' })).toBeVisible();
    } else {
      await expect(page.getByRole('heading', { name: 'Workflow Builder — Workflow target' })).toBeVisible();
    }
    await expect(page).toHaveURL(/#workflows$/);
    await page.goto('/?profile=target#agents');
    await expect(page.locator('.agents-detail-heading')).toContainText('Profile target');
    await expect(page).toHaveURL(/#agents$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.goto('/?run=target#reviews');
    await expect(page.getByLabel('Run evidence summary')).toContainText('run-target');
    await expect(page.getByLabel('Run evidence summary')).not.toContainText('run-first');
    await expect(page).toHaveURL(/#reviews$/);
    await page.screenshot({ path: testInfo.outputPath('run-evidence.png'), fullPage: true });
    await page.goto('/?run=missing#reviews');
    await expect(page.getByRole('alert')).toContainText('The requested run is unavailable');
    await expect(page.getByLabel('Run evidence summary')).toHaveCount(0);
  });
}

test('canceling a workspace objective link consumes its one-shot context', async ({ page }) => {
  await page.route('**/api/v1/**', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    json: { authenticated: true, local: true, login: 'Local workspace' },
  }));
  await page.route('**/healthz', (route) => route.fulfill({ json: { status: 'ok' } }));
  await page.goto('/?create=1&product_id=product&workflow=workflow&project=project&mode=live#objectives');
  const dialog = page.getByRole('dialog', { name: 'New objective' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/\?mode=live#objectives$/);
  await page.goto('/?mode=live#overview');
  await page.goto('/?mode=live#objectives');
  await expect(page.getByRole('dialog', { name: 'New objective' })).toHaveCount(0);
});
