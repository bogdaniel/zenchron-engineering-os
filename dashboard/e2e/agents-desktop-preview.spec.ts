import { expect, test } from '@playwright/test';

const dashboardPort = Number((globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env?.ZENCHRON_E2E_DASHBOARD_PORT) || 4173;
test.use({ baseURL: `http://127.0.0.1:${dashboardPort}` });

test('Agents desktop preview can edit and save prompt cards in the local fixture', async ({ page }) => {
  const agentRequests: string[] = [];
  for (const endpoint of ['agents', 'agent-runs']) await page.route(`**/api/v1/${endpoint}`, (route) => {
    agentRequests.push(endpoint);
    return route.fulfill({ status: 401, body: 'authentication required' });
  });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 401, body: 'authentication required' }));
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#agents');
  await expect(page.locator('.agents-title-heading .page-heading > p'))
    .toHaveText('Manage AI agents, profiles, prompts, tools, and governance. Define specialized agents for your engineering workflows.');
  const researchStatus = page.locator('.agent-row').filter({ hasText: 'Research Analyst' }).locator('.agent-status');
  await expect(researchStatus).toHaveText('idle');
  await expect(researchStatus).toHaveClass(/\bidle\b/);
  await expect(researchStatus).toHaveCSS('color', 'rgb(154, 184, 237)');
  const selectedProfile = page.locator('.agent-row').first();
  const profileProvider = selectedProfile.locator('.agent-preview-provider');
  await expect(profileProvider).toHaveText('Claude 3.7 Sonnet · Anthropic');
  await expect(profileProvider).toHaveCSS('font-size', '10px');
  const profileMeta = selectedProfile.locator('.agent-preview-meta');
  await expect(profileMeta).toContainText('Last run: 2m ago');
  await expect(profileMeta).toContainText('Cost: $0.42');
  await expect(profileMeta).toContainText('Success: 98.4%');
  await expect(profileMeta.locator('svg')).toHaveCount(3);
  await expect(profileMeta).toHaveCSS('display', 'flex');
  expect(await profileMeta.locator('small').evaluateAll((items) => items.every((item) => getComputedStyle(item).fontSize === '9px'))).toBe(true);
  expect(await profileMeta.evaluate((meta) => meta.scrollWidth <= meta.clientWidth),
    'run, cost, and success details stay on one readable line').toBe(true);
  expect(await profileMeta.locator('small').evaluateAll((items) =>
    items.every((item) => item.scrollWidth <= item.clientWidth)), 'no metadata segment is clipped').toBe(true);
  expect((await selectedProfile.boundingBox())?.height).toBeGreaterThanOrEqual(100);
  await expect(selectedProfile.locator('.agent-status')).toHaveCSS('position', 'absolute');
  const detailActions = page.locator('.agents-detail-actions');
  for (const name of ['Run Agent', 'Duplicate Profile', 'Disable', 'Compare Versions']) {
    const action = detailActions.getByRole('button', { name, exact: true });
    await expect(action).toHaveCSS('height', '30px');
    await expect(action).toHaveCSS('font-size', '10px');
    await expect(action.locator('svg')).toBeVisible();
  }
  await expect(detailActions.getByRole('button', { name: 'Duplicate Profile' }).locator('.tabler-icon-copy')).toBeVisible();
  await expect(detailActions.getByRole('button', { name: 'Disable' }).locator('.tabler-icon-ban')).toBeVisible();
  await expect(detailActions.getByRole('button', { name: 'Compare Versions' }).locator('.tabler-icon-git-compare')).toBeVisible();
  const detailTabs = page.getByRole('tablist', { name: 'Agent profile sections' });
  await expect(detailTabs).toHaveCSS('border-radius', '9px');
  await expect(detailTabs).toHaveCSS('background-color', 'rgb(21, 20, 31)');
  await expect(detailTabs.getByRole('tab', { name: 'Overview' })).toHaveCSS('background-image', /linear-gradient/);

  const lowerPanelBottoms = await page.locator('.agents-preview-bottom > .agents-overview-card').evaluateAll((panels) =>
    panels.map((panel) => panel.getBoundingClientRect().bottom));
  const contentGridBottom = await page.locator('.agents-content-grid').evaluate((grid) => grid.getBoundingClientRect().bottom);
  expect(lowerPanelBottoms.every((bottom) => bottom <= contentGridBottom - 4),
    `run history and performance trends fit inside the detail panel: ${lowerPanelBottoms.join(', ')} > ${contentGridBottom}`).toBe(true);

  const promptCards = page.locator('.agents-overview-previews .agents-overview-card');
  await expect(promptCards).toHaveCount(2);
  const systemPrompt = promptCards.nth(0).locator('.agents-prompt-preview');
  const goalPrompt = promptCards.nth(1).locator('.agents-prompt-preview');
  await expect(systemPrompt.locator('.agents-prompt-line')).toHaveCount(6);
  await expect(goalPrompt.locator('.agents-prompt-line')).toHaveCount(0);
  await expect(goalPrompt).toHaveCSS('font-family', /sans-serif/);
  await expect(goalPrompt).toHaveCSS('background-color', 'rgb(16, 16, 26)');
  await expect(goalPrompt).toContainText('Review the provided code changes, identify issues,');
  await expect(goalPrompt).toContainText('with recommended actions and code suggestions.');
  await expect(systemPrompt.locator('.agents-prompt-line > i')).toHaveText(['1', '2', '3', '4', '5', '6']);
  expect((await systemPrompt.boundingBox())?.height).toBe(82);
  await expect(systemPrompt.locator('.agents-prompt-line > code').first()).toHaveCSS('font-size', '10px');
  await expect(systemPrompt.locator('.agents-prompt-line').first()).toHaveCSS('line-height', '12px');
  expect(await systemPrompt.locator('.agents-prompt-line').evaluateAll((rows) =>
    rows.every((row) => row.scrollWidth <= row.clientWidth))).toBe(true);
  const editPrompt = promptCards.first().getByRole('button', { name: 'Edit' });
  await expect(editPrompt.locator('svg')).toHaveClass(/tabler-icon-pencil/);
  await expect(editPrompt).toHaveCSS('border-color', 'rgb(56, 52, 76)');
  const promptMenu = promptCards.first().getByRole('button', { name: 'System Prompt options' });
  await expect(promptMenu).toHaveCSS('border-color', 'rgb(56, 52, 76)');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await promptMenu.click();
  await page.getByRole('menuitem', { name: 'Copy prompt' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('You are the Zenchron Code Reviewer.');
  await promptCards.first().getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('tab', { name: 'Prompts' })).toHaveAttribute('aria-selected', 'true');
  const editor = page.locator('.agent-prompt-editor').first();
  await expect(editor.locator('.monaco-editor')).toBeVisible();
  await editor.locator('.monaco-editor').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('Review the change and cite concrete evidence.');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.locator('.agents-prompt-preview').first().locator('.agents-prompt-line > code'))
    .toHaveText('Review the change and cite concrete evidence.');
  await expect(page.locator('.agents-preview-feedback')).toContainText('saved in this preview only');
  expect(agentRequests).toEqual([]);
});

test('Agents overview panel actions open their local detail controls', async ({ page }) => {
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 401, body: 'authentication required' }));
  await page.route('**/api/v1/agents', (route) => route.fulfill({ status: 401, body: 'authentication required' }));
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill({ status: 401, body: 'authentication required' }));
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#agents');

  await page.getByRole('button', { name: 'Manage →', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Variables & Templates' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.locator('.agents-preview-overview-grid .agents-overview-card').filter({ hasText: 'Tool Permissions' })
    .getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('tab', { name: 'Tools & Permissions' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Save profile' })).toBeVisible();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.locator('.agents-preview-overview-grid .agents-overview-card').filter({ hasText: 'Safety & Governance' })
    .getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('tab', { name: 'Safety & Governance' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('checkbox', { name: 'Allow Code Changes' }).check();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.locator('.agents-preview-safety')).toContainText('Allowed');
  await page.getByRole('button', { name: 'View Details' }).click();
  await expect(page.getByRole('tab', { name: 'Run History' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Performance trend range' }).click();
  await page.getByRole('menuitem', { name: 'Last 7 Days' }).click();
  await expect(page.locator('[aria-label="Mock agent success, cost, and latency trends · Last 7 Days"]')).toBeVisible();
});
