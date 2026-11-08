import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// Guide captures (npm run shots — never in CI): a reimbursement link
// (34-tx-reimburse), a set-aside filed with its savings counterparty
// (35-tx-type-link) and categories split over one transaction (36-tx-split).
// The rules behind each are unit-tested (features/transactions/*.test.tsx).

async function openReviewTx(page) {
  await page.click('[data-testid="tab-transactions"]');
  await page.waitForSelector('[data-testid="tx-list"]');
  // dm100 = Amazon.nl -28.99 in the seeded dataset
  await page.click('[data-testid="tx-row-dm100"]');
  await page.waitForSelector('[data-testid="screen-tx-detail"]');
}

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`shots-tx-reimburse a reimbursement link on the detail [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await openReviewTx(page);
    await page.click('[data-testid="reimb-add"]');
    await page.waitForSelector('[data-testid="reimb-link-list"]');
    // a deterministic big credit: the list is date-sorted and relative-dated rows drift
    await page.locator('[data-testid="reimb-link-list"] [data-testid^="tx-row-"]').filter({ hasText: 'Demo Corp' }).first().click();
    await page.locator('[data-testid^="reimb-amount-"]').first().fill('10,00');
    await page.click('[data-testid="reimb-save"]');
    await expect(page.locator('[data-testid="tx-detail-amount"]')).toContainText('18.99');
    await shot(page, k('34-tx-reimburse'));
    await teardown(page, ctx, k('34-tx-reimburse'));
  });

  test(`shots-tx-link a set-aside filed with its savings counterparty [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await openReviewTx(page);
    await page.click('[data-testid="tx-detail-cats-edit"]');
    await page.click('[data-testid="part-cat-0"]');
    await page.waitForSelector('[data-testid="catpicker-search"]');
    await page.fill('[data-testid="catpicker-search"]', 'set aside');
    await page.click('[data-testid="catpicker-savingDeposit"]');
    await page.waitForSelector('[data-testid="counter-accounts"]');
    await page.click('[data-testid="counter-pick-demo_save"]');
    await page.click('[data-testid="counter-fork-create"]');
    await page.click('[data-testid="part-cat-save"]');
    await expect(page.locator('[data-testid="tx-detail-linked-account"]')).toBeVisible();
    await shot(page, k('35-tx-type-link'));
    await teardown(page, ctx, k('35-tx-type-link'));
  });

  test(`shots-tx-split categories split over one transaction [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await openReviewTx(page);
    await page.click('[data-testid="tx-detail-category-row"]');
    await page.waitForSelector('[data-testid="part-cats-editor"]');
    await page.click('[data-testid="part-cat-add"]');
    await page.fill('[data-testid="part-cat-amount-0"]', '20,00');
    await page.click('[data-testid="part-cat-1"]');
    await page.waitForSelector('[data-testid="catpicker-search"]');
    await page.fill('[data-testid="catpicker-search"]', 'gift');
    await page.click('[data-testid="catpicker-gift"]');
    await page.click('[data-testid="part-cat-remainder"]');
    await expect(page.locator('[data-testid="part-cat-amount-1"]')).toHaveValue('8,99');
    await shot(page, k('36-tx-split') + '--s1');
    await page.click('[data-testid="part-cat-save"]');
    await expect(page.locator('[data-testid="tx-detail-categories"]')).toContainText('8.99');
    await shot(page, k('36-tx-split'));
    await teardown(page, ctx, k('36-tx-split'));
  });
}
