import { expect, test } from '@playwright/test';

const now = new Date().toISOString();
const project = (id: string, name: string) => ({
  id, name, branch: 'main', git_remote: `github.com/acme/${name}`, worker_id: 'worker', worker_name: 'Local worker',
  last_seen: now, worker_status: 'online',
});
const run = (digit: string, branch: string) => ({
  id: digit.repeat(32), agent_id: 'a'.repeat(32), agent_name: 'Engineer', project_id: 'project',
  project_name: 'Repository', worker_id: 'worker', worker_name: 'Local worker', branch, base_branch: 'main',
  prompt: `Review ${branch}`, status: 'succeeded', attempts: 1, created_at: now, updated_at: now, diff_available: true,
});

async function useData(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/auth/session') return route.fulfill({ json: {
      authenticated: true, local: true, login: 'Local workspace',
    } });
    if (path === '/api/v1/projects') return route.fulfill({ json: [
      project('first', 'First repository'), project('second', 'Second repository'),
    ] });
    if (path === '/api/v1/agent-runs') return route.fulfill({ json: [
      run('1', 'zenchron/agent-run/first'), run('2', 'zenchron/agent-run/second'),
    ] });
    return route.fulfill({ json: [] });
  });
  await page.route('**/healthz', (route) => route.fulfill({ json: { status: 'ok' } }));
}

test('Projects grid opens focused rows with Enter and Space', async ({ page }) => {
  await useData(page);
  await page.setViewportSize({ width: 1672, height: 941 });
  const projectsLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/projects');
  await page.goto('/?mode=live#projects');
  expect(await (await projectsLoaded).json()).toHaveLength(2);
  await expect(page.locator('.projects-grid-wrap')).toContainText('First repository');
  const rows = page.getByRole('row').filter({ hasText: /First repository|Second repository/ });
  await expect(rows).toHaveCount(2);
  await rows.nth(1).getByRole('gridcell').first().press('Enter');
  await expect(page.locator('.project-detail-heading h3')).toHaveText('Second repository');
  await rows.first().getByRole('gridcell').first().press('Space');
  await expect(page.locator('.project-detail-heading h3')).toHaveText('First repository');
});

test('Local branch grid opens a focused run with Enter', async ({ page }) => {
  await useData(page);
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/?mode=live#reviews');
  await page.getByRole('button', { name: 'Local branches' }).click();
  await expect(page.locator('.reviews-grid-wrap')).toContainText('zenchron/agent-run/first');
  const rows = page.getByRole('row').filter({ hasText: /zenchron\/agent-run\/(first|second)/ });
  await expect(rows).toHaveCount(2);
  await rows.nth(1).getByRole('gridcell').first().press('Enter');
  await expect(page.getByRole('heading', { name: 'zenchron/agent-run/second' })).toBeVisible();
});
