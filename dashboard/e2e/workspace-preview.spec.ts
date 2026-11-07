import { expect, test } from '@playwright/test';

test('local Product Workspace mock matches the supplied overview without protected API traffic', async ({ page }) => {
  const apiRequests: { method: string; path: string }[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    apiRequests.push({ method: request.method(), path: new URL(request.url()).pathname });
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"preview fixture expected"}' });
  });
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/?preview=mock#workspace');

  await expect(page.getByRole('heading', { name: 'Good morning, Alex' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nova Platform' })).toBeVisible();
  await expect(page.getByText('Product Health')).toBeVisible();
  await expect(page.getByText('Release Streams')).toBeVisible();
  await expect(page.getByText('Stakeholders (8)')).toBeVisible();
  await expect(page.locator('.workspace-mock-product')).toHaveCount(5);
  await expect(page.locator('.workspace-mock-card')).toHaveCount(9);
  await expect(page.locator('.workspace-mock-roadmap-row')).toHaveCount(4);
  await expect(page.locator('.workspace-mock-objectives > div')).toHaveCount(5);
  await expect(page.locator('.workspace-mock-list.people > div')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'New Workspace' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Search products' })).toBeDisabled();

  const gridColumns = await page.locator('.workspace-mock-grid').evaluate((grid) =>
    getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length);
  expect(gridColumns).toBe(12);
  const overflowingCards = await page.locator('.workspace-mock-card').evaluateAll((cards) =>
    cards.filter((card) => card.scrollHeight > card.clientHeight + 1).map((card) => card.textContent?.trim()));
  expect(overflowingCards).toEqual([]);
  expect(apiRequests.filter(({ path }) => path !== '/api/v1/auth/session')).toEqual([]);
  expect(apiRequests.filter(({ method }) => method !== 'GET')).toEqual([]);
});
