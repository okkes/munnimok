import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// Why this spec exists (test policy 2026-09-17): custom categories as a
// real-browser flow — the manage screen's grouped catalog, creating a
// custom sub through the form sheet and picking it on a transaction
// through the split-categories editor and the picker (three stacked
// sheets). It produces the gallery/guide screenshots 29-cats-manage and
// 30-cats-create. Rename/delete, custom mains (#244) and the cascade are
// unit-tested (features/categories/ManageCategoriesScreen.test.tsx).

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
    // groups start collapsed (user redesign) — unfold what we inspect
    await page.click('[data-testid="cats-group-consumption"]');
    await expect(page.locator('[data-testid="managecat-groceries"]')).toBeVisible();
    // demo seed ships a custom main with its locked Other sub
    await page.click('[data-testid="cats-group-demo_cat_padel"]');
    await expect(page.locator('[data-testid="managecat-demo_cat_padel_other"]')).toBeVisible();
    await shot(page, k('29-cats-manage'));
    await teardown(page, ctx, k('29-cats-manage'));
  });

  test(`cats-a2 create custom sub (direction follows the parent, #244), use it on a transaction [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await goToManageCats(page);
    await page.click('[data-testid="cats-group-consumption"]');
    await page.click('[data-testid="cats-addsub-consumption"]');
    await page.waitForSelector('[data-testid="catform-name"]');
    await page.fill('[data-testid="catform-name"]', 'Bubble Tea');
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
    await page.waitForSelector('[data-testid="part-cats-editor"]');
    await page.click('[data-testid="part-cat-0"]');
    await page.waitForSelector('[data-testid="catpicker-search"]');
    await page.fill('[data-testid="catpicker-search"]', 'bubble');
    // #234/#246: the search wears a clear × and a ◆ chip that share the
    // catpicker- prefix — pick inside the LIST, where rows live
    const customOption = page.locator('[data-testid="catpicker-list"] [data-testid^="catpicker-"]:not([data-testid="catpicker-list"]):not([data-testid="catpicker-create-custom"])').first();
    await customOption.click();
    await page.waitForTimeout(400);
    await page.click('[data-testid="part-cat-save"]');
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="tx-detail-category-row"]')).toContainText('Bubble Tea');
    await shot(page, k('30-cats-create'));
    await teardown(page, ctx, k('30-cats-create'));
  });
}
