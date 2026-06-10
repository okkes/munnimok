import { test } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

// Wait for the m-fade animation (280ms) to complete before screenshotting.
// Without this, click-triggered screen transitions are caught at ~opacity 0.
const shot = async (page, name) => {
  await page.waitForTimeout(350);
  return page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
};

// ---------------------------------------------------------------------------
// Base setup: clear storage, set English
// ---------------------------------------------------------------------------
async function base(page, extraSetup) {
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('munni_lang', JSON.stringify('en'));
  });
  if (extraSetup) await page.addInitScript(extraSetup);
  await page.goto('/');
  await page.waitForSelector('.m-logo');
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------
async function goToSignupPicker(page) {
  await page.getByText('Create account', { exact: false }).first().click();
  await page.waitForSelector('text=Sign up with email');
}

async function goToSignupEmail(page) {
  await goToSignupPicker(page);
  await page.getByText('Sign up with email').click();
  await page.waitForSelector('text=Send verification code');
}

// ---------------------------------------------------------------------------
// Group 1 — Main login screen
// ---------------------------------------------------------------------------

test('01 login – fresh install', async ({ page }) => {
  await base(page);
  await shot(page, '01-login-fresh');
});

test('02 login – returning user (welcome back heading)', async ({ page }) => {
  await base(page, () => localStorage.setItem('munni_opened_before', 'true'));
  await shot(page, '02-login-returning');
});

test('03 login – email address not found error', async ({ page }) => {
  await base(page);
  await page.fill('[data-testid="login-email-input"]', 'nobody@example.com');
  await page.click('[data-testid="login-email-submit"]');
  await page.waitForSelector('text=No account found', { timeout: 4000 });
  await shot(page, '03-login-email-error');
});

test('04 login – Google SSO loading screen', async ({ page }) => {
  await base(page);
  await page.click('[data-testid="login-google-btn"]');
  await page.waitForSelector('text=Signing in with', { timeout: 2000 });
  await shot(page, '04-login-sso-loading');
});

test('05 login – Apple SSO loading screen', async ({ page }) => {
  await base(page);
  await page.click('[data-testid="login-apple-btn"]');
  await page.waitForSelector('text=Signing in with', { timeout: 2000 });
  await shot(page, '05-login-sso-loading-apple');
});

// ---------------------------------------------------------------------------
// Group 2 — Signup method picker
// ---------------------------------------------------------------------------

test('06 signup – method picker (no prior accounts)', async ({ page }) => {
  await base(page);
  await goToSignupPicker(page);
  await shot(page, '06-signup-picker');
});

test('07 signup – Google already registered (disabled)', async ({ page }) => {
  await base(page, () =>
    localStorage.setItem('munni_signup_methods', JSON.stringify(['google'])));
  await goToSignupPicker(page);
  await shot(page, '07-signup-google-disabled');
});

test('08 signup – Google and Apple both disabled', async ({ page }) => {
  await base(page, () =>
    localStorage.setItem('munni_signup_methods', JSON.stringify(['google', 'apple'])));
  await goToSignupPicker(page);
  await shot(page, '08-signup-both-sso-disabled');
});

// ---------------------------------------------------------------------------
// Group 3 — Signup email entry
// ---------------------------------------------------------------------------

test('09 signup-email – empty form', async ({ page }) => {
  await base(page);
  await goToSignupEmail(page);
  await shot(page, '09-signup-email-form');
});

test('10 signup-email – invalid format (bla@bla.)', async ({ page }) => {
  await base(page);
  await goToSignupEmail(page);
  await page.fill('input[type="email"]', 'bla@bla.');
  await page.getByText('Send verification code').click();
  await page.waitForSelector('text=valid email', { timeout: 3000 });
  await shot(page, '10-signup-email-invalid');
});

test('11 signup-email – reserved address (bank@munni.app)', async ({ page }) => {
  await base(page);
  await goToSignupEmail(page);
  await page.fill('input[type="email"]', 'bank@munni.app');
  await page.getByText('Send verification code').click();
  await page.waitForSelector('text=cannot be used', { timeout: 3000 });
  await shot(page, '11-signup-email-reserved');
});

test('12 signup-email – address already registered', async ({ page }) => {
  await base(page, () => {
    localStorage.setItem('munni_signup_emails', JSON.stringify(['taken@example.com']));
    localStorage.setItem('munni_signup_methods', JSON.stringify(['email']));
  });
  await goToSignupEmail(page);
  await page.fill('input[type="email"]', 'taken@example.com');
  await page.getByText('Send verification code').click();
  await page.waitForSelector('text=already registered', { timeout: 3000 });
  await shot(page, '12-signup-email-exists');
});

// ---------------------------------------------------------------------------
// Group 4 — Verification screens
// ---------------------------------------------------------------------------

test('13 verify – digits auto-filling (in progress)', async ({ page }) => {
  await base(page);
  await goToSignupEmail(page);
  await page.fill('input[type="email"]', 'new@example.com');
  await page.getByText('Send verification code').click();
  // Wait for auto-fill animation to start
  await page.waitForSelector('text=Auto-filling code', { timeout: 3000 });
  await shot(page, '13-verify-filling');
});

test('14 verify – all 6 digits filled', async ({ page }) => {
  await base(page);
  await goToSignupEmail(page);
  await page.fill('input[type="email"]', 'new2@example.com');
  await page.getByText('Send verification code').click();
  await page.waitForSelector('text=Auto-filling code', { timeout: 3000 });
  // Wait for all 6 digits to appear (fills at 100ms intervals, 6 digits = ~600ms)
  await page.waitForTimeout(700);
  await shot(page, '14-verify-complete');
});

test('15 verify – login OTP (returning email user)', async ({ page }) => {
  await base(page, () => {
    localStorage.setItem('munni_signup_emails', JSON.stringify(['user@example.com']));
    localStorage.setItem('munni_signup_methods', JSON.stringify(['email']));
    localStorage.setItem('munni_opened_before', 'true');
  });
  await page.fill('[data-testid="login-email-input"]', 'user@example.com');
  await page.click('[data-testid="login-email-submit"]');
  await page.waitForSelector('text=Auto-filling code', { timeout: 3000 });
  await page.waitForTimeout(700);
  await shot(page, '15-verify-login');
});

// ---------------------------------------------------------------------------
// Group 5 — Email input (dedicated screen via "Sign in instead")
// ---------------------------------------------------------------------------

test('16 email-input – screen after "Sign in instead"', async ({ page }) => {
  await base(page, () => {
    localStorage.setItem('munni_signup_emails', JSON.stringify(['taken@example.com']));
    localStorage.setItem('munni_signup_methods', JSON.stringify(['email']));
  });
  await goToSignupEmail(page);
  await page.fill('input[type="email"]', 'taken@example.com');
  await page.getByText('Send verification code').click();
  await page.waitForSelector('text=Sign in instead', { timeout: 3000 });
  await page.getByText('Sign in instead').click();
  await page.waitForSelector('text=Sign in', { timeout: 3000 });
  await shot(page, '16-email-input-screen');
});

test('17 email-input – not found error', async ({ page }) => {
  await base(page, () => {
    localStorage.setItem('munni_signup_emails', JSON.stringify(['taken@example.com']));
    localStorage.setItem('munni_signup_methods', JSON.stringify(['email']));
  });
  await goToSignupEmail(page);
  await page.fill('input[type="email"]', 'taken@example.com');
  await page.getByText('Send verification code').click();
  await page.waitForSelector('text=Sign in instead', { timeout: 3000 });
  await page.getByText('Sign in instead').click();
  await page.waitForSelector('text=Sign in', { timeout: 3000 });
  await page.fill('input[type="email"]', 'nobody@example.com');
  await page.getByText('Continue').click();
  await page.waitForSelector('text=No account found', { timeout: 3000 });
  await shot(page, '17-email-input-error');
});

// ---------------------------------------------------------------------------
// Group 6 — No account found
// ---------------------------------------------------------------------------

test('18 no-account – Google (no prior registration)', async ({ page }) => {
  await base(page);
  await page.click('[data-testid="login-google-btn"]');
  await page.waitForSelector('text=No account found', { timeout: 4000 });
  await shot(page, '18-no-account-google');
});

test('19 no-account – Apple (no prior registration)', async ({ page }) => {
  await base(page);
  await page.click('[data-testid="login-apple-btn"]');
  await page.waitForSelector('text=No account found', { timeout: 4000 });
  await shot(page, '19-no-account-apple');
});
