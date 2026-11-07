import { expect, test, type Page } from '@playwright/test';

async function useLocalSession(page: Page) {
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, local: true, login: 'Local workspace' }),
  }));
}

const objectives = [
  {
    id: '11111111111111111111111111111111', title: 'Ship API v2', description: 'Finish the API launch.',
    owner: 'Alex Chen', product: 'Core Product', product_id: '', status: 'on_track', progress: 78,
    due_date: '2026-11-30', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-10T00:00:00Z',
  },
  {
    id: '22222222222222222222222222222222', title: 'Reduce CI time', description: 'Improve build latency.',
    owner: 'Priya Shah', product: 'Core Product', product_id: '', status: 'at_risk', progress: 34,
    due_date: '2026-12-15', created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-11T00:00:00Z',
  },
  {
    id: '33333333333333333333333333333333', title: 'Complete migration', description: 'Finish the migration.',
    owner: 'Maya Patel', product: 'Core Product', product_id: '', status: 'in_progress', progress: 50,
    due_date: '2026-09-30', created_at: '2026-08-02T00:00:00Z', updated_at: '2026-08-11T00:00:00Z',
  },
  {
    id: '44444444444444444444444444444444', title: 'Document ownership', description: 'Record service owners.',
    owner: 'Alex Chen', product: 'Core Product', product_id: '', status: 'blocked', progress: 10,
    due_date: '', created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-12T00:00:00Z',
  },
];

test('local Objectives mock preview renders the supplied screen without protected reads or writes', async ({ page }) => {
  const objectiveRequests: string[] = [];
  const productRequests: string[] = [];
  await page.route('**/api/v1/objectives', (route) => {
    objectiveRequests.push(route.request().method());
    return route.fulfill({ status: 401, body: 'authentication required' });
  });
  await page.route('**/api/v1/products', (route) => {
    productRequests.push(route.request().method());
    return route.fulfill({ status: 401, body: 'authentication required' });
  });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 401, body: 'authentication required' }));
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/?preview=mock#objectives');

  await expect(page.getByRole('heading', { name: 'Objectives' })).toBeVisible();
  await expect(page.locator('.objective-metric').nth(0)).toContainText('Objective Throughput');
  await expect(page.locator('.objective-metric').nth(0)).toContainText('Completed this quarter');
  await expect(page.locator('.objective-metric').nth(1)).toContainText('Objective Success Rate86.7%');
  await expect(page.locator('.objective-grid-wrap .ag-row')).toHaveCount(6);
  await expect(page.locator('.objective-detail-panel')).toContainText('Launch AI code review v2');
  await expect(page.locator('.objective-preview-blocker')).toContainText('Model training run (PR #1462)');
  await expect(page.locator('.objective-milestones-list > div')).toHaveCount(4);
  expect(objectiveRequests).toEqual([]);
  expect(productRequests).toEqual([]);

  await page.getByRole('button', { name: 'New Objective' }).click();
  await page.getByRole('textbox', { name: 'Objective title' }).fill('Preview-only objective');
  await page.getByRole('button', { name: 'Create objective' }).click();
  await expect(page.getByText('The mock preview is read-only.')).toBeVisible();
  expect(objectiveRequests).toEqual([]);
});

test('empty objective workspace shows a first-objective prompt without stale selection guidance', async ({ page }) => {
  await useLocalSession(page);
  await page.route('**/api/v1/objectives', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.route('**/api/v1/products', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#objectives');

  await expect(page.locator('.ag-overlay-no-rows-center')).toHaveText('No objectives yet. Create one to begin.');
  await expect(page.locator('.objective-grid-toolbar')).not.toContainText('Select an objective to inspect details');
  await expect(page.locator('.objective-detail-empty')).toContainText(/create the first objective/i);
});

test('filtered objective table distinguishes no matches from an empty workspace', async ({ page }) => {
  await useLocalSession(page);
  await page.route('**/api/v1/objectives', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(objectives),
  }));
  await page.route('**/api/v1/products', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#objectives');
  await page.getByRole('textbox', { name: 'Search objectives' }).fill('missing objective');

  await expect(page.locator('.ag-overlay-no-rows-center')).toHaveText('No objectives match these filters.');
  await expect(page.locator('.objective-grid-toolbar')).toContainText('No objectives match these filters.');
  await expect(page.locator('.objective-grid-toolbar')).not.toContainText('Select an objective to inspect details');
});

test('objective quarter filter and table, cards, and Kanban views share records', async ({ page }) => {
  await useLocalSession(page);
  await page.route('**/api/v1/objectives', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(objectives),
  }));
  await page.route('**/api/v1/products', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.clock.install({ time: new Date('2026-11-04T12:00:00Z') });
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/#objectives');

  await expect(page.getByRole('button', { name: 'Table', pressed: true })).toBeVisible();
  await expect(page.locator('.objective-grid-wrap .ag-row')).toHaveCount(2);
  await expect(page.locator('.objective-grid-wrap .ag-row').first()).toHaveCSS('height', '42px');
  await expect(page.locator('.objective-grid-wrap .ag-cell').first()).toHaveCSS('font-size', '11px');
  await expect(page.locator('.objective-grid-wrap .ag-header-cell-text').first()).toHaveCSS('font-size', '10px');
  await page.getByRole('combobox', { name: 'Filter by due quarter' }).click();
  await page.getByRole('option', { name: 'All due dates' }).click();
  await expect(page.locator('.objective-grid-wrap .ag-row')).toHaveCount(4);
  await page.getByRole('combobox', { name: 'Filter by due quarter' }).click();
  await page.getByRole('option', { name: 'This Quarter' }).click();
  await expect(page.locator('.objective-grid-wrap .ag-row')).toHaveCount(2);

  await page.getByRole('button', { name: 'Cards' }).click();
  const shipCard = page.getByRole('button', { name: /Ship API v2/ });
  await expect(shipCard).toBeVisible();
  await shipCard.click();
  await expect(shipCard).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.objective-detail-head h3')).toHaveText('Ship API v2');

  await page.getByRole('button', { name: 'Kanban' }).click();
  await expect(page.getByRole('region', { name: 'On Track' }).getByRole('button', { name: /Ship API v2/ }))
    .toBeVisible();
  await expect(page.getByRole('region', { name: 'At Risk' }).getByRole('button', { name: /Reduce CI time/ }))
    .toBeVisible();
  await page.getByRole('textbox', { name: 'Search objectives' }).fill('Ship');
  await expect(page.locator('.objective-kanban-column[aria-label="At Risk"] .objective-item-card')).toHaveCount(0);
  await expect(page.locator('.objective-kanban-column[aria-label="On Track"] .objective-item-card')).toHaveCount(1);

  await page.getByRole('textbox', { name: 'Search objectives' }).fill('');
  await page.getByRole('combobox', { name: 'Filter by due quarter' }).click();
  await page.getByRole('option', { name: 'All due dates' }).click();
  await page.getByRole('tab', { name: 'Planning' }).click();
  await expect(page.locator('.objective-planning-view .objective-item-card-title')).toHaveText([
    /Complete migration/, /Ship API v2/, /Reduce CI time/, /Document ownership/,
  ]);
  const planningTab = page.getByRole('tab', { name: 'Planning' });
  await expect(planningTab).toHaveAttribute('aria-selected', 'true');
  await expect(planningTab).toHaveCSS('background-color', 'rgb(45, 33, 64)');

  await page.getByRole('tab', { name: 'Roadmap' }).click();
  await expect(page.getByRole('region', { name: '2026 Q3' })).toContainText('Complete migration');
  await expect(page.getByRole('region', { name: '2026 Q4' })).toContainText('Ship API v2');
  await expect(page.getByRole('region', { name: 'Unscheduled' })).toContainText('Document ownership');
});
