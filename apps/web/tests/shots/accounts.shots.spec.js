import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, gotoGlobalSettings, shot, teardown } from '../helpers/base.js';

// Guide captures (npm run shots — never in CI): All accounts with the demo
// space's accounts (16-accounts-list) and a space's Add account (17).
// Creating an account is part of the offline e2e flow; its rules are unit-tested.

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`shots-acct the accounts overview [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await gotoGlobalSettings(page);
    await page.click('[data-testid="settings-accounts-row"]');
    await page.waitForSelector('[data-testid="screen-accounts"]');
    await page.click('[data-testid="accounts-space-head-demo_space"]');
    await expect(page.locator('[data-testid="account-row-demo_main"]')).toContainText('Demo Checking');
    await shot(page, k('16-accounts-list'));
    await teardown(page, ctx, k('16-accounts-list'));
  });

  test(`shots-acct-add a space's Add account: the doors, the type grid, the manual form [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await gotoGlobalSettings(page);
    await page.click('[data-testid="settings-accounts-row"]');
    await page.click('[data-testid="accounts-add"]');
    await page.click('[data-testid="chooser-manual-door"]');
    await page.click('[data-testid="space-accounts-add"]');
    await shot(page, k('17-accounts-add') + '--s1');
    await page.click('[data-testid="chooser-manual"]');
    await page.waitForSelector('[data-testid="chooser-accttype-cash"]');
    await shot(page, k('17-accounts-add') + '--s2');
    await page.click('[data-testid="chooser-accttype-cash"]');
    await page.fill('[data-testid="chooser-acctform-name"]', 'Wallet');
    await page.fill('[data-testid="chooser-acctform-balance"]', '52,50');
    await shot(page, k('17-accounts-add'));
    await teardown(page, ctx, k('17-accounts-add'));
  });
}
