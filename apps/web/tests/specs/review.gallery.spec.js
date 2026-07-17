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
    // oldest first (user rule): Bol.com leads the backlog
    await expect(page.locator('[data-testid="review-card"]')).toContainText('Bol.com');
    await shot(page, k('13-review-banner'));
    await teardown(page, ctx, k('13-review-banner'));
  });

  test(`review-a2 confirm and recategorize drain the queue [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await page.click('[data-testid="home-review-banner"]');
    // oldest first (user rule): Bol.com → H&M → Amazon.nl
    await expect(page.locator('[data-testid="review-card"]')).toContainText('Bol.com');
    await page.click('[data-testid="review-confirm-btn"]'); // 1/3 confirmed
    await expect(page.locator('[data-testid="review-card"]')).toContainText('H&M Nederland');
    await shot(page, k('14-review-flow') + '--s1');
    // recategorize H&M — the row opens the unified editor (user redesign);
    // the pick is STAGED, confirm writes it
    await page.click('[data-testid="review-category-chip"]');
    await page.click('[data-testid="split-cat-0"]');
    await page.waitForSelector('[data-testid="catpicker-search"]');
    await page.fill('[data-testid="catpicker-search"]', 'gift');
    await page.click('[data-testid="catpicker-gift"]');
    await page.click('[data-testid="split-save"]');
    await expect(page.locator('[data-testid="review-category-chip"]')).toContainText('Gift');
    await shot(page, k('14-review-flow') + '--s2');
    await page.click('[data-testid="review-confirm-btn"]'); // 2/3 confirmed as Gift
    await expect(page.locator('[data-testid="review-card"]')).toContainText('Amazon.nl');
    await page.click('[data-testid="review-confirm-btn"]'); // 3/3 done
    await expect(page.locator('[data-testid="review-empty"]')).toBeVisible();
    await shot(page, k('14-review-flow'));
    await teardown(page, ctx, k('14-review-flow'));
  });

  test(`review-a3 empty queue hides home banner [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await page.click('[data-testid="home-review-banner"]');
    // each confirm must actually advance the queue — rapid clicks can
    // land twice on the same card while it swaps (CI-only flake)
    const card = page.locator('[data-testid="review-card"]');
    for (let i = 0; i < 3; i++) {
      const before = await card.textContent();
      await page.click('[data-testid="review-confirm-btn"]');
      await expect(async () => {
        if (await page.locator('[data-testid="review-empty"]').count()) return;
        expect(await card.textContent()).not.toBe(before);
      }).toPass();
    }
    await expect(page.locator('[data-testid="review-empty"]')).toBeVisible();
    await page.click('[data-testid="review-back"]');
    await expect(page.locator('[data-testid="screen-home"]')).toBeVisible();
    await expect(page.locator('[data-testid="home-review-banner"]')).toHaveCount(0);
    await shot(page, k('15-review-done'));
    await teardown(page, ctx, k('15-review-done'));
  });
}
