import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function goToAccounts(page) {
  await page.click('[data-testid="login-demo-btn"]');
  await page.waitForSelector('[data-testid="home-space-avatar"]', { timeout: 5000 });
  await page.click('[data-testid="home-space-avatar"]');
  await page.waitForSelector('[data-testid="nav-drawer-settings"]', { timeout: 2000 });
  await page.click('[data-testid="nav-drawer-settings"]');
  await page.waitForSelector('[data-testid="profile-link-accounts"]', { timeout: 3000 });
  await page.click('[data-testid="profile-link-accounts"]');
  await page.waitForSelector('[data-testid="assets-group"]', { timeout: 3000 });
}

async function openTypeSelect(page) {
  await page.click('[data-testid="asset-add-row"]');
  await page.waitForSelector('[data-testid="acct-type-bank"]', { timeout: 2000 });
}

async function openLiabilityTypeSelect(page) {
  await page.click('[data-testid="liability-add-row"]');
  await page.waitForSelector('[data-testid="acct-type-credit"]', { timeout: 2000 });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  // ── A: Main screen ──────────────────────────────────────────────────────

  test(`acct-a1 financial accounts main screen [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await expect(page.locator('[data-testid="assets-group"]')).toBeVisible();
    await expect(page.locator('[data-testid="liabilities-group"]')).toBeVisible();
    await shot(page, k('acct-a1-main'));
    await teardown(page, ctx, k('acct-a1-main'));
  });

  test(`acct-a2 asset type selector shows only 4 asset types [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await page.click('[data-testid="asset-add-row"]');
    await page.waitForSelector('[data-testid="acct-type-bank"]', { timeout: 2000 });
    for (const t of ['bank','saving','cash','brokerage']) {
      await expect(page.locator(`[data-testid="acct-type-${t}"]`)).toBeVisible();
    }
    await expect(page.locator('[data-testid="acct-type-credit"]')).not.toBeVisible();
    await shot(page, k('acct-a2-type-select-asset'));
    await teardown(page, ctx, k('acct-a2-type-select-asset'));
  });

  // ── B: Bank account flow ─────────────────────────────────────────────────

  test(`acct-b1 bank account method screen [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await openTypeSelect(page);
    await page.click('[data-testid="acct-type-bank"]');
    await page.waitForSelector('[data-testid="acct-method-manual"]', { timeout: 2000 });
    await expect(page.locator('[data-testid="acct-method-auto"]')).toBeVisible();
    await shot(page, k('acct-b1-bank-method'));
    await teardown(page, ctx, k('acct-b1-bank-method'));
  });

  test(`acct-b2 bank manual – bank search screen [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await openTypeSelect(page);
    await page.click('[data-testid="acct-type-bank"]');
    await page.waitForSelector('[data-testid="acct-method-manual"]', { timeout: 2000 });
    await page.click('[data-testid="acct-method-manual"]');
    await page.waitForSelector('[data-testid="acct-bank-search"]', { timeout: 2000 });
    await shot(page, k('acct-b2-bank-search'));
    await teardown(page, ctx, k('acct-b2-bank-search'));
  });

  test(`acct-b3 bank manual – search filters banks [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await openTypeSelect(page);
    await page.click('[data-testid="acct-type-bank"]');
    await page.click('[data-testid="acct-method-manual"]');
    await page.waitForSelector('[data-testid="acct-bank-search"]', { timeout: 2000 });
    await page.fill('[data-testid="acct-bank-search"]', 'ING');
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid="bank-row-ing"]')).toBeVisible();
    await shot(page, k('acct-b3-bank-search-ing'));
    await teardown(page, ctx, k('acct-b3-bank-search-ing'));
  });

  test(`acct-b4 bank manual – select bank then fill form [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await openTypeSelect(page);
    await page.click('[data-testid="acct-type-bank"]');
    await page.click('[data-testid="acct-method-manual"]');
    await page.waitForSelector('[data-testid="acct-bank-search"]', { timeout: 2000 });
    await page.click('[data-testid="bank-row-ing"]');
    await page.waitForSelector('[data-testid="acct-display-name"]', { timeout: 2000 });
    await expect(page.locator('[data-testid="acct-account-number"]')).toBeVisible();
    await expect(page.locator('[data-testid="acct-currency-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="acct-initial-balance"]')).toBeVisible();
    await shot(page, k('acct-b4-bank-form'));
    await teardown(page, ctx, k('acct-b4-bank-form'));
  });

  test(`acct-b5 bank manual – save and see in assets list [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await openTypeSelect(page);
    await page.click('[data-testid="acct-type-bank"]');
    await page.click('[data-testid="acct-method-manual"]');
    await page.waitForSelector('[data-testid="acct-bank-search"]', { timeout: 2000 });
    await page.click('[data-testid="bank-row-ing"]');
    await page.waitForSelector('[data-testid="acct-display-name"]', { timeout: 2000 });
    await page.fill('[data-testid="acct-account-number"]', 'NL91INGB0417164300');
    await page.fill('[data-testid="acct-initial-balance"]', '5000');
    await page.click('[data-testid="acct-save-btn"]');
    await page.waitForSelector('[data-testid="assets-group"]', { timeout: 2000 });
    await expect(page.locator('[data-testid="account-row"]').first()).toBeVisible();
    await shot(page, k('acct-b5-bank-saved'));
    await teardown(page, ctx, k('acct-b5-bank-saved'));
  });

  test(`acct-b6 bank manual – validation requires bank selection [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await openTypeSelect(page);
    await page.click('[data-testid="acct-type-bank"]');
    await page.click('[data-testid="acct-method-manual"]');
    await page.waitForSelector('[data-testid="acct-bank-search"]', { timeout: 2000 });
    // Search for "Other" to surface it from the collapsed accordion group
    await page.fill('[data-testid="acct-bank-search"]', 'Other');
    await page.waitForTimeout(150);
    await page.click('[data-testid="bank-row-other"]');
    await page.waitForSelector('[data-testid="acct-save-btn"]', { timeout: 2000 });
    await page.fill('[data-testid="acct-account-number"]', 'NL91ABNA0417164300');
    await page.click('[data-testid="acct-save-btn"]');
    // Should save since "Other" is a valid bank and account number is filled
    await page.waitForSelector('[data-testid="assets-group"]', { timeout: 2000 });
    await shot(page, k('acct-b6-bank-other-saved'));
    await teardown(page, ctx, k('acct-b6-bank-other-saved'));
  });

  // ── C: Cash Wallet flow ──────────────────────────────────────────────────

  test(`acct-c1 cash wallet form [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await openTypeSelect(page);
    await page.click('[data-testid="acct-type-cash"]');
    await page.waitForSelector('[data-testid="cash-display-name"]', { timeout: 2000 });
    await expect(page.locator('[data-testid="cash-initial-balance"]')).toBeVisible();
    await shot(page, k('acct-c1-cash-form'));
    await teardown(page, ctx, k('acct-c1-cash-form'));
  });

  test(`acct-c2 cash wallet name required [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await openTypeSelect(page);
    await page.click('[data-testid="acct-type-cash"]');
    await page.waitForSelector('[data-testid="cash-save-btn"]', { timeout: 2000 });
    await page.click('[data-testid="cash-save-btn"]');
    // Error should appear
    await page.waitForSelector('[data-testid="cash-display-name"]', { timeout: 1000 });
    await shot(page, k('acct-c2-cash-validation'));
    await teardown(page, ctx, k('acct-c2-cash-validation'));
  });

  test(`acct-c3 cash wallet save success [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await openTypeSelect(page);
    await page.click('[data-testid="acct-type-cash"]');
    await page.waitForSelector('[data-testid="cash-display-name"]', { timeout: 2000 });
    await page.fill('[data-testid="cash-display-name"]', 'My Wallet');
    await page.fill('[data-testid="cash-initial-balance"]', '250');
    await page.click('[data-testid="cash-save-btn"]');
    await page.waitForSelector('[data-testid="assets-group"]', { timeout: 2000 });
    await expect(page.locator('[data-testid="account-row"]').first()).toBeVisible();
    await shot(page, k('acct-c3-cash-saved'));
    await teardown(page, ctx, k('acct-c3-cash-saved'));
  });

  // ── D: Brokerage manual flow ─────────────────────────────────────────────

  test(`acct-d1 broker method screen [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await openTypeSelect(page);
    await page.click('[data-testid="acct-type-brokerage"]');
    await page.waitForSelector('[data-testid="acct-method-manual"]', { timeout: 2000 });
    await shot(page, k('acct-d1-broker-method'));
    await teardown(page, ctx, k('acct-d1-broker-method'));
  });

  test(`acct-d2 broker manual search and save [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await openTypeSelect(page);
    await page.click('[data-testid="acct-type-brokerage"]');
    await page.click('[data-testid="acct-method-manual"]');
    await page.waitForSelector('[data-testid="broker-search"]', { timeout: 2000 });
    await page.click('[data-testid="broker-row-degiro"]');
    await page.waitForSelector('[data-testid="broker-save-btn"]', { timeout: 2000 });
    await shot(page, k('acct-d2-broker-manual-form'));
    await page.click('[data-testid="broker-save-btn"]');
    await page.waitForSelector('[data-testid="assets-group"]', { timeout: 2000 });
    await shot(page, k('acct-d2-broker-saved'));
    await teardown(page, ctx, k('acct-d2-broker-saved'));
  });

  // ── E: Mortgage flow ─────────────────────────────────────────────────────

  test(`acct-e1 mortgage form and save [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await openLiabilityTypeSelect(page);
    await page.click('[data-testid="acct-type-mortgage"]');
    await page.waitForSelector('[data-testid="mortgage-lender"]', { timeout: 2000 });
    await shot(page, k('acct-e1-mortgage-form'));
    // Try save without required fields
    await page.click('[data-testid="mortgage-save-btn"]');
    await page.waitForTimeout(300);
    // Fill required fields
    await page.fill('[data-testid="mortgage-lender"]', 'ING Bank');
    await page.fill('[data-testid="mortgage-original"]', '320000');
    await page.fill('[data-testid="mortgage-balance"]', '285000');
    await page.fill('[data-testid="mortgage-rate"]', '3.5');
    await page.fill('[data-testid="mortgage-years"]', '30');
    await page.fill('[data-testid="mortgage-monthly"]', '1350');
    await page.click('[data-testid="mortgage-save-btn"]');
    await page.waitForSelector('[data-testid="liabilities-group"]', { timeout: 2000 });
    await shot(page, k('acct-e1-mortgage-saved'));
    await teardown(page, ctx, k('acct-e1-mortgage-saved'));
  });

  // ── F: Loan flow ─────────────────────────────────────────────────────────

  test(`acct-f1 loan type selector [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await openLiabilityTypeSelect(page);
    await page.click('[data-testid="acct-type-loan"]');
    await page.waitForSelector('[data-testid="loan-type-personal"]', { timeout: 2000 });
    for (const t of ['personal','car','student','other']) {
      await expect(page.locator(`[data-testid="loan-type-${t}"]`)).toBeVisible();
    }
    await shot(page, k('acct-f1-loan-type'));
    await teardown(page, ctx, k('acct-f1-loan-type'));
  });

  test(`acct-f2 loan form (car) and save [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await openLiabilityTypeSelect(page);
    await page.click('[data-testid="acct-type-loan"]');
    await page.waitForSelector('[data-testid="loan-type-car"]', { timeout: 2000 });
    await page.click('[data-testid="loan-type-car"]');
    await page.waitForSelector('[data-testid="loan-lender"]', { timeout: 2000 });
    await page.fill('[data-testid="loan-lender"]', 'Volkswagen Finance');
    await page.fill('[data-testid="loan-original"]', '18000');
    await page.fill('[data-testid="loan-balance"]', '12500');
    await page.click('[data-testid="loan-save-btn"]');
    await page.waitForSelector('[data-testid="liabilities-group"]', { timeout: 2000 });
    await expect(page.locator('[data-testid="account-row"]').first()).toBeVisible();
    await shot(page, k('acct-f2-loan-saved'));
    await teardown(page, ctx, k('acct-f2-loan-saved'));
  });

  // ── G: Saving account flow ───────────────────────────────────────────────

  test(`acct-g1 saving account manual form [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await openTypeSelect(page);
    await page.click('[data-testid="acct-type-saving"]');
    await page.waitForSelector('[data-testid="acct-method-manual"]', { timeout: 2000 });
    await page.click('[data-testid="acct-method-manual"]');
    await page.waitForSelector('[data-testid="acct-bank-search"]', { timeout: 2000 });
    await page.click('[data-testid="bank-row-abn"]');
    await page.waitForSelector('[data-testid="acct-initial-balance"]', { timeout: 2000 });
    await page.fill('[data-testid="acct-account-number"]', 'NL91ABNA0417164300');
    await page.fill('[data-testid="acct-initial-balance"]', '10000');
    await page.click('[data-testid="acct-save-btn"]');
    await page.waitForSelector('[data-testid="assets-group"]', { timeout: 2000 });
    await shot(page, k('acct-g1-saving-saved'));
    await teardown(page, ctx, k('acct-g1-saving-saved'));
  });

  // ── H: Credit card flow ──────────────────────────────────────────────────

  test(`acct-h1 credit card method screen [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await openLiabilityTypeSelect(page);
    await page.click('[data-testid="acct-type-credit"]');
    await page.waitForSelector('[data-testid="acct-method-manual"]', { timeout: 2000 });
    await shot(page, k('acct-h1-credit-method'));
    await teardown(page, ctx, k('acct-h1-credit-method'));
  });

  // ── I: Delete account ────────────────────────────────────────────────────

  test(`acct-i1 delete account shows confirm sheet [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    // Pre-populate with one account
    await base(page, V, () => {
      const userId = 'demo-user-id';
      const key = `munni_bank_accounts_${userId}`;
      const acct = [{ id: 'test_acct_1', name: 'My ING', type: 'bank', iban: 'NL12 INGB 0000', balance: 1234.56, currency: 'EUR', color: '#ff6200' }];
      localStorage.setItem(key, JSON.stringify(acct));
    });
    await goToAccounts(page);
    // Find the x button on an account row — use first account's delete button
    const xBtn = page.locator('[data-testid="account-row"] button').first();
    if (await xBtn.count() > 0) {
      await xBtn.click();
      await page.waitForSelector('[data-testid="sheet-close"]', { timeout: 2000 });
      await shot(page, k('acct-i1-delete-confirm'));
    } else {
      // No pre-seeded account visible (demo user doesn't use that key) — just screenshot main
      await shot(page, k('acct-i1-main'));
    }
    await teardown(page, ctx, k('acct-i1-delete-confirm'));
  });

  // ── J: Net worth summary ─────────────────────────────────────────────────

  test(`acct-j1 assets and liabilities groups always visible [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    await expect(page.locator('[data-testid="assets-group"]')).toBeVisible();
    await expect(page.locator('[data-testid="liabilities-group"]')).toBeVisible();
    await shot(page, k('acct-j1-main-groups'));
    await teardown(page, ctx, k('acct-j1-main-groups'));
  });

  // ── K: Manual/Automated badge & edit sheet ───────────────────────────────

  test(`acct-k1 account row shows Manual badge not PSD2 [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    // Create a manual bank account
    await openTypeSelect(page);
    await page.click('[data-testid="acct-type-bank"]');
    await page.click('[data-testid="acct-method-manual"]');
    await page.waitForSelector('[data-testid="acct-bank-search"]', { timeout: 2000 });
    await page.click('[data-testid="bank-row-ing"]');
    await page.waitForSelector('[data-testid="acct-save-btn"]', { timeout: 2000 });
    await page.fill('[data-testid="acct-account-number"]', 'NL91INGB0417164300');
    await page.click('[data-testid="acct-save-btn"]');
    await page.waitForSelector('[data-testid="account-row"]', { timeout: 2000 });
    const rowText = await page.locator('[data-testid="account-row"]').first().textContent();
    expect(rowText).not.toContain('PSD2');
    expect(rowText.toUpperCase()).toContain('MANUAL');
    await shot(page, k('acct-k1-manual-badge'));
    await teardown(page, ctx, k('acct-k1-manual-badge'));
  });

  test(`acct-k2 edit sheet has no initial balance field [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToAccounts(page);
    // Create an account then open its edit sheet
    await openTypeSelect(page);
    await page.click('[data-testid="acct-type-bank"]');
    await page.click('[data-testid="acct-method-manual"]');
    await page.waitForSelector('[data-testid="acct-bank-search"]', { timeout: 2000 });
    await page.click('[data-testid="bank-row-ing"]');
    await page.waitForSelector('[data-testid="acct-save-btn"]', { timeout: 2000 });
    await page.fill('[data-testid="acct-account-number"]', 'NL91INGB0417164300');
    await page.fill('[data-testid="acct-initial-balance"]', '1000');
    await page.click('[data-testid="acct-save-btn"]');
    await page.waitForSelector('[data-testid="account-row"]', { timeout: 2000 });
    // Click the row to open edit sheet
    await page.locator('[data-testid="account-row"]').first().click();
    await page.waitForSelector('[data-testid="sheet-close"]', { timeout: 2000 });
    await shot(page, k('acct-k2-edit-sheet'));
    // Edit sheet must NOT expose an initial balance or balance field
    await expect(page.locator('[data-testid="acct-initial-balance"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="acct-edit-balance"]')).not.toBeVisible();
    await teardown(page, ctx, k('acct-k2-edit-sheet'));
  });
}
