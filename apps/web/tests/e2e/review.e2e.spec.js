import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`review-a1 the banner opens the queue; confirm and recategorise drain it; the banner goes [${V.id}]`, async ({ browser }) => {
    test.slow(); // drains the whole demo queue through the live query
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await expect(page.locator('[data-testid="home-review-banner"]')).toContainText(/[0-9]+ transactions/);
    await shot(page, k('13-review-banner') + '--s1');
    await page.click('[data-testid="home-review-banner"]');
    const card = page.locator('[data-testid="review-card"]');
    await expect(card).toBeVisible();
    await shot(page, k('13-review-banner'));

    const first = (await card.textContent()) ?? '';
    await page.click('[data-testid="review-confirm-btn"]');
    await expect(card).not.toHaveText(first);
    await shot(page, k('14-review-flow') + '--s1');

    await page.click('[data-testid="review-category-chip"]');
    await page.click('[data-testid="part-cat-0"]');
    await page.waitForSelector('[data-testid="catpicker-search"]');
    await page.fill('[data-testid="catpicker-search"]', 'gift');
    await page.click('[data-testid="catpicker-gift"]');
    await page.click('[data-testid="part-cat-save"]');
    await expect(page.locator('[data-testid="review-category-chip"]')).toContainText('Gift');
    await shot(page, k('14-review-flow') + '--s2');
    await page.click('[data-testid="review-confirm-btn"]');

    // re-confirming a card that has not swapped yet is idempotent; a confirm that updated similar rows walks their
    // receipts first (#495) and the deck waits for it — this flow skips the walk
    await expect(async () => {
      if (await page.locator('[data-testid="review-empty"]').count()) return;
      const skipReceipt = page.locator('[data-testid="receipt-queue-skip"]');
      if (await skipReceipt.count()) await skipReceipt.click({ timeout: 2000 }).catch(() => undefined);
      else await page.click('[data-testid="review-confirm-btn"]', { timeout: 2000 }).catch(() => undefined);
      throw new Error('queue not empty yet');
    }).toPass({ timeout: 90_000, intervals: [800, 1500, 3000] });
    await shot(page, k('14-review-flow'));

    await page.click('[data-testid="review-back"]');
    await expect(page.locator('[data-testid="screen-home"]')).toBeVisible();
    await expect(page.locator('[data-testid="home-review-banner"]')).toHaveCount(0);
    await shot(page, k('15-review-done'));
    await teardown(page, ctx, k('14-review-flow'));
  });
}
