import { expect, test, type Page } from '@playwright/test';

const profileID = 'ab'.repeat(16);
const projectID = 'ef'.repeat(16);
const workerID = 'cd'.repeat(16);
const runID = '12'.repeat(16);
const now = new Date().toISOString();
const viewports = [{ name: 'desktop', width: 1672, height: 941 }, { name: 'mobile', width: 390, height: 844 }];

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockWorkspace(page: Page, options: { providerReady: boolean; issuesStatus?: number }) {
  await page.route('**/api/v1/auth/session', (route) => route.fulfill(json({ authenticated: true, local: true, login: 'E2E' })));
  await page.route('**/api/v1/agents', (route) => route.fulfill(json([{
    id: profileID, name: 'Codex engineer', description: 'Resolves GitHub issues.', provider: 'codex-cli', model: 'default',
    status: 'active', system_prompt: 'Follow AGENTS.md.', goal_prompt: '', tools: ['code.write'], version: 1, updated_at: now,
  }])));
  await page.route('**/api/v1/workers', (route) => route.fulfill(json([{
    id: workerID, name: 'dev-laptop', status: 'online', last_seen: now, agent_runtime_enabled: false,
    providers: [{ id: 'codex-cli', version: 'codex-cli 0.167.0', ready: options.providerReady }],
  }])));
  await page.route('**/api/v1/projects', (route) => route.fulfill(json([{
    id: projectID, name: 'platform', branch: 'main', git_remote: 'github.com/acme/platform', worker_id: workerID,
    worker_name: 'dev-laptop', last_seen: now, worker_status: 'online',
  }])));
  await page.route(`**/api/v1/projects/${projectID}/issues`, (route) => route.fulfill(options.issuesStatus
    ? { status: options.issuesStatus, body: 'unavailable' }
    : json([{ number: 7, title: 'Bound the claim response body' }, { number: 9, title: 'Document worker enrollment' }])));
}

const evidenceRun = {
  id: runID, agent_id: profileID, agent_name: 'Codex engineer', project_id: projectID, project_name: 'platform',
  worker_id: workerID, worker_name: 'dev-laptop', branch: `zenchron/agent-run/${runID}`, base_branch: 'main',
  prompt: 'Resolve GitHub issue #7: Bound the claim response body', output: 'Bounded the body and added a test.',
  status: 'succeeded', attempts: 2, created_at: now, updated_at: now, diff_available: true, diff_attempt: 2,
  commit_sha: 'a'.repeat(40), base_commit: 'b'.repeat(40), repository: 'github.com/acme/platform',
  issue_number: 7, issue_title: 'Bound the claim response body', issue_url: 'https://github.com/acme/platform/issues/7',
  provider: 'codex-cli', provider_version: 'codex-cli 0.167.0', termination_reason: 'completed',
  verification: 'passed', publication: 'published', pull_request_enabled: true, pull_request_number: 23,
  pull_request_url: 'https://github.com/acme/platform/pull/23', usage: { input_tokens: 706042, output_tokens: 6570 },
  attempt_log: [
    { attempt: 1, worker_id: workerID, started_at: now, finished_at: now, status: 'lease_expired', termination_reason: 'lease_lost' },
    { attempt: 2, worker_id: workerID, started_at: now, finished_at: now, status: 'succeeded', commit_sha: 'a'.repeat(40) },
  ],
};

for (const viewport of viewports) {
  test(`queue dialog starts a run from a GitHub issue when the CLI provider is ready (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockWorkspace(page, { providerReady: true });
    let queued: Record<string, unknown> | undefined;
    await page.route('**/api/v1/agent-runs', (route) => {
      if (route.request().method() !== 'POST') return route.fulfill(json([]));
      queued = route.request().postDataJSON();
      return route.fulfill(json({ ...evidenceRun, status: 'queued', attempts: 0, attempt_log: [] }, 202));
    });
    await page.goto('/#agents');
    await page.getByRole('button', { name: 'Run Agent' }).click();
    const dialog = page.getByRole('dialog', { name: 'Queue agent run' });
    await expect(dialog.getByLabel('Project')).toHaveValue('platform · dev-laptop · codex-cli ready');
    await expect(dialog.locator('.agents-queue-note')).toHaveText('dev-laptop reports codex-cli 0.167.0 installed and signed in.');
    await dialog.getByRole('button', { name: 'Queue run', exact: true }).click();
    await expect(dialog.getByText('Add a task prompt or choose an issue')).toBeVisible();
    expect(queued).toBeUndefined();
    await dialog.getByRole('combobox', { name: 'GitHub issue (optional)' }).click();
    await page.getByRole('option', { name: '#7 Bound the claim response body' }).click();
    await expect(dialog.locator('.agents-issue-note')).toHaveText(
      'The agent receives the issue text and the pull request will close issue #7.');
    await expect(dialog.getByLabel('Task prompt (optional)')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await dialog.getByRole('button', { name: 'Queue run', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(queued).toEqual({ agent_id: profileID, project_id: projectID, prompt: '', issue_number: 7 });
  });
}

test('queue dialog blocks a CLI profile whose worker has not signed in and reports unavailable issues', async ({ page }) => {
  await mockWorkspace(page, { providerReady: false, issuesStatus: 502 });
  let queued = false;
  await page.route('**/api/v1/agent-runs', (route) => {
    if (route.request().method() !== 'POST') return route.fulfill(json([]));
    queued = true;
    return route.fulfill(json({ ...evidenceRun, status: 'queued', attempts: 0, attempt_log: [] }, 202));
  });
  await page.goto('/#agents');
  await page.getByRole('button', { name: 'Run Agent' }).click();
  const dialog = page.getByRole('dialog', { name: 'Queue agent run' });
  await expect(dialog.getByLabel('Project')).toHaveValue('platform · dev-laptop · codex-cli not ready');
  await expect(dialog.locator('.agents-queue-note')).toHaveText(
    'dev-laptop does not report codex-cli installed and signed in; sign in on the worker and restart it.');
  await expect(dialog.locator('.agents-issue-note')).toHaveText(
    'GitHub issues are unavailable for this project; the run can still start from a task prompt.');
  await expect(dialog.getByRole('combobox', { name: 'GitHub issue (optional)' })).toBeDisabled();
  await dialog.getByLabel('Task prompt').fill('Tidy the worker README.');
  await expect(dialog.getByRole('button', { name: 'Queue run', exact: true })).toBeDisabled();
  expect(queued).toBe(false);
});

test('Settings reports which coding CLIs are ready on online workers', async ({ page }) => {
  await mockWorkspace(page, { providerReady: true });
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill(json([])));
  await page.goto('/#integrations');
  const workers = page.locator('.system-service-card').filter({ has: page.getByRole('heading', { name: 'Local workers' }) });
  await expect(workers).toContainText('1 of 1 workers reporting a recent heartbeat. Coding CLIs ready: codex-cli on 1.');
});

for (const viewport of viewports) {
  test(`Reviews shows run evidence, attempts, checks, and events (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockWorkspace(page, { providerReady: true });
    await page.route('**/api/v1/agent-runs', (route) => route.fulfill(json([evidenceRun])));
    await page.route(`**/api/v1/agent-runs/${runID}/diff`, (route) => route.fulfill(json({
      run_id: runID, diff: 'diff --git a/a.go b/a.go\n+bound\n', truncated: false })));
    await page.route(`**/api/v1/agent-runs/${runID}/events`, (route) => route.fulfill(json([
      { sequence: 1, attempt: 2, at: now, kind: 'status', message: 'Attempt 2 claimed by worker dev-laptop' },
      { sequence: 2, attempt: 2, at: now, kind: 'tool', message: `$ go test ./... ${'long-argument-'.repeat(30)}` },
      { sequence: 3, attempt: 2, at: now, kind: 'verification', message: 'passed: go vet ./...' },
      { sequence: 4, attempt: 2, at: now, kind: 'status', message: 'Publication: published https://github.com/acme/platform/pull/23' },
    ])));
    await page.route(`**/api/v1/agent-runs/${runID}/pull-request`, (route) => route.fulfill(json({
      number: 23, url: 'https://github.com/acme/platform/pull/23', state: 'open', merged: false, head_sha: 'a'.repeat(40),
      checks: [{ name: 'go', status: 'completed', conclusion: 'success' }, { name: 'dashboard', status: 'in_progress', conclusion: '' }],
      reviews: [],
    })));
    await page.goto('/#reviews');
    await page.getByRole('button', { name: 'Local branches' }).click();
    await page.getByRole('group', { name: 'Review detail sections' }).getByRole('button', { name: 'Evidence' }).click();
    const summary = page.getByLabel('Run evidence summary');
    for (const [name, value] of [
      ['Issue', '#7 Bound the claim response body'], ['Provider', 'codex-cli 0.167.0'], ['Worker', 'dev-laptop'],
      ['Base commit', 'bbbbbbbbbbbb'], ['Result commit', 'aaaaaaaaaaaa'], ['Execution', 'Completed'],
      ['Verification', 'Passed'], ['Publication', 'Pull request published'], ['Pull request', '#23 on GitHub'],
      ['Usage', '706,042 input · 6,570 output tokens'],
    ]) {
      await expect(summary.locator('div').filter({ has: page.getByText(name, { exact: true }) }).locator('dd')).toContainText(value);
    }
    await expect(summary.getByRole('link', { name: '#7 Bound the claim response body' }))
      .toHaveAttribute('href', 'https://github.com/acme/platform/issues/7');
    const checks = page.getByRole('region', { name: 'Pull request checks' });
    await expect(checks.getByRole('listitem')).toHaveText(['gosuccess', 'dashboardin_progress']);
    const attempts = page.getByRole('region', { name: 'Run attempts' });
    await expect(attempts.getByRole('listitem').first()).toContainText('Attempt 1Worker lease expired');
    await expect(attempts.getByRole('listitem').nth(1)).toContainText('Attempt 2Succeeded · commit aaaaaaaaaaaa');
    const events = page.getByRole('region', { name: 'Run events' }).getByRole('listitem');
    await expect(events).toHaveCount(4);
    await expect(events.nth(2)).toContainText('verificationpassed: go vet ./...');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const panel = await page.locator('.reviews-change-empty:has(.run-evidence)').boundingBox();
    expect(panel?.height).toBeGreaterThanOrEqual(220);
    await page.screenshot({ path: `test-results/run-evidence-${viewport.name}.png`, fullPage: true });
  });
}

test('Reviews evidence reports loading failures and an empty event log', async ({ page }) => {
  await mockWorkspace(page, { providerReady: true });
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill(json([{ ...evidenceRun, attempt_log: [] }])));
  await page.route(`**/api/v1/agent-runs/${runID}/diff`, (route) => route.fulfill(json({ run_id: runID, diff: '', truncated: false })));
  let eventsStatus = 500;
  await page.route(`**/api/v1/agent-runs/${runID}/events`, (route) => route.fulfill(
    eventsStatus === 200 ? json([]) : { status: eventsStatus, body: 'failed' }));
  await page.route(`**/api/v1/agent-runs/${runID}/pull-request`, (route) => route.fulfill({ status: 502, body: 'unavailable' }));
  await page.goto('/#reviews');
  await page.getByRole('button', { name: 'Local branches' }).click();
  await page.getByRole('group', { name: 'Review detail sections' }).getByRole('button', { name: 'Evidence' }).click();
  await expect(page.getByRole('region', { name: 'Pull request checks' }).getByRole('alert'))
    .toHaveText('Pull request status unavailable (502)');
  await expect(page.getByRole('region', { name: 'Run events' }).getByRole('alert'))
    .toHaveText('Run events unavailable (500)', { timeout: 15_000 });
  await expect(page.getByRole('region', { name: 'Run attempts' })).toHaveCount(0);
  eventsStatus = 200;
  await page.reload();
  await page.getByRole('button', { name: 'Local branches' }).click();
  await page.getByRole('group', { name: 'Review detail sections' }).getByRole('button', { name: 'Evidence' }).click();
  await expect(page.getByRole('region', { name: 'Run events' })).toContainText('No events recorded for this run.');
});

test('queue dialog creates a GitHub issue and selects it for the run', async ({ page }) => {
  await mockWorkspace(page, { providerReady: true });
  let created: Record<string, unknown> | undefined;
  let failCreation = true;
  await page.route(`**/api/v1/projects/${projectID}/issues`, (route) => {
    if (route.request().method() !== 'POST') return route.fulfill(json([{ number: 7, title: 'Bound the claim response body' }]));
    if (failCreation) return route.fulfill({ status: 502, body: 'GitHub could not create this issue; verify token permissions and provider access' });
    created = route.request().postDataJSON();
    return route.fulfill(json({ number: 41, title: 'Reject control characters in worker names' }, 201));
  });
  let queued: Record<string, unknown> | undefined;
  await page.route('**/api/v1/agent-runs', (route) => {
    if (route.request().method() !== 'POST') return route.fulfill(json([]));
    queued = route.request().postDataJSON();
    return route.fulfill(json({ ...evidenceRun, status: 'queued', attempts: 0, attempt_log: [] }, 202));
  });
  await page.goto('/#agents');
  await page.getByRole('button', { name: 'Run Agent' }).click();
  const dialog = page.getByRole('dialog', { name: 'Queue agent run' });
  await dialog.getByRole('button', { name: 'Create a new issue' }).click();
  const draft = dialog.getByRole('group', { name: 'New GitHub issue' });
  await expect(draft.getByRole('button', { name: 'Create issue' })).toBeDisabled();
  await draft.getByLabel('Issue title').fill('Reject control characters in worker names');
  await draft.getByLabel('Issue description').fill('Problem, expected behavior, acceptance criteria.');
  await draft.getByRole('button', { name: 'Create issue' }).click();
  await expect(draft.getByRole('alert')).toContainText('GitHub could not create this issue');
  failCreation = false;
  await draft.getByRole('button', { name: 'Create issue' }).click();
  await expect(draft).toBeHidden();
  expect(created).toEqual({ title: 'Reject control characters in worker names', body: 'Problem, expected behavior, acceptance criteria.' });
  await expect(dialog.getByRole('combobox', { name: 'GitHub issue (optional)' })).toHaveValue('#41 Reject control characters in worker names');
  await dialog.getByRole('button', { name: 'Queue run', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(queued).toEqual({ agent_id: profileID, project_id: projectID, prompt: '', issue_number: 41 });
});

test('Reviews evidence imports GitHub change requests and retries a failed pull request', async ({ page }) => {
  await mockWorkspace(page, { providerReady: true });
  let run: Record<string, unknown> = { ...evidenceRun, publication: 'pull_request_failed', pull_request_number: undefined,
    pull_request_url: undefined, pull_request_error: 'The branch was pushed, but GitHub could not create the pull request.' };
  const calls: string[] = [];
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill(json([run])));
  await page.route(`**/api/v1/agent-runs/${runID}/diff`, (route) => route.fulfill(json({ run_id: runID, diff: '', truncated: false })));
  await page.route(`**/api/v1/agent-runs/${runID}/events`, (route) => route.fulfill(json([])));
  await page.route(`**/api/v1/agent-runs/${runID}/pull-request`, (route) => route.fulfill(json({
    number: 23, url: evidenceRun.pull_request_url, state: 'open', merged: false, head_sha: 'a'.repeat(40), checks: [], reviews: [] })));
  await page.route(`**/api/v1/agent-runs/${runID}/publish`, (route) => {
    calls.push('publish');
    run = { ...evidenceRun };
    return route.fulfill(json(run));
  });
  let importStatus = 409;
  await page.route(`**/api/v1/agent-runs/${runID}/sync-reviews`, (route) => {
    calls.push('sync-reviews');
    return route.fulfill(importStatus === 200 ? json({ imported: 2, run }) : { status: 409, body: 'agent run review history is full' });
  });
  await page.goto('/#reviews');
  await page.getByRole('button', { name: 'Local branches' }).click();
  await page.getByRole('group', { name: 'Review detail sections' }).getByRole('button', { name: 'Evidence' }).click();
  const summary = page.getByLabel('Run evidence summary');
  await expect(summary).toContainText('Branch pushed; pull request not created');
  await expect(page.getByRole('button', { name: 'Import change requests from GitHub' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry pull request' }).click();
  await expect(page.locator('.run-evidence-actions').getByRole('status')).toHaveText('Pull request published.');
  await expect(summary).toContainText('Pull request published', { timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Retry pull request' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Import change requests from GitHub' }).click();
  await expect(page.locator('.run-evidence-actions').getByRole('alert')).toHaveText('agent run review history is full');
  importStatus = 200;
  await page.getByRole('button', { name: 'Import change requests from GitHub' }).click();
  await expect(page.locator('.run-evidence-actions').getByRole('status')).toHaveText('Imported 2 change requests from GitHub.');
  expect(calls).toEqual(['publish', 'sync-reviews', 'sync-reviews']);
});

test('the Mock and Live switch selects the data source, keeps the page, and stays in the address', async ({ page, baseURL }) => {
  const local = new URL(baseURL!);
  local.hostname = '127.0.0.1';
  await mockWorkspace(page, { providerReady: true });
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill(json([evidenceRun])));
  await page.route(`**/api/v1/agent-runs/${runID}/diff`, (route) => route.fulfill(json({ run_id: runID, diff: '', truncated: false })));
  await page.route(`**/api/v1/agent-runs/${runID}/events`, (route) => route.fulfill(json([
    { sequence: 1, attempt: 2, at: now, kind: 'status', message: 'Attempt 2 claimed by worker dev-laptop' },
  ])));
  await page.route(`**/api/v1/agent-runs/${runID}/pull-request`, (route) => route.fulfill(json({
    number: 23, url: evidenceRun.pull_request_url, state: 'open', merged: false, head_sha: 'a'.repeat(40), checks: [], reviews: [] })));
  // A local address starts in Mock and offers the selector.
  await page.goto(`${local.origin}/#agents`);
  const mode = page.getByRole('radiogroup', { name: 'Data mode' });
  await expect(mode.getByRole('radio', { name: 'Mock' })).toBeChecked();
  await expect(page.locator('.agents-preview-notice')).toHaveText('ILLUSTRATIVE DATA');
  await expect(page.getByRole('heading', { name: 'Agent Profiles (6)' })).toBeVisible();
  await mode.getByText('Live').click();
  await expect(page).toHaveURL(/\?mode=live#agents$/);
  await expect(page.locator('.agents-preview-notice')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Agent Profiles (1)' })).toBeVisible();
  await expect(page.locator('.agents-design-preview .agent-row')).toContainText('Codex engineer');
  await page.getByRole('link', { name: 'Reviews' }).click();
  await expect(page).toHaveURL(/\?mode=live#reviews$/);
  await page.goto(`${local.origin}/?mode=mock#agents`);
  await expect(page.locator('.agents-preview-notice')).toHaveText('ILLUSTRATIVE DATA');
  // Projects has no fixtures: Mock says the inventory is Live-only instead of showing an empty one.
  await page.goto(`${local.origin}/?mode=mock#projects`);
  await expect(page.locator('.projects-live-badge')).toHaveText('No sample data');
  await expect(page.getByRole('heading', { name: 'Live data only' })).toBeVisible();
  await page.goto(`${local.origin}/?mode=live#projects`);
  await expect(page.locator('.projects-live-badge')).toHaveText(/Worker inventory · live/i);
  await expect(page.getByRole('gridcell', { name: 'platform' })).toBeVisible();
  // Off a local address there is no selector and no Mock, whatever the address says.
  await page.goto(`${baseURL}/?mode=mock#agents`);
  await expect(page.getByRole('heading', { name: 'Agent Profiles (1)' })).toBeVisible();
  await expect(page.locator('.agents-preview-notice')).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: 'Data mode' })).toHaveCount(0);
  await page.goto(`${local.origin}/?mode=live#reviews`);
  await page.getByRole('button', { name: 'Local branches' }).click();
  await page.getByRole('group', { name: 'Review detail sections' }).getByRole('button', { name: 'Evidence' }).click();
  await expect(page.getByLabel('Run evidence summary')).toContainText('#7 Bound the claim response body');
  await expect(page.getByRole('region', { name: 'Run events' })).toContainText('Attempt 2 claimed by worker dev-laptop');
});
