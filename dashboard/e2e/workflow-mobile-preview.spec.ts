import { expect, test } from '@playwright/test';

test('phone Workflow mock shows the sample run, task progress, and approvals without API reads', async ({ page }) => {
  const apiRequests: { method: string; path: string }[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    apiRequests.push({ method: request.method(), path: new URL(request.url()).pathname });
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"preview fixture expected"}' });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?preview=mock#workflows');

  await expect(page.getByRole('heading', { name: 'Workflow Orchestration' })).toBeVisible();
  await expect(page.locator('.workflow-mobile-overview .workflow-overview-canvas')).toBeVisible();
  await expect(page.locator('.workflow-mobile-run-preview')).toBeVisible();
  await expect(page.locator('.workflow-mobile-run-summary')).toContainText('Run #8821 · Started 8m ago');
  await expect(page.locator('.workflow-mobile-run-progress')).toContainText('78%');
  await expect(page.locator('.workflow-mobile-run-task')).toHaveCount(5);
  await expect(page.locator('.workflow-mobile-run-task.complete')).toHaveCount(2);
  await expect(page.locator('.workflow-mobile-run-task.active')).toHaveCount(1);
  await expect(page.locator('.workflow-mobile-approval-row')).toHaveCount(2);
  await expect(page.locator('.workflow-mobile-approval-row').last()).toContainText('Awaiting approval');
  await expect(page.getByRole('button', { name: 'Review' })).toBeDisabled();
  await expect(page.locator('.sidebar nav')).toBeVisible();

  const clippedPanels = await page.locator('.workflow-mobile-run-preview > .shared-panel-surface').evaluateAll((panels) =>
    panels.filter((panel) => panel.scrollHeight > panel.clientHeight + 1).map((panel) => panel.textContent?.trim()));
  expect(clippedPanels).toEqual([]);
  expect(apiRequests.filter(({ path }) => path !== '/api/v1/auth/session')).toEqual([]);
  expect(apiRequests.filter(({ method }) => method !== 'GET')).toEqual([]);
});
