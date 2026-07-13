import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, gotoGlobalSettings, gotoSpaces, shot, teardown } from '../helpers/base.js';

// --- Tests ------------------------------------------------------------------

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`shell-a1 home tab default [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await expect(page.locator('[data-testid="screen-home"]')).toBeVisible();
    await expect(page).toHaveURL(/#\/home$/);
    await shot(page, k('01-shell-home'));
    await teardown(page, ctx, k('01-shell-home'));
  });

  test(`shell-a2 tab navigation [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await page.click('[data-testid="tab-transactions"]');
    await expect(page.locator('[data-testid="screen-transactions"]')).toBeVisible();
    await shot(page, k('02-shell-tabs') + '--s1');
    await page.click('[data-testid="tab-recurring"]');
    await expect(page.locator('[data-testid="screen-recurring"]')).toBeVisible();
    await shot(page, k('02-shell-tabs') + '--s2');
    await page.click('[data-testid="tab-settings"]');
    await expect(page.locator('[data-testid="screen-settings"]')).toBeVisible();
    await shot(page, k('02-shell-tabs'));
    await teardown(page, ctx, k('02-shell-tabs'));
  });

  test(`shell-a3 browser back returns to previous tab [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await page.click('[data-testid="tab-transactions"]');
    await expect(page.locator('[data-testid="screen-transactions"]')).toBeVisible();
    await shot(page, k('03-shell-back') + '--s1');
    await page.goBack();
    await expect(page.locator('[data-testid="screen-home"]')).toBeVisible();
    await expect(page).toHaveURL(/#\/home$/);
    await shot(page, k('03-shell-back'));
    await teardown(page, ctx, k('03-shell-back'));
  });

  test(`shell-a4 language switch to Dutch [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await gotoGlobalSettings(page);
    await expect(page.locator('[data-testid="settings-language-row"]')).toBeVisible();
    await shot(page, k('04-shell-language') + '--s1');
    await page.click('[data-testid="settings-language-row"]');
    await expect(page.locator('[data-testid="lang-option-nl"]')).toBeVisible();
    await page.waitForTimeout(500); // sheet slide-in
    await shot(page, k('04-shell-language') + '--s2');
    await page.click('[data-testid="lang-option-nl"]');
    await page.waitForTimeout(500); // sheet slide-out
    await expect(page.locator('[data-testid="screen-settings-global"]')).toContainText('Algemene instellingen');
    await shot(page, k('04-shell-language'));
    await teardown(page, ctx, k('04-shell-language'));
  });

  test(`shell-a6 offline profile: create, add data, sign out keeps it [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V); // login screen, no session
    await page.click('[data-testid="login-offline-btn"]');
    await page.waitForSelector('[data-testid="offline-name"]');
    await page.fill('[data-testid="offline-name"]', 'Okkes Offline');
    await shot(page, k('38-offline') + '--s1');
    await page.click('[data-testid="offline-create"]');
    await page.waitForSelector('[data-testid="tab-home"]');
    // personal space carries the profile name
    await gotoSpaces(page);
    await expect(page.locator('[data-testid="screen-spaces"]')).toContainText('Okkes Offline');
    // add a cash account, then a manual transaction (zero network)
    await gotoGlobalSettings(page);
    await page.click('[data-testid="settings-accounts-row"]');
    await page.click('[data-testid="accounts-add"]');
    await page.click('[data-testid="accttype-cash"]');
    await page.fill('[data-testid="acctform-name"]', 'Wallet');
    await page.fill('[data-testid="acctform-balance"]', '100');
    await page.click('[data-testid="acctform-save"]');
    await page.waitForTimeout(500);
    await page.click('[data-testid="tab-transactions"]');
    await page.click('[data-testid="tx-add"]');
    await page.fill('[data-testid="txform-amount"]', '5,00');
    await page.fill('[data-testid="txform-merchant"]', 'Offline Coffee');
    await page.click('[data-testid="txform-save"]');
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="tx-list"]')).toContainText('Offline Coffee');
    await shot(page, k('38-offline') + '--s2');
    // sign out does NOT destroy offline data; profile is selectable again
    await page.click('[data-testid="tab-settings"]');
    await page.click('[data-testid="settings-signout"]');
    await page.waitForSelector('[data-testid="screen-login"]');
    await page.click('[data-testid="login-offline-btn"]');
    await page.locator('[data-testid^="offline-profile-"]').click();
    await page.waitForSelector('[data-testid="tab-home"]');
    await page.click('[data-testid="tab-transactions"]');
    await expect(page.locator('[data-testid="tx-list"]')).toContainText('Offline Coffee');
    await shot(page, k('38-offline'));
    await teardown(page, ctx, k('38-offline'));
  });

  test(`shell-a5 dark mode toggle [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await gotoGlobalSettings(page);
    await expect(page.locator('[data-testid="settings-theme-toggle"]')).toBeVisible();
    await page.click('[data-testid="settings-theme-toggle"]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await shot(page, k('05-shell-dark'));
    await teardown(page, ctx, k('05-shell-dark'));
  });
}

