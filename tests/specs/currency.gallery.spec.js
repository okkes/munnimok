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
  await page.fill('[data-testid="onboard-country-search"]', countryName.slice(0, 4));
  await page.waitForTimeout(300);
  await page.locator('[data-testid="country-row"]').filter({ hasText: countryName }).first().click();
}

// ─── Currency tests ──────────────────────────────────────────────────────────

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;
  const email = (suffix) => `cur-${suffix}-${V.id.replace(/-/g, '')}@example.com`;

  // (a) Selecting country during onboarding shows currency hint and auto-sets currency

  test(`currency-a1 onboard NL → EUR hint shown [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep1(page, email('a1'));
    await page.fill('[data-testid="onboard-firstname"]', 'Jan');
    await page.fill('[data-testid="onboard-lastname"]', 'Bakker');
    await selectCountry(page, 'Netherlands');
    await expect(page.locator('[data-testid="onboard-currency-hint"]')).toBeVisible();
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
    await expect(page.locator('[data-testid="onboard-currency-hint"]')).toBeVisible();
    const hintText = await page.locator('[data-testid="onboard-currency-hint"]').textContent();
    expect(hintText).toContain('TRY');
    await shot(page, k('currency-a2-tr-try-hint'));
    await teardown(page, ctx, k('currency-a2-tr-try-hint'));
  });

  test(`currency-a3 onboard US → USD hint shown [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToStep1(page, email('a3'));
    await page.fill('[data-testid="onboard-firstname"]', 'John');
    await page.fill('[data-testid="onboard-lastname"]', 'Smith');
    await selectCountry(page, 'United States');
    await expect(page.locator('[data-testid="onboard-currency-hint"]')).toBeVisible();
    const hintText = await page.locator('[data-testid="onboard-currency-hint"]').textContent();
    expect(hintText).toContain('USD');
    await shot(page, k('currency-a3-us-usd-hint'));
    await teardown(page, ctx, k('currency-a3-us-usd-hint'));
  });

  // (b) After signup with NL, home screen shows EUR symbol

  test(`currency-b1 home balance shows EUR after NL signup [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    // Pre-set currency to EUR (simulating completed NL onboarding)
    await base(page, V, () => {
      localStorage.setItem('munni_display_currency', JSON.stringify('EUR'));
    });
    await page.click('[data-testid="login-demo"]');
    await page.waitForSelector('[data-testid="home-balance-amount"]', { timeout: 5000 });
    const balanceText = await page.locator('[data-testid="home-balance-amount"]').textContent();
    expect(balanceText).toMatch(/€/);
    await shot(page, k('currency-b1-home-eur'));
    await teardown(page, ctx, k('currency-b1-home-eur'));
  });

  test(`currency-b2 home balance shows $ when USD currency set [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, () => {
      localStorage.setItem('munni_display_currency', JSON.stringify('USD'));
    });
    await page.click('[data-testid="login-demo"]');
    await page.waitForSelector('[data-testid="home-balance-amount"]', { timeout: 5000 });
    const balanceText = await page.locator('[data-testid="home-balance-amount"]').textContent();
    expect(balanceText).toMatch(/\$/);
    await shot(page, k('currency-b2-home-usd'));
    await teardown(page, ctx, k('currency-b2-home-usd'));
  });

  // Helper: navigate to the Settings (appearance) screen via nav drawer → profile → settings push
  async function goToSettingsScreen(page) {
    await page.waitForSelector('[data-testid="nav-drawer"]', { timeout: 5000 });
    await page.click('[data-testid="nav-drawer"]');
    await page.waitForSelector('[data-testid="nav-drawer-settings"]', { timeout: 2000 });
    await page.click('[data-testid="nav-drawer-settings"]');
    // Now on Profile screen — click the Appearance row which pushes 'settings' route
    await page.waitForSelector('[data-testid="profile-link-appearance"]', { timeout: 3000 });
    await page.click('[data-testid="profile-link-appearance"]');
    await page.waitForSelector('[data-testid="settings-currency-row"]', { timeout: 3000 });
  }

  // (c) Settings > Appearance: currency and language rows work

  test(`currency-c1 settings currency row visible and opens picker [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, () => {
      localStorage.setItem('munni_display_currency', JSON.stringify('EUR'));
    });
    await page.click('[data-testid="login-demo"]');
    await goToSettingsScreen(page);
    await shot(page, k('currency-c1-settings-currency-row'));
    await page.click('[data-testid="settings-currency-row"]');
    await page.waitForSelector('[data-testid="sheet-overlay"]', { timeout: 2000 });
    await shot(page, k('currency-c1-currency-picker-open'));
    await teardown(page, ctx, k('currency-c1-currency-picker-open'));
  });

  test(`currency-c2 settings language row navigates to language picker [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.click('[data-testid="login-demo"]');
    await goToSettingsScreen(page);
    await shot(page, k('currency-c2-settings-language-row'));
    await page.click('[data-testid="settings-language-row"]');
    await page.waitForSelector('[data-testid="language-picker-screen"]', { timeout: 2000 });
    await shot(page, k('currency-c2-language-picker'));
    await teardown(page, ctx, k('currency-c2-language-picker'));
  });

  test(`currency-c3 settings search bar visible [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.click('[data-testid="login-demo"]');
    await goToSettingsScreen(page);
    await expect(page.locator('[data-testid="settings-search"]')).toBeVisible();
    await shot(page, k('currency-c3-settings-search'));
    await teardown(page, ctx, k('currency-c3-settings-search'));
  });
}
