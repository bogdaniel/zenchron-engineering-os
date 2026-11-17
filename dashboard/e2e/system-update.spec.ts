import { expect, test } from '@playwright/test';

const oldRevision = '0123456789abcdef0123456789abcdef01234567';
const newRevision = 'abcdef0123456789abcdef0123456789abcdef01';

test('Live reconnect reloads the activated dashboard while preserving its route and mode', async ({ page }) => {
  let documentLoads = 0;
  page.on('load', () => documentLoads++);
  let revision = oldRevision;
  let state = 'activating';
  await page.route('**/api/v1/system/update', (route) => route.fulfill({ json: {
    running_revision: revision, latest_revision: newRevision, state,
    worker_compatible: true, active_runs: 0,
  } }));
  await page.goto('http://127.0.0.1:4174/?mode=live#settings');
  await expect(page.getByRole('heading', { name: 'System Update' })).toBeVisible();
  revision = newRevision;
  state = 'active';
  await expect.poll(() => documentLoads, { timeout: 15_000 }).toBeGreaterThan(1);
  expect(page.url()).toContain('/?mode=live#settings');
  await expect(page.getByText(newRevision.slice(0, 12)).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Settings & Integrations' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('Mock Settings does not read managed update status', async ({ page }) => {
  let reads = 0;
  await page.route('**/api/v1/system/update', async (route) => {
    reads++;
    await route.fulfill({ json: { running_revision: oldRevision, state: 'idle', worker_compatible: true, active_runs: 0 } });
  });
  await page.goto('http://127.0.0.1:4174/?mode=mock#settings');
  await expect(page.getByRole('heading', { name: 'System Update' })).toBeVisible();
  expect(reads).toBe(0);
  await expect(page.getByText('Mock status is illustrative; the installed update service is not queried.')).toBeVisible();
});
