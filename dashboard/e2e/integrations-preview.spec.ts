import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:4173' });

test('local Integrations mock filters and updates its fixture without provider writes', async ({ page }) => {
  const apiRequests: { method: string; path: string }[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    apiRequests.push({ method: request.method(), path: new URL(request.url()).pathname });
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"preview fixture expected"}' });
  });
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#integrations');

  await expect(page.getByRole('heading', { name: 'Good morning, Alex' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Settings & Integrations' })).toBeVisible();
  await expect(page.getByText('All Systems Operational')).toBeVisible();
  const desktopFit = await page.evaluate(() => ({
    documentHeight: document.documentElement.scrollHeight,
    actionsBottom: document.querySelector('.system-preview-actions')!.getBoundingClientRect().bottom,
    viewportHeight: window.innerHeight,
  }));
  expect(desktopFit.documentHeight).toBeLessThanOrEqual(desktopFit.viewportHeight);
  expect(desktopFit.actionsBottom).toBeLessThanOrEqual(desktopFit.viewportHeight);
  await page.getByRole('button', { name: 'Audit log', exact: true }).click();
  const auditDialog = page.getByRole('dialog', { name: 'Activity & audit · preview' });
  await expect(auditDialog.locator('tbody tr')).toHaveCount(3);
  await page.keyboard.press('Escape');
  const auditDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Import / Export' }).click();
  expect((await auditDownload).suggestedFilename()).toBe('zenchron-preview-audit.json');
  await page.getByRole('button', { name: 'Activity & Audit' }).click();
  await expect(auditDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Integrations Overview' })).toBeVisible();
  await expect(page.locator('.system-preview-provider')).toHaveCount(10);
  await expect(page.locator('.system-preview-provider .system-preview-status')).toHaveCount(10);
  await page.getByRole('button', { name: 'Model Providers' }).click();
  await expect(page.locator('.system-preview-provider')).toHaveCount(3);
  await page.getByRole('link', { name: 'Connected Integrations' }).click();
  await expect(page.locator('.system-preview-provider')).toHaveCount(10);
  const connectedBadge = page.locator('.system-preview-provider .system-preview-status').first();
  const statusDot = connectedBadge.locator('.system-preview-status-dot');
  const dotAlignment = await connectedBadge.evaluate((badge) => {
    const badgeRect = badge.getBoundingClientRect();
    const dotRect = badge.querySelector('.system-preview-status-dot')!.getBoundingClientRect();
    return Math.abs((badgeRect.top + badgeRect.bottom) / 2 - (dotRect.top + dotRect.bottom) / 2);
  });
  await expect(statusDot).toBeVisible();
  expect(dotAlignment, 'status dot is vertically centered in its badge').toBeLessThanOrEqual(1);
  await expect(page.locator('.system-integration-filters button:not(.system-preview-category-more)')).toHaveCount(6);
  await expect(page.locator('.system-preview-settings-grid > .system-preview-card')).toHaveCount(8);
  await expect(page.locator('.system-preview-settings-badge')).toHaveCount(7);
  await expect(page.locator('.system-preview-provider-link-row button[aria-label$="options"]')).toHaveCount(10);
  await expect(page.locator('.system-preview-provider-link-row button[aria-label*="preview key"]')).toHaveCount(3);
  const githubLink = page.locator('.system-preview-provider').filter({ hasText: 'GitHub' }).locator('.system-preview-provider-link');
  await expect(githubLink).toContainText('org/zenchron-engineering');
  expect(await githubLink.evaluate((link) => link.scrollWidth <= link.clientWidth), 'GitHub account link is not clipped').toBe(true);
  await page.setViewportSize({ width: 682, height: 844 });
  expect(await githubLink.evaluate((link) => link.scrollWidth <= link.clientWidth), 'GitHub account link stays visible at the reported width').toBe(true);
  expect(await page.locator('.system-health').evaluate((badge) => badge.scrollWidth <= badge.clientWidth),
    'the system health badge stays fully visible at the reported width').toBe(true);
  expect(await page.locator('.system-preview-provider-control').evaluateAll((controls) => controls.every((control) => {
    const badge = control.querySelector('.system-preview-status')!.getBoundingClientRect();
    const toggle = control.querySelector('.system-preview-switch')!.getBoundingClientRect();
    const card = control.closest('.system-preview-provider')!.getBoundingClientRect();
    return badge.right <= toggle.left && toggle.right <= card.right - 4;
  })), 'Connected badges and toggles stay inside every provider card').toBe(true);
  await expect(page.locator('.system-preview-provider-control').first()).toBeVisible();
  await page.setViewportSize({ width: 1672, height: 941 });
  const categories = page.locator('.system-integration-filters');
  await categories.getByRole('button', { name: /Models/ }).click();
  await expect(page.locator('.system-preview-provider')).toHaveCount(3);
  await categories.getByRole('button', { name: /All/ }).click();
  const githubSwitch = page.getByRole('switch', { name: 'GitHub connected' });
  const githubProvider = page.locator('.system-preview-provider').filter({ hasText: 'GitHub' });
  await githubProvider.getByRole('button', { name: 'GitHub options' }).click();
  await page.getByRole('menuitem', { name: 'Disconnect in preview' }).click();
  await expect(githubSwitch).not.toBeChecked();
  await expect(githubProvider.getByText('Disconnected')).toBeVisible();
  await githubProvider.locator('.system-preview-switch label').click();
  await expect(githubSwitch).toBeChecked();
  const revealKey = page.getByRole('button', { name: 'Reveal OpenAI preview key' });
  await revealKey.click();
  await expect(page.locator('.system-preview-provider').filter({ hasText: 'OpenAI' })).toContainText('Preview key · OpenAI');
  await page.locator('.system-preview-add-integration').click();
  const addDialog = page.getByRole('dialog', { name: 'Add integration · preview only' });
  await addDialog.getByRole('textbox', { name: 'Integration name' }).fill('Preview Connector');
  await addDialog.getByRole('button', { name: 'Add to preview' }).click();
  await expect(page.locator('.system-preview-provider')).toHaveCount(11);
  await page.getByRole('button', { name: 'More integration categories' }).click();
  await page.getByRole('menuitem', { name: 'Other' }).click();
  await expect(page.locator('.system-preview-provider')).toHaveCount(1);
  await expect(page.locator('.system-preview-provider')).toContainText('Preview Connector');
  await categories.getByRole('button', { name: /All/ }).click();
  await expect(page.locator('.system-preview-audit-range')).toHaveText('Last 24 hours');
  await expect(page.locator('.system-preview-audit-range')).toHaveAttribute('title', /fixed sample time range/);
  await expect(page.getByRole('button', { name: 'Last 24 hours' })).toHaveCount(0);
  await expect(page.locator('.system-preview-add-integration')).toHaveCSS('border-top-style', 'dashed');
  await expect(page.locator('.system-preview-policy')).toContainText('Human Approval (Prod)');
  await expect(page.locator('.system-preview-secrets')).toContainText('OPENAI_API_KEY');
  await expect(page.locator('.system-preview-audit tbody tr')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Test Connections' })).toBeEnabled();
  const organizationName = page.getByRole('textbox', { name: 'Organization Name' });
  await expect(organizationName).toHaveValue('Zenchron Engineering');
  await organizationName.fill('Preview Engineering');
  const maxRuns = page.locator('#preview-max-runs');
  await maxRuns.focus();
  await maxRuns.press('ArrowRight');
  await expect(maxRuns).toHaveValue('13');
  const runTimeout = page.getByRole('combobox', { name: 'Default Run Timeout' });
  await runTimeout.click();
  await page.getByRole('option', { name: '4 hours' }).click();
  await expect(runTimeout).toHaveValue('4 hours');
  await page.getByRole('button', { name: 'Add Policy' }).click();
  await expect(page.locator('.system-preview-policy')).toContainText('Signed commits required');
  await page.getByRole('button', { name: 'Remove Signed commits required' }).click();
  await page.getByRole('button', { name: 'Add Secret' }).click();
  const secretDialog = page.getByRole('dialog', { name: 'Add secret · preview only' });
  await secretDialog.getByRole('textbox', { name: 'Secret name' }).fill('preview_token');
  await secretDialog.getByRole('button', { name: 'Add secret to preview' }).click();
  await expect(page.locator('.system-preview-secrets tbody tr')).toHaveCount(4);
  await page.getByRole('button', { name: 'Add Rule' }).click();
  await expect(page.locator('.system-preview-notifications tbody tr')).toHaveCount(4);
  await page.getByRole('button', { name: 'Test Connections' }).click();
  await expect(page.getByRole('dialog', { name: 'Connection test · preview only' })).toContainText('All 11 sample integrations responded');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByRole('status')).toContainText('Changes saved in this preview only');
  await organizationName.fill('Discard Me');
  await page.getByRole('button', { name: 'Discard Changes' }).click();
  await expect(organizationName).toHaveValue('Preview Engineering');
  const defaultProduct = page.getByRole('combobox', { name: 'Default Product' });
  await defaultProduct.click();
  await page.getByRole('option', { name: 'Orion Analytics' }).click();
  await expect(defaultProduct).toHaveValue('Orion Analytics');
  await page.getByRole('button', { name: 'Discard Changes' }).click();
  await expect(defaultProduct).toHaveValue('Core Product');
  await page.getByRole('button', { name: 'Add Secret' }).click();
  const secretDialogAgain = page.getByRole('dialog', { name: 'Add secret · preview only' });
  await secretDialogAgain.getByRole('textbox', { name: 'Secret name' }).fill('preview_token_2');
  await secretDialogAgain.getByRole('button', { name: 'Add secret to preview' }).click();
  await expect(page.locator('.system-preview-secrets tbody tr')).toHaveCount(5);
  await page.getByRole('button', { name: 'PREVIEW_TOKEN_2 secret options' }).click();
  await page.getByRole('menuitem', { name: 'Rotate preview secret' }).click();
  await expect(page.locator('.system-preview-secrets tbody tr').last()).toContainText('Just now');
  await page.getByRole('button', { name: 'PREVIEW_TOKEN_2 secret options' }).click();
  await page.getByRole('menuitem', { name: 'Remove from preview' }).click();
  await expect(page.locator('.system-preview-secrets tbody tr')).toHaveCount(4);
  await page.getByRole('button', { name: 'Add Rule' }).click();
  const newRule = page.locator('.system-preview-notifications tbody tr').last();
  const newRuleSwitch = page.getByRole('switch', { name: 'Preview notification 5' });
  await newRule.locator('.system-preview-switch label').click();
  await expect(newRuleSwitch).not.toBeChecked();
  await newRule.getByRole('button', { name: 'Preview notification 5 options' }).click();
  await page.getByRole('menuitem', { name: 'Remove rule' }).click();
  await expect(page.locator('.system-preview-notifications tbody tr')).toHaveCount(4);
  await runTimeout.click();
  await page.getByRole('option', { name: '1 hour' }).click();
  await page.getByRole('button', { name: 'Discard Changes' }).click();
  await expect(runTimeout).toHaveValue('4 hours');
  await expect(maxRuns).toHaveValue('13');
  await expect(page.locator('.system-preview-secrets tbody tr')).toHaveCount(4);
  await expect(page.locator('.system-preview-notifications tbody tr')).toHaveCount(4);
  expect(await page.locator('.system-preview-card').evaluateAll((cards) => cards.every((card) => card.scrollHeight <= card.clientHeight + 1)),
    'settings cards keep sample content visible after preview edits are discarded').toBe(true);

  const columns = await page.locator('.system-preview-service-grid').evaluate((grid) =>
    getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length);
  const settingsColumns = await page.locator('.system-preview-settings-grid').evaluate((grid) =>
    getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length);
  expect(columns).toBe(4);
  expect(settingsColumns).toBe(3);
  expect(apiRequests.filter(({ path }) => path !== '/api/v1/auth/session')).toEqual([]);
  expect(apiRequests.filter(({ method }) => method !== 'GET')).toEqual([]);
});

test('local Integrations preview keeps tabs on one line and audit table scrolls on phone', async ({ page }) => {
  await page.route('**/api/v1/**', async (route) => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"preview fixture expected"}' });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#integrations');

  await expect(page.getByRole('heading', { name: 'Integrations Overview' })).toBeVisible();
  await expect(page.locator('.system-tabs button')).toHaveCSS('white-space', 'nowrap');
  const mobileGrid = await page.locator('.system-preview-service-grid').evaluate((grid) => ({
    columns: getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length,
    grid: (() => { const { x, width } = grid.getBoundingClientRect(); return { x, width }; })(),
    firstCard: (() => { const { x, width } = grid.firstElementChild!.getBoundingClientRect(); return { x, width }; })(),
  }));
  expect(mobileGrid.columns, 'mobile providers use one full-width column').toBe(1);
  expect(mobileGrid.firstCard.x).toBeGreaterThanOrEqual(mobileGrid.grid.x);
  expect(mobileGrid.firstCard.x + mobileGrid.firstCard.width).toBeLessThanOrEqual(mobileGrid.grid.x + mobileGrid.grid.width);
  const auditScroller = page.locator('.system-preview-audit .system-preview-table-scroll');
  await expect(auditScroller).toBeVisible();
  expect(await auditScroller.evaluate((element) => element.scrollWidth > element.clientWidth),
    'audit table scrolls inside its card at phone width').toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'phone layout has no page-level horizontal overflow').toBe(true);
});

test('local Settings section shares the preview cards and marks its navigation active', async ({ page }) => {
  await page.route('**/api/v1/**', async (route) => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"preview fixture expected"}' });
  });
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#settings');

  await expect(page.locator('.system-tabs a.active')).toHaveText(/Settings/);
  await expect(page.locator('.system-config-nav a[aria-current="page"]')).toHaveText('Organization Profile');
  await expect(page.locator('.system-preview-settings-grid > .system-preview-card')).toHaveCount(8);
  await expect(page.locator('.system-preview-service-grid')).toHaveCount(0);
  const autoScale = page.getByRole('switch', { name: 'Auto-scale Runners' });
  await expect(autoScale).toBeChecked();
  await page.locator('.system-preview-controller .system-preview-switch').first().locator('label').click();
  await expect(autoScale).not.toBeChecked();
  await page.getByRole('button', { name: 'Policies' }).click();
  await expect(page.locator('#system-preview-policy')).toBeInViewport();
  await page.getByRole('button', { name: 'Model Providers' }).click();
  await expect(page).toHaveURL(/#integrations$/);
  await expect(page.locator('.system-preview-provider')).toHaveCount(3);
});
