import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, freshCamtFixture, gotoGlobalSettings, shot, teardown } from '../helpers/base.js';

// Critical flow: a bank statement file through a real file picker and a real
// IndexedDB — the preview matches the existing account by IBAN, the import
// sets the balance and the categories, and a re-import is all duplicates.

// date-freshened copy — the static file ages out of the attach history window
const FIXTURE = freshCamtFixture();

async function goToAccounts(page) {
  await gotoGlobalSettings(page);
  await page.click('[data-testid="settings-accounts-row"]');
  await page.waitForSelector('[data-testid="screen-accounts"]');
  // space cards mount collapsed — open the demo cluster
  await page.click('[data-testid="accounts-space-head-demo_space"]');
  await page.waitForSelector('[data-testid="account-row-demo_main"]');
}

async function pickFixture(page) {
  await page.setInputFiles('[data-testid="accounts-import-input"]', FIXTURE);
  await page.waitForSelector('[data-testid="import-preview"]');
}

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`import-a1 a statement: matched by IBAN, imported with balance and categories, a re-import skips it all [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await goToAccounts(page);
    await pickFixture(page);
    // statement 1 matches demo checking by IBAN, statement 2 is new
    await expect(page.locator('[data-testid="import-preview"]')).toContainText('Demo Checking');
    await expect(page.locator('[data-testid="import-preview"]')).toContainText('New account');
    await shot(page, k('19-import-preview'));

    await page.click('[data-testid="import-run"]');
    await expect(page.locator('[data-testid="import-result"]')).toContainText('Imported 3 transactions, skipped 0');
    await shot(page, k('20-import-run') + '--s1');
    await page.click('[data-testid="import-close"]');
    // the matched account takes the statement's closing balance; the new one is created
    await expect(page.locator('[data-testid="account-row-demo_main"]')).toContainText('3,390.55');
    await expect(page.locator('[data-testid="screen-accounts"]')).toContainText('Bank · 4300');
    await page.click('[data-testid="tab-transactions"]');
    await expect(page.locator('[data-testid="tx-list"]')).toContainText('Jumbo Amsterdam');
    await expect(page.locator('[data-testid="tx-list"]')).toContainText('Grocery');
    await expect(page.locator('[data-testid="tx-list"]')).toContainText('Onbekende Winkel XQZ');
    await shot(page, k('20-import-run') + '--s2');

    await goToAccounts(page);
    await pickFixture(page);
    await page.click('[data-testid="import-run"]');
    await expect(page.locator('[data-testid="import-result"]')).toContainText('Imported 0 transactions, skipped 3');
    await shot(page, k('20-import-run'));
    await teardown(page, ctx, k('20-import-run'));
  });
}
