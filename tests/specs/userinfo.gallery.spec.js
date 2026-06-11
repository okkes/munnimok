import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// Register a unique email, complete onboarding (skip banks), land on Settings > My Profile.
async function goToUserInfo(page, emailStr) {
  // Signup flow
  await page.click('[data-testid="login-create-account"]');
  await page.waitForSelector('[data-testid="signup-pick-email"]');
  await page.click('[data-testid="signup-pick-email"]');
  await page.waitForSelector('[data-testid="signup-send-code"]');
  await page.fill('input[type="email"]', emailStr);
  await page.click('[data-testid="signup-send-code"]');
  // Wait for step 1 — OTP auto-fills
  await page.waitForSelector('[data-testid="onboard-firstname"]', { timeout: 5000 });
  await page.fill('[data-testid="onboard-firstname"]', 'Test');
  await page.fill('[data-testid="onboard-lastname"]', 'User');
  // Country is required — select Netherlands
  await page.click('[data-testid="onboard-country-btn"]');
  await page.waitForSelector('[data-testid="onboard-country-sheet"]', { timeout: 3000 });
  await page.locator('[data-testid="sheet-close"] button').filter({ hasText: 'Netherlands' }).first().click();
  await page.click('[data-testid="onboard-continue"]');
  // Step 2 — skip bank
  await page.waitForSelector('[data-testid="onboard-step2"]', { timeout: 3000 });
  await page.click('[data-testid="onboard-bank-skip"]');
  // Now in the main app — go to Settings (tab id = 'profile')
  await page.waitForSelector('[data-testid="tab-profile"]', { timeout: 8000 });
  await page.click('[data-testid="tab-profile"]');
  await page.waitForSelector('[data-testid="profile-settings-btn"]', { timeout: 3000 });
  await page.click('[data-testid="profile-settings-btn"]');
  await page.waitForSelector('[data-testid="profile-country-btn"]', { timeout: 3000 });
}

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;
  const email = (suffix) => `ui-${suffix}-${V.id.replace(/-/g, '')}@example.com`;

  test(`01 userinfo-country-picker – open and select [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('pick'));
    await expect(page.locator('[data-testid="profile-country-btn"]')).toBeVisible();
    await shot(page, k('01-userinfo-country-picker') + '--s1');
    // Open picker
    await page.click('[data-testid="profile-country-btn"]');
    await page.waitForSelector('[data-testid="profile-country-sheet"]', { timeout: 3000 });
    await shot(page, k('01-userinfo-country-picker') + '--s2');
    // Select Germany
    const deRow = page.locator('[data-testid="sheet-close"] div.m-tap').filter({ hasText: 'Germany' }).first();
    await expect(deRow).toBeVisible();
    await deRow.click();
    await expect(page.locator('[data-testid="profile-country-btn"]')).toContainText('Germany');
    await shot(page, k('01-userinfo-country-picker'));
    await teardown(page, ctx, k('01-userinfo-country-picker'));
  });

  test(`02 userinfo-country-search – search and retain [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToUserInfo(page, email('search'));
    await page.click('[data-testid="profile-country-btn"]');
    await page.waitForSelector('[data-testid="profile-country-sheet"]', { timeout: 3000 });
    await shot(page, k('02-userinfo-country-search') + '--s1');
    // Type to filter — highlight appears
    await page.fill('[data-testid="profile-country-search"]', 'Ger');
    await page.waitForTimeout(200);
    await shot(page, k('02-userinfo-country-search') + '--s2');
    // Germany should be visible in the filtered list
    const deRow = page.locator('[data-testid="sheet-close"] div.m-tap').filter({ hasText: 'Germany' }).first();
    await expect(deRow).toBeVisible();
    await deRow.click();
    await expect(page.locator('[data-testid="profile-country-btn"]')).toContainText('Germany');
    // Save
    await page.locator('button').filter({ hasText: 'Save' }).first().click();
    await page.waitForTimeout(300);
    // Re-open My Profile to verify retention
    await page.click('[data-testid="profile-settings-btn"]');
    await page.waitForSelector('[data-testid="profile-country-btn"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="profile-country-btn"]')).toContainText('Germany');
    await shot(page, k('02-userinfo-country-search'));
    await teardown(page, ctx, k('02-userinfo-country-search'));
  });
}
