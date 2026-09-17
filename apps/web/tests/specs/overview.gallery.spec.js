import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// Why this spec exists (test policy 2026-09-17): the period overview as
// the user meets it — the Home tiles and the expense drill-down (chart,
// composition, expandable categories, period switch) rendered by a real
// browser on demo data. It produces the guide screenshots 59-overview-home
// and 60-overview-expense. The sign mechanics of the saving/income sides
// are unit-tested (features/overview/OverviewScreen.test.tsx).

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`ov-a1 home tiles show the period summary [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await expect(page.locator('[data-testid="home-overview-expense"]')).toContainText('€');
    await expect(page.locator('[data-testid="home-overview-income"]')).toBeVisible();
    await shot(page, k('59-overview-home'));
    await teardown(page, ctx, k('59-overview-home'));
  });

  test(`ov-a2 expense drill-down: chart, composition, expandable categories [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await page.click('[data-testid="home-overview-expense"]');
    await page.waitForSelector('[data-testid="screen-overview"]');
    await expect(page.locator('[data-testid="overview-total"]')).toContainText('€');
    await expect(page.locator('[data-testid="overview-barchart"]')).toBeVisible();
    await shot(page, k('60-overview-expense') + '--s1');

    // expand the largest main category to its sub categories
    const group = page.locator('[data-testid^="overview-group-"]').first();
    await group.click();
    await expect(page.locator('[data-testid^="overview-subs-"]').first()).toBeVisible();
    await shot(page, k('60-overview-expense'));

    // older period selectable via the bar chart
    await page.click('[data-testid="overview-bar-2"]');
    await expect(page.locator('[data-testid="overview-total"]')).toContainText('€');
    await teardown(page, ctx, k('60-overview-expense'));
  });
}
