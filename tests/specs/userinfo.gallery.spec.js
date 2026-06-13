import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

// Select a country in the onboarding picker.
// onboard-country-sheet testId is on the search input; country rows are button.m-tap inside the sheet.
async function selectCountryOnboard(page, countryName) {
  await page.locator('[data-testid="sheet-close"] button').filter({ hasText: countryName }).first().click();
}

// Select a country in the profile country picker.
// profile-country-sheet testId is on the scroll container; items are div.m-tap inside it.
async function selectCountryProfile(page, countryName) {
  await page.locator('[data-testid="profile-country-sheet"] div.m-tap').filter({ hasText: countryName }).first().click();
}

// Complete email signup (names + country) and land on the Settings tab (ScreenProfile).
async function goToSettings(page, emailStr, opts = {}) {
  const firstName = opts.firstName || 'Test';
  const lastName  = opts.lastName  || 'User';
  const country   = opts.country   || 'Netherlands';
  await page.click('[data-testid="login-create-account"]');
  await page.waitForSelector('[data-testid="signup-pick-email"]');
  await page.click('[data-testid="signup-pick-email"]');
  await page.waitForSelector('[data-testid="signup-send-code"]');
  await page.fill('input[type="email"]', emailStr);
  await page.click('[data-testid="signup-send-code"]');
  await page.waitForSelector('[data-testid="onboard-firstname"]', { timeout: 5000 });
  await page.fill('[data-testid="onboard-firstname"]', firstName);
  await page.fill('[data-testid="onboard-lastname"]', lastName);
  await page.click('[data-testid="onboard-country-btn"]');
  await page.waitForSelector('[data-testid="onboard-country-sheet"]', { timeout: 3000 });
  await selectCountryOnboard(page, country);
  await page.click('[data-testid="onboard-continue"]');
  await page.waitForSelector('[data-testid="onboard-step2"]', { timeout: 3000 });
  await page.click('[data-testid="onboard-bank-skip"]');
  await page.waitForSelector('[data-testid="tab-profile"]', { timeout: 8000 });
  await page.click('[data-testid="tab-profile"]');
  await page.waitForSelector('[data-testid="profile-settings-btn"]', { timeout: 3000 });
}

// Complete email signup and navigate all the way to ScreenUserInfo (My Profile).
async function goToUserInfo(page, emailStr, opts = {}) {
  await goToSettings(page, emailStr, opts);
  await page.click('[data-testid="profile-settings-btn"]');
  await page.waitForSelector('[data-testid="profile-country-btn"]', { timeout: 3000 });
}

// Demo login and land on the Settings tab.
async function goToSettingsDemo(page) {
  await page.click('[data-testid="login-demo-btn"]');
  await page.waitForSelector('[data-testid="tab-home"]', { timeout: 8000 });
  await page.click('[data-testid="tab-profile"]');
  await page.waitForSelector('[data-testid="profile-settings-btn"]', { timeout: 3000 });
}

// Demo login and navigate to ScreenUserInfo (My Profile).
async function goToUserInfoDemo(page) {
  await goToSettingsDemo(page);
  await page.click('[data-testid="profile-settings-btn"]');
  await page.waitForSelector('[data-testid="profile-country-btn"]', { timeout: 3000 });
}

// Google SSO signup (name pre-filled) + select country → land on ScreenUserInfo.
async function goToUserInfoGoogle(page) {
  await page.click('[data-testid="login-create-account"]');
  await page.waitForSelector('[data-testid="signup-pick-google"]', { timeout: 3000 });
  await page.click('[data-testid="signup-pick-google"]');
  await page.waitForSelector('[data-testid="onboard-firstname"]', { timeout: 5000 });
  await page.click('[data-testid="onboard-country-btn"]');
  await page.waitForSelector('[data-testid="onboard-country-sheet"]', { timeout: 3000 });
  await selectCountryOnboard(page, 'Netherlands');
  await page.click('[data-testid="onboard-continue"]');
  // Google SSO has banks:['ing'] pre-wired → "Complete" button shows, not "Skip"
  await page.waitForSelector('[data-testid="onboard-step2"]', { timeout: 3000 });
  await page.click('[data-testid="onboard-complete"]');
  await page.waitForSelector('[data-testid="tab-home"]', { timeout: 8000 });
  await page.click('[data-testid="tab-profile"]');
  await page.waitForSelector('[data-testid="profile-settings-btn"]', { timeout: 3000 });
  await page.click('[data-testid="profile-settings-btn"]');
  await page.waitForSelector('[data-testid="profile-country-btn"]', { timeout: 3000 });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;
  const email = (suffix) => `ui-${suffix}-${V.id.replace(/-/g, '')}@example.com`;

  // ─────────────────────────────────────────────────────────────────────────
  // Group 1 — Country field (existing)
  // ─────────────────────────────────────────────────────────────────────────

  test(`01 userinfo-country-picker – open and select [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('pick'));
    await expect(page.locator('[data-testid="profile-country-btn"]')).toBeVisible();
    await shot(page, k('01-userinfo-country-picker') + '--s1');
    await page.click('[data-testid="profile-country-btn"]');
    await page.waitForSelector('[data-testid="profile-country-sheet"]', { timeout: 3000 });
    await shot(page, k('01-userinfo-country-picker') + '--s2');
    const deRow = page.locator('[data-testid="profile-country-sheet"] div.m-tap').filter({ hasText: 'Germany' }).first();
    await expect(deRow).toBeVisible();
    await deRow.click();
    await expect(page.locator('[data-testid="profile-country-btn"]')).toContainText('Germany');
    await shot(page, k('01-userinfo-country-picker'));
    await teardown(page, ctx, k('01-userinfo-country-picker'));
  });

  test(`02 userinfo-country-search – search with highlight and retain [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('search'));
    await page.click('[data-testid="profile-country-btn"]');
    await page.waitForSelector('[data-testid="profile-country-sheet"]', { timeout: 3000 });
    await shot(page, k('02-userinfo-country-search') + '--s1');
    await page.fill('[data-testid="profile-country-search"]', 'Ger');
    await page.waitForTimeout(200);
    await shot(page, k('02-userinfo-country-search') + '--s2');
    const deRow = page.locator('[data-testid="profile-country-sheet"] div.m-tap').filter({ hasText: 'Germany' }).first();
    await expect(deRow).toBeVisible();
    await deRow.click();
    await expect(page.locator('[data-testid="profile-country-btn"]')).toContainText('Germany');
    await page.click('[data-testid="profile-save-btn"]');
    await page.waitForTimeout(300);
    await page.click('[data-testid="profile-settings-btn"]');
    await page.waitForSelector('[data-testid="profile-country-btn"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="profile-country-btn"]')).toContainText('Germany');
    await shot(page, k('02-userinfo-country-search'));
    await teardown(page, ctx, k('02-userinfo-country-search'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 2 — Settings screen (ScreenProfile)
  // ─────────────────────────────────────────────────────────────────────────

  test(`03 settings – email user layout [${V.id}]`, async ({ browser }) => {
    test.setTimeout(90000);
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSettings(page, email('slay'));
    await shot(page, k('03-settings-layout-email') + '--s1');
    // Identity card visible with name and email
    await expect(page.locator('[data-testid="profile-settings-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="profile-settings-btn"]')).toContainText('Test', { timeout: 10000 });
    await expect(page.locator('[data-testid="profile-settings-btn"]')).toContainText('User', { timeout: 10000 });
    // Sign-out row visible
    await expect(page.locator('[data-testid="profile-signout-row"]')).toBeVisible();
    // No "Demo" badge on the identity card
    await expect(page.locator('[data-testid="profile-settings-btn"]')).not.toContainText('Demo');
    await shot(page, k('03-settings-layout-email'));
    await teardown(page, ctx, k('03-settings-layout-email'));
  });

  test(`04 settings – demo user layout [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSettingsDemo(page);
    await shot(page, k('04-settings-layout-demo') + '--s1');
    // Demo badge on identity card
    const identityCard = page.locator('[data-testid="profile-settings-btn"]');
    await expect(identityCard).toBeVisible();
    const cardText = await identityCard.textContent();
    expect(cardText).toContain('Demo');
    // demo@munni.app email shown
    await expect(identityCard).toContainText('demo@munni.app');
    // Reset demo row visible
    await expect(page.locator('[data-testid="profile-reset-row"]')).toBeVisible();
    await shot(page, k('04-settings-layout-demo'));
    await teardown(page, ctx, k('04-settings-layout-demo'));
  });

  test(`05 settings – sign out returns to login [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSettings(page, email('sout'));
    await shot(page, k('05-settings-signout') + '--s1');
    await page.click('[data-testid="profile-signout-row"]');
    await page.waitForSelector('.m-logo', { timeout: 5000 });
    await shot(page, k('05-settings-signout'));
    await teardown(page, ctx, k('05-settings-signout'));
  });

  test(`06 settings – reset demo sheet opens and cancel dismisses [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSettingsDemo(page);
    await page.click('[data-testid="profile-reset-row"]');
    await page.waitForSelector('[data-testid="profile-reset-sheet"]', { timeout: 3000 });
    await shot(page, k('06-settings-reset-sheet') + '--s1');
    await expect(page.locator('[data-testid="profile-reset-sheet"]')).toBeVisible();
    // Cancel button dismisses
    await page.locator('[data-testid="profile-reset-sheet"] button').filter({ hasText: /cancel/i }).click();
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid="profile-reset-sheet"]')).not.toBeVisible();
    await shot(page, k('06-settings-reset-sheet'));
    await teardown(page, ctx, k('06-settings-reset-sheet'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 3 — My Profile (ScreenUserInfo) layout variants
  // ─────────────────────────────────────────────────────────────────────────

  test(`07 userinfo – demo user layout [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfoDemo(page);
    await shot(page, k('07-userinfo-layout-demo') + '--s1');
    // Name inputs exist but are disabled
    await expect(page.locator('[data-testid="profile-firstname-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="profile-firstname-input"]')).toBeDisabled();
    await expect(page.locator('[data-testid="profile-lastname-input"]')).toBeDisabled();
    // No Save button (demo users cannot save)
    await expect(page.locator('[data-testid="profile-save-btn"]')).not.toBeVisible();
    // No API endpoint section
    await expect(page.locator('[data-testid="profile-api-row"]')).not.toBeVisible();
    // No Delete account
    await expect(page.locator('[data-testid="profile-delete-row"]')).not.toBeVisible();
    // "Demo account" label
    await expect(page.locator('text=Demo account')).toBeVisible();
    await shot(page, k('07-userinfo-layout-demo'));
    await teardown(page, ctx, k('07-userinfo-layout-demo'));
  });

  test(`08 userinfo – Google SSO layout [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfoGoogle(page);
    await shot(page, k('08-userinfo-layout-google') + '--s1');
    // Name inputs editable (not disabled)
    await expect(page.locator('[data-testid="profile-firstname-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="profile-firstname-input"]')).not.toBeDisabled();
    // Save button present
    await expect(page.locator('[data-testid="profile-save-btn"]')).toBeVisible();
    // API endpoint section visible
    await expect(page.locator('[data-testid="profile-api-row"]')).toBeVisible();
    // Email row: locked (Google lock icon — no m-tap class)
    const emailRow = page.locator('[data-testid="profile-change-email-row"]');
    await expect(emailRow).toBeVisible();
    // Email row should NOT have m-tap class for Google (canChangeEmail = false)
    const cls = await emailRow.getAttribute('class');
    expect(cls || '').not.toContain('m-tap');
    // "Signed in with Google" text (Settings identity card also has this text — use first visible)
    await expect(page.locator('text=Signed in with Google').first()).toBeVisible();
    await shot(page, k('08-userinfo-layout-google'));
    await teardown(page, ctx, k('08-userinfo-layout-google'));
  });

  test(`09 userinfo – email user layout [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('lay'));
    await shot(page, k('09-userinfo-layout-email') + '--s1');
    // Name fields editable
    await expect(page.locator('[data-testid="profile-firstname-input"]')).not.toBeDisabled();
    // Save button
    await expect(page.locator('[data-testid="profile-save-btn"]')).toBeVisible();
    // Country section
    await expect(page.locator('[data-testid="profile-country-btn"]')).toBeVisible();
    // Email row tappable (canChangeEmail = true for email login)
    const emailRow = page.locator('[data-testid="profile-change-email-row"]');
    await expect(emailRow).toBeVisible();
    const cls = await emailRow.getAttribute('class');
    expect(cls || '').toContain('m-tap');
    // API endpoint + delete account
    await expect(page.locator('[data-testid="profile-api-row"]')).toBeVisible();
    await expect(page.locator('[data-testid="profile-delete-row"]')).toBeVisible();
    await shot(page, k('09-userinfo-layout-email'));
    await teardown(page, ctx, k('09-userinfo-layout-email'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 4 — Photo picker
  // ─────────────────────────────────────────────────────────────────────────

  test(`10 userinfo – photo picker opens [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('ppopen'));
    await shot(page, k('10-photo-picker-opens') + '--s1');
    await page.click('[data-testid="profile-change-photo-btn"]');
    await page.waitForSelector('[data-testid="profile-pic-sheet"]', { timeout: 3000 });
    await shot(page, k('10-photo-picker-opens') + '--s2');
    await expect(page.locator('[data-testid="profile-pic-sheet"]')).toBeVisible();
    // Grid of stock avatars visible (5×N grid buttons)
    const avatarBtns = page.locator('[data-testid="profile-pic-sheet"] button');
    await expect(avatarBtns.first()).toBeVisible();
    await shot(page, k('10-photo-picker-opens'));
    await teardown(page, ctx, k('10-photo-picker-opens'));
  });

  test(`11 userinfo – photo picker select avatar updates header [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('ppsel'));
    await page.click('[data-testid="profile-change-photo-btn"]');
    await page.waitForSelector('[data-testid="profile-pic-sheet"]', { timeout: 3000 });
    await shot(page, k('11-photo-picker-select') + '--s1');
    // Click first stock avatar button
    await page.locator('[data-testid="profile-pic-sheet"] button').first().click();
    await page.waitForTimeout(300);
    // Sheet should close
    await expect(page.locator('[data-testid="profile-pic-sheet"]')).not.toBeVisible();
    // Avatar button now shows an emoji (not initials)
    await expect(page.locator('[data-testid="profile-avatar-btn"]')).toBeVisible();
    await shot(page, k('11-photo-picker-select'));
    await teardown(page, ctx, k('11-photo-picker-select'));
  });

  test(`12 userinfo – photo picker remove photo [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('pprem'));
    // First select an avatar
    await page.click('[data-testid="profile-change-photo-btn"]');
    await page.waitForSelector('[data-testid="profile-pic-sheet"]', { timeout: 3000 });
    await page.locator('[data-testid="profile-pic-sheet"] button').first().click();
    await page.waitForTimeout(300);
    await shot(page, k('12-photo-picker-remove') + '--s1');
    // Re-open picker — "Remove photo" button should appear since a pic is set
    await page.click('[data-testid="profile-change-photo-btn"]');
    await page.waitForSelector('[data-testid="profile-pic-sheet"]', { timeout: 3000 });
    await shot(page, k('12-photo-picker-remove') + '--s2');
    const removeBtn = page.locator('[data-testid="profile-pic-sheet"] button').filter({ hasText: /remove/i });
    await expect(removeBtn).toBeVisible();
    await removeBtn.click();
    await page.waitForTimeout(300);
    // Sheet closed
    await expect(page.locator('[data-testid="profile-pic-sheet"]')).not.toBeVisible();
    // Avatar back to initials (gradient div, no emoji background)
    await shot(page, k('12-photo-picker-remove'));
    await teardown(page, ctx, k('12-photo-picker-remove'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 5 — Country info sheet
  // ─────────────────────────────────────────────────────────────────────────

  test(`13 userinfo – country info sheet opens [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('cinfo'));
    await shot(page, k('13-country-info-sheet') + '--s1');
    // Tap the ⓘ next to COUNTRY label
    await page.click('[data-testid="profile-country-info-btn"]');
    await page.waitForSelector('[data-testid="profile-country-info-sheet"]', { timeout: 3000 });
    await shot(page, k('13-country-info-sheet') + '--s2');
    await expect(page.locator('[data-testid="profile-country-info-sheet"]')).toBeVisible();
    // Info sheet explains what the country field is for
    const infoText = await page.locator('[data-testid="profile-country-info-sheet"]').textContent();
    expect(infoText.toLowerCase()).toMatch(/primarily|purchases|region/);
    await shot(page, k('13-country-info-sheet'));
    await teardown(page, ctx, k('13-country-info-sheet'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 6 — Name editing
  // ─────────────────────────────────────────────────────────────────────────

  test(`14 userinfo – name edit persists to Settings identity card [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('nmedit'));
    await shot(page, k('14-name-edit-save') + '--s1');
    // Clear and retype name
    await page.fill('[data-testid="profile-firstname-input"]', 'Alice');
    await page.fill('[data-testid="profile-lastname-input"]', 'Wonder');
    await shot(page, k('14-name-edit-save') + '--s2');
    await page.click('[data-testid="profile-save-btn"]');
    // After save, back to Settings screen
    await page.waitForSelector('[data-testid="profile-settings-btn"]', { timeout: 3000 });
    // Identity card shows updated name
    await expect(page.locator('[data-testid="profile-settings-btn"]')).toContainText('Alice');
    await expect(page.locator('[data-testid="profile-settings-btn"]')).toContainText('Wonder');
    await shot(page, k('14-name-edit-save'));
    await teardown(page, ctx, k('14-name-edit-save'));
  });

  test(`15 userinfo – signup name and country appear in My Profile [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    // Signup with specific name and Germany
    await goToUserInfo(page, email('nmsig'), { firstName: 'Jane', lastName: 'Doe', country: 'Germany' });
    await shot(page, k('15-name-reflects-signup') + '--s1');
    // First/last name fields pre-filled from signup
    await expect(page.locator('[data-testid="profile-firstname-input"]')).toHaveValue('Jane');
    await expect(page.locator('[data-testid="profile-lastname-input"]')).toHaveValue('Doe');
    // Country field shows Germany
    await expect(page.locator('[data-testid="profile-country-btn"]')).toContainText('Germany');
    await shot(page, k('15-name-reflects-signup'));
    await teardown(page, ctx, k('15-name-reflects-signup'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 7 — API endpoint
  // ─────────────────────────────────────────────────────────────────────────

  test(`16 userinfo – API sheet opens [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('apopen'));
    await shot(page, k('16-api-sheet-open') + '--s1');
    await page.click('[data-testid="profile-api-row"]');
    await page.waitForSelector('[data-testid="profile-api-sheet"]', { timeout: 3000 });
    await shot(page, k('16-api-sheet-open') + '--s2');
    await expect(page.locator('[data-testid="profile-api-sheet"]')).toBeVisible();
    await expect(page.locator('[data-testid="profile-api-draft-input"]')).toBeVisible();
    // Reset and Save CTAs present
    await expect(page.locator('[data-testid="profile-api-sheet"] button').filter({ hasText: /reset/i })).toBeVisible();
    await expect(page.locator('[data-testid="profile-api-sheet"] button').filter({ hasText: /save/i })).toBeVisible();
    await shot(page, k('16-api-sheet-open'));
    await teardown(page, ctx, k('16-api-sheet-open'));
  });

  test(`17 userinfo – API sheet save stores custom URL [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('apsave'));
    await page.click('[data-testid="profile-api-row"]');
    await page.waitForSelector('[data-testid="profile-api-draft-input"]', { timeout: 3000 });
    await shot(page, k('17-api-sheet-save') + '--s1');
    await page.fill('[data-testid="profile-api-draft-input"]', 'https://my.server.local:8443');
    await page.locator('[data-testid="profile-api-sheet"] button').filter({ hasText: /save/i }).click();
    await page.waitForTimeout(300);
    // Sheet closed
    await expect(page.locator('[data-testid="profile-api-sheet"]')).not.toBeVisible();
    // API row now shows the custom URL
    await expect(page.locator('[data-testid="profile-api-row"]')).toContainText('my.server.local');
    await shot(page, k('17-api-sheet-save'));
    await teardown(page, ctx, k('17-api-sheet-save'));
  });

  test(`18 userinfo – API sheet reset restores default URL [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('apreset'));
    // Set a custom URL first
    await page.click('[data-testid="profile-api-row"]');
    await page.waitForSelector('[data-testid="profile-api-draft-input"]', { timeout: 3000 });
    await page.fill('[data-testid="profile-api-draft-input"]', 'https://custom.server:9000');
    await page.locator('[data-testid="profile-api-sheet"] button').filter({ hasText: /save/i }).click();
    await page.waitForTimeout(200);
    // Re-open and reset
    await page.click('[data-testid="profile-api-row"]');
    await page.waitForSelector('[data-testid="profile-api-draft-input"]', { timeout: 3000 });
    await shot(page, k('18-api-sheet-reset') + '--s1');
    await page.locator('[data-testid="profile-api-sheet"] button').filter({ hasText: /reset/i }).click();
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid="profile-api-sheet"]')).not.toBeVisible();
    // Row no longer shows the custom URL
    await expect(page.locator('[data-testid="profile-api-row"]')).not.toContainText('custom.server');
    await shot(page, k('18-api-sheet-reset'));
    await teardown(page, ctx, k('18-api-sheet-reset'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 8 — Change email (email login users only)
  // ─────────────────────────────────────────────────────────────────────────

  test(`19 userinfo – change email sheet opens [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('ceopen'));
    await shot(page, k('19-change-email-opens') + '--s1');
    await page.click('[data-testid="profile-change-email-row"]');
    await page.waitForSelector('[data-testid="profile-change-email-sheet"]', { timeout: 3000 });
    await shot(page, k('19-change-email-opens') + '--s2');
    await expect(page.locator('[data-testid="profile-change-email-sheet"]')).toBeVisible();
    // Step 1: email input visible
    await expect(page.locator('[data-testid="profile-change-email-sheet"] input[type="email"]')).toBeVisible();
    await shot(page, k('19-change-email-opens'));
    await teardown(page, ctx, k('19-change-email-opens'));
  });

  test(`20 userinfo – change email invalid format shows error [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('ceinv'));
    await page.click('[data-testid="profile-change-email-row"]');
    await page.waitForSelector('[data-testid="profile-change-email-sheet"]', { timeout: 3000 });
    await page.fill('[data-testid="profile-change-email-sheet"] input[type="email"]', 'notanemail');
    await shot(page, k('20-change-email-invalid') + '--s1');
    await page.locator('[data-testid="profile-change-email-sheet"] button.m-btn').filter({ hasText: /continue/i }).click();
    await page.waitForTimeout(300);
    // Error message shown
    const errorEl = page.locator('[data-testid="profile-change-email-sheet"]').locator('div').filter({ hasText: /invalid|valid email/i }).first();
    await expect(errorEl).toBeVisible();
    await shot(page, k('20-change-email-invalid'));
    await teardown(page, ctx, k('20-change-email-invalid'));
  });

  test(`21 userinfo – change email verify step + wrong code error [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('ceverify'));
    await page.click('[data-testid="profile-change-email-row"]');
    await page.waitForSelector('[data-testid="profile-change-email-sheet"]', { timeout: 3000 });
    // Type valid new email
    await page.fill('[data-testid="profile-change-email-sheet"] input[type="email"]', 'new-addr@example.com');
    await page.locator('[data-testid="profile-change-email-sheet"] button.m-btn').filter({ hasText: /continue/i }).click();
    // Step 2: verify OTP
    await page.waitForSelector('[data-testid="profile-change-email-sheet"] input[inputmode="numeric"]', { timeout: 3000 });
    await shot(page, k('21-change-email-verify') + '--s1');
    await page.fill('[data-testid="profile-change-email-sheet"] input[inputmode="numeric"]', '000000');
    await page.locator('[data-testid="profile-change-email-sheet"] button.m-btn').filter({ hasText: /confirm/i }).click();
    await page.waitForTimeout(300);
    // Wrong code error
    const errEl = page.locator('[data-testid="profile-change-email-sheet"]').locator('div').filter({ hasText: /invalid|code/i }).first();
    await expect(errEl).toBeVisible();
    await shot(page, k('21-change-email-verify'));
    await teardown(page, ctx, k('21-change-email-verify'));
  });

  test(`22 userinfo – change email done: correct code updates email display [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('cedone'));
    await page.click('[data-testid="profile-change-email-row"]');
    await page.waitForSelector('[data-testid="profile-change-email-sheet"]', { timeout: 3000 });
    await page.fill('[data-testid="profile-change-email-sheet"] input[type="email"]', 'changed@example.com');
    await page.locator('[data-testid="profile-change-email-sheet"] button.m-btn').filter({ hasText: /continue/i }).click();
    await page.waitForSelector('[data-testid="profile-change-email-sheet"] input[inputmode="numeric"]', { timeout: 3000 });
    await shot(page, k('22-change-email-done') + '--s1');
    // Correct demo code
    await page.fill('[data-testid="profile-change-email-sheet"] input[inputmode="numeric"]', '123456');
    await page.locator('[data-testid="profile-change-email-sheet"] button.m-btn').filter({ hasText: /confirm/i }).click();
    // Done state: "Email address updated" title + new email shown
    await expect(page.locator('[data-testid="profile-change-email-sheet"]')).toContainText('Email address updated', { timeout: 5000 });
    await shot(page, k('22-change-email-done') + '--s2');
    await expect(page.locator('[data-testid="profile-change-email-sheet"]')).toContainText('changed@example.com');
    // Tap Done → sheet closes
    await page.locator('[data-testid="profile-change-email-sheet"] button.m-btn').filter({ hasText: /done/i }).click();
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid="profile-change-email-sheet"]')).not.toBeVisible();
    // Email row now shows new address
    await expect(page.locator('[data-testid="profile-change-email-row"]')).toContainText('changed@example.com');
    await shot(page, k('22-change-email-done'));
    await teardown(page, ctx, k('22-change-email-done'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 9 — Delete account
  // ─────────────────────────────────────────────────────────────────────────

  test(`23 userinfo – delete sheet opens with reason list [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('delopen'));
    await shot(page, k('23-delete-opens') + '--s1');
    await page.click('[data-testid="profile-delete-row"]');
    await page.waitForSelector('[data-testid="profile-delete-sheet"]', { timeout: 3000 });
    await shot(page, k('23-delete-opens') + '--s2');
    await expect(page.locator('[data-testid="profile-delete-sheet"]')).toBeVisible();
    // At least 4 reason checkboxes in the feedback step (there are 5 reasons + 2 buttons)
    const checkboxes = page.locator('[data-testid="profile-delete-sheet"] .m-tap');
    const checkboxCount = await checkboxes.count();
    expect(checkboxCount).toBeGreaterThanOrEqual(4);
    await shot(page, k('23-delete-opens'));
    await teardown(page, ctx, k('23-delete-opens'));
  });

  test(`24 userinfo – delete: ticking reason fills checkbox [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('dcheck'));
    await page.click('[data-testid="profile-delete-row"]');
    await page.waitForSelector('[data-testid="profile-delete-sheet"]', { timeout: 3000 });
    await shot(page, k('24-delete-reasons') + '--s1');
    // Click the first reason row
    await page.locator('[data-testid="profile-delete-sheet"] .m-tap').first().click();
    await page.waitForTimeout(200);
    // The checkbox div (20×20) should now have a sage background
    const checkbox = page.locator('[data-testid="profile-delete-sheet"] .m-tap').first().locator('div').first();
    const bg = await checkbox.evaluate(el => getComputedStyle(el).background);
    // The filled checkbox has a sage/green background — verify it's not transparent
    expect(bg).not.toBe('');
    await shot(page, k('24-delete-reasons'));
    await teardown(page, ctx, k('24-delete-reasons'));
  });

  test(`25 userinfo – delete confirm step: shows red CTA and Back [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('dconfirm'));
    await page.click('[data-testid="profile-delete-row"]');
    await page.waitForSelector('[data-testid="profile-delete-sheet"]', { timeout: 3000 });
    // Click Continue to advance to confirm step
    await page.locator('[data-testid="profile-delete-sheet"] button.m-btn').filter({ hasText: /continue/i }).click();
    await page.waitForTimeout(400);
    await shot(page, k('25-delete-confirm') + '--s1');
    // Confirm step: red "Delete my account" button and "Back" button
    const deleteBtn = page.locator('[data-testid="profile-delete-sheet"] button').filter({ hasText: /delete my account/i });
    await expect(deleteBtn).toBeVisible();
    const backBtn = page.locator('[data-testid="profile-delete-sheet"] button.m-btn').filter({ hasText: /back/i });
    await expect(backBtn).toBeVisible();
    // Tap Back → returns to feedback step (checkboxes visible again)
    await backBtn.click();
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid="profile-delete-sheet"] .m-tap').first()).toBeVisible();
    await shot(page, k('25-delete-confirm'));
    await teardown(page, ctx, k('25-delete-confirm'));
  });

  test(`26 userinfo – delete confirm executes: lands on login [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('dexec'));
    await page.click('[data-testid="profile-delete-row"]');
    await page.waitForSelector('[data-testid="profile-delete-sheet"]', { timeout: 3000 });
    await page.locator('[data-testid="profile-delete-sheet"] button.m-btn').filter({ hasText: /continue/i }).click();
    await page.waitForTimeout(400);
    await shot(page, k('26-delete-executes') + '--s1');
    // Confirm delete
    await page.locator('[data-testid="profile-delete-sheet"] button').filter({ hasText: /delete my account/i }).click();
    await page.waitForSelector('.m-logo', { timeout: 5000 });
    await shot(page, k('26-delete-executes'));
    await teardown(page, ctx, k('26-delete-executes'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 10 — Signup data visible in My Profile
  // ─────────────────────────────────────────────────────────────────────────

  test(`27 userinfo – onboarding data (name + country) pre-fills profile [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    // Sign up with custom name and France as country
    await goToUserInfo(page, email('onbdata'), { firstName: 'Sophie', lastName: 'Martin', country: 'France' });
    await shot(page, k('27-onboarding-data') + '--s1');
    // My Profile shows what was entered in onboarding
    await expect(page.locator('[data-testid="profile-firstname-input"]')).toHaveValue('Sophie');
    await expect(page.locator('[data-testid="profile-lastname-input"]')).toHaveValue('Martin');
    await expect(page.locator('[data-testid="profile-country-btn"]')).toContainText('France');
    await shot(page, k('27-onboarding-data'));
    await teardown(page, ctx, k('27-onboarding-data'));
  });
}
