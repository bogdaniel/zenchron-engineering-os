import { expect, test } from '@playwright/test';

test('Agents populated desktop layout matches the reference panel geometry', async ({ page }) => {
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: true, login: 'E2E' }),
  }));
  await page.setViewportSize({ width: 1672, height: 941 });
  const profileID = 'ab'.repeat(16);
  const projectID = 'ef'.repeat(16);
  const workerID = 'cd'.repeat(16);
  const updatedAt = new Date().toISOString();
  const profile = (id: string, name: string, description: string, model: string, tools: string[], status = 'active') => ({
    id, name, description, provider: 'anthropic', model, status,
    system_prompt: `System prompt for ${name}.`, goal_prompt: `Goal prompt for ${name}.`,
    tools, version: 3, updated_at: updatedAt,
  });
  await page.route('**/api/v1/agents', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([
      { ...profile(profileID, 'Code Reviewer', 'Review code for quality and safety.', 'claude-3.7-sonnet',
        ['code.search', 'code.write', 'git.diff', 'git.read']),
      system_prompt: 'Review code changes.', goal_prompt: 'Return actionable findings.' },
      profile('02'.repeat(16), 'Test Generator', 'Generate comprehensive tests.', 'gpt-4o', ['code.search', 'tests.run']),
      profile('03'.repeat(16), 'Planner', 'Break objectives into executable plans.', 'claude-3.5-haiku', ['docs.search']),
      profile('04'.repeat(16), 'Release Manager', 'Coordinate releases and rollout plans.', 'claude-3.5-haiku', ['git.read']),
      profile('05'.repeat(16), 'Research Analyst', 'Research and summarize technical information.', 'gemini-1.5-pro',
        ['docs.search'], 'disabled'),
      profile('06'.repeat(16), 'Coverage Analyzer', 'Identify test coverage gaps.', 'gpt-4o', ['git.diff', 'tests.run']),
    ]),
  }));
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([{
      id: '01'.repeat(16), agent_id: profileID, agent_name: 'Code Reviewer', project_id: projectID,
      project_name: 'Nova Platform', worker_id: workerID, worker_name: 'Mac', branch: 'zenchron/agent-run/0101',
      prompt: 'Review auth changes', status: 'succeeded', attempts: 1,
      created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      updated_at: new Date(Date.now() - 5 * 60_000).toISOString(), diff_available: true,
    }]),
  }));
  await page.goto('/#agents');
  await expect(page.getByRole('heading', { name: 'Code Reviewer' })).toBeVisible();
  await expect(page.locator('.agent-row')).toHaveCount(6);
  await expect(page.locator('.agent-row').nth(4)).toContainText('disabled');
  await expect(page.locator('.agents-metric').nth(0).locator('strong')).toHaveText('6');
  await expect(page.locator('.agents-metric').nth(1).locator('strong')).toHaveText('5');
  await expect(page.locator('.agents-metric').filter({ hasText: 'Total Cost (30d)' }))
    .toContainText('Provider usage records are unavailable');
  const firstMetric = page.locator('.agents-metric').first();
  const [metricIcon, metricLabel] = await Promise.all([
    firstMetric.locator('.metric-top > svg').boundingBox(),
    firstMetric.locator('.metric-top > span').boundingBox(),
  ]);
  expect(metricIcon && metricLabel).toBeTruthy();
  expect(metricIcon!.x + metricIcon!.width).toBeLessThan(metricLabel!.x);
  for (const metric of await page.locator('.agents-metric').all()) {
    const icon = await metric.locator('.metric-top > svg').boundingBox();
    const value = await metric.locator('strong').boundingBox();
    expect(icon && value).toBeTruthy();
    expect(icon!.y + icon!.height).toBeLessThanOrEqual(value!.y);
  }
  const profileRow = page.locator('.agent-row').filter({ hasText: 'Code Reviewer' });
  await expect(profileRow).toContainText('Last run 5m ago');
  await expect(profileRow).toContainText('1 completed · 100% success');
  await expect(profileRow).toContainText('code.search');
  await expect(profileRow).toContainText('+1');
  await expect(profileRow.locator('.agent-row-body small').first()).toHaveCSS('font-size', '10px');
  await expect(profileRow.locator('.agent-tool-badge').first()).toHaveCSS('font-size', '9px');
  const performance = page.locator('.agents-profile-metrics');
  await expect(performance).toContainText('Runs');
  await expect(performance).toContainText('Avg latency');
  await expect(performance).toContainText('Unavailable');
  const trend = page.locator('.agents-trend-panel');
  await expect(trend).toContainText('1 succeeded · 0 failed · 0 other');
  await expect(trend.locator('.agents-trend-chart')).toHaveAttribute('aria-label', /1 successful/);
  await expect(page.locator('.agents-prompt-preview').nth(0)).toContainText('Review code changes.');
  await expect(page.locator('.agents-prompt-preview').nth(1)).toContainText('Return actionable findings.');
  const permissionRows = page.locator('.agents-permission-row');
  await expect(permissionRows).toHaveCount(5);
  await expect(permissionRows.filter({ hasText: 'Code search' })).toContainText('Allowed');
  await expect(permissionRows.filter({ hasText: 'Write files' })).toContainText('Allowed');
  await expect(permissionRows.filter({ hasText: 'Documentation search' })).toContainText('Not granted');
  await expect(page.locator('.agents-safeguard-list')).toContainText('Isolated Git worktree');
  await expect(page.locator('.agents-safeguard-list')).toContainText('Test execution');
  await expect(page.getByRole('button', { name: 'Edit profile' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save profile' })).toHaveCount(0);
  await expect(page.locator('.agents-profile-summary')).toContainText('claude-3.7-sonnet');
  const list = await page.locator('.agents-list-panel').boundingBox();
  const detail = await page.locator('.agents-detail-panel').boundingBox();
  const runs = await page.locator('.agents-runs-panel').boundingBox();
  const sidebar = await page.locator('.sidebar').boundingBox();
  const metrics = await page.locator('.agents-metrics').boundingBox();
  const noteCount = await page.locator('.agents-runtime-note').count();
  expect(list && detail && runs && sidebar && metrics).toBeTruthy();
  expect(sidebar!.width).toBe(247);
  expect(metrics!.x).toBe(263);
  expect(Math.abs(metrics!.y - 136.5)).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics!.height - 65)).toBeLessThanOrEqual(1);
  expect(Math.abs(list!.y - 213.5)).toBeLessThanOrEqual(1);
  expect(Math.abs(list!.width - 425.5)).toBeLessThanOrEqual(1);
  expect(noteCount).toBe(0);
  expect(list!.height).toBeGreaterThan(detail!.height);
  expect(runs!.x).toBeCloseTo(detail!.x, 0);
  expect(runs!.y).toBeGreaterThan(detail!.y);
  expect(runs!.y + runs!.height).toBeLessThanOrEqual((list!.y + list!.height) + 1);
  await expect(page.locator('.agents-panel-heading h3').first()).toHaveCSS('font-size', '16px');

  await page.setViewportSize({ width: 1672, height: 749 });
  const compact = await page.evaluate(() => Object.fromEntries(
    ['.agents-content-grid', '.agents-list-panel', '.agents-detail-panel', '.agents-runs-panel']
      .map((selector) => {
        const { x, y, width, height, bottom } = document.querySelector(selector)!.getBoundingClientRect();
        return [selector, { x, y, width, height, bottom }];
      }),
  ));
  const compactList = compact['.agents-list-panel'];
  const compactDetail = compact['.agents-detail-panel'];
  const compactRuns = compact['.agents-runs-panel'];
  expect(compactList.height).toBeGreaterThan(compactDetail.height);
  expect(compactRuns.x).toBeCloseTo(compactDetail.x, 0);
  expect(compactRuns.bottom).toBeLessThanOrEqual(compactList.bottom + 1);
  expect(compact['.agents-content-grid'].bottom).toBeLessThanOrEqual(749);
});

test('Agents layout fits tablet and phone widths without panel overlap', async ({ page }) => {
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: true, login: 'E2E' }),
  }));
  for (const [width, height, expectedColumns] of [[1024, 768, 2], [390, 844, 1]]) {
    await page.setViewportSize({ width, height });
    await page.goto('/#agents');
    await expect(page.locator('.agents-page')).toBeVisible();
    const layout = await page.evaluate(() => {
      const grid = document.querySelector('.agents-content-grid')!;
      const panels = ['.agents-list-panel', '.agents-detail-panel', '.agents-runs-panel']
        .map((selector) => document.querySelector(selector)!.getBoundingClientRect())
        .map(({ x, y, width, height }) => ({ x, y, width, height }));
      const overlaps = panels.some((first, index) => panels.slice(index + 1).some((second) =>
        first.x < second.x + second.width && second.x < first.x + first.width
        && first.y < second.y + second.height && second.y < first.y + first.height));
      return {
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        columns: getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length,
        panels,
        overlaps,
      };
    });
    expect(layout.document).toBe(layout.viewport);
    expect(layout.columns).toBe(expectedColumns);
    expect(layout.panels.every(({ width, height }) => width > 0 && height > 0)).toBe(true);
    expect(layout.overlaps).toBe(false);
  }
});

test('Agents local design preview labels illustrative metadata without API reads', async ({ page }) => {
  const requests: string[] = [];
  for (const endpoint of ['agents', 'agent-runs']) {
    await page.route(`**/api/v1/${endpoint}`, (route) => {
      requests.push(endpoint);
      return route.fulfill({ status: 401, body: 'authentication required' });
    });
  }
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 401, body: 'authentication required',
  }));
  await page.setViewportSize({ width: 1672, height: 941 });
  const previewURL = new URL('/#agents', test.info().project.use.baseURL as string);
  previewURL.hostname = '127.0.0.1';
  await page.goto(previewURL.toString());
  await expect(page.locator('.agents-design-preview')).toBeVisible();
  await expect(page.locator('.agents-mobile-preview')).toBeHidden();
  await expect(page.locator('.agents-mobile-return')).toBeHidden();
  await expect(page.locator('.agents-preview-notice')).toHaveText('ILLUSTRATIVE DATA');
  await expect(page.getByRole('heading', { name: 'Agent Profiles (6)' })).toBeVisible();
  await expect(page.locator('.agents-list-panel .agents-count')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Search agents' })).toHaveCSS('width', '160px');
  expect(await page.locator('.agent-row-body small').evaluateAll((details) =>
    details.every((detail) => detail.scrollWidth <= detail.clientWidth)),
  'desktop preview profile metadata is not ellipsized').toBe(true);
  const visibleProfileRows = await page.locator('.agents-list').evaluate((list) => {
    const rows = [...list.querySelectorAll('.agent-row')].map((row) => row.getBoundingClientRect());
    const bottom = list.getBoundingClientRect().bottom;
    return rows.slice(0, 5).every((row) => row.bottom <= bottom) && rows[5]!.top >= bottom
      && list.scrollHeight > list.clientHeight;
  });
  expect(visibleProfileRows, 'the desktop mock shows five complete profiles and scrolls to the sixth').toBe(true);
  const sixthProfile = page.locator('.agent-row').nth(5);
  await sixthProfile.scrollIntoViewIfNeeded();
  await expect(sixthProfile).toBeInViewport();
  const summary = page.locator('.agents-profile-summary');
  await expect(summary).toContainText('Model');
  await expect(summary).toContainText('Provider');
  await expect(summary).toContainText('Status');
  await expect(summary).toContainText('Owner');
  await expect(summary).toContainText('Created');
  await expect(summary).toContainText('Last Updated');
  const previewPerformance = page.locator('.agents-profile-metrics');
  await expect(previewPerformance).toContainText('+21%');
  await expect(previewPerformance).toContainText('+1.6pp');
  await expect(previewPerformance).toContainText('-18%');
  await expect(previewPerformance).toContainText('-14%');
  await expect(page.getByRole('img', { name: 'Illustrative performance trend' })).toBeVisible();
  const history = page.locator('.agents-preview-run-table');
  await expect(history.locator('thead th')).toHaveText([
    'Run ID', 'Trigger', 'Input', 'Status', 'Duration', 'Cost', 'Time',
  ]);
  await expect(history.locator('tbody tr')).toHaveCount(3);
  await expect(history).toContainText('feat/auth-improvements');
  const finalPreviewRun = await history.locator('tbody tr').last().boundingBox();
  const runHistoryPanel = await history.locator(
    'xpath=ancestor::div[contains(@class,"agents-overview-card")]').boundingBox();
  expect(finalPreviewRun && runHistoryPanel).toBeTruthy();
  expect(finalPreviewRun!.y + finalPreviewRun!.height).toBeLessThanOrEqual(runHistoryPanel!.y + runHistoryPanel!.height);
  expect(requests).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.agents-mobile-preview-label')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Agents & Reviews' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('Agents local preview filters and sorts profiles without API writes', async ({ page }) => {
  const requests: string[] = [];
  for (const endpoint of ['agents', 'agent-runs']) await page.route(`**/api/v1/${endpoint}`, async (route) => {
    requests.push(route.request().method());
    await route.fulfill({ status: 401, body: 'authentication required' });
  });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 401, body: 'authentication required' }));
  await page.setViewportSize({ width: 1672, height: 941 });
  const previewURL = new URL('/#agents', test.info().project.use.baseURL as string);
  previewURL.hostname = '127.0.0.1';
  await page.goto(previewURL.toString());

  const rows = page.locator('.agent-row');
  await expect(rows).toHaveCount(6);
  await page.getByRole('button', { name: 'Filter agents' }).click();
  await page.getByRole('menuitem', { name: 'Disabled only' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Research Analyst');
  await page.getByRole('button', { name: 'Filter agents' }).click();
  await page.getByRole('menuitem', { name: 'All profiles' }).click();
  await page.getByRole('button', { name: 'Sort agents' }).click();
  await page.getByRole('menuitem', { name: 'Name Z–A' }).click();
  await expect(rows.first()).toContainText('Test Generator');
  await page.getByRole('textbox', { name: 'Search agents' }).fill('no matching agent');
  await expect(rows).toHaveCount(0);
  await expect(page.locator('.agents-detail-empty')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search agents' }).fill('planner');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Planner');
  expect(requests).toEqual([]);
});

test('Agents preview actions update only the local fixture', async ({ page }) => {
  const requests: string[] = [];
  for (const endpoint of ['agents', 'agent-runs']) await page.route(`**/api/v1/${endpoint}`, (route) => {
    requests.push(endpoint); return route.fulfill({ status: 401, body: 'authentication required' });
  });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 401, body: 'authentication required' }));
  await page.setViewportSize({ width: 1672, height: 941 });
  const previewURL = new URL('/#agents', test.info().project.use.baseURL as string);
  previewURL.hostname = '127.0.0.1';
  await page.goto(previewURL.toString());

  await expect(page.locator('.agent-row')).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'Code Reviewer options' })).toBeVisible();
  await page.getByRole('button', { name: 'Test Generator options' }).click();
  await page.getByRole('menuitem', { name: 'Open profile' }).click();
  await expect(page.getByRole('heading', { name: 'Test Generator' })).toBeVisible();
  await page.getByRole('button', { name: 'Create Agent' }).click();
  const create = page.getByRole('dialog', { name: 'Create agent profile' });
  await create.getByLabel('Profile name').fill('Preview Writer');
  await create.getByLabel('Provider identifier').fill('local-preview');
  await create.getByLabel('Model identifier').fill('writer-v1');
  await create.getByRole('button', { name: 'Create profile' }).click();
  await expect(page.locator('.agent-row')).toHaveCount(7);
  await expect(page.getByRole('heading', { name: 'Preview Writer' })).toBeVisible();

  await page.getByRole('button', { name: 'Agent Library' }).click();
  await page.getByRole('dialog', { name: 'Agent Library' }).getByRole('button', { name: /Code Reviewer/ }).click();
  await page.getByRole('button', { name: 'Run Agent' }).click();
  await expect(page.getByRole('tab', { name: 'Run History' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.agents-runs-list')).toContainText('SIMULATED · local preview run');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(page.locator('.agents-detail-heading .agent-status')).toHaveText('disabled');
  await page.getByRole('button', { name: 'Enable', exact: true }).click();
  await page.getByRole('button', { name: 'Duplicate Profile' }).click();
  await expect(page.locator('.agent-row')).toHaveCount(8);
  await expect(page.getByRole('heading', { name: 'Code Reviewer Copy' })).toBeVisible();
  await page.getByRole('button', { name: 'Compare Versions' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Profile versions');
  await page.locator('.agent-row').first().click();
  await page.getByRole('button', { name: 'More agent actions' }).click();
  await page.getByRole('menuitem', { name: 'Open run history' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('SIMULATED · local preview run');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Import / Export' }).click();
  await page.getByRole('menuitem', { name: 'Export profiles as JSON' }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('agents-preview.json');
  const importedProfile = [{ id: 'imported-preview', name: 'Imported Reviewer', description: '', provider: 'preview',
    model: 'review-v1', status: 'active', system_prompt: '', goal_prompt: '', tools: [], version: 1,
    updated_at: new Date().toISOString() }];
  await page.getByRole('button', { name: 'Import / Export' }).click();
  await page.getByRole('menuitem', { name: 'Import profiles from JSON' }).click();
  await page.getByLabel('Import agent profiles JSON').evaluate((element, data) => {
    const input = element as HTMLInputElement;
    const transfer = new DataTransfer();
    transfer.items.add(new File([JSON.stringify(data)], 'agents.json', { type: 'application/json' }));
    input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  }, importedProfile);
  await expect(page.locator('.agent-row')).toHaveCount(1);
  await expect(page.locator('.agent-row').first()).toContainText('Imported Reviewer');
  await page.getByRole('button', { name: 'Imported Reviewer options' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate profile' }).click();
  await expect(page.locator('.agent-row')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Imported Reviewer Copy' })).toBeVisible();
  expect(requests).toEqual([]);
});

test('Agents empty state uses the primary create action', async ({ page }) => {
  await page.route('**/api/v1/agents', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.goto('/#agents');
  const unavailableMetrics = page.locator('.agents-metric strong.metric-unavailable');
  await expect(unavailableMetrics).toHaveCount(2);
  await expect(unavailableMetrics.first()).toHaveCSS('font-size', '14px');
  const create = page.getByRole('button', { name: 'Create first agent' });
  await expect(page.locator('.agents-trend-empty')).toContainText('No runs recorded for this profile');
  await expect(create).toHaveCSS('background-image', /linear-gradient/);
  await create.click();
  await expect(page.getByRole('dialog', { name: 'Create agent profile' })).toBeVisible();
});

test('Agents queue dialog explains when a worker has no model runtime', async ({ page }) => {
  await page.route('**/api/v1/workers', async (route) => {
    const url = new URL(route.request().url());
    url.hostname = '127.0.0.1';
    const response = await route.fetch({ url: url.toString() });
    const workers = await response.json() as { agent_runtime_enabled?: boolean }[];
    await route.fulfill({ response, body: JSON.stringify(workers.map((worker) => ({
      ...worker, agent_runtime_enabled: false,
    }))) });
  });
  await page.goto('/#agents');
  const created = await page.evaluate(async () => {
    const response = await fetch('/api/v1/agents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Runtime status check', provider: 'custom', model: 'review-v1', tools: [] }),
    });
    return response.ok;
  });
  expect(created).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Queue run' }).click();
  const dialog = page.getByRole('dialog', { name: 'Queue agent run' });
  await expect(dialog.locator('.agents-queue-note')).toContainText('has no OpenAI-compatible endpoint configured');
  await expect(dialog.getByLabel('Project')).toHaveValue(/^zenchron-engineering-os · .+ · runtime not configured$/);
});

test('agent profiles can be saved and disabled from the dashboard', async ({ page }) => {
  const name = `QA Reviewer ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('link', { name: 'Agents' }).click();
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  await page.getByRole('button', { name: 'Create Agent' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Profile name').fill(name);
  await dialog.getByLabel('Description').fill('Review a bounded change set.');
  await dialog.getByLabel('Provider identifier').fill('custom');
  await dialog.getByLabel('Model identifier').fill('review-v1');
  await dialog.getByLabel('System prompt').fill('Review safely and report evidence.');
  await dialog.getByLabel('Goal prompt').fill('Find defects in the change.');
  await dialog.getByLabel('Read repository files').check();
  await dialog.getByLabel('Write files in isolated branch').check();
  await dialog.getByRole('button', { name: 'Create profile' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.locator('.agents-detail-heading h3')).toHaveCSS('font-size', '18px');
  await expect(page.locator('.agents-detail-heading h3')).toHaveCSS('font-weight', '650');
  const profileSearch = page.getByRole('textbox', { name: 'Search agents' });
  await profileSearch.fill(name);
  await expect(page.locator('.agent-row').filter({ hasText: name }).getByText('custom · review-v1')).toBeVisible();
  await profileSearch.fill('no matching profile');
  await expect(page.getByText('No profiles match this search.')).toBeVisible();
  await profileSearch.fill('');
  await page.getByRole('button', { name: 'Queue run' }).click();
  const runDialog = page.getByRole('dialog', { name: 'Queue agent run' });
  await expect(runDialog.locator('.agents-queue-note')).toContainText('reports an OpenAI-compatible endpoint configured');
  await runDialog.getByLabel('Project').click();
  await page.getByRole('option', { name: 'zenchron-engineering-os' }).click();
  await expect(runDialog.getByLabel('Project')).toHaveValue(/^zenchron-engineering-os · .+ · runtime configured$/);
  await runDialog.getByLabel('Task prompt').fill('Review the current changes.');
  await runDialog.getByRole('button', { name: 'Queue run', exact: true }).click();
  await expect(runDialog).toBeHidden();
  const detail = page.locator('.agents-detail-panel');
  await detail.getByRole('tab', { name: 'Run History' }).click();
  const queuedRun = detail.locator('.agents-run-row').filter({ hasText: 'Review the current changes.' });
  await expect(queuedRun).toContainText('succeeded', { timeout: 15_000 });
  await expect(queuedRun).toContainText(/Branch: zenchron\/agent-run\/[a-f0-9]{32}/);
  await detail.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByRole('button', { name: 'Save profile' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit profile' }).click();
  await detail.getByLabel('Model', { exact: true }).fill('review-v2');
  await detail.getByRole('tab', { name: 'Prompts' }).click();
  const systemPrompt = detail.locator('.agent-prompt-editor').first();
  await expect(systemPrompt.locator('.monaco-editor')).toBeVisible();
  await systemPrompt.locator('.monaco-editor').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('Review safely and cite changed files.');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByRole('button', { name: 'Edit profile' })).toBeVisible();
  await expect(page.locator('.agent-row').filter({ hasText: name }).getByText('custom · review-v2')).toBeVisible();
  await page.getByRole('button', { name: 'Disable profile' }).click();
  await expect(page.getByText('disabled', { exact: true }).first()).toBeVisible();
});

test('Agents dashboard completes a run and resumes requested review changes on the same branch', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Agents' }).click();
  const profile = await page.evaluate(async () => {
    const profileResponse = await fetch('/api/v1/agents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'E2E Reviewer', provider: 'custom', model: 'review-v1', tools: ['code.write'] }),
    });
    if (!profileResponse.ok) throw new Error(`E2E profile setup failed: ${await profileResponse.text()}`);
    return profileResponse.json();
  });
  await page.reload();
  await page.locator('.agent-row').filter({ hasText: 'E2E Reviewer' }).click();
  await page.getByRole('button', { name: 'Queue run' }).click();
  const queueDialog = page.getByRole('dialog', { name: 'Queue agent run' });
  await expect(queueDialog.locator('.agents-queue-note')).toContainText('reports an OpenAI-compatible endpoint configured');
  await queueDialog.getByLabel('Task prompt').fill('Summarize the project structure.');
  await queueDialog.getByRole('button', { name: 'Queue run', exact: true }).click();
  const row = page.locator('.agents-runs-panel .agents-run-row')
    .filter({ hasText: 'Summarize the project structure.' });
  await expect(row.locator('.agents-run-badge')).toHaveText('succeeded', { timeout: 15_000 });
  const run = await page.evaluate(async () => {
    const response = await fetch('/api/v1/agent-runs');
    const runs = await response.json();
    return runs.find((item: { prompt: string }) => item.prompt === 'Summarize the project structure.');
  });
  expect(run.agent_id).toBe(profile.id);
  await expect.poll(() => page.evaluate(async (runID) => {
    const response = await fetch('/api/v1/agent-runs');
    const runs = await response.json();
    return runs.find((item: { id: string }) => item.id === runID)?.status;
  }, run.id), { timeout: 15_000 }).toBe('succeeded');
  const evidence = await page.evaluate(async (runID) => {
    const [runsResponse, diffResponse] = await Promise.all([
      fetch('/api/v1/agent-runs'), fetch(`/api/v1/agent-runs/${runID}/diff`),
    ]);
    const runs = await runsResponse.json();
    return { run: runs.find((item: { id: string }) => item.id === runID),
      diffStatus: diffResponse.status, diff: await diffResponse.json() };
  }, run.id);
  expect(evidence.run.diff_available).toBe(true);
  expect(evidence.run.commit_sha).toMatch(/^[a-f0-9]{40}$/);
  expect(evidence.diffStatus).toBe(200);
  expect(evidence.diff.diff).toContain('agent-output.md');
  expect(evidence.diff.diff).toContain('Created by the E2E model.');
  await expect(row).toContainText('succeeded');
  await expect(row).toContainText('zenchron-engineering-os');
  await expect(row).toContainText(`commit ${evidence.run.commit_sha.slice(0, 7)}`);
  await page.getByRole('link', { name: 'Reviews' }).click();
  await page.getByRole('button', { name: 'Local branches' }).click();
  await expect(page.locator('.reviews-diff-meta')).toContainText(`Local commit ${evidence.run.commit_sha.slice(0, 7)}`);
  await page.getByLabel('Review comment').fill('Add a regression note for the requested change.');
  await page.getByRole('button', { name: 'Request changes' }).click();
  await expect.poll(() => page.evaluate(async (runID) => {
    const response = await fetch('/api/v1/agent-runs');
    const runs = await response.json();
    const item = runs.find((entry: { id: string }) => entry.id === runID);
    return { status: item?.status, attempts: item?.attempts };
  }, run.id), { timeout: 15_000 }).toEqual({ status: 'succeeded', attempts: 2 });
  const followUp = await page.evaluate(async (runID) => {
    const [runsResponse, diffResponse] = await Promise.all([
      fetch('/api/v1/agent-runs'), fetch(`/api/v1/agent-runs/${runID}/diff`),
    ]);
    const runs = await runsResponse.json();
    const item = runs.find((entry: { id: string }) => entry.id === runID);
    return { run: item, diff: await diffResponse.json() };
  }, run.id);
  expect(followUp.run.branch).toBe(evidence.run.branch);
  expect(followUp.run.commit_sha).not.toBe(evidence.run.commit_sha);
  expect(followUp.run.review_comments).toContainEqual(expect.objectContaining({
    body: 'Add a regression note for the requested change.', request_changes: true,
  }));
  expect(followUp.diff.diff).toContain('Created by the E2E model.');
  expect(followUp.diff.diff).toContain('Review feedback addressed by the E2E worker.');
  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(page.locator('.metric-card.blue')).toContainText('Running Agents');
  await expect(page.locator('.metric-card.blue')).toContainText('0');
  await expect(page.locator('.agents-panel')).toContainText('E2E Reviewer');
});

test('Reviews can cancel an active worker run and retain its partial branch diff', async ({ page }) => {
  await page.goto('/#agents');
  const run = await page.evaluate(async () => {
    const profileResponse = await fetch('/api/v1/agents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Cancellation E2E', provider: 'custom', model: 'review-v1', tools: ['code.write'] }),
    });
    const profile = await profileResponse.json();
    const projects = await fetch('/api/v1/projects').then((response) => response.json());
    const project = projects.find((item: { worker_status: string }) => item.worker_status === 'online');
    if (!profileResponse.ok || !project) throw new Error('Cancellation E2E setup failed');
    const response = await fetch('/api/v1/agent-runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: profile.id, project_id: project.id,
        prompt: 'Hold for cancellation after writing partial output.',
      }),
    });
    return { status: response.status, run: await response.json() };
  });
  expect(run.status).toBe(202);
  await expect.poll(async () => {
    const response = await page.request.get('http://127.0.0.1:8082/test-state');
    return (await response.json()).waitingForCancellation;
  }, { timeout: 15_000 }).toBe(true);

  await page.goto('/#reviews');
  await page.getByRole('button', { name: 'Local branches' }).click();
  const row = page.locator('.ag-row').filter({ hasText: run.run.branch });
  await expect(row).toBeVisible();
  await row.click();
  await page.getByRole('button', { name: 'Cancel run' }).click();
  await expect(page.locator('.reviews-detail-heading')).toContainText('cancelled', { timeout: 15_000 });
  await expect(page.locator('.reviews-code-editor[aria-label="Local branch diff"]')).toBeVisible();
  await expect(page.locator('.reviews-code-editor .view-lines')).toContainText('Partial output before cancellation.');
  await expect(page.locator('.reviews-change-empty')).toContainText('partial-output.md');
  await page.getByRole('textbox', { name: 'Review comment' }).fill('Resume from the captured partial output.');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(page.getByLabel('Review comments')).toContainText('Resume from the captured partial output.');
});
