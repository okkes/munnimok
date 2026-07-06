import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// --- Tests ------------------------------------------------------------------

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`review-a1 banner opens queue [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    // 3 seeded transactions need review
    await expect(page.locator('[data-testid="home-review-banner"]')).toContainText('3');
    await shot(page, k('13-review-banner') + '--s1');
    await page.click('[data-testid="home-review-banner"]');
    await expect(page.locator('[data-testid="review-card"]')).toBeVisible();
    // newest first: Amazon.nl (dm100)
    await expect(page.locator('[data-testid="review-card"]')).toContainText('Amazon.nl');
    await shot(page, k('13-review-banner'));
    await teardown(page, ctx, k('13-review-banner'));
  });

  test(`review-a2 confirm and recategorize drain the queue [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await page.click('[data-testid="home-review-banner"]');
    await expect(page.locator('[data-testid="review-card"]')).toContainText('Amazon.nl');
    await page.click('[data-testid="review-confirm-btn"]'); // 1/3 confirmed
    await expect(page.locator('[data-testid="review-card"]')).toContainText('H&M Nederland');
    await shot(page, k('14-review-flow') + '--s1');
    // recategorize H&M via the chip
    await page.click('[data-testid="review-category-chip"]');
    await page.waitForSelector('[data-testid="catpicker-search"]');
    await page.fill('[data-testid="catpicker-search"]', 'gift');
    await page.click('[data-testid="catpicker-gift"]');
    await expect(page.locator('[data-testid="review-card"]')).toContainText('Bol.com');
    await shot(page, k('14-review-flow') + '--s2');
    await page.click('[data-testid="review-confirm-btn"]'); // 3/3 done
    await expect(page.locator('[data-testid="review-empty"]')).toBeVisible();
    await shot(page, k('14-review-flow'));
    await teardown(page, ctx, k('14-review-flow'));
  });

  test(`review-a3 empty queue hides home banner [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await page.click('[data-testid="home-review-banner"]');
    for (let i = 0; i < 3; i++) await page.click('[data-testid="review-confirm-btn"]');
    await expect(page.locator('[data-testid="review-empty"]')).toBeVisible();
    await page.click('[data-testid="review-back"]');
    await expect(page.locator('[data-testid="screen-home"]')).toBeVisible();
    await expect(page.locator('[data-testid="home-review-banner"]')).toHaveCount(0);
    await shot(page, k('15-review-done'));
    await teardown(page, ctx, k('15-review-done'));
  });
}
