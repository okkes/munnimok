import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// --- Tests ------------------------------------------------------------------

async function goToAccounts(page) {
  await page.click('[data-testid="tab-settings"]');
  await page.click('[data-testid="settings-accounts-row"]');
  await page.waitForSelector('[data-testid="screen-accounts"]');
}

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`acct-a1 list shows seeded demo accounts [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await goToAccounts(page);
    await expect(page.locator('[data-testid="account-row-demo_main"]')).toContainText('Demo Checking');
    await expect(page.locator('[data-testid="account-row-demo_save"]')).toContainText('8,150.00');
    await shot(page, k('16-accounts-list'));
    await teardown(page, ctx, k('16-accounts-list'));
  });

  test(`acct-a2 add manual cash account updates list and home total [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await goToAccounts(page);
    await page.click('[data-testid="accounts-add"]');
    await page.waitForSelector('[data-testid="accttype-cash"]');
    await page.waitForTimeout(500); // sheet slide-in
    await shot(page, k('17-accounts-add') + '--s1');
    await page.click('[data-testid="accttype-cash"]');
    await page.fill('[data-testid="acctform-name"]', 'Wallet');
    await page.fill('[data-testid="acctform-balance"]', '52,50');
    await shot(page, k('17-accounts-add') + '--s2');
    await page.click('[data-testid="acctform-save"]');
    await page.waitForTimeout(500); // sheet slide-out
    await expect(page.locator('[data-testid="screen-accounts"]')).toContainText('Wallet');
    await expect(page.locator('[data-testid="screen-accounts"]')).toContainText('52.50');
    // home total includes the new account: 11,570.55 + 52.50
    await page.click('[data-testid="tab-home"]');
    await expect(page.locator('[data-testid="home-total-balance"]')).toContainText('11,623.05');
    await shot(page, k('17-accounts-add'));
    await teardown(page, ctx, k('17-accounts-add'));
  });

  test(`acct-a3 rename and delete via edit sheet [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await goToAccounts(page);
    await page.click('[data-testid="account-row-demo_save"]');
    await page.waitForSelector('[data-testid="acctedit-name"]');
    await page.fill('[data-testid="acctedit-name"]', 'Rainy Day Fund');
    await page.click('[data-testid="acctedit-save"]');
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="account-row-demo_save"]')).toContainText('Rainy Day Fund');
    await shot(page, k('18-accounts-edit') + '--s1');
    // delete it: tombstone removes it from the list and the home total
    await page.click('[data-testid="account-row-demo_save"]');
    await page.click('[data-testid="acctedit-delete"]');
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="account-row-demo_save"]')).toHaveCount(0);
    await page.click('[data-testid="tab-home"]');
    await expect(page.locator('[data-testid="home-total-balance"]')).toContainText('3,420.55');
    await shot(page, k('18-accounts-edit'));
    await teardown(page, ctx, k('18-accounts-edit'));
  });
}
