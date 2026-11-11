import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:4173' });

test('phone Workflow mock shows the sample run, task progress, and approvals without API reads', async ({ page }) => {
  const apiRequests: { method: string; path: string }[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    apiRequests.push({ method: request.method(), path: new URL(request.url()).pathname });
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"preview fixture expected"}' });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#workflows');

  await expect(page.locator('.workflow-mobile-header')).toBeVisible();
  await expect(page.locator('.workflow-mobile-menu-trigger')).toHaveCSS('background-color', 'rgb(20, 19, 31)');
  await expect(page.getByRole('link', { name: 'Back to Overview' })).toHaveAttribute('href', '#overview');
  await expect(page.locator('.sidebar > .brand')).toBeHidden();
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.locator('.workflow-mobile-eyebrow')).toHaveText('Objective');
  await expect(page.locator('.workflow-desktop-eyebrow')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Workflow Orchestration' })).toBeVisible();
  await expect(page.locator('.workflow-mobile-description')).toHaveText('Ship AI code review v2');
  await expect(page.locator('.workflow-mobile-status')).toHaveText('Running');
  await expect(page.getByRole('navigation', { name: 'Workflow sections' })).toBeHidden();
  await expect(page.locator('.workflow-toolbar')).toBeHidden();
  await expect(page.locator('.workflow-mobile-overview .workflow-overview-canvas')).toBeVisible();
  const overviewNodes = page.locator('.workflow-mobile-overview .workflow-node');
  await expect(overviewNodes).toHaveCount(6);
  expect(await overviewNodes.locator('b').allTextContents()).toEqual(
    ['Trigger', 'Plan', 'Build', 'Test', 'Review', 'Merge']);
  expect(await overviewNodes.evaluateAll((nodes) => {
    const canvas = nodes[0].closest('.workflow-overview-canvas')!.getBoundingClientRect();
    const boxes = nodes.map((node) => node.getBoundingClientRect());
    return boxes.every((box, index) => box.left >= canvas.left && box.right <= canvas.right &&
      box.top >= canvas.top && box.bottom <= canvas.bottom && boxes.slice(index + 1).every((other) =>
        box.right <= other.left || box.left >= other.right || box.bottom <= other.top || box.top >= other.bottom));
  })).toBe(true);
  await expect(page.locator('.workflow-mobile-run-preview')).toBeVisible();
  await expect(page.locator('.workflow-mobile-run-summary')).toContainText('Run #8821 · Started 8m ago');
  await expect(page.locator('.workflow-mobile-run-progress')).toContainText('78%');
  await expect(page.locator('.workflow-mobile-run-task')).toHaveCount(5);
  await expect(page.locator('.workflow-mobile-run-task.complete')).toHaveCount(2);
  await expect(page.locator('.workflow-mobile-run-task.active')).toHaveCount(1);
  await expect(page.locator('.workflow-mobile-run-task b').first()).toHaveCSS('font-size', '10px');
  await expect(page.locator('.workflow-mobile-run-task small').first()).toHaveCSS('font-size', '10px');
  await expect(page.locator('.workflow-mobile-approval-row')).toHaveCount(2);
  await expect(page.locator('.workflow-mobile-approval-row').last()).toContainText('Awaiting approval');
  await expect(page.locator('.workflow-mobile-approval-row small').last()).toHaveCSS('font-size', '10px');
  const approvalsFitInitialViewport = await page.evaluate(() => {
    const approval = document.querySelector('.workflow-mobile-run-approvals')!.getBoundingClientRect();
    const navigation = document.querySelector('.sidebar nav')!.getBoundingClientRect();
    return approval.top >= 0 && approval.bottom <= navigation.top;
  });
  expect(approvalsFitInitialViewport, 'the full approval card should fit above the fixed phone navigation').toBe(true);
  await expect(page.getByRole('button', { name: 'Review' })).toBeEnabled();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page.locator('#workflow-mobile-run-tasks')).toBeInViewport();
  await page.getByRole('button', { name: 'Approvals', exact: true }).click();
  await expect(page.locator('#workflow-mobile-run-approvals')).toBeInViewport();
  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.locator('.workflow-status')).toContainText('Review Approval previewed');
  await expect(page.locator('.sidebar nav')).toBeVisible();

  const clippedPanels = await page.locator('.workflow-mobile-run-preview > .shared-panel-surface').evaluateAll((panels) =>
    panels.filter((panel) => panel.scrollHeight > panel.clientHeight + 1).map((panel) => panel.textContent?.trim()));
  expect(clippedPanels).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const approvalsClearOfNavigation = await page.evaluate(() => {
    const approval = document.querySelector('.workflow-mobile-approval-row:last-child')!.getBoundingClientRect();
    const navigation = document.querySelector('.sidebar nav')!.getBoundingClientRect();
    return approval.bottom <= navigation.top;
  });
  expect(approvalsClearOfNavigation, 'approval controls should be reachable above the fixed phone navigation').toBe(true);
  await page.getByRole('button', { name: 'More workflow actions' }).click();
  await page.getByRole('menuitem', { name: 'Show approvals' }).click();
  await expect(page.getByRole('button', { name: 'Approvals', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(apiRequests.filter(({ path }) => path !== '/api/v1/auth/session')).toEqual([]);
  expect(apiRequests.filter(({ method }) => method !== 'GET')).toEqual([]);
  await page.getByRole('link', { name: 'Back to Overview' }).click();
  await expect(page).toHaveURL(/#overview$/);
});
