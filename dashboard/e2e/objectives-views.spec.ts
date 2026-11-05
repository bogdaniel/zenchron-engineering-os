import { expect, test } from '@playwright/test';

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

test('objective quarter filter and table, cards, and Kanban views share records', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Planning' }).click();
  await expect(page.locator('.objective-planning-view .objective-item-card-title')).toHaveText([
    /Complete migration/, /Ship API v2/, /Reduce CI time/, /Document ownership/,
  ]);
  await expect(page.getByRole('button', { name: 'Planning' })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'Roadmap' }).click();
  await expect(page.getByRole('region', { name: '2026 Q3' })).toContainText('Complete migration');
  await expect(page.getByRole('region', { name: '2026 Q4' })).toContainText('Ship API v2');
  await expect(page.getByRole('region', { name: 'Unscheduled' })).toContainText('Document ownership');
});
