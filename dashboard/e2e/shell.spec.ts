import { expect, test } from '@playwright/test';

test('shared shell, headings, and metric cards keep their visual scale across routes', async ({ page }) => {
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/');
  const referenceWidth = await page.locator('.sidebar').evaluate((sidebar) =>
    Math.round(parseFloat(getComputedStyle(sidebar).width)),
  );
  expect(referenceWidth, 'full screen reference sidebar width').toBe(224);
  const pageSelectors: Record<string, { title: string; panel: string }> = {
    overview: { title: '.greeting h1', panel: '.activity-panel h3' },
    objectives: { title: '.page-heading h2', panel: '.panel-heading h3' },
    workflows: { title: '.page-heading h2', panel: '.workflow-subheading h3' },
    agents: { title: '.page-heading h2', panel: '.agents-panel-heading h3' },
    projects: { title: '.page-heading h2', panel: '.projects-panel-heading h3' },
    workspace: { title: '.page-heading h2', panel: '.workspace-panel-heading h3' },
    reviews: { title: '.page-heading h2', panel: '.reviews-panel-heading h3' },
    integrations: { title: '.page-heading h2', panel: '.system-section-heading h3' },
    reports: { title: '.reports-greeting .page-heading h1', panel: '.reports-panel-heading h3' },
    settings: { title: '.page-heading h2', panel: '.system-setting-heading h3' },
  };
  for (const route of Object.keys(pageSelectors)) {
    if (route !== 'overview') {
      await page.evaluate((hash) => { window.location.hash = `#${hash}`; }, route);
      await expect(page.locator('.app-shell')).toHaveClass(new RegExp(`${route}-shell`));
    }
    const selectors = pageSelectors[route];
    await expect(page.locator(selectors.panel).first(), `${route}: panel title exists`).toBeVisible();
    await expect(page.locator('.shared-panel-heading h3:visible').first(), `${route}: visible shared panel heading`).toBeVisible();
    const styles = await page.evaluate(({ title, panel }) => ({
      sidebarWidth: getComputedStyle(document.querySelector('.sidebar')!).width,
      bodyFont: getComputedStyle(document.body).fontFamily,
      navigationFont: getComputedStyle(document.querySelector('.nav-link')!).fontSize,
      navigationWeight: getComputedStyle(document.querySelector('.nav-link')!).fontWeight,
      navigationFontFamily: getComputedStyle(document.querySelector('.nav-link')!).fontFamily,
      topbarHeight: getComputedStyle(document.querySelector('.topbar')!).height,
      hasSharedHeading: title ? Boolean(document.querySelector(title)?.closest('.page-heading')) : undefined,
      titleFont: title ? getComputedStyle(document.querySelector(title)!).fontSize : undefined,
      titleWeight: title ? getComputedStyle(document.querySelector(title)!).fontWeight : undefined,
      titleFontFamily: title ? getComputedStyle(document.querySelector(title)!).fontFamily : undefined,
      panelHeadingSize: getComputedStyle(document.querySelector(panel)!).fontSize,
      panelHeadingWeight: getComputedStyle(document.querySelector(panel)!).fontWeight,
      panelFontFamily: getComputedStyle(document.querySelector(panel)!).fontFamily,
      sharedPanelHeadings: Array.from(document.querySelectorAll('.shared-panel-heading:not(.entity-detail-heading) h3'), (heading) => ({
        size: getComputedStyle(heading).fontSize,
        weight: getComputedStyle(heading).fontWeight,
      })),
    }), selectors);
    expect(Math.round(parseFloat(styles.sidebarWidth))).toBe(224);
    expect(styles.bodyFont).toContain('Inter');
    expect(styles.navigationFontFamily).toBe(styles.bodyFont);
    expect(styles.titleFontFamily).toBe(styles.bodyFont);
    expect(styles.panelFontFamily).toBe(styles.bodyFont);
    expect(styles.navigationFont).toBe('15px');
    expect(styles.navigationWeight).toBe('400');
    expect((await page.locator('.nav-link').first().boundingBox())?.height).toBe(44);
    const workspaceLink = page.locator('.nav-link').filter({ hasText: 'Product Workspace' });
    await expect(workspaceLink, 'long navigation label remains readable').toHaveCSS('white-space', 'normal');
    expect(await workspaceLink.evaluate((link) => link.scrollWidth <= link.clientWidth),
      'long navigation label wraps inside the sidebar').toBe(true);
    expect(styles.topbarHeight).toBe('80px');
    if (selectors.title) {
      if (route !== 'overview') expect(styles.hasSharedHeading).toBe(true);
      expect(styles.titleFont).toBe('22px');
      expect(styles.titleWeight).toBe('650');
      if (route === 'reports') {
        await expect(page.locator('.reports-greeting p')).toHaveCSS('font-size', '12px');
        const description = await page.locator('.reports-greeting p').evaluate((element) => ({
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }));
        expect(description.scrollWidth, 'reports description is not truncated').toBeLessThanOrEqual(description.clientWidth);
      }
    }
    if (route === 'reports') {
      await expect(page.locator('.reports-page .page-heading')).toHaveCount(0);
      await expect(page.locator('.reports-page .reports-scope-bar')).toBeVisible();
    }
    expect(styles.panelHeadingSize, `${route}: panel heading size`).toBe('14px');
    expect(styles.panelHeadingWeight, `${route}: panel heading weight`).toBe('600');
    expect(styles.sharedPanelHeadings.every(({ size, weight }) => size === '14px' && weight === '600'),
      `${route}: every shared panel heading uses the common scale`).toBe(true);
    if (['overview', 'agents', 'workspace', 'reviews', 'integrations', 'settings', 'objectives', 'projects', 'reports'].includes(route)) {
      await expect(page.locator('.shared-panel-surface').first(), `${route}: shared panel surface`)
        .toHaveCSS('border-radius', '11px');
    }
    if (!['workflows', 'settings'].includes(route)) {
      await expect(page.locator('.shared-panel-heading p').first(), `${route}: shared panel description`)
        .toHaveCSS('font-size', '11px');
    }
    if (route === 'workspace') {
      await expect(page.locator('.workspace-directory-heading p'), 'workspace directory description uses shared scale')
        .toHaveCSS('font-size', '11px');
    }
  }

  await page.setViewportSize({ width: 1505, height: 800 });
  const framedReferenceWidth = await page.locator('.sidebar').evaluate((sidebar) =>
    Math.round(parseFloat(getComputedStyle(sidebar).width)),
  );
  expect(framedReferenceWidth, 'monitor screen reference sidebar width').toBe(224);

  await page.setViewportSize({ width: 390, height: 844 });
  for (const [route, selectors] of Object.entries(pageSelectors)) {
    await page.evaluate((hash) => { window.location.hash = `#${hash}`; }, route);
    await expect(page.locator('.app-shell')).toHaveClass(new RegExp(`${route}-shell`));
    const panel = route === 'workflows' ? '.workflow-mobile-detail-panel .shared-panel-heading h3' : selectors.panel;
    await expect(page.locator(panel).first()).toBeVisible();
    const styles = await page.evaluate(({ title, panel }) => ({
      navigationFont: getComputedStyle(document.querySelector('.nav-link')!).fontSize,
      navigationWeight: getComputedStyle(document.querySelector('.nav-link')!).fontWeight,
      titleFont: getComputedStyle(document.querySelector(title)!).fontSize,
      panelHeadingSize: getComputedStyle(document.querySelector(panel)!).fontSize,
      panelHeadingWeight: getComputedStyle(document.querySelector(panel)!).fontWeight,
    }), { title: selectors.title, panel });
    expect(styles.titleFont, `${route}: mobile title size`).toBe('20px');
    expect(styles.navigationWeight, `${route}: mobile navigation weight`).toBe('400');
    expect(styles.panelHeadingSize, `${route}: mobile panel heading size`).toBe(route === 'workflows' ? '11px' : '13px');
    expect(styles.panelHeadingWeight, `${route}: mobile panel heading weight`).toBe('600');
    if (!['workflows', 'settings'].includes(route)) {
      await expect(page.locator('.shared-panel-heading p').first(), `${route}: mobile shared panel description`)
        .toHaveCSS('font-size', '10px');
    }
    if (route === 'reviews') {
      await expect(page.locator('.topbar .greeting'), 'mobile reviews uses its page heading').toBeHidden();
      await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();
      const sectionOrder = await page.evaluate(() => [
        '.reviews-title-row', '.reviews-tabs', '.reviews-metrics', '.reviews-workspace',
      ].map((selector) => document.querySelector(selector)!.getBoundingClientRect().top));
      expect(sectionOrder[0]).toBeLessThan(sectionOrder[1]);
      expect(sectionOrder[1]).toBeLessThan(sectionOrder[2]);
      expect(sectionOrder[2]).toBeLessThan(sectionOrder[3]);
      const metricColumns = await page.locator('.reviews-metrics').evaluate((grid) =>
        getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length,
      );
      expect(metricColumns).toBe(3);
    }
    if (route === 'workspace') {
      await expect(page.locator('.workspace-directory-heading p'), 'workspace directory description uses mobile scale')
        .toHaveCSS('font-size', '10px');
    }
  }

  const metricCards = {
    overview: '.metric-card.shared-metric-card',
    objectives: '.objective-metric.shared-metric-card',
    agents: '.agents-metric.shared-metric-card',
    projects: '.projects-metric.shared-metric-card',
    workspace: '.workspace-metric.shared-metric-card',
    reviews: '.reviews-metric.shared-metric-card',
    reports: '.reports-metric.shared-metric-card',
  };
  await page.setViewportSize({ width: 1672, height: 941 });
  for (const [route, selector] of Object.entries(metricCards)) {
    await page.evaluate((hash) => { window.location.hash = `#${hash}`; }, route);
    const metric = page.locator(selector).first();
    await expect(metric, `${route}: mobile shared metric card`).toBeVisible();
    await expect(metric, `${route}: shared metric card`).toBeVisible();
    const styles = await metric.evaluate((card) => ({
      label: getComputedStyle(card.querySelector('.metric-top')!).fontSize,
      value: getComputedStyle(card.querySelector('strong')!).fontSize,
      valueText: card.querySelector('strong')?.textContent?.trim(),
      weight: getComputedStyle(card.querySelector('strong')!).fontWeight,
      letterSpacing: getComputedStyle(card.querySelector('strong')!).letterSpacing,
      detail: card.querySelector('small') ? getComputedStyle(card.querySelector('small')!).fontSize : undefined,
      radius: getComputedStyle(card).borderRadius,
    }));
    expect(styles.label, `${route}: metric label size`).toBe('12px');
    expect(styles.value, `${route}: metric value size`).toBe(
      styles.valueText === 'Unavailable' ? '14px' : '26px',
    );
    expect(styles.weight, `${route}: metric value weight`).toBe('650');
    expect(styles.letterSpacing, `${route}: metric value letter spacing`).toBe('-0.8px');
    expect(styles.radius, `${route}: metric card radius`).toBe(route === 'overview' ? '13px' : '10px');
    if (styles.detail) expect(styles.detail, `${route}: metric detail size`).toBe('11px');
  }

  await page.evaluate(() => { window.location.hash = '#objectives'; });
  const compactMetric = page.locator('.objective-metric.shared-metric-card').nth(2);
  await expect(compactMetric).toBeVisible();
  const compactStyles = await compactMetric.evaluate((card) => ({
    label: getComputedStyle(card.querySelector('.metric-top')!).fontSize,
    value: getComputedStyle(card.querySelector('strong')!).fontSize,
    detail: getComputedStyle(card.querySelector('small')!).fontSize,
    detailFits: card.querySelector('small')!.scrollHeight <= card.querySelector('small')!.clientHeight,
  }));
  expect(compactStyles).toEqual({ label: '12px', value: '26px', detail: '11px', detailFits: true });

  await page.setViewportSize({ width: 390, height: 844 });
  for (const [route, selector] of Object.entries(metricCards)) {
    await page.evaluate((hash) => { window.location.hash = `#${hash}`; }, route);
    const metric = page.locator(selector).first();
    const styles = await metric.evaluate((card) => ({
      label: getComputedStyle(card.querySelector('.metric-top')!).fontSize,
      value: getComputedStyle(card.querySelector('strong')!).fontSize,
      letterSpacing: getComputedStyle(card.querySelector('strong')!).letterSpacing,
      valueText: card.querySelector('strong')?.textContent?.trim(),
      detail: card.querySelector('small') ? getComputedStyle(card.querySelector('small')!).fontSize : undefined,
    }));
    expect(styles.label, `${route}: mobile metric label size`).toBe('11px');
    expect(styles.letterSpacing, `${route}: mobile metric value letter spacing`).toBe('-0.8px');
    expect(styles.value, `${route}: mobile metric value size`).toBe(
      styles.valueText === 'Unavailable' ? '14px' : '21px',
    );
    if (styles.detail) expect(styles.detail, `${route}: mobile metric detail size`).toBe('10px');
  }

  await page.evaluate(() => { window.location.hash = '#objectives'; });
  const compactMobile = page.locator('.objective-metric.shared-metric-card').nth(2);
  const compactMobileStyles = await compactMobile.evaluate((card) => ({
    label: getComputedStyle(card.querySelector('.metric-top')!).fontSize,
    value: getComputedStyle(card.querySelector('strong')!).fontSize,
    detail: getComputedStyle(card.querySelector('small')!).fontSize,
  }));
    expect(compactMobileStyles).toEqual({ label: '11px', value: '21px', detail: '10px' });
});

test('desktop sidebar keeps the compact width at reference and regular monitor sizes', async ({ page }) => {
  for (const width of [1672, 1505]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#reports');
    await expect(page.locator('.reports-page')).toBeVisible();
    expect(await page.locator('.sidebar').evaluate((sidebar) => sidebar.getBoundingClientRect().width)).toBe(224);
    expect(await page.locator('.reports-scope-bar').evaluate((bar) => bar.getBoundingClientRect().x)).toBe(242);
    expect(await page.locator('.sidebar nav .nav-link').evaluateAll((links) =>
      links.every((link) => link.scrollWidth <= link.clientWidth),
    ), 'all desktop navigation labels fit without clipping').toBe(true);
  }
});

test('mobile overview matches the phone shell and keeps workflow/reviews accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Reviews', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();
  await expect(page.locator('.search-box')).toBeHidden();
  await expect(page.locator('.workspace-button')).toBeHidden();
  await expect(page.locator('.sidebar nav .nav-link:visible')).toHaveCount(5);
  await expect(page.locator('.metric-grid .metric-card:visible')).toHaveCount(4);
  await expect(page.locator('.metric-card.pr-queue-metric')).toBeHidden();
  await expect(page.locator('.overview-shell .workflow-panel')).toBeHidden();
  await expect(page.locator('.activity-panel')).toBeVisible();
  await expect.poll(() => page.locator('.nav-link[href="#overview"] .nav-label').evaluate((element) =>
    getComputedStyle(element, '::after').content,
  )).toBe('"Home"');
  await expect.poll(() => page.locator('.nav-link[href="#settings"] .nav-label').evaluate((element) =>
    getComputedStyle(element, '::after').content,
  )).toBe('"Profile"');
  await expect(page.locator('.sidebar nav')).toHaveCSS('position', 'fixed');
  await expect(page.locator('.activity-list')).toContainText('zenchron-engineering-os');
  const metricColumns = await page.locator('.metric-grid').evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(' ').length,
  );
  expect(metricColumns).toBe(2);
  await page.getByRole('link', { name: 'Workflows', exact: true }).click();
  await expect(page.locator('.workflow-page')).toBeVisible();
  await page.getByRole('link', { name: 'Reviews', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reviews' })).toBeVisible();
  await expect(page.locator('.reviews-title-copy p')).toBeVisible();
});
