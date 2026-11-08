import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// Critical flow: entering money by hand — a manual transaction is created,
// shows in the list, opens on its detail and is edited in place.

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`tx-a1 a manual transaction is created, opened and edited [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await page.click('[data-testid="tab-transactions"]');
    await page.click('[data-testid="tx-add"]');
    await page.waitForSelector('[data-testid="txform-amount"]');
    await page.fill('[data-testid="txform-amount"]', '12,50');
    await page.fill('[data-testid="txform-merchant"]', 'Test Lunch');
    // the demo has several manual accounts: pick the main one
    await page.click('[data-testid="txform-account"]');
    await page.click('[data-testid="txform-account-demo_main"]');
    await page.click('[data-testid="txform-category"]');
    await page.click('[data-testid="part-cat-0"]');
    await page.waitForSelector('[data-testid="catpicker-search"]');
    await page.fill('[data-testid="catpicker-search"]', 'dining');
    await page.click('[data-testid="catpicker-restaurants"]');
    await page.click('[data-testid="part-cat-save"]');
    await shot(page, k('27-tx-create') + '--s1');
    await page.click('[data-testid="txform-save"]');
    // saving opens the new transaction's own page
    await expect(page.locator('[data-testid="tx-detail-amount"]')).toContainText('12.50');
    await shot(page, k('09-tx-detail'));
    await page.goBack();
    await expect(page.locator('[data-testid="tx-list"]')).toContainText('Test Lunch');
    await expect(page.locator('[data-testid="tx-list"]')).toContainText('12.50');
    await shot(page, k('27-tx-create'));

    await page.locator('[data-testid^="tx-row-"]', { hasText: 'Test Lunch' }).first().click();
    await page.waitForSelector('[data-testid="screen-tx-detail"]');
    await page.click('[data-testid="tx-detail-edit"]');
    await page.waitForSelector('[data-testid="txform-amount"]');
    await page.fill('[data-testid="txform-amount"]', '99,99');
    await page.fill('[data-testid="txform-merchant"]', 'Lunch Corrected');
    await page.click('[data-testid="txform-save"]');
    await expect(page.locator('[data-testid="tx-detail-amount"]')).toContainText('99.99');
    await expect(page.locator('[data-testid="screen-tx-detail"]')).toContainText('Lunch Corrected');
    await shot(page, k('28-tx-edit'));
    await teardown(page, ctx, k('27-tx-create'));
  });
}
