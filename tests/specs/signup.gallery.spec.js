import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

// Navigate from login screen all the way to onboarding step 1.
// Each test uses a unique email to avoid collisions across parallel variants.
async function goToStep1(page, email) {
  await page.click('[data-testid="login-create-account"]');
  await page.waitForSelector('[data-testid="signup-pick-email"]');
  await page.click('[data-testid="signup-pick-email"]');
  await page.waitForSelector('[data-testid="signup-send-code"]');
  await page.fill('input[type="email"]', email);
  await page.click('[data-testid="signup-send-code"]');
  await page.waitForSelector('[data-testid="onboard-firstname"]', { timeout: 5000 });
}

// Navigate to step 2 (bank connect).
async function goToStep2(page, email) {
  await goToStep1(page, email);
  await page.fill('[data-testid="onboard-firstname"]', 'Alice');
  await page.fill('[data-testid="onboard-lastname"]', 'Smith');
  // Country is required — select Netherlands
  await page.click('[data-testid="onboard-country-btn"]');
  await page.waitForSelector('[data-testid="onboard-country-sheet"]', { timeout: 3000 });
  await page.locator('[data-testid="sheet-close"] button').filter({ hasText: 'Netherlands' }).first().click();
  await page.click('[data-testid="onboard-continue"]');
  await page.waitForSelector('[data-testid="onboard-step2"]', { timeout: 3000 });
}

// Navigate to bank search.
async function goToBankSearch(page, email) {
  await goToStep2(page, email);
  await page.click('[data-testid="onboard-add-bank"]');
  await page.waitForSelector('[data-testid="bank-search-screen"]', { timeout: 3000 });
}

// Navigate to bank credentials (ING).
async function goToBankCreds(page, email) {
  await goToBankSearch(page, email);
  await page.click('[data-testid="bank-list-row"]');
  await page.waitForSelector('[data-testid="bank-creds-screen"]', { timeout: 3000 });
}

// Navigate all the way to the PSD2 consent screen.
async function goToConsent(page, email) {
  await goToBankCreds(page, email);
  await page.click('[data-testid="bank-creds-connect"]');
  await page.waitForSelector('[data-testid="bank-consent-screen"]', { timeout: 3000 });
}

// Navigate to connecting screen (after Authorise).
async function goToConnecting(page, email) {
  await goToConsent(page, email);
  await page.click('[data-testid="bank-consent-authorise"]');
  await page.waitForSelector('[data-testid="bank-connecting-screen"]', { timeout: 3000 });
}

// Complete the full bank connect flow and land on step 2 with bank row.
async function goToStep2WithBank(page, email) {
  await goToConnecting(page, email);
  await page.waitForSelector('[data-testid="bank-done-screen"]', { timeout: 4000 });
  await page.click('[data-testid="bank-done-btn"]');
  await page.waitForSelector('[data-testid="onboard-step2"]', { timeout: 3000 });
  await page.waitForSelector('[data-testid="onboard-bank-row"]', { timeout: 2000 });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;
  const email = (suffix) => `test-${suffix}-${V.id.replace(/-/g, '')}@example.com`;

  // -------------------------------------------------------------------------
  // Group A — Login Screen Extras
  // -------------------------------------------------------------------------

  test(`20 lang-picker – opens [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await shot(page, k('20-lang-picker-open') + '--s1');
    await page.click('[data-testid="login-lang-btn"]');
    await page.waitForSelector('[data-testid="lang-option-en"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="lang-option-en"]')).toBeVisible();
    await expect(page.locator('[data-testid="lang-option-nl"]')).toBeVisible();
    await expect(page.locator('[data-testid="lang-option-tr"]')).toBeVisible();
    await shot(page, k('20-lang-picker-open'));
    await teardown(page, ctx, k('20-lang-picker-open'));
  });

  test(`21 lang-picker – switch to Dutch [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await shot(page, k('21-lang-switch-nl') + '--s1');
    await page.click('[data-testid="login-lang-btn"]');
    await page.waitForSelector('[data-testid="lang-option-nl"]', { timeout: 3000 });
    await shot(page, k('21-lang-switch-nl') + '--s2');
    await page.click('[data-testid="lang-option-nl"]');
    // After selection, picker closes and login screen shows in Dutch
    await page.waitForSelector('[data-testid="login-google-btn"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="login-lang-btn"]')).toBeVisible();
    await shot(page, k('21-lang-switch-nl'));
    await teardown(page, ctx, k('21-lang-switch-nl'));
  });

  test(`22 terms – screen opens [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await shot(page, k('22-terms-screen') + '--s1');
    await page.click('[data-testid="login-terms-link"]');
    await page.waitForSelector('[data-testid="terms-screen"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="terms-screen"]')).toBeVisible();
    await shot(page, k('22-terms-screen'));
    await teardown(page, ctx, k('22-terms-screen'));
  });

  test(`23 privacy – screen opens [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await shot(page, k('23-privacy-screen') + '--s1');
    await page.click('[data-testid="login-privacy-link"]');
    await page.waitForSelector('[data-testid="terms-screen"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="terms-screen"]')).toBeVisible();
    await shot(page, k('23-privacy-screen'));
    await teardown(page, ctx, k('23-privacy-screen'));
  });

  test(`24 demo-user – home loads [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await shot(page, k('24-demo-user') + '--s1');
    await page.click('[data-testid="login-demo-btn"]');
    await page.waitForSelector('[data-testid="tab-home"]', { timeout: 5000 });
    await expect(page.locator('[data-testid="tab-home"]')).toBeVisible();
    await shot(page, k('24-demo-user'));
    await teardown(page, ctx, k('24-demo-user'));
  });

  // -------------------------------------------------------------------------
  // Group B — Onboarding Step 1
  // -------------------------------------------------------------------------

  test(`25 onboard-step1 – fresh form [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await shot(page, k('25-onboard-step1-fresh') + '--s1');
    await page.click('[data-testid="login-create-account"]');
    await page.waitForSelector('[data-testid="signup-pick-email"]');
    await shot(page, k('25-onboard-step1-fresh') + '--s2');
    await page.click('[data-testid="signup-pick-email"]');
    await page.waitForSelector('[data-testid="signup-send-code"]');
    await page.fill('input[type="email"]', email('step1'));
    await shot(page, k('25-onboard-step1-fresh') + '--s3');
    await page.click('[data-testid="signup-send-code"]');
    await page.waitForSelector('[data-testid="verify-autofilling"]', { timeout: 4000 });
    await shot(page, k('25-onboard-step1-fresh') + '--s4');
    await page.waitForSelector('[data-testid="onboard-firstname"]', { timeout: 5000 });
    await expect(page.locator('[data-testid="onboard-firstname"]')).toBeVisible();
    await expect(page.locator('[data-testid="onboard-continue"]')).toBeVisible();
    await shot(page, k('25-onboard-step1-fresh'));
    await teardown(page, ctx, k('25-onboard-step1-fresh'));
  });

  test(`26 onboard – first name missing [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep1(page, email('fn-missing'));
    await shot(page, k('26-onboard-firstname-error') + '--s1');
    // Submit without filling any name
    await page.click('[data-testid="onboard-continue"]');
    await page.waitForSelector('[data-testid="onboard-firstname-error"]', { timeout: 2000 });
    await expect(page.locator('[data-testid="onboard-firstname-error"]')).toBeVisible();
    await shot(page, k('26-onboard-firstname-error'));
    await teardown(page, ctx, k('26-onboard-firstname-error'));
  });

  test(`27 onboard – last name missing [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep1(page, email('ln-missing'));
    await page.fill('[data-testid="onboard-firstname"]', 'Alice');
    await shot(page, k('27-onboard-lastname-error') + '--s1');
    await page.click('[data-testid="onboard-continue"]');
    await page.waitForSelector('[data-testid="onboard-lastname-error"]', { timeout: 2000 });
    await expect(page.locator('[data-testid="onboard-lastname-error"]')).toBeVisible();
    await shot(page, k('27-onboard-lastname-error'));
    await teardown(page, ctx, k('27-onboard-lastname-error'));
  });

  test(`28 onboard – name too long [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep1(page, email('toolong'));
    const longName = 'A'.repeat(51);
    await page.fill('[data-testid="onboard-firstname"]', longName);
    await shot(page, k('28-onboard-name-toolong') + '--s1');
    await page.click('[data-testid="onboard-continue"]');
    await page.waitForSelector('[data-testid="onboard-firstname-error"]', { timeout: 2000 });
    await expect(page.locator('[data-testid="onboard-firstname-error"]')).toBeVisible();
    await shot(page, k('28-onboard-name-toolong'));
    await teardown(page, ctx, k('28-onboard-name-toolong'));
  });

  test(`29 onboard – API info tooltip [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep1(page, email('apiinfo'));
    await shot(page, k('29-onboard-api-info') + '--s1');
    await page.click('[data-testid="onboard-api-info-btn"]');
    await page.waitForSelector('[data-testid="onboard-api-info-sheet"]', { timeout: 2000 });
    await expect(page.locator('[data-testid="onboard-api-info-sheet"]')).toBeVisible();
    await shot(page, k('29-onboard-api-info'));
    await teardown(page, ctx, k('29-onboard-api-info'));
  });

  test(`30 onboard – avatar picker [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep1(page, email('avatar'));
    await shot(page, k('30-onboard-avatar-picker') + '--s1');
    await page.click('[data-testid="onboard-avatar-btn"]');
    await page.waitForSelector('[data-testid="onboard-avatar-picker"]', { timeout: 2000 });
    await expect(page.locator('[data-testid="onboard-avatar-picker"]')).toBeVisible();
    await shot(page, k('30-onboard-avatar-picker') + '--s2');
    // Pick the first stock avatar
    await page.locator('[data-testid="onboard-avatar-picker"] button').first().click();
    await page.waitForSelector('[data-testid="onboard-avatar-btn"]', { timeout: 2000 });
    await shot(page, k('30-onboard-avatar-picker'));
    await teardown(page, ctx, k('30-onboard-avatar-picker'));
  });

  test(`31 onboard – Google SSO step 1 [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.click('[data-testid="login-create-account"]');
    await page.waitForSelector('[data-testid="signup-pick-google"]');
    await shot(page, k('31-onboard-sso-google') + '--s1');
    await page.click('[data-testid="signup-pick-google"]');
    await page.waitForSelector('[data-testid="login-sso-loading"]', { timeout: 2000 });
    await shot(page, k('31-onboard-sso-google') + '--s2');
    await page.waitForSelector('[data-testid="onboard-firstname"]', { timeout: 4000 });
    await expect(page.locator('[data-testid="onboard-firstname"]')).toBeVisible();
    await expect(page.locator('[data-testid="onboard-continue"]')).toBeVisible();
    await shot(page, k('31-onboard-sso-google'));
    await teardown(page, ctx, k('31-onboard-sso-google'));
  });

  test(`32 onboard – step 1 to step 2 [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep1(page, email('s1tos2'));
    await page.fill('[data-testid="onboard-firstname"]', 'Alice');
    await page.fill('[data-testid="onboard-lastname"]', 'Smith');
    await page.click('[data-testid="onboard-country-btn"]');
    await page.waitForSelector('[data-testid="onboard-country-sheet"]', { timeout: 3000 });
    await page.locator('[data-testid="sheet-close"] button').filter({ hasText: 'Netherlands' }).first().click();
    await shot(page, k('32-onboard-step1-to-step2') + '--s1');
    await page.click('[data-testid="onboard-continue"]');
    await page.waitForSelector('[data-testid="onboard-step2"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="onboard-step2"]')).toBeVisible();
    await shot(page, k('32-onboard-step1-to-step2'));
    await teardown(page, ctx, k('32-onboard-step1-to-step2'));
  });

  // -------------------------------------------------------------------------
  // Group C — Onboarding Step 2 (Bank Connect)
  // -------------------------------------------------------------------------

  test(`33 onboard-step2 – empty state [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep2(page, email('s2empty'));
    await shot(page, k('33-onboard-step2-empty') + '--s1');
    // No bank connected: primary CTA is "Add bank", skip link visible
    await expect(page.locator('[data-testid="onboard-add-bank"]')).toBeVisible();
    await expect(page.locator('[data-testid="onboard-bank-skip"]')).toBeVisible();
    await shot(page, k('33-onboard-step2-empty'));
    await teardown(page, ctx, k('33-onboard-step2-empty'));
  });

  test(`34 bank-search – filter results [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep2(page, email('bsfilter'));
    await shot(page, k('34-bank-search-filter') + '--s1');
    await page.click('[data-testid="onboard-add-bank"]');
    await page.waitForSelector('[data-testid="bank-search-screen"]', { timeout: 3000 });
    await page.fill('[data-testid="bank-search-input"]', 'rabo');
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid="bank-list-row"]').first()).toBeVisible();
    await shot(page, k('34-bank-search-filter'));
    await teardown(page, ctx, k('34-bank-search-filter'));
  });

  test(`35 bank-search – no results [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToBankSearch(page, email('bsnoresults'));
    await shot(page, k('35-bank-search-no-results') + '--s1');
    await page.fill('[data-testid="bank-search-input"]', 'zzz');
    await page.waitForTimeout(300);
    await page.waitForSelector('[data-testid="bank-search-no-results"]', { timeout: 2000 });
    await expect(page.locator('[data-testid="bank-search-no-results"]')).toBeVisible();
    await shot(page, k('35-bank-search-no-results'));
    await teardown(page, ctx, k('35-bank-search-no-results'));
  });

  test(`36 bank-creds – form pre-filled [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToBankSearch(page, email('bcreds'));
    await shot(page, k('36-bank-creds-form') + '--s1');
    await page.click('[data-testid="bank-list-row"]');
    await page.waitForSelector('[data-testid="bank-creds-screen"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="bank-creds-screen"]')).toBeVisible();
    await expect(page.locator('[data-testid="bank-creds-connect"]')).toBeVisible();
    await shot(page, k('36-bank-creds-form'));
    await teardown(page, ctx, k('36-bank-creds-form'));
  });

  test(`37 bank-creds – empty username error [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToBankCreds(page, email('bcredserr'));
    await page.fill('[data-testid="bank-creds-username"]', '');
    await shot(page, k('37-bank-creds-error') + '--s1');
    await page.click('[data-testid="bank-creds-connect"]');
    await page.waitForSelector('[data-testid="bank-creds-error"]', { timeout: 2000 });
    await expect(page.locator('[data-testid="bank-creds-error"]')).toBeVisible();
    await shot(page, k('37-bank-creds-error'));
    await teardown(page, ctx, k('37-bank-creds-error'));
  });

  test(`47 bank-creds – empty password error [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToBankCreds(page, email('bpasserr'));
    // username is pre-filled by goToBankCreds; clear only the password
    await page.fill('[data-testid="bank-creds-username"]', 'demo.user@munni.app');
    await page.evaluate(() => {
      // clear password field — type=password value must be set via input event
      const el = document.querySelector('input[type="password"]');
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await shot(page, k('47-bank-creds-password-error') + '--s1');
    await page.click('[data-testid="bank-creds-connect"]');
    await page.waitForSelector('[data-testid="bank-creds-error"]', { timeout: 2000 });
    await expect(page.locator('[data-testid="bank-creds-error"]')).toBeVisible();
    await shot(page, k('47-bank-creds-password-error'));
    await teardown(page, ctx, k('47-bank-creds-password-error'));
  });

  test(`48 country-picker – select country [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep1(page, email('country'));
    await expect(page.locator('[data-testid="onboard-country-btn"]')).toBeVisible();
    await shot(page, k('48-country-picker') + '--s1');
    await page.click('[data-testid="onboard-country-btn"]');
    await page.waitForSelector('[data-testid="onboard-country-sheet"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="onboard-country-sheet"]')).toBeVisible();
    await shot(page, k('48-country-picker') + '--s2');
    // Select Netherlands — first row in the list
    const nlRow = page.locator('[data-testid="sheet-close"] button').filter({ hasText: 'Netherlands' }).first();
    await nlRow.click();
    await expect(page.locator('[data-testid="onboard-country-btn"]')).toContainText('Netherlands');
    await shot(page, k('48-country-picker'));
    await teardown(page, ctx, k('48-country-picker'));
  });

  test(`49 country-search – search with highlight [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep1(page, email('csearch'));
    await page.click('[data-testid="onboard-country-btn"]');
    await page.waitForSelector('[data-testid="onboard-country-sheet"]', { timeout: 3000 });
    await shot(page, k('49-country-search') + '--s1');
    // Type search query — list should filter and highlight matches
    await page.fill('[data-testid="onboard-country-sheet"]', 'Neth');
    await page.waitForTimeout(200);
    await shot(page, k('49-country-search') + '--s2');
    // Netherlands should be visible in the filtered list
    const nlRow = page.locator('[data-testid="sheet-close"] button').filter({ hasText: 'Netherlands' }).first();
    await expect(nlRow).toBeVisible();
    await nlRow.click();
    await expect(page.locator('[data-testid="onboard-country-btn"]')).toContainText('Netherlands');
    await shot(page, k('49-country-search'));
    await teardown(page, ctx, k('49-country-search'));
  });

  test(`38 bank-consent – PSD2 screen [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToBankCreds(page, email('bconsent'));
    await shot(page, k('38-bank-psd2-consent') + '--s1');
    await page.click('[data-testid="bank-creds-connect"]');
    await page.waitForSelector('[data-testid="bank-consent-screen"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="bank-consent-screen"]')).toBeVisible();
    await expect(page.locator('[data-testid="bank-consent-authorise"]')).toBeVisible();
    await shot(page, k('38-bank-psd2-consent'));
    await teardown(page, ctx, k('38-bank-psd2-consent'));
  });

  test(`39 bank-connecting – spinner [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToConsent(page, email('bconnecting'));
    await shot(page, k('39-bank-connecting') + '--s1');
    await page.click('[data-testid="bank-consent-authorise"]');
    await page.waitForSelector('[data-testid="bank-connecting-screen"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="bank-connecting-screen"]')).toBeVisible();
    await shot(page, k('39-bank-connecting'));
    await teardown(page, ctx, k('39-bank-connecting'));
  });

  test(`40 bank-connected – success screen [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToConnecting(page, email('bdone'));
    await shot(page, k('40-bank-connected') + '--s1');
    await page.waitForSelector('[data-testid="bank-done-screen"]', { timeout: 4000 });
    await expect(page.locator('[data-testid="bank-done-screen"]')).toBeVisible();
    await expect(page.locator('[data-testid="bank-done-btn"]')).toBeVisible();
    await shot(page, k('40-bank-connected'));
    await teardown(page, ctx, k('40-bank-connected'));
  });

  test(`41 step2-with-bank – row + Complete CTA [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToConnecting(page, email('brow'));
    await page.waitForSelector('[data-testid="bank-done-screen"]', { timeout: 4000 });
    await shot(page, k('41-step2-with-bank') + '--s1');
    await page.click('[data-testid="bank-done-btn"]');
    await page.waitForSelector('[data-testid="onboard-bank-row"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="onboard-bank-row"]')).toBeVisible();
    await expect(page.locator('[data-testid="onboard-complete"]')).toBeVisible();
    await expect(page.locator('[data-testid="onboard-add-another-bank"]')).toBeVisible();
    await shot(page, k('41-step2-with-bank'));
    await teardown(page, ctx, k('41-step2-with-bank'));
  });

  test(`42 step2-skip – home loads [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep2(page, email('skip'));
    await shot(page, k('42-step2-skip') + '--s1');
    await page.click('[data-testid="onboard-bank-skip"]');
    await page.waitForSelector('[data-testid="tab-home"]', { timeout: 5000 });
    await expect(page.locator('[data-testid="tab-home"]')).toBeVisible();
    await shot(page, k('42-step2-skip'));
    await teardown(page, ctx, k('42-step2-skip'));
  });

  test(`43 bank-remove – row removed [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep2WithBank(page, email('bremove'));
    await shot(page, k('43-bank-remove') + '--s1');
    // Click the × button on the bank row
    await page.click('[data-testid="onboard-remove-bank"]');
    await shot(page, k('43-bank-remove') + '--s2');
    // Step 2 returns to empty state
    await page.waitForSelector('[data-testid="onboard-add-bank"]', { timeout: 2000 });
    await expect(page.locator('[data-testid="onboard-add-bank"]')).toBeVisible();
    await shot(page, k('43-bank-remove'));
    await teardown(page, ctx, k('43-bank-remove'));
  });

  // -------------------------------------------------------------------------
  // Group D — Browser Back Navigation
  // -------------------------------------------------------------------------

  test(`44 back – step 2 to step 1 [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep2(page, email('back-s2s1'));
    await shot(page, k('44-back-step2-to-step1') + '--s1');
    await page.goBack();
    await page.waitForSelector('[data-testid="onboard-step1"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="onboard-step1"]')).toBeVisible();
    await shot(page, k('44-back-step2-to-step1'));
    await teardown(page, ctx, k('44-back-step2-to-step1'));
  });

  test(`45 back – bank search to step 2 [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToBankSearch(page, email('back-bss2'));
    await shot(page, k('45-back-search-to-step2') + '--s1');
    await page.goBack();
    await page.waitForSelector('[data-testid="onboard-step2"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="onboard-step2"]')).toBeVisible();
    await shot(page, k('45-back-search-to-step2'));
    await teardown(page, ctx, k('45-back-search-to-step2'));
  });

  test(`46 back – bank creds to search [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToBankCreds(page, email('back-bcs'));
    await shot(page, k('46-back-creds-to-search') + '--s1');
    await page.goBack();
    await page.waitForSelector('[data-testid="bank-search-screen"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="bank-search-screen"]')).toBeVisible();
    await shot(page, k('46-back-creds-to-search'));
    await teardown(page, ctx, k('46-back-creds-to-search'));
  });

  test(`50 onboard – country missing error [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep1(page, email('no-country'));
    await page.fill('[data-testid="onboard-firstname"]', 'Alice');
    await page.fill('[data-testid="onboard-lastname"]', 'Smith');
    await shot(page, k('50-onboard-country-error') + '--s1');
    // Submit without selecting a country
    await page.click('[data-testid="onboard-continue"]');
    // Diagnostic: capture state immediately after click so CI failure is inspectable in the gallery
    await shot(page, k('50-onboard-country-error') + '--after-click');
    // Use 'attached' so a scroll-offset element still passes (Playwright 1.60 visibility check)
    await page.locator('[data-testid="onboard-country-error"]').waitFor({ state: 'attached', timeout: 3000 });
    await page.locator('[data-testid="onboard-country-error"]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-testid="onboard-country-error"]')).toBeVisible();
    await shot(page, k('50-onboard-country-error') + '--s2');
    // Now select a country — error element should be removed from DOM
    await page.click('[data-testid="onboard-country-btn"]');
    await page.waitForSelector('[data-testid="onboard-country-sheet"]', { timeout: 3000 });
    await page.locator('[data-testid="sheet-close"] button').filter({ hasText: 'Netherlands' }).first().click();
    await page.locator('[data-testid="onboard-country-error"]').waitFor({ state: 'detached', timeout: 2000 });
    await shot(page, k('50-onboard-country-error'));
    await teardown(page, ctx, k('50-onboard-country-error'));
  });
}
