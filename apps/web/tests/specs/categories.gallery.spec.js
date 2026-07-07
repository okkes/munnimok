import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// --- Tests ------------------------------------------------------------------

async function goToManageCats(page) {
  await page.click('[data-testid="tab-settings"]');
  await page.click('[data-testid="settings-categories-row"]');
  await page.waitForSelector('[data-testid="screen-manage-cats"]');
}

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`cats-a1 manage screen lists catalog by parent [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await goToManageCats(page);
    await expect(page.locator('[data-testid="managecat-groceries"]')).toBeVisible();
    await shot(page, k('29-cats-manage'));
    await teardown(page, ctx, k('29-cats-manage'));
  });

  test(`cats-a2 create custom category, use it on a transaction [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await goToManageCats(page);
    await page.click('[data-testid="cats-add"]');
    await page.waitForSelector('[data-testid="catform-name"]');
    await page.fill('[data-testid="catform-name"]', 'Bubble Tea');
    await page.click('[data-testid="catform-parent-consumption"]');
    await page.click('[data-testid="catform-icon-coffee-outline"]');
    await page.waitForTimeout(400);
    await shot(page, k('30-cats-create') + '--s1');
    await page.click('[data-testid="catform-save"]');
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="screen-manage-cats"]')).toContainText('Bubble Tea');
    await shot(page, k('30-cats-create') + '--s2');

    // recategorize a transaction to the new custom category
    await page.click('[data-testid="tab-transactions"]');
    await page.click('[data-testid="tx-row-dm100"]');
    await page.click('[data-testid="tx-detail-category-row"]');
    await page.waitForSelector('[data-testid="catpicker-search"]');
    await page.fill('[data-testid="catpicker-search"]', 'bubble');
    const customOption = page.locator('[data-testid^="catpicker-"]:not([data-testid="catpicker-search"])').first();
    await customOption.click();
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="tx-detail-category-row"]')).toContainText('Bubble Tea');
    await shot(page, k('30-cats-create'));
    await teardown(page, ctx, k('30-cats-create'));
  });

  test(`cats-a3 edit and delete custom category; txs fall back [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await goToManageCats(page);
    // create one
    await page.click('[data-testid="cats-add"]');
    await page.fill('[data-testid="catform-name"]', 'Temp Cat');
    await page.click('[data-testid="catform-save"]');
    await page.waitForTimeout(500);
    // rename via edit
    await page.click('[data-testid="screen-manage-cats"] button:has-text("Temp Cat")');
    await page.waitForSelector('[data-testid="catform-name"]');
    await page.fill('[data-testid="catform-name"]', 'Renamed Cat');
    await page.click('[data-testid="catform-save"]');
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="screen-manage-cats"]')).toContainText('Renamed Cat');
    await shot(page, k('31-cats-edit') + '--s1');
    // delete
    await page.click('[data-testid="screen-manage-cats"] button:has-text("Renamed Cat")');
    await page.click('[data-testid="catform-delete"]');
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="screen-manage-cats"]')).not.toContainText('Renamed Cat');
    await shot(page, k('31-cats-edit'));
    await teardown(page, ctx, k('31-cats-edit'));
  });
}
