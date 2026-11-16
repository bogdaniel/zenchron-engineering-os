import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 1672, height: 941 }, { width: 390, height: 844 }]) {
  test(`record links select the referenced workflow and profile at ${viewport.width}px`, async ({ page }) => {
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
    await page.goto('/?workflow=target#workflows');
    if (viewport.width === 390) {
      await expect(page.getByRole('img', { name: 'Key workflow stages for Workflow target; 0 stages summarize 0 components' })).toBeVisible();
    } else {
      await expect(page.getByRole('heading', { name: 'Workflow Builder — Workflow target' })).toBeVisible();
    }
    await page.goto('/?profile=target#agents');
    await expect(page.locator('.agents-detail-heading')).toContainText('Profile target');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
