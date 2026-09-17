import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// Why this spec exists (test policy 2026-09-17): the trends screen as one
// real-browser flow — the three views render their charts from demo data
// and the category picker narrows the bars to one main. It produces the
// guide screenshots 63-trends-categories and 65-trends-networth (plus
// 64/66 for the gallery). The bucketing math is unit-tested
// (domain/trends.test.ts, features/trends/TrendsScreen.test.tsx).

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`tr-a1 three trend views render their charts; the picker narrows to one main [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await page.goto('/#/trends');
    await page.waitForSelector('[data-testid="trends-cat-chart"]');
    await expect(page.locator('[data-testid="trends-cat-current"]')).toContainText('€');
    await shot(page, k('63-trends-categories'));

    // the category picker narrows the bars to one main (66-trends-picker)
    await page.click('[data-testid="trends-cat-picker"]');
    await page.click('[data-testid="trends-cat-consumption"]');
    await expect(page.locator('[data-testid="trends-cat-picker"]')).toContainText('Consumption');
    await shot(page, k('66-trends-picker'));

    await page.click('[data-testid="trends-view-cashflow"]');
    await page.waitForSelector('[data-testid="trends-flow-chart"]');
    await shot(page, k('64-trends-cashflow'));

    await page.click('[data-testid="trends-view-networth"]');
    await page.waitForSelector('[data-testid="trends-worth-chart"]');
    await expect(page.locator('[data-testid="trends-worth-now"]')).toContainText('€');
    await shot(page, k('65-trends-networth'));
    await teardown(page, ctx, k('65-trends-networth'));
  });
}
