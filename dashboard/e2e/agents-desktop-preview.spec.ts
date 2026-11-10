import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:4173' });

test('Agents desktop preview can edit and save prompt cards in the local fixture', async ({ page }) => {
  const agentRequests: string[] = [];
  for (const endpoint of ['agents', 'agent-runs']) await page.route(`**/api/v1/${endpoint}`, (route) => {
    agentRequests.push(endpoint);
    return route.fulfill({ status: 401, body: 'authentication required' });
  });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 401, body: 'authentication required' }));
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#agents');

  const promptCards = page.locator('.agents-overview-previews .agents-overview-card');
  await expect(promptCards).toHaveCount(2);
  await promptCards.first().getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('tab', { name: 'Prompts' })).toHaveAttribute('aria-selected', 'true');
  const editor = page.locator('.agent-prompt-editor').first();
  await expect(editor.locator('.monaco-editor')).toBeVisible();
  await editor.locator('.monaco-editor').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('Review the change and cite concrete evidence.');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.locator('.agents-prompt-preview').first())
    .toHaveText('Review the change and cite concrete evidence.');
  await expect(page.locator('.agents-preview-feedback')).toContainText('saved in this preview only');
  expect(agentRequests).toEqual([]);
});
