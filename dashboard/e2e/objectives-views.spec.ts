import { expect, test, type Page } from '@playwright/test';

async function useLocalSession(page: Page) {
  await page.route('**/api/v1/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, local: true, login: 'Local workspace' }),
  }));
  await page.route('**/healthz', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '{"status":"ok"}',
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
  await page.goto('http://127.0.0.1:4173/#objectives');

  await expect(page.getByRole('heading', { name: 'Objectives' })).toBeVisible();
  await expect(page.locator('.objective-metric').nth(0)).toContainText('Objective Throughput');
  await expect(page.locator('.objective-metric').nth(0)).toContainText('Completed this quarter');
  await expect(page.locator('.objective-metric').nth(1)).toContainText('Objective Success Rate86.7%');
  await expect(page.locator('.objective-metric').nth(1)
    .locator('.objective-metric-trend .mantine-Badge-root')).toHaveText('↑ +6.9 pp');
  for (const index of [2, 3, 4, 5]) {
    await expect(page.locator('.objective-metric').nth(index).locator('small')).toBeHidden();
  }
  await expect(page.getByRole('combobox', { name: 'Filter by due quarter' })).toHaveValue('This Quarter');
  const objectiveRows = page.locator('.objective-grid-wrap [role="row"]:has([role="gridcell"])');
  await expect(objectiveRows).toHaveCount(6);
  await expect(objectiveRows.first()).toHaveClass(/ag-row-selected/);
  await expect(page.locator('.objective-grid-wrap .ag-cell[col-id="title"]').first()).toHaveCSS('font-size', '11px');
  await expect(page.locator('.objective-grid-wrap .objective-status').first()).toHaveCSS('font-size', '9px');
  await expect(page.locator('.objective-preview-overview .objective-overview-card b').first())
    .toHaveCSS('font-size', '12px');
  await expect(page.locator('.objective-owner-avatar')).toHaveCount(6);
  await expect(page.locator('.objective-approval-status.changes-req')).toHaveCount(1);
  await expect(page.locator('.objective-detail-panel')).toContainText('Launch AI code review v2');
  await expect(page.locator('.objective-preview-blocker')).toContainText('Model training run (PR #1462)');
  await expect(page.locator('.objective-milestones-list > div')).toHaveCount(4);
  const lowerPanelHeights = await page.evaluate(() => ({
    chart: document.querySelector('.objective-capacity')!.getBoundingClientRect().height,
    milestones: document.querySelector('.objective-milestones-card')!.getBoundingClientRect().height,
  }));
  expect(Math.abs(lowerPanelHeights.chart - lowerPanelHeights.milestones)).toBeLessThanOrEqual(1);
  await page.getByRole('tab', { name: 'Milestones', exact: true }).click();
  await expect(page.locator('.objective-detail-milestones > div')).toHaveCount(4);
  await page.getByRole('tab', { name: 'Related PRs' }).click();
  await expect(page.locator('.objective-detail-prs > div')).toHaveCount(4);
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await expect(page.locator('.objective-detail-activity > div')).toHaveCount(4);
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  const overflowingCards = await page.locator('.objective-preview-overview .objective-overview-card')
    .evaluateAll((cards) => cards.filter((card) => card.scrollHeight > card.clientHeight)
      .map((card) => card.querySelector('b')?.textContent));
  expect(overflowingCards).toEqual([]);
  const clippedHeaders = await page.locator('.objective-preview-layout .ag-header-cell-text')
    .evaluateAll((headers) => headers.filter((header) => header.scrollWidth > header.clientWidth).map((header) => header.textContent));
  expect(clippedHeaders).toEqual([]);
  const overflowingGridHeaders = await page.locator('.objective-grid-wrap .ag-header-cell').evaluateAll((headers) => {
    const centerRight = document.querySelector('.objective-grid-wrap .ag-header')!.getBoundingClientRect().right;
    return headers.filter((header) => header.closest('.ag-header')
      && header.getBoundingClientRect().right > centerRight + 1)
      .map((header) => ({ label: header.textContent, right: header.getBoundingClientRect().right, centerRight }));
  });
  expect(overflowingGridHeaders).toEqual([]);
  const clippedObjectiveTitles = await page.locator('.objective-grid-wrap .ag-cell[col-id="title"] .ag-cell-value')
    .evaluateAll((cells) => cells.filter((cell) => cell.scrollWidth > cell.clientWidth).map((cell) => cell.textContent));
  expect(clippedObjectiveTitles).toEqual([]);
  const clippedCells = await page.locator('.objective-grid-wrap .ag-cell[col-id="product"], .objective-grid-wrap .ag-cell[col-id="due_date"]')
    .evaluateAll((cells) => cells.filter((cell) => {
      const content = cell.querySelector('.ag-cell-value');
      return content && content.scrollWidth > content.clientWidth;
    }).map((cell) => cell.textContent));
  expect(clippedCells).toEqual([]);
  expect(objectiveRequests).toEqual([]);
  expect(productRequests).toEqual([]);

  await page.getByRole('button', { name: 'New Objective' }).click();
  await page.getByRole('textbox', { name: 'Objective title' }).fill('Preview-only objective');
  await page.getByRole('button', { name: 'Create objective' }).click();
  await expect(page.getByText('The mock preview is read-only.')).toBeVisible();
  expect(objectiveRequests).toEqual([]);
});

test('Objectives mock layout stays within desktop, tablet, and mobile viewports', async ({ page }) => {
  const dataRequests: string[] = [];
  await page.route('**/api/v1/**', (route) => {
    dataRequests.push(route.request().url());
    return route.fulfill({ status: 401, body: 'layout-only test' });
  });
  for (const [width, height] of [[1668, 750], [1440, 900], [1280, 800], [768, 1024], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.goto('http://127.0.0.1:4173/#objectives');
    await expect(page.getByRole('heading', { name: 'Objectives' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Objective' })).toBeVisible();
    await expect(page.locator('.objective-grid-wrap [role="row"]:has([role="gridcell"])')).toHaveCount(6);
    if (width === 390) {
      const tabButtonsFit = await page.locator('.objectives-tabs').evaluate((tabs) => {
        const bounds = tabs.getBoundingClientRect();
        return [...tabs.querySelectorAll('button')].every((button) => {
          const buttonBounds = button.getBoundingClientRect();
          return buttonBounds.left >= bounds.left && buttonBounds.right <= bounds.right;
        });
      });
      expect(tabButtonsFit, 'all Objective view controls should fit in the mobile tab bar').toBe(true);
      const capacityLegendFits = await page.locator('.objective-capacity-legend').evaluate((legend) =>
        legend.scrollWidth <= legend.clientWidth);
      expect(capacityLegendFits, 'capacity legend should fit the mobile card').toBe(true);
      const milestoneRowsFit = await page.locator('.objective-milestones-list > div').evaluateAll((rows) =>
        rows.every((row) => [...row.children].every((child) => {
          if (getComputedStyle(child).display === 'none') return true;
          const bounds = child.getBoundingClientRect();
          return bounds.left >= row.getBoundingClientRect().left && bounds.right <= row.getBoundingClientRect().right + 1;
        })));
      expect(milestoneRowsFit, 'milestone details should fit the mobile card').toBe(true);
    }
    const clippedMetricLabels = await page.locator('.objective-metric .metric-top > span')
      .evaluateAll((labels) => labels.filter((label) => label.scrollWidth > label.clientWidth).map((label) => label.textContent));
    expect(clippedMetricLabels).toEqual([]);
    if (width >= 1280) {
      await expect.poll(() => page.evaluate(() => {
        const grid = document.querySelector('.objective-grid-wrap')!.getBoundingClientRect();
        const header = document.querySelector('.objective-grid-wrap .ag-header-cell:last-child')!.getBoundingClientRect();
        return header.right <= grid.right + 1;
      })).toBe(true);
    }
    if (width <= 850) {
      const clippedTrends = await page.locator('.objective-metric-trend')
        .evaluateAll((trends) => trends.filter((trend) => trend.scrollWidth > trend.clientWidth).length);
      expect(clippedTrends).toBe(0);
    }
    const layout = await page.evaluate(() => ({
      pageRight: document.querySelector('.objectives-page')!.getBoundingClientRect().right,
      documentWidth: document.documentElement.scrollWidth,
      lastHeaderRight: document.querySelectorAll('.objective-grid-wrap .ag-header-cell').length
        ? document.querySelector('.objective-grid-wrap .ag-header-cell:last-child')!.getBoundingClientRect().right : 0,
      gridRight: document.querySelector('.objective-grid-wrap')!.getBoundingClientRect().right,
    }));
    expect(layout.documentWidth, `Objectives page overflows at ${width}x${height}`).toBeLessThanOrEqual(width);
    expect(layout.pageRight, `Objectives content overflows at ${width}x${height}`).toBeLessThanOrEqual(width);
    if (width >= 1280) {
      expect(layout.lastHeaderRight, `Table columns overflow at ${width}x${height}`).toBeLessThanOrEqual(layout.gridRight + 1);
    }
  }
  expect(dataRequests.filter((url) => /\/api\/v1\/(objectives|products)/.test(url))).toEqual([]);
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
  await page.goto('http://zenchron.test:4173/#objectives');

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
  await page.goto('http://zenchron.test:4173/#objectives');
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
  await page.goto('http://zenchron.test:4173/#objectives');

  await expect(page.getByRole('button', { name: 'Table', pressed: true })).toBeVisible();
  const objectiveRows = page.locator('.objective-grid-wrap [role="row"]:has([role="gridcell"])');
  await expect(objectiveRows).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Filter by owner' }).click();
  await page.getByRole('option', { name: 'Alex Chen' }).click();
  await expect(objectiveRows).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Filter by owner' }).click();
  await page.getByRole('option', { name: 'All owners' }).click();
  await page.getByRole('combobox', { name: 'Filter by status' }).click();
  await page.getByRole('option', { name: 'At Risk' }).click();
  await expect(objectiveRows).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Filter by status' }).click();
  await page.getByRole('option', { name: 'All statuses' }).click();
  await page.getByRole('combobox', { name: 'Filter by product' }).click();
  await page.getByRole('option', { name: 'Core Product' }).click();
  await expect(objectiveRows).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Filter by product' }).click();
  await page.getByRole('option', { name: 'All products' }).click();
  await expect(objectiveRows.first()).toHaveCSS('height', '42px');
  await page.locator('.objective-grid-wrap .ag-cell[col-id=title]').filter({ hasText: 'Reduce CI time' }).click();
  await expect(page.locator('.objective-grid-wrap [role="row"].ag-row-selected')).toContainText('Reduce CI time');
  await expect(page.locator('.objective-detail-head h3')).toHaveText('Reduce CI time');
  await expect(page.locator('.objective-grid-wrap .ag-cell').first()).toHaveCSS('font-size', '11px');
  await expect(page.locator('.objective-grid-wrap .ag-header-cell-text').first()).toHaveCSS('font-size', '10px');
  await page.getByRole('combobox', { name: 'Filter by due quarter' }).click();
  await page.getByRole('option', { name: 'All due dates' }).click();
  await expect(objectiveRows).toHaveCount(4);
  await page.getByRole('combobox', { name: 'Filter by due quarter' }).click();
  await page.getByRole('option', { name: 'This Quarter' }).click();
  await expect(objectiveRows).toHaveCount(2);

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
  await page.getByRole('textbox', { name: 'Search objectives' }).fill('build latency');
  await expect(page.locator('.objective-kanban-column[aria-label="At Risk"] .objective-item-card'))
    .toContainText('Reduce CI time');
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

test('objective create and edit submit the expected API payloads', async ({ page }) => {
  await useLocalSession(page);
  const productID = 'a'.repeat(32);
  const persisted = [objectives[0]];
  const createdPayloads: unknown[] = [];
  const updatedPayloads: unknown[] = [];
  await page.route('**/api/v1/objectives', async (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON();
      createdPayloads.push(payload);
      const created = {
        ...payload, id: '55555555555555555555555555555555', product: 'Unassigned', status: 'in_progress', progress: 0,
        created_at: '2026-11-04T12:00:00Z', updated_at: '2026-11-04T12:00:00Z',
      };
      persisted.push(created);
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(persisted) });
  });
  await page.route('**/api/v1/objectives/*', async (route) => {
    const payload = route.request().postDataJSON();
    updatedPayloads.push(payload);
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const current = persisted.find((item) => item.id === id)!;
    Object.assign(current, payload);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) });
  });
  await page.route('**/api/v1/products', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify([{ id: productID, name: 'Core Product', description: '', repository_ids: [], created_at: '', updated_at: '' }]) }));
  await page.clock.install({ time: new Date('2026-11-04T12:00:00Z') });
  await page.goto('http://zenchron.test:4173/#objectives');

  await page.getByRole('button', { name: 'New Objective' }).click();
  await page.getByRole('textbox', { name: 'Objective title' }).fill('Expand reliability testing');
  await page.getByRole('textbox', { name: 'Description' }).fill('Add coverage for critical paths.');
  await page.getByRole('textbox', { name: 'Owner' }).fill('Sam Rivera');
  await page.getByLabel('Due date').fill('2026-12-10');
  await page.getByRole('button', { name: 'Create objective' }).click();
  await expect(page.locator('.objective-detail-head h3')).toHaveText('Expand reliability testing');
  expect(createdPayloads).toEqual([{
    title: 'Expand reliability testing', description: 'Add coverage for critical paths.', owner: 'Sam Rivera',
    product_id: '', due_date: '2026-12-10',
  }]);

  await page.getByRole('button', { name: 'Edit objective' }).click();
  await page.getByRole('textbox', { name: 'Objective title' }).fill('Expand reliability review');
  await page.getByRole('textbox', { name: 'Description' }).fill('Expand critical-path coverage.');
  await page.getByRole('textbox', { name: 'Owner' }).fill('Sam Rivera');
  await page.getByLabel('Due date').fill('2027-01-15');
  await page.getByRole('combobox', { name: 'Product', exact: true }).click();
  await page.getByRole('option', { name: 'Core Product' }).click();
  await page.getByRole('combobox', { name: 'Status', exact: true }).click();
  await page.getByRole('option', { name: 'Completed' }).click();
  await page.getByRole('textbox', { name: 'Progress' }).fill('100');
  await page.getByRole('button', { name: 'Save updates' }).click();
  await expect(page.locator('.detail-summary')).toContainText('100% complete');
  await expect(page.locator('.objective-detail-head h3')).toHaveText('Expand reliability review');
  await expect(page.locator('.detail-meta-grid')).toContainText('Sam Rivera');
  await expect(page.locator('.detail-meta-grid')).toContainText('Jan 15, 2027');
  expect(updatedPayloads).toEqual([{
    title: 'Expand reliability review', description: 'Expand critical-path coverage.', owner: 'Sam Rivera',
    due_date: '2027-01-15', status: 'completed', progress: 100, product_id: productID,
  }]);
});
