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
    await page.waitForSelector('[data-testid="split-editor"]'); // ONE unified flow (user request)
    await page.click('[data-testid="split-cat-0"]');
    await page.waitForSelector('[data-testid="catpicker-videoGame"]');
    await page.waitForTimeout(500); // sheet slide-in
    await shot(page, k('10-tx-recat') + '--s1');
    await page.click('[data-testid="catpicker-videoGame"]');
    await page.waitForTimeout(400);
    await page.click('[data-testid="split-save"]');
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
    await page.waitForSelector('[data-testid="split-editor"]');
    await page.click('[data-testid="split-cat-0"]');
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

  test(`tx-a7 link and unlink a reimbursement [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await openFirstReviewTx(page); // dm100: Amazon.nl -28.99
    // link the salary credit, capped automatically at the open remainder
    await page.click('[data-testid="reimb-add"]');
    await page.waitForSelector('[data-testid="reimb-picker"]');
    await page.locator('[data-testid^="reimb-pick-"]').first().click();
    await expect(page.locator('[data-testid="reimb-amount"]')).toHaveValue('28,99'); // clamped prefill
    await page.fill('[data-testid="reimb-amount"]', '10,00');
    await page.click('[data-testid="reimb-save"]');
    await page.waitForTimeout(500);
    // net −18.99, gross struck through, summary line
    await expect(page.locator('[data-testid="tx-detail-amount"]')).toContainText('18.99');
    await expect(page.locator('[data-testid="tx-detail-gross"]')).toContainText('28.99');
    await expect(page.locator('[data-testid="reimb-summary"]')).toContainText('10.00');
    await shot(page, k('34-tx-reimburse'));
    // unlink restores the gross amount
    await page.locator('[data-testid^="reimb-unlink-"]').click();
    await expect(page.locator('[data-testid="tx-detail-amount"]')).toContainText('28.99');
    await expect(page.locator('[data-testid="tx-detail-gross"]')).toHaveCount(0);
    await teardown(page, ctx, k('34-tx-reimburse'));
  });

  test(`tx-a8 link counter-account suggests type; conflicting category resets [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await openFirstReviewTx(page); // dm100: hobby expense on demo_main
    await page.click('[data-testid="tx-detail-type-row"]');
    await page.waitForSelector('[data-testid="txtype-options"]');
    // the account list stacks behind the counterparty row (user redesign)
    await page.click('[data-testid="txtype-counter-row"]');
    // link the savings account -> type becomes Saving, category conflicts -> reset
    await page.click('[data-testid="txtype-linked-demo_save"]');
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="tx-detail-type-row"]')).toContainText('Saving');
    await expect(page.locator('[data-testid="tx-detail-category-row"]')).toContainText('Uncategorized');
    // reopen: the account only SUGGESTS (user revision) — manual types stay
    // usable and an override keeps the link
    await page.click('[data-testid="tx-detail-type-row"]');
    await expect(page.locator('[data-testid="txtype-default-note"]')).toBeVisible();
    await expect(page.locator('[data-testid="txtype-expense"]')).toBeEnabled();
    await shot(page, k('35-tx-type-link'));
    await page.click('[data-testid="txtype-expense"]');
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="tx-detail-type-row"]')).toContainText('Expense');
    await expect(page.locator('[data-testid="tx-detail-linked-account"]')).toBeVisible(); // link survived
    await teardown(page, ctx, k('35-tx-type-link'));
  });

  test(`tx-a9 split a transaction across two categories [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await openFirstReviewTx(page); // dm100: -28.99
    await page.click('[data-testid="tx-detail-category-row"]');
    await page.waitForSelector('[data-testid="split-editor"]');
    await page.click('[data-testid="split-add-row"]');
    // assign 20.00 to the first row; second row is open -> remainder shown
    await page.fill('[data-testid="split-amount-0"]', '20,00');
    await expect(page.locator('[data-testid="split-remainder"]')).toContainText('8.99');
    await expect(page.locator('[data-testid="split-save"]')).toBeDisabled();
    // pick a category for row 2 and auto-balance via the remainder chip
    await page.click('[data-testid="split-cat-1"]');
    await page.waitForSelector('[data-testid="catpicker-search"]');
    await page.fill('[data-testid="catpicker-search"]', 'gift');
    await page.click('[data-testid="catpicker-gift"]');
    await page.waitForTimeout(700);
    await page.click('[data-testid="split-remainder"]');
    await expect(page.locator('[data-testid="split-amount-1"]')).toHaveValue('8,99');
    await shot(page, k('36-tx-split') + '--s1');
    await page.click('[data-testid="split-save"]');
    await page.waitForTimeout(500);
    // breakdown visible; primary category = largest slice (Hobby, 20.00)
    await expect(page.locator('[data-testid="tx-detail-categories"]')).toContainText('20.00');
    await expect(page.locator('[data-testid="tx-detail-categories"]')).toContainText('8.99');
    await expect(page.locator('[data-testid="tx-detail-category-row"]')).toContainText('Hobby');
    await shot(page, k('36-tx-split'));
    // clearing restores a single category
    await page.click('[data-testid="tx-detail-category-row"]');
    await page.click('[data-testid="split-clear"]');
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid^="tx-detail-cat-"]')).toHaveCount(0);
    await teardown(page, ctx, k('36-tx-split'));
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
