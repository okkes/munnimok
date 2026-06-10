import { test, expect } from '@playwright/test';
import path from 'path';
import { VARIANTS, createPage, base, shot, teardown, SHOTS_DIR } from '../helpers/base.js';
import { goToSignupPicker, goToSignupEmail } from '../helpers/nav.js';

for (const V of VARIANTS) {
  // Prefix every screenshot name with the variant id.
  const k = (name) => `${name}--${V.id}`;

  // -------------------------------------------------------------------------
  // Group 1 — Main Login
  // -------------------------------------------------------------------------

  test(`01 login – fresh install [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    // Verify language is active
    const lang = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('munni_lang')); } catch { return null; } });
    expect(lang).toBe(V.lang);
    await shot(page, k('01-login-fresh'));
    await teardown(page, ctx, k('01-login-fresh'));
  });

  test(`02 login – returning user [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, () => localStorage.setItem('munni_opened_before', 'true'));
    await shot(page, k('02-login-returning'));
    await teardown(page, ctx, k('02-login-returning'));
  });

  test(`03 login – email not found [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.fill('[data-testid="login-email-input"]', 'nobody@example.com');
    await page.click('[data-testid="login-email-submit"]');
    await page.waitForSelector('[data-testid="login-error"]', { timeout: 4000 });
    await shot(page, k('03-login-email-error'));
    await teardown(page, ctx, k('03-login-email-error'));
  });

  test(`04 login – Google SSO loading [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.click('[data-testid="login-google-btn"]');
    await page.waitForSelector('[data-testid="login-sso-loading"]', { timeout: 2000 });
    await shot(page, k('04-login-sso-loading'));
    await teardown(page, ctx, k('04-login-sso-loading'));
  });

  test(`05 login – Apple SSO loading [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.click('[data-testid="login-apple-btn"]');
    await page.waitForSelector('[data-testid="login-sso-loading"]', { timeout: 2000 });
    await shot(page, k('05-login-sso-loading-apple'));
    await teardown(page, ctx, k('05-login-sso-loading-apple'));
  });

  // -------------------------------------------------------------------------
  // Group 2 — Signup Method Picker
  // -------------------------------------------------------------------------

  test(`06 signup – method picker [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSignupPicker(page);
    await shot(page, k('06-signup-picker'));
    await teardown(page, ctx, k('06-signup-picker'));
  });

  test(`07 signup – Google disabled [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, () =>
      localStorage.setItem('munni_signup_methods', JSON.stringify(['google'])));
    await goToSignupPicker(page);
    await shot(page, k('07-signup-google-disabled'));
    await teardown(page, ctx, k('07-signup-google-disabled'));
  });

  test(`08 signup – both SSO disabled [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, () =>
      localStorage.setItem('munni_signup_methods', JSON.stringify(['google', 'apple'])));
    await goToSignupPicker(page);
    await shot(page, k('08-signup-both-sso-disabled'));
    await teardown(page, ctx, k('08-signup-both-sso-disabled'));
  });

  // -------------------------------------------------------------------------
  // Group 3 — Signup Email Entry
  // -------------------------------------------------------------------------

  test(`09 signup-email – empty form [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSignupEmail(page);
    await shot(page, k('09-signup-email-form'));
    await teardown(page, ctx, k('09-signup-email-form'));
  });

  test(`10 signup-email – invalid format [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSignupEmail(page);
    await page.fill('input[type="email"]', 'bla@bla.');
    await page.click('[data-testid="signup-send-code"]');
    await page.waitForSelector('[data-testid="signup-email-error"]', { timeout: 3000 });
    await shot(page, k('10-signup-email-invalid'));
    await teardown(page, ctx, k('10-signup-email-invalid'));
  });

  test(`11 signup-email – reserved address [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSignupEmail(page);
    await page.fill('input[type="email"]', 'bank@munni.app');
    await page.click('[data-testid="signup-send-code"]');
    await page.waitForSelector('[data-testid="signup-email-error"]', { timeout: 3000 });
    await shot(page, k('11-signup-email-reserved'));
    await teardown(page, ctx, k('11-signup-email-reserved'));
  });

  // Test 12: captures step screenshots for en-light-mobile to power the step-replay player.
  test(`12 signup-email – address already registered [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, () => {
      localStorage.setItem('munni_signup_emails', JSON.stringify(['taken@example.com']));
      localStorage.setItem('munni_signup_methods', JSON.stringify(['email']));
    });

    if (V.id === 'en-light-mobile') {
      // Step 1: Login screen (starting state)
      await shot(page, k('12-signup-email-exists') + '--s1');

      // Step 2: Signup method picker
      await page.click('[data-testid="login-create-account"]');
      await page.waitForSelector('[data-testid="signup-pick-email"]');
      await shot(page, k('12-signup-email-exists') + '--s2');

      // Step 3: Email form open
      await page.click('[data-testid="signup-pick-email"]');
      await page.waitForSelector('[data-testid="signup-send-code"]');
      await shot(page, k('12-signup-email-exists') + '--s3');

      // Final: submit and capture error
      await page.fill('input[type="email"]', 'taken@example.com');
      await page.click('[data-testid="signup-send-code"]');
      await page.waitForSelector('[data-testid="signup-email-error"]', { timeout: 3000 });
      await shot(page, k('12-signup-email-exists'));
    } else {
      await goToSignupEmail(page);
      await page.fill('input[type="email"]', 'taken@example.com');
      await page.click('[data-testid="signup-send-code"]');
      await page.waitForSelector('[data-testid="signup-email-error"]', { timeout: 3000 });
      await shot(page, k('12-signup-email-exists'));
    }

    await teardown(page, ctx, k('12-signup-email-exists'));
  });

  // -------------------------------------------------------------------------
  // Group 4 — Verification
  // -------------------------------------------------------------------------

  test(`13 verify – auto-fill in progress [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSignupEmail(page);
    await page.fill('input[type="email"]', 'new@example.com');
    await page.click('[data-testid="signup-send-code"]');
    await page.waitForSelector('[data-testid="verify-autofilling"]', { timeout: 4000 });
    await shot(page, k('13-verify-filling'));
    await teardown(page, ctx, k('13-verify-filling'));
  });

  test(`14 verify – auto-fill complete [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSignupEmail(page);
    await page.fill('input[type="email"]', 'new2@example.com');
    await page.click('[data-testid="signup-send-code"]');
    await page.waitForSelector('[data-testid="verify-autofilling"]', { timeout: 4000 });
    // Wait for all 6 digits to fill (~600 ms at 100 ms/digit)
    await page.waitForTimeout(700);
    await shot(page, k('14-verify-complete'));
    await teardown(page, ctx, k('14-verify-complete'));
  });

  test(`15 verify – login OTP complete [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, () => {
      localStorage.setItem('munni_signup_emails', JSON.stringify(['user@example.com']));
      localStorage.setItem('munni_signup_methods', JSON.stringify(['email']));
      localStorage.setItem('munni_opened_before', 'true');
    });
    await page.fill('[data-testid="login-email-input"]', 'user@example.com');
    await page.click('[data-testid="login-email-submit"]');
    await page.waitForSelector('[data-testid="verify-autofilling"]', { timeout: 4000 });
    await page.waitForTimeout(700);
    await shot(page, k('15-verify-login'));
    await teardown(page, ctx, k('15-verify-login'));
  });

  // -------------------------------------------------------------------------
  // Group 5 — Email Input (dedicated)
  // -------------------------------------------------------------------------

  test(`16 email-input – dedicated screen [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, () => {
      localStorage.setItem('munni_signup_emails', JSON.stringify(['taken@example.com']));
      localStorage.setItem('munni_signup_methods', JSON.stringify(['email']));
    });
    await goToSignupEmail(page);
    await page.fill('input[type="email"]', 'taken@example.com');
    await page.click('[data-testid="signup-send-code"]');
    await page.waitForSelector('[data-testid="signup-sign-in-instead"]', { timeout: 3000 });
    await page.click('[data-testid="signup-sign-in-instead"]');
    await page.waitForSelector('[data-testid="email-input-continue"]');
    await shot(page, k('16-email-input-screen'));
    await teardown(page, ctx, k('16-email-input-screen'));
  });

  test(`17 email-input – not found error [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, () => {
      localStorage.setItem('munni_signup_emails', JSON.stringify(['taken@example.com']));
      localStorage.setItem('munni_signup_methods', JSON.stringify(['email']));
    });
    await goToSignupEmail(page);
    await page.fill('input[type="email"]', 'taken@example.com');
    await page.click('[data-testid="signup-send-code"]');
    await page.waitForSelector('[data-testid="signup-sign-in-instead"]', { timeout: 3000 });
    await page.click('[data-testid="signup-sign-in-instead"]');
    await page.waitForSelector('[data-testid="email-input-continue"]');
    await page.fill('input[type="email"]', 'nobody@example.com');
    await page.click('[data-testid="email-input-continue"]');
    await page.waitForSelector('[data-testid="login-error"]', { timeout: 3000 });
    await shot(page, k('17-email-input-error'));
    await teardown(page, ctx, k('17-email-input-error'));
  });

  // -------------------------------------------------------------------------
  // Group 6 — No Account Found
  // -------------------------------------------------------------------------

  test(`18 no-account – Google [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.click('[data-testid="login-google-btn"]');
    await page.waitForSelector('[data-testid="login-no-account"]', { timeout: 4000 });
    await shot(page, k('18-no-account-google'));
    await teardown(page, ctx, k('18-no-account-google'));
  });

  test(`19 no-account – Apple [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.click('[data-testid="login-apple-btn"]');
    await page.waitForSelector('[data-testid="login-no-account"]', { timeout: 4000 });
    await shot(page, k('19-no-account-apple'));
    await teardown(page, ctx, k('19-no-account-apple'));
  });
}
