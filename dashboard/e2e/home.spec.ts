import { expect, test } from '@playwright/test';

test('dashboard opens', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Zenchron' })).toBeVisible();
});
