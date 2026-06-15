import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function goToStep1(page, email) {
  await page.click('[data-testid="login-create-account"]');
  await page.waitForSelector('[data-testid="signup-pick-email"]');
  await page.click('[data-testid="signup-pick-email"]');
  await page.fill('input[type="email"]', email);
  await page.click('[data-testid="signup-send-code"]');
  await page.waitForSelector('[data-testid="onboard-firstname"]', { timeout: 5000 });
}

async function selectCountry(page, countryName) {
  await page.click('[data-testid="onboard-country-btn"]');
  await page.waitForSelector('[data-testid="onboard-country-sheet"]', { timeout: 3000 });
  // onboard-country-sheet is the search input inside the sheet
  await page.fill('[data-testid="onboard-country-sheet"]', countryName.slice(0, 4));
  await page.waitForTimeout(300);
  // Scope to sheet-close backdrop so we don't match the trigger button
  await page.locator('[data-testid="sheet-close"] button').filter({ hasText: countryName }).first().click();
  await page.waitForTimeout(200);
}

// Navigate to settings screen via nav drawer → Profile → Appearance link
async function goToSettingsScreen(page) {
  await page.waitForSelector('[data-testid="home-space-avatar"]', { timeout: 5000 });
  await page.click('[data-testid="home-space-avatar"]');
  await page.waitForSelector('[data-testid="nav-drawer-settings"]', { timeout: 2000 });
  await page.click('[data-testid="nav-drawer-settings"]');
  await page.waitForSelector('[data-testid="profile-link-appearance"]', { timeout: 3000 });
  await page.click('[data-testid="profile-link-appearance"]');
  await page.waitForSelector('[data-testid="settings-currency-row"]', { timeout: 3000 });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;
  const email = (suffix) => `cur-${suffix}-${V.id.replace(/-/g, '')}@example.com`;

  // (a) Selecting country during onboarding shows currency hint

  test(`currency-a1 onboard NL → EUR hint shown [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep1(page, email('a1'));
    await page.fill('[data-testid="onboard-firstname"]', 'Jan');
    await page.fill('[data-testid="onboard-lastname"]', 'Bakker');
    await selectCountry(page, 'Netherlands');
    await expect(page.locator('[data-testid="onboard-currency-hint"]')).toBeVisible({ timeout: 2000 });
    const hintText = await page.locator('[data-testid="onboard-currency-hint"]').textContent();
    expect(hintText).toContain('EUR');
    await shot(page, k('currency-a1-nl-eur-hint'));
    await teardown(page, ctx, k('currency-a1-nl-eur-hint'));
  });

  test(`currency-a2 onboard TR → TRY hint shown [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep1(page, email('a2'));
    await page.fill('[data-testid="onboard-firstname"]', 'Mehmet');
    await page.fill('[data-testid="onboard-lastname"]', 'Yilmaz');
    await selectCountry(page, 'Turkey');
    await expect(page.locator('[data-testid="onboard-currency-hint"]')).toBeVisible({ timeout: 2000 });
    const hintText = await page.locator('[data-testid="onboard-currency-hint"]').textContent();
    expect(hintText).toContain('TRY');
    await shot(page, k('currency-a2-tr-try-hint'));
    await teardown(page, ctx, k('currency-a2-tr-try-hint'));
  });

  test(`currency-a3 onboard GB → GBP hint shown [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep1(page, email('a3'));
    await page.fill('[data-testid="onboard-firstname"]', 'Alice');
    await page.fill('[data-testid="onboard-lastname"]', 'Smith');
    await selectCountry(page, 'United Kingdom');
    await expect(page.locator('[data-testid="onboard-currency-hint"]')).toBeVisible({ timeout: 2000 });
    const hintText = await page.locator('[data-testid="onboard-currency-hint"]').textContent();
    expect(hintText).toContain('GBP');
    await shot(page, k('currency-a3-gb-gbp-hint'));
    await teardown(page, ctx, k('currency-a3-gb-gbp-hint'));
  });

  // (b) Home screen shows correct currency symbol

  test(`currency-b1 home balance shows EUR [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, () => {
      localStorage.setItem('munni_display_currency', JSON.stringify('EUR'));
    });
    await page.click('[data-testid="login-demo-btn"]');
    await page.waitForSelector('[data-testid="home-balance-amount"]', { timeout: 5000 });
    const balanceText = await page.locator('[data-testid="home-balance-amount"]').textContent();
    expect(balanceText).toMatch(/€/);
    await shot(page, k('currency-b1-home-eur'));
    await teardown(page, ctx, k('currency-b1-home-eur'));
  });

  test(`currency-b2 home balance shows £ when GBP set [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, () => {
      localStorage.setItem('munni_display_currency', JSON.stringify('GBP'));
    });
    await page.click('[data-testid="login-demo-btn"]');
    await page.waitForSelector('[data-testid="home-balance-amount"]', { timeout: 5000 });
    const balanceText = await page.locator('[data-testid="home-balance-amount"]').textContent();
    expect(balanceText).toMatch(/£/);
    await shot(page, k('currency-b2-home-gbp'));
    await teardown(page, ctx, k('currency-b2-home-gbp'));
  });

  // (c) Settings screen: currency and language rows work

  test(`currency-c1 settings currency row opens picker sheet [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, () => {
      localStorage.setItem('munni_display_currency', JSON.stringify('EUR'));
    });
    await page.click('[data-testid="login-demo-btn"]');
    await goToSettingsScreen(page);
    await expect(page.locator('[data-testid="settings-currency-row"]')).toBeVisible();
    await shot(page, k('currency-c1-settings-currency-row'));
    await page.click('[data-testid="settings-currency-row"]');
    await page.waitForSelector('[data-testid="sheet-close"]', { timeout: 2000 });
    await shot(page, k('currency-c1-currency-picker-open'));
    await teardown(page, ctx, k('currency-c1-currency-picker-open'));
  });

  test(`currency-c2 settings language row navigates to language picker [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.click('[data-testid="login-demo-btn"]');
    await goToSettingsScreen(page);
    await expect(page.locator('[data-testid="settings-language-row"]')).toBeVisible();
    await shot(page, k('currency-c2-settings-language-row'));
    await page.click('[data-testid="settings-language-row"]');
    // Language picker screen has lang-option-en/nl/tr rows
    await page.waitForSelector('[data-testid="lang-option-en"]', { timeout: 2000 });
    await shot(page, k('currency-c2-language-picker'));
    await teardown(page, ctx, k('currency-c2-language-picker'));
  });

  test(`currency-c3 settings floating search bar visible [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.click('[data-testid="login-demo-btn"]');
    await goToSettingsScreen(page);
    await expect(page.locator('[data-testid="settings-search"]')).toBeVisible();
    await shot(page, k('currency-c3-settings-search'));
    await teardown(page, ctx, k('currency-c3-settings-search'));
  });
}
