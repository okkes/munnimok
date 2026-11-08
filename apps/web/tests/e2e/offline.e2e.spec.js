import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, gotoGlobalSettings, gotoSpaces, shot, teardown } from '../helpers/base.js';

// Critical flow: the offline start — a zero-network profile is created, holds
// an account and a transaction, and survives signing out.

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`offline-a1 an offline profile keeps its account and transaction across a sign-out [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V); // the login screen, no session
    await page.click('[data-testid="login-offline-btn"]');
    await page.waitForSelector('[data-testid="screen-offline-intro"]');
    await shot(page, k('38-offline') + '--s0');
    await page.click('[data-testid="offline-continue"]');
    await page.waitForSelector('[data-testid="screen-offline-profiles"]');
    await page.fill('[data-testid="offline-name"]', 'Okkes Offline');
    await shot(page, k('38-offline') + '--s1');
    await page.click('[data-testid="offline-create"]');
    await page.waitForSelector('[data-testid="screen-onboarding"]');
    await page.click('[data-testid="onboarding-save"]');
    await page.click('[data-testid="onboarding-lock-later"]');
    // Mina owns the first run — skipping it creates the default space
    await page.click('[data-testid="mina-skip"]');
    await page.click('[data-testid="mina-skip-confirm"]');
    await page.waitForSelector('[data-testid="mina-tutorial"]', { state: 'detached' });
    await page.waitForSelector('[data-testid="tab-home"]');
    await gotoSpaces(page);
    await expect(page.locator('[data-testid="screen-spaces"]')).toContainText('Private');

    // a cash account on the space's own accounts screen, then a transaction
    await gotoGlobalSettings(page);
    await page.click('[data-testid="settings-accounts-row"]');
    await page.click('[data-testid="accounts-add"]');
    await page.click('[data-testid="chooser-manual-door"]');
    await page.click('[data-testid="space-accounts-add"]');
    await page.click('[data-testid="chooser-manual"]');
    await page.click('[data-testid="chooser-accttype-cash"]');
    await page.fill('[data-testid="chooser-acctform-name"]', 'Wallet');
    await page.fill('[data-testid="chooser-acctform-balance"]', '100');
    await page.click('[data-testid="chooser-acctform-save"]');
    await expect(page.locator('[data-testid="screen-space-accounts"]')).toContainText('Wallet');
    await page.click('[data-testid="tab-transactions"]');
    await page.click('[data-testid="tx-add"]');
    await page.fill('[data-testid="txform-amount"]', '5,00');
    await page.fill('[data-testid="txform-merchant"]', 'Offline Coffee');
    await page.click('[data-testid="txform-save"]');
    // saving opens the new transaction's own page; back leads to the list
    await expect(page.locator('[data-testid="screen-tx-detail"]')).toContainText('Offline Coffee');
    await page.goBack();
    await expect(page.locator('[data-testid="tx-list"]')).toContainText('Offline Coffee');
    await shot(page, k('38-offline') + '--s2');

    // signing out keeps an offline profile: it is selectable again, data intact
    await page.click('[data-testid="tab-settings"]');
    await page.click('[data-testid="settings-signout"]');
    await page.waitForSelector('[data-testid="screen-login"]');
    await page.click('[data-testid="login-offline-btn"]');
    await page.click('[data-testid="offline-continue"]');
    await page.locator('[data-testid^="offline-profile-"]').click();
    await page.waitForSelector('[data-testid="tab-home"]');
    await page.click('[data-testid="tab-transactions"]');
    await expect(page.locator('[data-testid="tx-list"]')).toContainText('Offline Coffee');
    await shot(page, k('38-offline'));
    await teardown(page, ctx, k('38-offline'));
  });
}
