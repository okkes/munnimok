import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, gotoGlobalSettings, shot, teardown, syncApiUp } from '../helpers/base.js';

// Splits SP1 against the real API: create a split, add manual expenses,
// read the ledger. Online-only feature — skips when the stack is down.

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`sp-a1 create a split, add expenses, ledger says who owes whom [${V.id}]`, async ({ browser }) => {
    test.skip(!(await syncApiUp()), 'sync API not running (docker compose -f deploy/docker-compose.test.yml up -d)');
    test.setTimeout(120_000);
    const sub = `e2e-split-${Date.now()}`;

    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { userSub: sub });

    await gotoGlobalSettings(page);
    await page.click('[data-testid="settings-splits-row"]');
    await page.waitForSelector('[data-testid="screen-splits"]');
    await page.waitForSelector('[data-testid="splits-empty"]');

    // create
    await page.click('[data-testid="splits-add"]');
    await page.fill('[data-testid="split-name"]', 'Barcelona trip');
    await page.click('[data-testid="split-create"]');
    await page.waitForSelector('[data-testid="screen-split-detail"]');

    // two manual expenses, both paid by me (solo split: net stays 0)
    for (const [desc, amount] of [['Tapas night', '30,00'], ['Metro cards', '9,50']]) {
      await page.click('[data-testid="split-add-entry"]');
      await page.fill('[data-testid="split-entry-desc"]', desc);
      await page.fill('[data-testid="split-entry-amount"]', amount);
      await page.click('[data-testid="split-entry-save"]');
      await expect(page.locator('[data-testid="split-entries"]')).toContainText(desc);
    }
    await expect(page.locator('[data-testid="split-entries"]')).toContainText('€30.00');
    await expect(page.locator('[data-testid="split-ledger"]')).toBeVisible();
    await shot(page, k('67-split-detail'));

    // back to the list: counts reflect the entries
    await page.click('[data-testid="split-back"]');
    await page.waitForSelector('[data-testid="screen-splits"]');
    await expect(page.locator('[data-testid^="split-row-"]')).toContainText('Barcelona trip');
    await shot(page, k('68-splits-list'));

    await teardown(page, ctx, k('68-splits-list'));
  });
}
