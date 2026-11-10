import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:4173' });

test('shared shell, headings, and metric cards keep their visual scale across routes', async ({ page }) => {
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto('/');
  const referenceWidth = await page.locator('.sidebar').evaluate((sidebar) =>
    Math.round(parseFloat(getComputedStyle(sidebar).width)),
  );
  expect(referenceWidth, 'full screen reference sidebar width').toBe(247);
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link'))
    .toHaveText([
      'Overview', 'Objectives', 'Workflows', 'Agents', 'Product Workspace', 'Reviews', 'Integrations', 'Reports', 'Settings',
    ]);
  await expect(page.locator('.sidebar-bottom strong')).toHaveText('Zenchron Engineering');
  await expect(page.locator('.sidebar-bottom p')).toHaveText('The AI-native engineering operating system.');
  const pageSelectors: Record<string, { title: string; panel: string }> = {
    overview: { title: '.greeting h1', panel: '.shared-panel-heading h3' },
    objectives: { title: '.page-heading h2', panel: '.shared-panel-heading h3' },
    workflows: { title: '.page-heading h2', panel: '.shared-panel-heading h3' },
    agents: { title: '.page-heading h2', panel: '.shared-panel-heading h3' },
    projects: { title: '.page-heading h2', panel: '.shared-panel-heading h3' },
    workspace: { title: '.workspace-mock-heading h1', panel: '.shared-panel-heading h3' },
    reviews: { title: '.page-heading h2', panel: '.shared-panel-heading h3' },
    integrations: { title: '.page-heading h2', panel: '.shared-panel-heading h3' },
    reports: { title: '.reports-greeting .page-heading h1', panel: '.shared-panel-heading h3' },
    settings: { title: '.page-heading h2', panel: '.shared-panel-heading h3' },
  };
  for (const route of Object.keys(pageSelectors)) {
    if (route !== 'overview') {
      await page.evaluate((hash) => { window.location.hash = `#${hash}`; }, route);
      await expect(page.locator('.app-shell')).toHaveClass(new RegExp(`${route}-shell`));
    }
    const selectors = pageSelectors[route];
    await expect(page.locator(`${selectors.panel}:visible`).first(), `${route}: visible shared panel heading`).toBeVisible();
    const styles = await page.evaluate(() => ({
      sidebarWidth: getComputedStyle(document.querySelector('.sidebar')!).width,
      sidebarPaddingTop: getComputedStyle(document.querySelector('.sidebar')!).paddingTop,
      brandFontSize: getComputedStyle(document.querySelector('.sidebar > .brand')!).fontSize,
      brandGap: getComputedStyle(document.querySelector('.sidebar > .brand')!).gap,
      bodyFont: getComputedStyle(document.body).fontFamily,
      navigationGap: getComputedStyle(document.querySelector('.nav-link')!).gap,
      navigationPaddingLeft: getComputedStyle(document.querySelector('.nav-link')!).paddingLeft,
      navigationRowGap: getComputedStyle(document.querySelector('.sidebar nav')!).rowGap,
      navigationFont: getComputedStyle(document.querySelector('.nav-link')!).fontSize,
      navigationWeight: getComputedStyle(document.querySelector('.nav-link')!).fontWeight,
      navigationFontFamily: getComputedStyle(document.querySelector('.nav-link')!).fontFamily,
      topbarHeight: getComputedStyle(document.querySelector('.topbar')!).height,
      panelHeadingToken: getComputedStyle(document.querySelector('.app-shell')!).getPropertyValue('--panel-heading-size').trim(),
    }));
    const title = page.locator(`${selectors.title}:visible`).first();
    await expect(title, `${route}: visible page title`).toBeVisible();
    if (!['overview', 'workspace'].includes(route)) expect(await title.evaluate((heading) => Boolean(heading.closest('.page-heading')))).toBe(true);
    await expect(title).toHaveCSS('font-size', route === 'workspace' ? '23px' : '22px');
    await expect(title).toHaveCSS('font-weight', '650');
    await expect(title).toHaveCSS('font-family', styles.bodyFont);
    const panelHeading = page.locator(`${selectors.panel}:visible`).first();
    const panelHeadingWeight = await panelHeading.evaluate((heading) => getComputedStyle(heading).fontWeight);
    const panelFontFamily = await panelHeading.evaluate((heading) => getComputedStyle(heading).fontFamily);
    expect(Math.round(parseFloat(styles.sidebarWidth))).toBe(247);
    expect(styles.sidebarPaddingTop).toBe('14px');
    expect(styles.brandFontSize).toBe('18px');
    expect(styles.brandGap).toBe('19px');
    expect(styles.navigationGap).toBe('18px');
    expect(styles.navigationPaddingLeft).toBe('27px');
    expect(styles.navigationRowGap).toBe('0px');
    expect(styles.bodyFont).toContain('Inter');
    expect(styles.navigationFontFamily).toBe(styles.bodyFont);
    expect(panelFontFamily).toBe(styles.bodyFont);
    expect(styles.navigationFont).toBe('16px');
    expect(styles.navigationWeight).toBe('500');
    await expect(page.locator('.nav-link:not(.active)').first()).toHaveCSS('min-height', '46px');
    const activeLink = page.locator('.nav-link.active');
    if (await activeLink.count()) {
      await expect(activeLink, `${route}: active sidebar item matches shared height`).toHaveCSS('height', '46px');
      await expect(activeLink, `${route}: active sidebar item keeps shared padding`).toHaveCSS('padding', '0px 8px 0px 27px');
    }
    expect(await page.locator('.sidebar').evaluate((sidebar) => getComputedStyle(sidebar).backgroundImage), `${route}: sidebar artwork is preserved`).toContain('sidebar-wave.png');
    await expect(page.locator('.sidebar'), `${route}: sidebar keeps its layered artwork over the translucent base`).toHaveCSS('background-color', 'rgba(10, 11, 19, 0.92)');
    const workspaceLabel = page.locator('.nav-link .nav-label').filter({ hasText: 'Product Workspace' });
    await expect(workspaceLabel, 'long navigation label stays on one line').toHaveCSS('white-space', 'nowrap');
    expect(await workspaceLabel.evaluate((label) => label.scrollWidth <= label.clientWidth),
      'long navigation label fits without clipping').toBe(true);
    expect(styles.topbarHeight).toBe('80px');
    if (route === 'reports') {
        await expect(page.locator('.reports-greeting p')).toHaveCSS('font-size', '12px');
        const description = await page.locator('.reports-greeting p').evaluate((element) => ({
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }));
        expect(description.scrollWidth, 'reports description is not truncated').toBeLessThanOrEqual(description.clientWidth);
    }
    if (route === 'reports') {
      await expect(page.locator('.reports-page .page-heading')).toHaveCount(0);
      await expect(page.locator('.reports-page .reports-scope-bar')).toBeVisible();
    }
    expect(panelHeadingWeight, `${route}: panel heading weight`).toBe('600');
    expect(styles.panelHeadingToken, `${route}: shared panel heading token`).toBe('16px');
    if (['overview', 'agents', 'workspace', 'reviews', 'integrations', 'settings', 'objectives', 'projects', 'reports'].includes(route)) {
      await expect(page.locator('.shared-panel-surface').first(), `${route}: shared panel surface`)
        .toHaveCSS('border-radius', '11px');
    }
    if (!['workflows', 'settings', 'workspace', 'integrations'].includes(route)) {
      await expect(page.locator('.shared-panel-heading p').first(), `${route}: shared panel description`)
        .toHaveCSS('font-size', '11px');
    }
    if (route === 'workspace') {
      await expect(page.locator('.workspace-mock-directory > .shared-panel-heading p'), 'workspace directory description uses mock scale')
        .toHaveCSS('font-size', '9px');
    }
    if (route === 'integrations') {
      await expect(page.locator('.shared-panel-heading p').first(), 'integrations description uses mock scale')
        .toHaveCSS('font-size', '10px');
    }
  }

  await page.setViewportSize({ width: 1505, height: 800 });
  const framedReferenceWidth = await page.locator('.sidebar').evaluate((sidebar) =>
    Math.round(parseFloat(getComputedStyle(sidebar).width)),
  );
  expect(framedReferenceWidth, 'monitor screen reference sidebar width').toBe(247);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.nav-link').first()).toHaveCSS('font-weight', '400');
  for (const route of Object.keys(pageSelectors)) {
    await page.evaluate((hash) => { window.location.hash = `#${hash}`; }, route);
    await expect(page.locator('.app-shell')).toHaveClass(new RegExp(`${route}-shell`));
    await expect(page.locator('.nav-link').first(), `${route}: mobile nav weight`).toHaveCSS('font-weight', '400');
    const activeMobileLink = page.locator('.nav-link.active:visible');
    if (await activeMobileLink.count()) {
      await expect(activeMobileLink, `${route}: active mobile nav item keeps shared minimum height`).toHaveCSS('min-height', '44px');
      await expect(activeMobileLink, `${route}: active mobile nav item keeps shared padding`).toHaveCSS('padding', '3px 2px');
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
  }
  const mobileNavigationLabels = await page.locator('.nav-link:visible .nav-label').evaluateAll((labels) =>
    labels.map((label) => label.getAttribute('data-mobile-label') ?? label.textContent?.trim()),
  );
  expect(mobileNavigationLabels).toEqual(['Home', 'Workflows', 'Agents', 'Reviews', 'Profile']);

  const metricCards = {
    overview: '.metric-card.shared-metric-card',
    objectives: '.objective-metric.shared-metric-card',
    agents: '.agents-metric.shared-metric-card',
    projects: '.projects-metric.shared-metric-card',
    workspace: '.workspace-mock-metric.shared-metric-card',
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
    expect(styles.label, `${route}: metric label size`).toBe(route === 'overview' ? '15px' : '12px');
    expect(styles.value, `${route}: metric value size`).toBe(
      styles.valueText === 'Unavailable' ? '14px' : route === 'overview' ? '30px' : '26px',
    );
    expect(styles.weight, `${route}: metric value weight`).toBe('650');
    expect(styles.letterSpacing, `${route}: metric value letter spacing`).toBe('-0.8px');
    expect(styles.radius, `${route}: metric card radius`).toBe(route === 'overview' ? '16px' : '10px');
    if (styles.detail) expect(styles.detail, `${route}: metric detail size`).toBe(
      route === 'agents' && await page.locator('.agents-design-preview').count() > 0 ? '9px' : '11px',
    );
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
    expect(styles.label, `${route}: mobile metric label size`).toBe(route === 'overview' ? '15px' : '11px');
    expect(styles.letterSpacing, `${route}: mobile metric value letter spacing`).toBe('-0.8px');
    expect(styles.value, `${route}: mobile metric value size`).toBe(
      styles.valueText === 'Unavailable' ? '14px' : '21px',
    );
    if (styles.detail) expect(styles.detail, `${route}: mobile metric detail size`).toBe(
      route === 'agents' && await page.locator('.agents-design-preview').count() > 0 ? '9px' : '10px',
    );
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

test('desktop sidebar matches mock width at reference and regular monitor sizes', async ({ page }) => {
  for (const width of [1672, 1505]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#reports');
    await expect(page.locator('.reports-page')).toBeVisible();
    expect(await page.locator('.sidebar').evaluate((sidebar) => sidebar.getBoundingClientRect().width)).toBe(247);
    expect(await page.locator('.reports-scope-bar').evaluate((bar) => bar.getBoundingClientRect().x)).toBe(263);
    expect(await page.locator('.sidebar nav .nav-link').evaluateAll((links) =>
      links.every((link) => link.scrollWidth <= link.clientWidth),
    ), 'all desktop navigation labels fit without clipping').toBe(true);
  }
});

test('mobile overview matches the phone shell and keeps workflow/reviews accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Overview', exact: true })).toBeVisible();
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
  await expect(page.locator('.activity-list')).toContainText('PR #41827 merged to trusted-main');
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
