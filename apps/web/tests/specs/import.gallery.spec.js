import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, freshCamtFixture, gotoGlobalSettings, shot, teardown } from '../helpers/base.js';

// Why this spec exists (test policy 2026-09-17): the bank-file import core
// flow with a real file picker and a real IndexedDB — preview matched by
// IBAN, the import itself (balances, auto-categorization, review flags)
// and the dedupe on re-import. It produces the gallery/guide screenshots
// 19-import-preview and 20-import-run. The parser and the invalid-file
// error are unit-tested (lib/camt053/parse.test.ts,
// features/accounts/AccountsScreen.test.tsx).

// date-freshened copy — the static file ages out of the default
// two-month attach history window (2026-09-06 incident)
const FIXTURE = freshCamtFixture();

async function goToAccounts(page) {
  await gotoGlobalSettings(page);
  await page.click('[data-testid="settings-accounts-row"]');
  await page.waitForSelector('[data-testid="screen-accounts"]');
  // #314 r2: space cards mount COLLAPSED — open the demo cluster so the
  // balance asserts on demo rows keep seeing them
  await page.click('[data-testid="accounts-space-head-demo_space"]');
  await page.waitForSelector('[data-testid="account-row-demo_main"]');
}

async function pickFixture(page) {
  await page.setInputFiles('[data-testid="accounts-import-input"]', FIXTURE);
  await page.waitForSelector('[data-testid="import-preview"]');
}

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`import-a1 preview matches existing account by IBAN [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await goToAccounts(page);
    await pickFixture(page);
    await page.waitForTimeout(500); // sheet slide-in
    // statement 1 matches demo checking by IBAN, statement 2 is new
    await expect(page.locator('[data-testid="import-preview"]')).toContainText('Demo Checking');
    await expect(page.locator('[data-testid="import-preview"]')).toContainText('New account');
    await shot(page, k('19-import-preview'));
    await teardown(page, ctx, k('19-import-preview'));
  });

  test(`import-a2 import categorizes, updates balance, dedupes on re-import [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await goToAccounts(page);
    await pickFixture(page);
    await page.click('[data-testid="import-run"]');
    await expect(page.locator('[data-testid="import-result"]')).toContainText('Imported 3 transactions, skipped 0');
    await shot(page, k('20-import-run') + '--s1');
    await page.click('[data-testid="import-close"]');
    await page.waitForTimeout(500);
    // matched account balance updated to CLBD 3390.55; new account created with 500.00
    await expect(page.locator('[data-testid="account-row-demo_main"]')).toContainText('3,390.55');
    await expect(page.locator('[data-testid="screen-accounts"]')).toContainText('Bank · 4300'); // new NL91ABNA…4300 account
    // Jumbo predicted as groceries (no review); unknown merchant needs review
    await page.click('[data-testid="tab-transactions"]');
    await expect(page.locator('[data-testid="tx-list"]')).toContainText('Jumbo Amsterdam');
    await expect(page.locator('[data-testid="tx-list"]')).toContainText('Grocery');
    await expect(page.locator('[data-testid="tx-list"]')).toContainText('Onbekende Winkel XQZ');
    await shot(page, k('20-import-run') + '--s2');
    // re-import the same file: everything is a duplicate
    await goToAccounts(page);
    await pickFixture(page);
    await page.click('[data-testid="import-run"]');
    await expect(page.locator('[data-testid="import-result"]')).toContainText('Imported 0 transactions, skipped 3');
    await shot(page, k('20-import-run'));
    await teardown(page, ctx, k('20-import-run'));
  });
}
