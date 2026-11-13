import { expect, test, type Page } from '@playwright/test';

const dashboardPort = Number((globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env?.ZENCHRON_E2E_DASHBOARD_PORT) || 4173;

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

test('Objectives in Mock renders the supplied screen and keeps create and edit local', async ({ page }) => {
  const objectiveRequests: string[] = [];
  const productRequests: string[] = [];
  await page.route('**/api/v1/objectives', (route) => {
    objectiveRequests.push(route.request().method());
    return route.fulfill({ status: 401, body: 'authentication required' });
  });
  await page.route('**/api/v1/objectives/*', (route) => {
    objectiveRequests.push(route.request().method());
    return route.fulfill({ status: 401, body: 'authentication required' });
  });
  await page.route('**/api/v1/products', (route) => {
    productRequests.push(route.request().method());
    return route.fulfill({ status: 401, body: 'authentication required' });
  });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 401, body: 'authentication required' }));
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto(`http://127.0.0.1:${dashboardPort}/#objectives`);

  await expect(page.getByRole('heading', { name: 'Objectives' })).toBeVisible();
  await expect(page.locator('.objective-filters .mantine-Select-section[data-position="left"]')).toHaveCount(4);
  await expect(page.locator('.objective-filters .mantine-Select-section[data-position="right"] .tabler-icon-chevron-down')).toHaveCount(4);
  await expect(page.getByRole('combobox', { name: 'Filter by product' })).toHaveValue('All Products');
  await expect(page.getByRole('combobox', { name: 'Filter by owner' })).toHaveValue('All Owners');
  await expect(page.getByRole('combobox', { name: 'Filter by status' })).toHaveValue('All Status');
  await expect(page.locator('.objective-metric').nth(0)).toContainText('Objective Throughput');
  await expect(page.locator('.objective-metric').nth(0)).toContainText('Completed this quarter');
  await expect(page.locator('.objective-metric').nth(1)).toContainText('Objective Success Rate86.7%');
  await expect(page.locator('.objective-metric').nth(1)
    .locator('.objective-metric-trend .mantine-Badge-root')).toHaveText('↑ +6.9 pp');
  for (const index of [2, 3, 4, 5]) {
    await expect(page.locator('.objective-metric').nth(index).locator('small')).toBeHidden();
  }
  await expect(page.locator('.objective-metric.red .tabler-icon-circle-minus')).toHaveCount(1);
  await expect(page.locator('.objective-metric.red .tabler-icon-alert-triangle')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Filter by due quarter' })).toHaveValue('This Quarter');
  const objectiveRows = page.locator('.objective-grid-wrap [role="row"]:has([role="gridcell"])');
  await expect(objectiveRows).toHaveCount(6);
  await expect(page.locator('.objective-grid-wrap .objective-row-actions')).toHaveCount(6);
  await expect(objectiveRows.first().getByRole('button', { name: 'More actions for Launch AI code review v2' })).toBeVisible();
  await page.getByRole('button', { name: 'View blocker details' }).click();
  await expect(page.getByRole('tab', { name: 'Related PRs' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'View all related pull requests' }).click();
  await expect(page.getByRole('tab', { name: 'Related PRs' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'View all objective activity' }).click();
  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await objectiveRows.nth(1).getByRole('button', { name: 'More actions for Improve review velocity' }).click();
  await page.getByRole('menuitem', { name: 'View activity' }).click();
  await expect(page.locator('.objective-detail-panel')).toContainText('Improve review velocity');
  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await objectiveRows.first().click();
  const tableComposition = await page.evaluate(() => {
    const tabs = document.querySelector('.objectives-tabs')!;
    const panel = document.querySelector('.objective-table-panel')!;
    const detail = document.querySelector('.objective-detail-panel')!;
    const capacity = document.querySelector('.objective-capacity')!;
    const tabsBounds = tabs.getBoundingClientRect();
    const panelBounds = panel.getBoundingClientRect();
    const detailBounds = detail.getBoundingClientRect();
    const capacityBounds = capacity.getBoundingClientRect();
    return {
      tabsOutsideTable: !panel.contains(tabs),
      sharedLeftEdge: Math.abs(tabsBounds.left - panelBounds.left) <= 1,
      tabsVerticalOffset: tabsBounds.top - detailBounds.top,
      panelGap: panelBounds.top - tabsBounds.bottom,
      capacityGap: capacityBounds.top - panelBounds.bottom,
    };
  });
  expect(tableComposition.tabsOutsideTable, 'view controls sit outside the objective table card').toBe(true);
  expect(tableComposition.sharedLeftEdge, 'view controls align with the table card').toBe(true);
  expect(tableComposition.tabsVerticalOffset, 'view controls start 10px below the detail card').toBeCloseTo(10, 0);
  expect(tableComposition.panelGap, 'the table card keeps the mock toolbar gap').toBeCloseTo(16, 0);
  expect(tableComposition.capacityGap, 'the capacity card keeps the mock table gap').toBeCloseTo(16, 0);
  await expect(page.locator('.objective-preview-pagination')).toContainText('Showing 1–6 of 42 objectives');
  await expect(page.locator('.objective-preview-pagination nav button')).toHaveText(['1', '2', '3', '4', '5', '7']);
  await page.getByRole('button', { name: 'Page 2' }).click();
  await expect(page.locator('.objective-preview-pagination')).toContainText('Showing 7–12 of 42 objectives');
  await expect(page.locator('.objective-preview-pagination button[aria-current="page"]')).toHaveText('2');
  await page.getByRole('button', { name: 'Page 7' }).click();
  await expect(page.locator('.objective-preview-pagination')).toContainText('Showing 37–42 of 42 objectives');
  await page.getByRole('button', { name: 'Page 1' }).click();
  await expect(page.locator('.objective-grid-wrap .objective-title-cell')).toHaveCount(6);
  await expect(page.locator('.objective-grid-wrap .objective-title-icon')).toHaveCount(6);
  await expect(page.locator('.objective-grid-wrap .objective-title-cell small')).toHaveText([
    'OBJ-1487', 'OBJ-1492', 'OBJ-1501', 'OBJ-1506', 'OBJ-1510', 'OBJ-1517',
  ]);
  const objectiveTitles = page.locator('.objective-grid-wrap .objective-title-cell > span');
  await expect(objectiveTitles.first()).toHaveText('Launch AI code review v2');
  const clippedTitleLabels = await objectiveTitles.evaluateAll((titles) => titles
    .filter((title) => title.scrollWidth > title.clientWidth)
    .map((title) => ({ text: title.textContent, width: title.clientWidth, scrollWidth: title.scrollWidth })));
  expect(clippedTitleLabels, 'all objective titles remain visible above their IDs').toEqual([]);
  const clippedObjectiveCells = await page.locator('.objective-grid-wrap .ag-cell[col-id="owner"], .objective-grid-wrap .ag-cell[col-id="product"], .objective-grid-wrap .ag-cell[col-id="due_date"]')
    .evaluateAll((cells) => cells.filter((cell) => cell.scrollWidth > cell.clientWidth).map((cell) => cell.textContent?.trim()));
  expect(clippedObjectiveCells, 'owner, product, and full due-date text fit their mock table cells').toEqual([]);
  expect(await page.locator('.objective-grid-wrap .mantine-Badge-label').evaluateAll((labels) =>
    labels.filter((label) => label.scrollWidth > label.clientWidth).map((label) => label.textContent?.trim())),
  'objective status and approval labels fit their mock badges').toEqual([]);
  await expect(page.locator('.objective-grid-wrap .objective-status.in_progress')).toHaveText('in progress');
  await expect(page.locator('.objective-grid-wrap .objective-approval-status.changes-req')).toHaveText('Changes Req.');
  const capacityAreas = page.locator('.objective-capacity-chart .recharts-area-area');
  await expect(capacityAreas).toHaveCount(4);
  expect(await capacityAreas.evaluateAll((areas) => areas.every((area) => Number(getComputedStyle(area).opacity) >= .18)),
    'both capacity series retain visible fill').toBe(true);
  await expect(objectiveRows.first()).toHaveClass(/ag-row-selected/);
  await expect(page.locator('.objective-grid-wrap .ag-cell[col-id="title"]').first()).toHaveCSS('font-size', '11px');
  await expect(page.locator('.objective-grid-wrap .objective-status').first()).toHaveCSS('font-size', '9px');
  await expect(page.locator('.objective-preview-overview .objective-overview-card b').first())
    .toHaveCSS('font-size', '12px');
  await expect(page.locator('.objective-owner-avatar')).toHaveCount(6);
  await expect(page.locator('.objective-approval-status.changes-req')).toHaveCount(1);
  await expect(page.locator('.objective-detail-panel')).toContainText('Launch AI code review v2');
  await expect(page.locator('.objective-detail-head .objective-preview-id')).toHaveText('OBJ-1487');
  await expect(page.locator('.objective-detail-head > div h3 .objective-preview-id')).toBeVisible();
  await expect(page.locator('.objective-detail-due-date')).toHaveText('Due Jan 27, 2025');
  const detailTabs = page.getByRole('tablist', { name: 'Objective details' });
  await expect(detailTabs).toHaveCSS('border-radius', '8px');
  await expect(detailTabs.getByRole('tab', { name: 'Overview', exact: true })).toHaveCSS('background-image', /linear-gradient/);
  const summaryLayout = await page.locator('.detail-summary').evaluate((summary) => {
    const progress = summary.querySelector('.mantine-Progress-root')!.getBoundingClientRect();
    const completion = summary.children[1].getBoundingClientRect();
    const dueDate = summary.querySelector('.objective-detail-due-date')!.getBoundingClientRect();
    return { progressWidth: progress.width, dateLeft: dueDate.left, progressRight: progress.right, completionRight: completion.right, progressLeft: progress.left };
  });
  expect(summaryLayout.progressWidth).toBeLessThanOrEqual(220);
  expect(summaryLayout.progressLeft - summaryLayout.completionRight).toBeLessThanOrEqual(8);
  expect(summaryLayout.progressRight).toBeLessThan(summaryLayout.dateLeft);
  await expect(page.locator('.objective-preview-blocker')).toContainText('Model training run (PR #1462)');
  const relatedPRRows = page.locator('.objective-preview-related-prs li');
  await expect(relatedPRRows).toHaveCount(4);
  await expect(relatedPRRows.locator('svg')).toHaveCount(4);
  await expect(relatedPRRows.locator('em')).toHaveText(['Review', 'Merged', 'Review', 'Open']);
  expect(await relatedPRRows.evaluateAll((rows) => rows.map((row) => getComputedStyle(row, '::before').content)))
    .toEqual(['none', 'none', 'none', 'none']);
  expect(await relatedPRRows.locator('em').evaluateAll((badges) => badges.map((badge) => badge.className)))
    .toEqual(['objective-preview-pr-status review', 'objective-preview-pr-status merged',
      'objective-preview-pr-status review', 'objective-preview-pr-status open']);
  await expect(page.locator('.objective-milestones-list > div')).toHaveCount(4);
  await expect(page.locator('.objective-milestone-progress b')).toHaveText(['100%', '100%', '60%', '0%']);
  await page.locator('.ag-row').filter({ hasText: 'Improve review velocity' }).click();
  await expect(page.locator('.objective-detail-panel')).toContainText('Improve review velocity');
  await page.getByRole('button', { name: 'Favorite objective' }).click();
  await expect(page.getByRole('button', { name: 'Remove objective favorite' })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.ag-row').filter({ hasText: 'Launch AI code review v2' }).click();
  await expect(page.getByRole('button', { name: 'Favorite objective' })).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.ag-row').filter({ hasText: 'Improve review velocity' }).click();
  await expect(page.getByRole('button', { name: 'Remove objective favorite' })).toHaveAttribute('aria-pressed', 'true');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy objective link' }).click();
  const objectiveLink = await page.evaluate(() => navigator.clipboard.readText());
  expect(objectiveLink).toContain('?objective=OBJ-1492#objectives');
  await page.getByRole('button', { name: 'More objective actions' }).click();
  await page.getByRole('menuitem', { name: 'View activity' }).click();
  await expect(page.locator('.objective-detail-activity > div')).toHaveCount(4);
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  const detailComposition = await page.evaluate(() => {
    const detail = document.querySelector('.objective-detail-panel')!;
    const detailBounds = detail.getBoundingClientRect();
    const layoutBounds = document.querySelector('.objective-content-grid')!.getBoundingClientRect();
    const milestones = document.querySelector('.objective-milestones-card')!;
    return {
      nested: detail.contains(milestones),
      detailHeight: detailBounds.height,
      layoutHeight: layoutBounds.height,
      milestonesBottom: milestones.getBoundingClientRect().bottom,
      detailBottom: detailBounds.bottom,
    };
  });
  expect(detailComposition.nested).toBe(true);
  expect(Math.abs(detailComposition.detailHeight - detailComposition.layoutHeight)).toBeLessThanOrEqual(1);
  expect(detailComposition.milestonesBottom).toBeLessThanOrEqual(detailComposition.detailBottom - 8);
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
    .evaluateAll((headers) => headers.filter((header) => {
      const text = document.createRange();
      text.selectNodeContents(header);
      return text.getBoundingClientRect().width > header.clientWidth + .5;
    }).map((header) => header.textContent));
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
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.objective-detail-head h3')).toContainText('Preview-only objective');
  await expect(page.locator('.objective-action-notice')).toHaveText('Objective created in this preview only');
  await expect(page.locator('.objective-metric').nth(2)).toContainText('43');
  await page.getByRole('button', { name: 'More objective actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit objective' }).click();
  await page.locator('.detail-edit-grid').getByRole('textbox', { name: 'Progress' }).fill('40');
  await page.getByRole('button', { name: 'Save updates' }).click();
  await expect(page.locator('.objective-action-notice')).toHaveText('Objective updated in this preview only');
  await expect(page.locator('.detail-summary')).toContainText('40% complete');
  expect(objectiveRequests).toEqual([]);
  expect(productRequests).toEqual([]);
});

test('Objectives preview deep link selects the referenced objective', async ({ page }) => {
  await page.route('**/api/v1/**', (route) => route.fulfill({ status: 401, body: 'preview fixture expected' }));
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto(`http://127.0.0.1:${dashboardPort}/?objective=OBJ-1492#objectives`);
  await expect(page.locator('.objective-detail-panel')).toContainText('Improve review velocity');
  await expect(page.locator('.objective-grid-wrap [role="row"].ag-row-selected')).toContainText('Improve review velocity');
});

test('Objectives mock layout stays within desktop, tablet, and mobile viewports', async ({ page }) => {
  const dataRequests: string[] = [];
  await page.route('**/api/v1/**', (route) => {
    dataRequests.push(route.request().url());
    return route.fulfill({ status: 401, body: 'layout-only test' });
  });
  for (const [width, height] of [[1668, 750], [1440, 900], [1280, 800], [768, 1024], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.goto(`http://127.0.0.1:${dashboardPort}/#objectives`);
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
      const milestoneCardContainsRows = await page.locator('.objective-milestones-card').evaluate((card) => {
        const cardBounds = card.getBoundingClientRect();
        const rows = [...card.querySelectorAll('.objective-milestones-list > div')];
        return card.scrollHeight <= card.clientHeight
          && rows.every((row) => row.getBoundingClientRect().bottom <= cardBounds.bottom + 1);
      });
      expect(milestoneCardContainsRows, 'all four milestones should remain visible inside the mobile card').toBe(true);
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
  await page.goto(`http://zenchron.test:${dashboardPort}/#objectives`);

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
  await page.goto(`http://zenchron.test:${dashboardPort}/#objectives`);
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
  await page.goto(`http://zenchron.test:${dashboardPort}/#objectives`);

  await expect(page.getByRole('button', { name: 'Table', pressed: true })).toBeVisible();
  const objectiveRows = page.locator('.objective-grid-wrap [role="row"]:has([role="gridcell"])');
  await expect(objectiveRows).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Filter by owner' }).click();
  await page.getByRole('option', { name: 'Alex Chen' }).click();
  await expect(objectiveRows).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Filter by owner' }).click();
  await page.getByRole('option', { name: 'All Owners' }).click();
  await page.getByRole('combobox', { name: 'Filter by status' }).click();
  await page.getByRole('option', { name: 'At Risk' }).click();
  await expect(objectiveRows).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Filter by status' }).click();
  await page.getByRole('option', { name: 'All Status' }).click();
  await page.getByRole('combobox', { name: 'Filter by product' }).click();
  await page.getByRole('option', { name: 'Core Product' }).click();
  await expect(objectiveRows).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Filter by product' }).click();
  await page.getByRole('option', { name: 'All Products' }).click();
  await expect(objectiveRows.first()).toHaveCSS('height', '42px');
  await page.locator('.objective-grid-wrap .ag-cell[col-id=title]').filter({ hasText: 'Reduce CI time' }).click();
  await expect(page.locator('.objective-grid-wrap [role="row"].ag-row-selected')).toContainText('Reduce CI time');
  await expect(page.locator('.objective-detail-head h3')).toHaveText('Reduce CI time22222222');
  await expect(page.locator('.objective-grid-wrap .ag-cell[col-id="title"]').first()).toHaveCSS('font-size', '11px');
  await expect(page.locator('.objective-grid-wrap .ag-cell[col-id="status"]').first()).toHaveCSS('font-size', '11.5px');
  await expect(page.locator('.objective-grid-wrap .ag-header-cell-text').first()).toHaveCSS('font-size', '8.5px');
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
  await expect(page.locator('.objective-detail-head h3')).toHaveText('Ship API v211111111');

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
  await expect(planningTab).toHaveCSS('background-color', 'rgb(78, 37, 129)');

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
  const updatedRecords: unknown[] = [];
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
    updatedRecords.push({ id: current.id, title: current.title, due_date: current.due_date,
      status: current.status, progress: current.progress });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) });
  });
  await page.route('**/api/v1/products', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify([{ id: productID, name: 'Core Product', description: '', repository_ids: [], created_at: '', updated_at: '' }]) }));
  await page.clock.install({ time: new Date('2026-11-04T12:00:00Z') });
  await page.goto(`http://zenchron.test:${dashboardPort}/#objectives`);

  await page.getByRole('button', { name: 'New Objective' }).click();
  await page.getByRole('textbox', { name: 'Objective title' }).fill('Expand reliability testing');
  await page.getByRole('textbox', { name: 'Description' }).fill('Add coverage for critical paths.');
  await page.getByRole('textbox', { name: 'Owner' }).fill('Sam Rivera');
  await page.getByLabel('Due date').fill('2026-12-10');
  await page.getByRole('button', { name: 'Create objective' }).click();
  await expect(page.locator('.objective-detail-head h3')).toHaveText('Expand reliability testing55555555');
  await expect(page.locator('.objective-grid-wrap [role="row"].ag-row-selected'))
    .toContainText('Expand reliability testing');
  expect(createdPayloads).toEqual([{
    title: 'Expand reliability testing', description: 'Add coverage for critical paths.', owner: 'Sam Rivera',
    product_id: '', due_date: '2026-12-10',
  }]);

  await page.getByRole('button', { name: 'More objective actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit objective' }).click();
  const editForm = page.locator('.detail-edit-grid');
  await editForm.getByRole('textbox', { name: 'Objective title' }).fill('Expand reliability review');
  await editForm.getByRole('textbox', { name: 'Description' }).fill('Expand critical-path coverage.');
  await editForm.getByRole('textbox', { name: 'Owner' }).fill('Sam Rivera');
  await editForm.getByLabel('Due date').fill('2027-01-15');
  await editForm.getByRole('combobox', { name: 'Product', exact: true }).click();
  await page.getByRole('option', { name: 'Core Product' }).click();
  await editForm.getByRole('combobox', { name: 'Status', exact: true }).click();
  await page.getByRole('option', { name: 'Completed' }).click();
  await editForm.getByRole('textbox', { name: 'Progress' }).fill('100');
  await page.getByRole('button', { name: 'Save updates' }).click();
  await expect.poll(() => updatedPayloads.length).toBe(1);
  expect(updatedPayloads).toEqual([{
    title: 'Expand reliability review', description: 'Expand critical-path coverage.', owner: 'Sam Rivera',
    due_date: '2027-01-15', status: 'completed', progress: 100, product_id: productID,
  }]);
  expect(updatedRecords).toEqual([{
    id: '55555555555555555555555555555555', title: 'Expand reliability review', due_date: '2027-01-15',
    status: 'completed', progress: 100,
  }]);
  await expect(page.locator('.detail-edit-grid')).toHaveCount(0);
  await expect(page.locator('.detail-summary')).toContainText('100% complete');
  await expect(page.locator('.objective-detail-head h3')).toHaveText('Expand reliability review55555555');
  await expect(page.locator('.detail-meta-grid')).toContainText('Sam Rivera');
  await expect(page.locator('.objective-detail-due-date')).toHaveText('Due Jan 15, 2027');
  await expect(page.locator('.objective-action-notice')).toHaveText('Objective updated');
});

test('Objectives in Live uses the approved layout with honest unavailable parts', async ({ page }) => {
  await useLocalSession(page);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page.route('**/api/v1/objectives', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(objectives),
  }));
  await page.clock.install({ time: new Date('2026-11-04T12:00:00Z') });
  await page.setViewportSize({ width: 1672, height: 941 });
  // A deployed host is always Live, whatever the address asks for.
  await page.goto(`http://zenchron.test:${dashboardPort}/?mode=mock#objectives`);

  const metrics = page.locator('.objective-metrics-preview .objective-metric');
  await expect(metrics).toHaveCount(6);
  await expect(metrics.nth(0)).toContainText('Objective Throughput0Completed objectives');
  await expect(metrics.nth(1)).toContainText('Objective Success Rate0%');
  await expect(metrics.nth(2)).toContainText('4');
  await expect(page.locator('.objective-metric-trend')).toHaveCount(0);
  await expect(page.locator('.objective-preview-layout .objective-grid-wrap [role="row"]:has([role="gridcell"])')).toHaveCount(2);
  await expect(page.locator('.objective-grid-wrap .objective-title-cell small').first()).toHaveText('11111111');
  await expect(page.locator('.objective-grid-wrap .ag-cell[col-id="approval"]').first()).toHaveText('—');
  await expect(page.locator('.objective-grid-wrap .ag-cell[col-id="workflow_count"]').first()).toHaveText('—');
  await expect(page.locator('.objective-preview-pagination')).toContainText('Showing 1–2 of 2 objectives');
  await expect(page.getByRole('textbox', { name: 'Search objectives' })).toBeVisible();
  await expect(page.locator('.objective-capacity')).toContainText('Unavailable: the control plane does not record when objectives were planned or completed.');
  await expect(page.locator('.objective-capacity-chart')).toHaveCount(0);

  await expect(page.locator('.objective-detail-head .objective-preview-id')).toHaveText('11111111');
  await expect(page.locator('.objective-detail-due-date')).toHaveText('Due Nov 30, 2026');
  await expect(page.locator('.detail-meta-grid')).toHaveText(/Owner\s*Alex Chen\s*Product\s*Core Product\s*Approval\s*Unavailable\s*Workflows\s*Unavailable/);
  await expect(page.getByRole('button', { name: 'Favorite objective' })).toBeDisabled();
  const overview = page.locator('.objective-preview-overview .objective-overview-card');
  await expect(overview).toHaveCount(6);
  await expect(overview.nth(0)).toContainText('Finish the API launch.');
  await expect(overview.nth(1)).toContainText('Unavailable: the control plane does not record blockers');
  await expect(overview.nth(2)).toContainText('Unavailable: the control plane does not record acceptance criteria');
  await expect(overview.nth(3)).toContainText('Unavailable: the control plane does not record linked pull requests');
  await expect(overview.nth(4)).toContainText('Target date: Nov 30, 2026');
  await expect(overview.nth(4)).toContainText('Created: Oct 1, 2026');
  await expect(overview.nth(5)).toContainText('Unavailable: the control plane does not record activity');
  await expect(page.locator('.objective-milestones-card')).toContainText('Unavailable');
  await expect(page.locator('.objective-milestones-list')).toHaveCount(0);
  for (const [tab, what] of [['Milestones', 'milestones'], ['Related PRs', 'linked pull requests'], ['Activity', 'activity']]) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page.getByRole('tabpanel')).toContainText(`Unavailable: the control plane does not record ${what} for objectives.`);
  }
  await expect(page.locator('.objectives-page')).not.toContainText(/OBJ-|Model training run|86\.7%/);

  await page.getByRole('button', { name: 'New Objective' }).click();
  await page.getByRole('textbox', { name: 'Objective title' }).fill('   ');
  await page.getByRole('button', { name: 'Create objective' }).click();
  await expect(page.getByRole('dialog')).toContainText('Add an objective title');
  expect(writes).toEqual([]);
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 844 });
  const moreActions = page.getByRole('button', { name: 'More objective actions' });
  await moreActions.scrollIntoViewIfNeeded();
  await expect(moreActions).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('Objectives in Live reports failed loads and saves without showing fixtures', async ({ page }) => {
  await useLocalSession(page);
  let listStatus = 500;
  await page.route('**/api/v1/objectives', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 400, body: 'owner is too long' })
    : route.fulfill({ status: listStatus, contentType: 'application/json', body: JSON.stringify(listStatus === 200 ? objectives : {}) }));
  await page.clock.install({ time: new Date('2026-11-04T12:00:00Z') });
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto(`http://zenchron.test:${dashboardPort}/#objectives`);

  await expect(page.locator('.objective-grid-wrap').getByRole('alert')).toContainText('Could not load objectives.');
  await expect(page.locator('.objective-metric').nth(2)).toContainText('—');
  await expect(page.locator('.objective-metric').nth(0)).toContainText('—');
  await expect(page.locator('.objectives-page')).not.toContainText(/Launch AI code review v2|OBJ-/);
  await expect(page.locator('.objective-detail-empty')).toBeVisible();

  await page.getByRole('button', { name: 'New Objective' }).click();
  await page.getByRole('textbox', { name: 'Objective title' }).fill('Rejected objective');
  await page.getByRole('dialog').getByRole('button', { name: 'Create objective' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('owner is too long');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  listStatus = 200;
  await page.getByRole('button', { name: 'Retry loading objectives' }).click();
  await expect(page.locator('.objective-grid-wrap [role="row"]:has([role="gridcell"])')).toHaveCount(2);
  await expect(page.locator('.objective-detail-head h3')).toContainText('Ship API v2');
});
