import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function useLiveSession(page: Page) {
  await page.route('**/api/v1/**', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/auth/session', (route) => route.fulfill(json({ authenticated: true, local: true, login: '' })));
  await page.route('**/healthz', (route) => route.fulfill(json({ status: 'ok' })));
}

test('dashboard displays the connected control plane and local worker', async ({ page }) => {
  await page.setViewportSize({ width: 1490, height: 829 });
  await page.route((url) => url.hostname === 'zenchron.test'
    && (url.pathname === '/healthz' || url.pathname.startsWith('/api/v1/')),
  async (route) => {
    const upstream = new URL(route.request().url());
    upstream.hostname = '127.0.0.1';
    upstream.port = '8083';
    const response = await page.request.get(upstream.toString());
    await route.fulfill({ response });
  });
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.goto('/');
  await expect(page.locator('.search-box')).toBeVisible();
  const overviewIconsLeadLabels = await page.locator('.metric-card .metric-top').evaluateAll((headers) =>
    headers.every((header) => {
      const icon = header.querySelector('svg')?.getBoundingClientRect();
      const label = header.querySelector('span')?.getBoundingClientRect();
      return icon !== undefined && label !== undefined && icon.right <= label.left;
    }),
  );
  expect(overviewIconsLeadLabels, 'Overview KPI icons sit before their labels').toBe(true);
  const headerRegions = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return { greetingRight: rect('.greeting').right, search: rect('.search-box'), actionsLeft: rect('.top-actions').left };
  });
  expect(headerRegions.search.left).toBeGreaterThanOrEqual(headerRegions.greetingRight);
  expect(headerRegions.search.right).toBeLessThanOrEqual(headerRegions.actionsLeft);
  await page.setViewportSize({ width: 1360, height: 829 });
  await expect(page.locator('.search-box')).toBeHidden();
  await page.setViewportSize({ width: 1490, height: 829 });
  await expect(page.getByRole('heading', { name: /Good morning/ })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search pages' })).toHaveAttribute('placeholder', 'Search Zenchron…');
  await expect(page.getByRole('heading', { name: 'Workflow Orchestration' })).toBeVisible();
  await expect(page.locator('.plan-panel .panel-actions')).toHaveCount(0);
  await expect(page.locator('.workflow-overview-canvas .workflow-node')).toHaveCount(6);
  await expect(page.locator('.workflow-overview-canvas .react-flow__edge')).toHaveCount(6);
  await expect(page.locator('.workflow-overview-canvas .react-flow__attribution')).toBeHidden();
  await expect(page.locator('.workflow-overview-canvas.stages-complete')).toHaveCount(0);
  await expect(page.locator('.workflow-node.trigger .workflow-node-icon svg')).toHaveCSS('width', '28px');
  await expect(page.locator('.workflow-overview-canvas .react-flow__edge-path').first()).toHaveAttribute('marker-end', /url/);
  const workflowSummary = page.locator('.workflow-overview-canvas');
  await expect(workflowSummary).toHaveAttribute('aria-label', /6 stages summarize 9 components/);
  await expect(workflowSummary).toContainText('Run agents');
  await expect(workflowSummary).toContainText('Run test suite');
  await expect(workflowSummary).toContainText('AI + human review');
  await expect(workflowSummary).toContainText('Gated release');
  await expect(page.locator('.workflow-overview-actions .muted-tag')).toHaveText('Execution unavailable');
  await expect(page.locator('.workflow-overview-actions .preview-running-badge')).toHaveCount(0);
  await expect(page.locator('.workflow-panel .shared-panel-heading p')).toHaveText(/ · (draft|active)$/);
  await expect(page.getByRole('link', { name: 'View Runs' })).toHaveAttribute('href', '#workflows');
  await page.getByRole('button', { name: 'Workflow options' }).click();
  await expect(page.getByRole('menu')).toContainText(/9 components · \d+ connections · runner not connected/);
  await expect(page.getByRole('menuitem', { name: 'Open workflow editor' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.app-shell')).toHaveClass(/sample-data/);
  await expect(page.locator('.overview-design-preview')).toBeVisible();
  await expect(page.locator('.metric-grid .mock-trend circle')).toHaveCount(0);
  await expect(page.locator('.pr-queue-metric .mock-bars')).toHaveCount(0);
  await expect(page.locator('.mock-budget-summary')).toHaveText('Not configured');
  await expect(page.locator('.timeline-panel .shared-panel-heading p')).toHaveText('No sprint schedule connected');
  await expect(page.locator('.timeline-empty')).toContainText('Sprint schedule unavailable');
  await expect(page.locator('.preview-timeline')).toHaveCount(0);
  await expect(page.locator('.evidence-health-list')).toContainText('Branch protection is not connected');
  await expect(page.locator('.evidence-health-list .muted-tag')).toHaveText(['Unavailable', 'Unavailable']);
  await expect(page.locator('.main-content')).not.toContainText('PR #41827');
  await expect(page.locator('.activity-list')).toContainText('Control plane is responding');
  await expect(page.getByText('Running Agents', { exact: true })).toBeVisible();
  await expect(page.getByText('Approval data unavailable', { exact: true })).toBeVisible();
  await expect(page.locator('.evidence-health-list')).toContainText('Trusted-main');
  await expect(page.locator('.evidence-health-list')).toContainText('Evidence');
  await expect(page.locator('.evidence-health-list .muted-tag .health-status-dot').first()).toHaveCSS('background-color', 'rgb(170, 160, 192)');
  await expect(page.getByText('No pending approvals', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No runs', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Worker “.+” is online/)).toBeVisible();
  await expect(page.locator('.activity-list')).toContainText('zenchron-engineering-os');
  await expect(page.locator('.metric-unavailable')).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'Code Review' })).toBeVisible();
  await expect(page.getByText('No local branch diffs yet', { exact: true })).toBeVisible();
  await expect(page.getByText('No pull requests yet', { exact: true })).toHaveCount(0);
  await expect(page.locator('.page-footer')).toBeHidden();
  await page.getByRole('link', { name: 'Product Workspace' }).click();
  await page.getByRole('button', { name: 'Product actions' }).click();
  await page.getByRole('menuitem', { name: 'Open repository inventory' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
});

test('Overview PR queue and CI health use complete GitHub history', async ({ page }) => {
  const projectID = 'a'.repeat(32);
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, local: true, login: '' }),
  }));
  await page.route('**/api/v1/projects', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify([{
      id: projectID, name: 'Platform', branch: 'main', git_remote: 'github.com/acme/platform',
      worker_id: 'b'.repeat(32), worker_name: 'Mac', worker_status: 'online', last_seen: ago(0),
    }]),
  }));
  await page.route('**/api/v1/projects/*/pull-request-history*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ complete: true, items: [
      { created_at: ago(120), closed_at: null, merged_at: null },
      { created_at: ago(60), closed_at: null, merged_at: null },
      { created_at: ago(180), closed_at: ago(30), merged_at: ago(30) },
    ] }),
  }));
  await page.route('**/api/v1/projects/*/workflow-run-history*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ complete: true, items: [
      { created_at: ago(60), status: 'completed', conclusion: 'success', run_started_at: ago(12), updated_at: ago(2) },
      { created_at: ago(60), status: 'completed', conclusion: 'failure', run_started_at: ago(12), updated_at: ago(2) },
      { created_at: ago(60), status: 'completed', conclusion: 'success', run_started_at: ago(12), updated_at: ago(2) },
    ] }),
  }));

  await page.goto('/');
  const queue = page.locator('.metric-card.pr-queue-metric');
  await expect(queue.locator('strong')).toHaveText('2');
  await expect(queue.locator('small')).toHaveText('2 open GitHub pull requests');
  const ci = page.locator('.metric-card.green');
  await expect(ci.locator('strong')).toHaveText('67%');
  await expect(ci.locator('small')).toHaveText('2 of 3 completed runs passed');
  await expect(page.getByRole('img', { name: 'Merged pull requests by period' })).toBeVisible();
  await expect(page.locator('.preview-analytics-summary > span')).toHaveText('PRs Merged (all history)');
  await expect(page.locator('.preview-analytics-summary strong')).toHaveText('1');
  await page.getByRole('button', { name: 'Choose analytics metric' }).click();
  await expect(page.getByRole('menuitem', { name: 'Open Reports' })).toHaveAttribute('href', '#reports');
  await page.getByRole('menuitem', { name: 'Cycle Time' }).click();
  await expect(page.locator('.preview-analytics-summary strong')).toHaveText('2.5h');
  await expect(page.getByRole('img', { name: 'Pull-request cycle time by period' })).toBeVisible();
  await page.getByRole('button', { name: 'Choose analytics metric' }).click();
  await page.getByRole('menuitem', { name: 'CI Duration' }).click();
  await expect(page.locator('.preview-analytics-summary strong')).toHaveText('10m');
  await expect(page.getByRole('img', { name: 'CI duration by period' })).toBeVisible();
});

test('Live Overview fills the approved panels with control-plane records and sends no writes', async ({ page }) => {
  await page.setViewportSize({ width: 1672, height: 941 });
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`);
  });
  await useLiveSession(page);
  const objective = (id: string, title: string, status: string, progress: number) => ({
    id, title, description: '', owner: 'E2E', product: 'Core', status, progress, due_date: '2030-01-01',
    created_at: ago(600), updated_at: ago(30),
  });
  await page.route('**/api/v1/objectives', (route) => route.fulfill(json([
    objective('1'.repeat(32), 'Ship the unified dashboard with a deliberately long objective title that must truncate', 'on_track', 40),
    objective('2'.repeat(32), 'Stabilise CI', 'blocked', 15),
    objective('3'.repeat(32), 'Already delivered', 'completed', 100),
  ])));
  const run = (id: string, agent: string, status: string, minutes: number) => ({
    id, agent_id: 'a'.repeat(32), agent_name: agent, project_id: 'b'.repeat(32), project_name: 'Nova Platform',
    worker_id: 'c'.repeat(32), worker_name: 'Mac', branch: `zenchron/agent-run/${id.slice(0, 4)}`, prompt: 'Do the work',
    status, attempts: 1, created_at: ago(minutes + 5), updated_at: ago(minutes), review_comments: [],
  });
  await page.route('**/api/v1/agent-runs', (route) => route.fulfill(json([
    run('d'.repeat(32), 'Planner', 'running', 3), run('e'.repeat(32), 'Fixer', 'failed', 125),
  ])));
  await page.goto('/');

  const cards = page.locator('.metric-grid .metric-card');
  await expect(cards).toHaveCount(5);
  await expect(cards.nth(0).locator('strong')).toHaveText('2');
  await expect(cards.nth(0).locator('.mantine-Badge-root')).toHaveText('2 open');
  await expect(cards.nth(1).locator('strong')).toHaveText('1');
  await expect(cards.nth(1).locator('.mantine-Badge-root')).toHaveText('0 workers');
  await expect(cards.nth(4).locator('strong')).toHaveText('Unavailable');

  const objectives = page.locator('.preview-objective-list > div');
  await expect(objectives).toHaveCount(2);
  await expect(objectives.nth(0).locator('small')).toHaveText('On Track');
  await expect(objectives.nth(0).locator('b')).toHaveText('40%');
  await expect(objectives.nth(1).locator('small[data-risk="true"]')).toHaveText('Blocked');
  await expect(objectives.nth(1).locator('.mantine-Progress-section')).toHaveCSS('background-image', /rgb\(232, 167, 25\)/);
  await expect(objectives.nth(0).locator('.mantine-Progress-section')).toHaveCSS('background-image', /rgb\(8, 197, 138\)/);
  const objectivePanel = await page.locator('.objective-panel').boundingBox();
  const longTitle = await objectives.nth(0).boundingBox();
  expect(longTitle!.x + longTitle!.width).toBeLessThanOrEqual(objectivePanel!.x + objectivePanel!.width);

  const runs = page.locator('.agents-panel .preview-agent-list > div');
  await expect(runs).toHaveText([/Planner\s*Nova Platform\s*Running\s*3m ago/, /Fixer\s*Nova Platform\s*Failed\s*2h ago/]);
  await expect(runs.nth(1).locator('.mantine-Badge-root')).toHaveCSS('color', 'rgb(241, 199, 95)');
  const agentsPanel = await page.locator('.agents-panel').boundingBox();
  const lastRun = await runs.last().boundingBox();
  expect(lastRun!.y + lastRun!.height).toBeLessThanOrEqual(agentsPanel!.y + agentsPanel!.height);

  await expect(page.locator('.activity-panel .activity-list > div')).toHaveText([
    /Control plane is responding\s*Live/, /Agent “Planner” running\s*3m ago/, /Agent “Fixer” failed\s*2h ago/,
  ]);
  await expect(page.locator('.activity-panel .activity-list > div').first().locator('svg')).toHaveCSS('border-radius', '50%');
  await page.getByRole('button', { name: 'All Activity' }).click();
  await expect(page.getByRole('dialog', { name: 'All Activity' }).locator('.activity-list > div')).toHaveCount(3);
  await page.keyboard.press('Escape');

  await expect(page.getByText('Approval data unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('No local branch diffs yet', { exact: true })).toBeVisible();
  await expect(page.locator('.chart-empty')).toContainText('No delivery data yet');
  await expect(page.locator('.preview-analytics-summary strong')).toHaveText('—');
  const middlePanels = await page.locator('.overview-middle-grid > .panel').evaluateAll((panels) =>
    panels.map((panel) => panel.getBoundingClientRect().width));
  expect(middlePanels).toEqual([342, 312, 328, 371]);
  expect(writes).toEqual([]);
});

test('Live Overview reports failed requests instead of sample values', async ({ page }) => {
  await useLiveSession(page);
  for (const path of ['projects', 'objectives', 'agent-runs', 'workflows']) {
    await page.route(`**/api/v1/${path}`, (route) => route.fulfill({ status: 500, body: 'boom' }));
  }
  await page.goto('/');
  // The shell's queries retry with backoff before they report an error.
  await expect(page.getByText('Objectives unavailable', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Agent runs unavailable', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Review runs unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('Workflow definition unavailable', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.metric-grid .metric-card strong')).toHaveText(
    ['Unavailable', 'Unavailable', 'Unavailable', 'Unavailable', 'Unavailable'], { timeout: 30_000 });
  await expect(page.locator('.metric-grid .metric-card').first().locator('.mantine-Badge-root')).toHaveText('Unavailable');
  await expect(page.locator('.pr-queue-metric small')).toHaveText('Repository inventory unavailable');
  await expect(page.locator('.chart-empty')).toContainText('GitHub history unavailable.');
  await expect(page.locator('.main-content')).not.toContainText('PR #41827');
  await expect(page.locator('.main-content')).not.toContainText('Ship AI code review v2');
});

test('Live Overview keeps the phone summary without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useLiveSession(page);
  await page.goto('/');
  await expect(page.locator('.metric-grid .metric-card:visible')).toHaveCount(4);
  await expect(page.locator('.mock-budget-summary small')).toHaveText('Not configured');
  expect(await page.locator('.metric-grid .metric-card:visible').evaluateAll((cards) =>
    cards.every((card) => card.scrollWidth <= card.clientWidth))).toBe(true);
  await expect(page.locator('.activity-panel')).toContainText('Control plane is responding');
  for (const selector of ['.workflow-panel', '.objective-panel', '.review-panel', '.timeline-panel', '.analytics-panel']) {
    await expect(page.locator(selector)).toBeHidden();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);
});
