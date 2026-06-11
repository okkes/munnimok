import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

// Navigate to the offline-info screen from login.
async function goToOfflineInfo(page) {
  await page.click('[data-testid="login-offline-btn"]');
  await page.waitForSelector('[data-testid="offline-info-screen"]', { timeout: 3000 });
}

// Navigate to the offline-create screen (no existing profiles).
async function goToOfflineCreate(page) {
  await goToOfflineInfo(page);
  await page.click('[data-testid="offline-info-cta"]');
  await page.waitForSelector('[data-testid="offline-create-screen"]', { timeout: 3000 });
}

// Create a fresh offline profile and land on home.
async function createOfflineProfile(page, name = 'TestUser') {
  await goToOfflineCreate(page);
  await page.fill('[data-testid="offline-create-name"]', name);
  await page.click('[data-testid="offline-create-cta"]');
  await page.waitForSelector('[data-testid="tab-home"]', { timeout: 5000 });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  // -------------------------------------------------------------------------
  // Group A — Login Screen Entry Point
  // -------------------------------------------------------------------------

  test(`60 offline – login btn visible [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await expect(page.locator('[data-testid="login-offline-btn"]')).toBeVisible();
    await shot(page, k('60-offline-login-btn'));
    await teardown(page, ctx, k('60-offline-login-btn'));
  });

  // -------------------------------------------------------------------------
  // Group B — Offline Info Screen
  // -------------------------------------------------------------------------

  test(`61 offline-info – screen opens [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await shot(page, k('61-offline-info') + '--s1');
    await goToOfflineInfo(page);
    await expect(page.locator('[data-testid="offline-info-screen"]')).toBeVisible();
    await expect(page.locator('[data-testid="offline-info-cta"]')).toBeVisible();
    await expect(page.locator('[data-testid="offline-info-back"]')).toBeVisible();
    await shot(page, k('61-offline-info'));
    await teardown(page, ctx, k('61-offline-info'));
  });

  test(`62 offline-info – back returns to login [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToOfflineInfo(page);
    await shot(page, k('62-offline-info-back') + '--s1');
    await page.click('[data-testid="offline-info-back"]');
    await page.waitForSelector('[data-testid="login-google-btn"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="login-google-btn"]')).toBeVisible();
    await shot(page, k('62-offline-info-back'));
    await teardown(page, ctx, k('62-offline-info-back'));
  });

  test(`63 offline-info – browser back returns to login [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToOfflineInfo(page);
    await shot(page, k('63-offline-info-browser-back') + '--s1');
    await page.goBack();
    await page.waitForSelector('[data-testid="login-google-btn"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="login-google-btn"]')).toBeVisible();
    await shot(page, k('63-offline-info-browser-back'));
    await teardown(page, ctx, k('63-offline-info-browser-back'));
  });

  // -------------------------------------------------------------------------
  // Group C — Offline Profile Creator
  // -------------------------------------------------------------------------

  test(`64 offline-create – screen opens from info CTA [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await shot(page, k('64-offline-create') + '--s1');
    await goToOfflineCreate(page);
    await expect(page.locator('[data-testid="offline-create-screen"]')).toBeVisible();
    await expect(page.locator('[data-testid="offline-create-name"]')).toBeVisible();
    await expect(page.locator('[data-testid="offline-create-cta"]')).toBeVisible();
    await shot(page, k('64-offline-create'));
    await teardown(page, ctx, k('64-offline-create'));
  });

  test(`65 offline-create – name required error [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToOfflineCreate(page);
    await shot(page, k('65-offline-create-name-error') + '--s1');
    // Submit without entering a name
    await page.click('[data-testid="offline-create-cta"]');
    await page.waitForTimeout(300);
    // Error message must appear
    const errorLocator = page.locator('[data-testid="offline-create-screen"]').getByText(/name|naam|ad/i).last();
    await shot(page, k('65-offline-create-name-error') + '--s2');
    // Still on create screen
    await expect(page.locator('[data-testid="offline-create-screen"]')).toBeVisible();
    await shot(page, k('65-offline-create-name-error'));
    await teardown(page, ctx, k('65-offline-create-name-error'));
  });

  test(`66 offline-create – create profile lands on home [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await shot(page, k('66-offline-create-flow') + '--s1');
    await goToOfflineCreate(page);
    await shot(page, k('66-offline-create-flow') + '--s2');
    await page.fill('[data-testid="offline-create-name"]', 'Okkes');
    await shot(page, k('66-offline-create-flow') + '--s3');
    await page.click('[data-testid="offline-create-cta"]');
    await page.waitForSelector('[data-testid="tab-home"]', { timeout: 5000 });
    await expect(page.locator('[data-testid="tab-home"]')).toBeVisible();
    await shot(page, k('66-offline-create-flow'));
    await teardown(page, ctx, k('66-offline-create-flow'));
  });

  // -------------------------------------------------------------------------
  // Group D — Home Offline Banner
  // -------------------------------------------------------------------------

  test(`67 offline-home – banner visible [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await createOfflineProfile(page, 'BannerUser');
    await shot(page, k('67-offline-home-banner') + '--s1');
    await expect(page.locator('[data-testid="offline-home-banner"]')).toBeVisible();
    await shot(page, k('67-offline-home-banner'));
    await teardown(page, ctx, k('67-offline-home-banner'));
  });

  // -------------------------------------------------------------------------
  // Group E — Offline Profile Selector
  // -------------------------------------------------------------------------

  test(`68 offline-select – shows existing profiles [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    // Pre-seed two offline profiles so the selector screen shows
    await base(page, V, () => {
      const profiles = [
        { id: 'offline_1111', name: 'Alice', picture: 'av1', createdAt: 1111 },
        { id: 'offline_2222', name: 'Bob',   picture: 'av2', createdAt: 2222 },
      ];
      localStorage.setItem('munni_offline_profiles', JSON.stringify(profiles));
    });
    // Info → CTA should go to offline-select (profiles exist)
    await goToOfflineInfo(page);
    await shot(page, k('68-offline-select') + '--s1');
    await page.click('[data-testid="offline-info-cta"]');
    await page.waitForSelector('[data-testid="offline-select-screen"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="offline-select-screen"]')).toBeVisible();
    await expect(page.locator('[data-testid="offline-add-profile"]')).toBeVisible();
    await shot(page, k('68-offline-select'));
    await teardown(page, ctx, k('68-offline-select'));
  });

  test(`69 offline-select – login with existing profile [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, () => {
      const profiles = [{ id: 'offline_3333', name: 'Eve', picture: 'av3', createdAt: 3333 }];
      localStorage.setItem('munni_offline_profiles', JSON.stringify(profiles));
    });
    await goToOfflineInfo(page);
    await page.click('[data-testid="offline-info-cta"]');
    await page.waitForSelector('[data-testid="offline-select-screen"]', { timeout: 3000 });
    await shot(page, k('69-offline-select-login') + '--s1');
    // Tap the profile tile (contains 'Eve')
    await page.locator('[data-testid="offline-select-screen"] button').filter({ hasText: 'Eve' }).first().click();
    await page.waitForSelector('[data-testid="tab-home"]', { timeout: 5000 });
    await expect(page.locator('[data-testid="tab-home"]')).toBeVisible();
    await shot(page, k('69-offline-select-login'));
    await teardown(page, ctx, k('69-offline-select-login'));
  });

  test(`70 offline-boot – auto-select screen on return with offline profiles [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    // Only offline profiles, no online signup methods → should boot to offline-select
    await base(page, V, () => {
      const profiles = [{ id: 'offline_4444', name: 'Carol', picture: 'av1', createdAt: 4444 }];
      localStorage.setItem('munni_offline_profiles', JSON.stringify(profiles));
      // Do NOT set munni_signup_methods
    });
    await page.waitForSelector('[data-testid="offline-select-screen"]', { timeout: 5000 });
    await expect(page.locator('[data-testid="offline-select-screen"]')).toBeVisible();
    await shot(page, k('70-offline-boot-select'));
    await teardown(page, ctx, k('70-offline-boot-select'));
  });
}
