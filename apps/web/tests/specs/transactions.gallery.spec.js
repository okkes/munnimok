import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// --- Tests ------------------------------------------------------------------

async function openFirstReviewTx(page) {
  await page.click('[data-testid="tab-transactions"]');
  await page.waitForSelector('[data-testid="tx-list"]');
  // dm100 = Amazon.nl -28.99, needsReview in the seeded dataset
  await page.click('[data-testid="tx-row-dm100"]');
  await page.waitForSelector('[data-testid="screen-tx-detail"]');
}

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`tx-a1 detail opens from list, back returns [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await openFirstReviewTx(page);
    await expect(page.locator('[data-testid="tx-detail-amount"]')).toContainText('28.99');
    await shot(page, k('09-tx-detail') + '--s1');
    await page.goBack();
    await expect(page.locator('[data-testid="tx-list"]')).toBeVisible();
    await shot(page, k('09-tx-detail'));
    await teardown(page, ctx, k('09-tx-detail'));
  });

  test(`tx-a2 recategorize via picker clears review flag [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await openFirstReviewTx(page);
    await page.click('[data-testid="tx-detail-category-row"]');
    await page.waitForSelector('[data-testid="catpicker-videoGame"]');
    await page.waitForTimeout(500); // sheet slide-in
    await shot(page, k('10-tx-recat') + '--s1');
    await page.click('[data-testid="catpicker-videoGame"]');
    await page.waitForTimeout(500); // sheet slide-out
    await expect(page.locator('[data-testid="tx-detail-category-row"]')).toContainText('Video Game');
    // review badge cleared by explicit categorization
    await expect(page.locator('[data-testid="tx-detail-category-row"]')).not.toContainText('Confirm');
    await shot(page, k('10-tx-recat'));
    await teardown(page, ctx, k('10-tx-recat'));
  });

  test(`tx-a3 category search filters picker [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await openFirstReviewTx(page);
    await page.click('[data-testid="tx-detail-category-row"]');
    await page.waitForSelector('[data-testid="catpicker-search"]');
    await page.fill('[data-testid="catpicker-search"]', 'groc');
    await expect(page.locator('[data-testid="catpicker-groceries"]')).toBeVisible();
    await expect(page.locator('[data-testid="catpicker-videoGame"]')).toHaveCount(0);
    await page.waitForTimeout(400);
    await shot(page, k('11-tx-cat-search'));
    await teardown(page, ctx, k('11-tx-cat-search'));
  });

  test(`tx-a5 create manual transaction [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await page.click('[data-testid="tab-transactions"]');
    await page.click('[data-testid="tx-add"]');
    await page.waitForSelector('[data-testid="txform-amount"]');
    await page.fill('[data-testid="txform-amount"]', '12,50');
    await page.fill('[data-testid="txform-merchant"]', 'Test Lunch');
    await page.click('[data-testid="txform-category"]');
    await page.waitForSelector('[data-testid="catpicker-search"]');
    await page.fill('[data-testid="catpicker-search"]', 'dining');
    await page.click('[data-testid="catpicker-restaurants"]');
    await page.waitForTimeout(500);
    await shot(page, k('27-tx-create') + '--s1');
    await page.click('[data-testid="txform-save"]');
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="tx-list"]')).toContainText('Test Lunch');
    await expect(page.locator('[data-testid="tx-list"]')).toContainText('12.50');
    await shot(page, k('27-tx-create'));
    await teardown(page, ctx, k('27-tx-create'));
  });

  test(`tx-a6 edit manual transaction amount and name [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await openFirstReviewTx(page); // dm100 — demo txs have no importRef, so editable
    await page.click('[data-testid="tx-detail-edit"]');
    await page.waitForSelector('[data-testid="txform-amount"]');
    await page.fill('[data-testid="txform-amount"]', '99,99');
    await page.fill('[data-testid="txform-merchant"]', 'Amazon Corrected');
    await page.click('[data-testid="txform-save"]');
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="tx-detail-amount"]')).toContainText('99.99');
    await expect(page.locator('[data-testid="screen-tx-detail"]')).toContainText('Amazon Corrected');
    await shot(page, k('28-tx-edit'));
    await teardown(page, ctx, k('28-tx-edit'));
  });

  test(`tx-a4 notes persist [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await openFirstReviewTx(page);
    await page.fill('[data-testid="tx-detail-notes"]', 'Split with Sam later');
    await page.click('[data-testid="tx-detail-amount"]'); // blur -> save
    await page.goBack();
    await page.click('[data-testid="tx-row-dm100"]');
    await expect(page.locator('[data-testid="tx-detail-notes"]')).toHaveValue('Split with Sam later');
    await shot(page, k('12-tx-notes'));
    await teardown(page, ctx, k('12-tx-notes'));
  });
}
