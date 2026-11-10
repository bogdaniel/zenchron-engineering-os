import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:4173' });

test('local Product Workspace mock matches the supplied overview without protected API traffic', async ({ page }) => {
  const apiRequests: { method: string; path: string }[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    apiRequests.push({ method: request.method(), path: new URL(request.url()).pathname });
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"preview fixture expected"}' });
  });
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#workspace');

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
  await expect(page.getByRole('button', { name: 'New Workspace' })).toBeEnabled();
  const search = page.getByRole('textbox', { name: 'Search products' });
  await search.fill('Orion');
  await expect(page.locator('.workspace-mock-product')).toHaveCount(1);
  await page.getByRole('button', { name: /Orion Analytics/ }).click();
  await expect(page.getByRole('heading', { name: 'Orion Analytics' })).toBeVisible();
  await page.getByRole('button', { name: /All Products/ }).click();
  await expect(page.locator('.workspace-mock-product')).toHaveCount(5);

  for (const [tab, card] of [['Objectives', 'objectives'], ['Repos', 'repositories'], ['Files', 'files'],
    ['Decisions', 'decisions'], ['Templates', 'linked-workflows']] as const) {
    await page.getByRole('button', { name: tab }).click();
    await expect(page.locator(`.workspace-mock-card.${card}`)).toBeVisible();
    await expect(page.locator('div.workspace-mock-grid')).toHaveClass(new RegExp(tab.toLowerCase()));
  }
  await page.getByRole('button', { name: 'Overview' }).click();
  await page.locator('.workspace-mock-card.objectives').getByRole('button', { name: /View All/ }).click();
  await expect(page.getByRole('button', { name: 'Objectives' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Overview' }).click();
  await page.locator('.workspace-mock-card.people').getByRole('button', { name: /Manage/ }).click();
  await expect(page.getByRole('dialog', { name: 'Stakeholders' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Timeline' }).click();
  await expect(page.locator('.workspace-mock-timeline-row')).toHaveCount(4);
  await page.getByRole('button', { name: 'Roadmap', exact: true }).click();
  await page.getByRole('button', { name: 'Choose roadmap quarter' }).click();
  await page.getByRole('menuitem', { name: 'Q3 ’25' }).click();
  await expect(page.getByRole('button', { name: 'Choose roadmap quarter' })).toContainText('Q3 ’25');
  await page.getByRole('button', { name: 'Choose delivery metrics time range' }).click();
  await page.getByRole('menuitem', { name: 'Last 4 weeks' }).click();
  await expect(page.getByText('3.8 days')).toBeVisible();
  await page.getByRole('button', { name: 'Share' }).click();
  await expect(page.getByRole('dialog', { name: 'Share Product Workspace' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Product actions' }).click();
  await page.getByRole('menuitem', { name: 'Add another product' }).click();
  await page.getByRole('textbox', { name: 'Product name' }).fill('Local Preview Product');
  await page.getByRole('button', { name: 'Add product', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Local Preview Product' })).toBeVisible();
  await expect(page.locator('.workspace-mock-product')).toHaveCount(6);
  const addProduct = page.getByRole('button', { name: /Add Product/ });
  await expect(addProduct).toBeEnabled();
  await expect(addProduct).toHaveCSS('background-image', /linear-gradient/);

  const gridColumns = await page.locator('div.workspace-mock-grid').evaluate((grid) =>
    getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length);
  expect(gridColumns).toBe(12);
  const overflowingCards = await page.locator('.workspace-mock-card').evaluateAll((cards) =>
    cards.filter((card) => card.scrollHeight > card.clientHeight + 1).map((card) => card.textContent?.trim()));
  expect(overflowingCards).toEqual([]);
  for (const [width, height, columns] of [[1024, 768, 2], [768, 1024, 1], [390, 844, 1]]) {
    await page.setViewportSize({ width, height });
    await page.reload();
    const responsiveLayout = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      columns: getComputedStyle(document.querySelector('.workspace-mock-grid')!)
        .gridTemplateColumns.trim().split(/\s+/).length,
      tabsFit: [...document.querySelectorAll('.workspace-mock-tabs button')].every((button) => {
        const tabs = document.querySelector('.workspace-mock-tabs')!.getBoundingClientRect();
        const item = button.getBoundingClientRect();
        return item.left >= tabs.left && item.right <= tabs.right + 1;
      }),
    }));
    expect(responsiveLayout.width).toBe(responsiveLayout.viewport);
    expect(responsiveLayout.columns).toBe(columns);
    expect(responsiveLayout.tabsFit).toBe(true);
    const clippedCards = await page.locator('.workspace-mock-card').evaluateAll((cards) =>
      cards.filter((card) => card.scrollHeight > card.clientHeight + 1).map((card) => card.textContent?.trim()));
    expect(clippedCards).toEqual([]);
  }
  expect(apiRequests.filter(({ path }) => path !== '/api/v1/auth/session')).toEqual([]);
  expect(apiRequests.filter(({ method }) => method !== 'GET')).toEqual([]);
});
