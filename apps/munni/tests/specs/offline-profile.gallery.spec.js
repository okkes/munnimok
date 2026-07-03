import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

// Create offline profile and navigate to Settings > My Profile (ScreenUserInfo offline view).
async function goToOfflineUserInfo(page, profileName = 'ProfileTestUser') {
  await page.click('[data-testid="login-offline-btn"]');
  await page.waitForSelector('[data-testid="offline-info-screen"]', { timeout: 3000 });
  await page.click('[data-testid="offline-info-cta"]');
  await page.waitForSelector('[data-testid="offline-create-screen"]', { timeout: 3000 });
  await page.fill('[data-testid="offline-create-name"]', profileName);
  await page.click('[data-testid="offline-create-cta"]');
  await page.waitForSelector('[data-testid="tab-home"]', { timeout: 5000 });
  await page.click('[data-testid="home-space-avatar"]');
  await page.waitForSelector('[data-testid="nav-drawer"]', { timeout: 3000 });
  await page.click('[data-testid="nav-drawer-settings"]');
  await page.waitForSelector('[data-testid="profile-settings-btn"]', { timeout: 3000 });
  await page.click('[data-testid="profile-settings-btn"]');
  await page.waitForSelector('[data-testid="offline-profile-key-section"]', { timeout: 5000 });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  // -------------------------------------------------------------------------
  // Group A — Offline profile view layout
  // -------------------------------------------------------------------------

  test(`71 offline-profile – username field visible, no country/api/account [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToOfflineUserInfo(page, 'LayoutUser');
    await shot(page, k('71-offline-profile-layout'));
    // Username field present
    await expect(page.locator('[data-testid="offline-profile-username"]')).toBeVisible();
    // No country picker
    await expect(page.locator('[data-testid="profile-country-btn"]')).not.toBeVisible();
    // No API section (server icon)
    const apiRow = page.locator('.m-card').filter({ hasText: /API endpoint|apiUrl/i });
    await expect(apiRow).not.toBeVisible();
    // Key section present
    await expect(page.locator('[data-testid="offline-profile-key-section"]')).toBeVisible();
    await teardown(page, ctx, k('71-offline-profile-layout'));
  });

  // -------------------------------------------------------------------------
  // Group B — Encryption key
  // -------------------------------------------------------------------------

  test(`72 offline-profile – key section visible and hidden by default [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToOfflineUserInfo(page, 'KeyUser');
    await shot(page, k('72-offline-key-section') + '--s1');
    const keySection = page.locator('[data-testid="offline-profile-key-section"]');
    await expect(keySection).toBeVisible();
    // Key is hidden by default — shows bullet characters
    const keyText = await keySection.textContent();
    expect(keyText).toContain('•');
    await shot(page, k('72-offline-key-section'));
    await teardown(page, ctx, k('72-offline-key-section'));
  });

  test(`73 offline-profile – eye toggle reveals and hides key [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToOfflineUserInfo(page, 'EyeUser');
    await shot(page, k('73-offline-key-toggle') + '--s1');
    // Click eye to reveal
    await page.click('[data-testid="offline-profile-key-toggle"]');
    await page.waitForTimeout(200);
    await shot(page, k('73-offline-key-toggle') + '--s2');
    // Key should now show actual hex content (no bullets)
    const keySection = page.locator('[data-testid="offline-profile-key-section"]');
    const revealed = await keySection.textContent();
    expect(revealed).not.toContain('•');
    // Click again to hide
    await page.click('[data-testid="offline-profile-key-toggle"]');
    await page.waitForTimeout(200);
    const rehidden = await keySection.textContent();
    expect(rehidden).toContain('•');
    await shot(page, k('73-offline-key-toggle'));
    await teardown(page, ctx, k('73-offline-key-toggle'));
  });

  test(`74 offline-profile – key info sheet opens [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToOfflineUserInfo(page, 'KeyInfoUser');
    await shot(page, k('74-offline-key-info') + '--s1');
    await page.click('[data-testid="offline-profile-key-info-btn"]');
    await page.waitForSelector('[data-testid="offline-profile-key-info-sheet"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="offline-profile-key-info-sheet"]')).toBeVisible();
    await shot(page, k('74-offline-key-info'));
    await teardown(page, ctx, k('74-offline-key-info'));
  });

  test(`75 offline-profile – regenerate key warning sheet opens [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToOfflineUserInfo(page, 'RegenUser');
    await shot(page, k('75-offline-key-regen-sheet') + '--s1');
    await page.click('[data-testid="offline-profile-key-regen"]');
    await page.waitForSelector('[data-testid="offline-profile-regen-sheet"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="offline-profile-regen-sheet"]')).toBeVisible();
    await expect(page.locator('[data-testid="offline-profile-regen-confirm"]')).toBeVisible();
    await shot(page, k('75-offline-key-regen-sheet'));
    await teardown(page, ctx, k('75-offline-key-regen-sheet'));
  });

  test(`76 offline-profile – confirm regen closes sheet [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToOfflineUserInfo(page, 'RegenConfirmUser');
    await page.click('[data-testid="offline-profile-key-regen"]');
    await page.waitForSelector('[data-testid="offline-profile-regen-confirm"]', { timeout: 3000 });
    await shot(page, k('76-offline-key-regen-confirm') + '--s1');
    await page.click('[data-testid="offline-profile-regen-confirm"]');
    await page.waitForTimeout(400);
    // Sheet should be dismissed
    await expect(page.locator('[data-testid="offline-profile-regen-sheet"]')).not.toBeVisible();
    // Key section still present
    await expect(page.locator('[data-testid="offline-profile-key-section"]')).toBeVisible();
    await shot(page, k('76-offline-key-regen-confirm'));
    await teardown(page, ctx, k('76-offline-key-regen-confirm'));
  });

  // -------------------------------------------------------------------------
  // Group C — Backup
  // -------------------------------------------------------------------------

  test(`77 offline-profile – backup sheet opens [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToOfflineUserInfo(page, 'BackupUser');
    await shot(page, k('77-offline-backup-sheet') + '--s1');
    await page.click('[data-testid="offline-profile-backup-btn"]');
    await page.waitForSelector('[data-testid="offline-profile-backup-sheet"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="offline-profile-backup-sheet"]')).toBeVisible();
    await expect(page.locator('[data-testid="offline-profile-backup-confirm"]')).toBeVisible();
    await shot(page, k('77-offline-backup-sheet'));
    await teardown(page, ctx, k('77-offline-backup-sheet'));
  });

  // -------------------------------------------------------------------------
  // Group D — Recover (from profile)
  // -------------------------------------------------------------------------

  test(`78 offline-profile – recover sheet opens [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToOfflineUserInfo(page, 'RecoverUser');
    await shot(page, k('78-offline-recover-sheet') + '--s1');
    await page.click('[data-testid="offline-profile-recover-btn"]');
    await page.waitForSelector('[data-testid="offline-profile-recover-sheet"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="offline-profile-recover-sheet"]')).toBeVisible();
    await expect(page.locator('[data-testid="offline-profile-recover-file-pick"]')).toBeVisible();
    await shot(page, k('78-offline-recover-sheet'));
    await teardown(page, ctx, k('78-offline-recover-sheet'));
  });

  test(`79 offline-profile – recover: file + key → success [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToOfflineUserInfo(page, 'RecoverFlowUser');
    await page.click('[data-testid="offline-profile-recover-btn"]');
    await page.waitForSelector('[data-testid="offline-profile-recover-file-pick"]', { timeout: 3000 });
    await shot(page, k('79-offline-recover-flow') + '--s1');
    // Upload a mock .mun file
    const fileInput = page.locator('[data-testid="offline-profile-recover-file-pick"] input[type="file"]');
    await fileInput.setInputFiles({ name: 'test.mun', mimeType: 'application/octet-stream', buffer: Buffer.from('{"app":"munni","version":1}') });
    await page.waitForTimeout(200);
    // Continue to key step
    await page.locator('[data-testid="offline-profile-recover-sheet"] .m-btn.sage').first().click();
    await page.waitForSelector('[data-testid="offline-profile-recover-key-input"]', { timeout: 3000 });
    await shot(page, k('79-offline-recover-flow') + '--s2');
    // Enter key
    await page.fill('[data-testid="offline-profile-recover-key-input"]', 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH');
    await page.click('[data-testid="offline-profile-recover-start"]');
    // Wait for loading + done (2.2s animation)
    await page.waitForSelector('[data-testid="offline-profile-recover-success"]', { timeout: 8000 });
    await expect(page.locator('[data-testid="offline-profile-recover-success"]')).toBeVisible();
    await shot(page, k('79-offline-recover-flow'));
    await teardown(page, ctx, k('79-offline-recover-flow'));
  });

  // -------------------------------------------------------------------------
  // Group E — Auto-backup
  // -------------------------------------------------------------------------

  test(`80 offline-profile – auto-backup sheet opens [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToOfflineUserInfo(page, 'AutoBackupUser');
    await shot(page, k('80-offline-auto-backup-sheet') + '--s1');
    await page.click('[data-testid="offline-profile-auto-backup-btn"]');
    await page.waitForSelector('[data-testid="offline-profile-auto-backup-sheet"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="offline-profile-auto-backup-sheet"]')).toBeVisible();
    await expect(page.locator('[data-testid="offline-profile-auto-backup-save"]')).toBeVisible();
    await shot(page, k('80-offline-auto-backup-sheet'));
    await teardown(page, ctx, k('80-offline-auto-backup-sheet'));
  });

  test(`81 offline-profile – auto-backup save closes sheet [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToOfflineUserInfo(page, 'AutoBackupSaveUser');
    await page.click('[data-testid="offline-profile-auto-backup-btn"]');
    await page.waitForSelector('[data-testid="offline-profile-auto-backup-sheet"]', { timeout: 3000 });
    await shot(page, k('81-offline-auto-backup-save') + '--s1');
    // Select weekly frequency by clicking the row containing "Weekly"
    await page.locator('[data-testid="offline-profile-auto-backup-sheet"] .m-tap').filter({ hasText: 'Weekly' }).first().click();
    // Select Google Drive
    await page.locator('[data-testid="offline-profile-auto-backup-sheet"] .m-tap').filter({ hasText: 'Google Drive' }).first().click();
    await shot(page, k('81-offline-auto-backup-save') + '--s2');
    await page.click('[data-testid="offline-profile-auto-backup-save"]');
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid="offline-profile-auto-backup-sheet"]')).not.toBeVisible();
    await shot(page, k('81-offline-auto-backup-save'));
    await teardown(page, ctx, k('81-offline-auto-backup-save'));
  });

  // -------------------------------------------------------------------------
  // Group F — Recover from offline creator (App.jsx)
  // -------------------------------------------------------------------------

  test(`82 offline-create – recover btn visible [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.click('[data-testid="login-offline-btn"]');
    await page.waitForSelector('[data-testid="offline-info-screen"]', { timeout: 3000 });
    await page.click('[data-testid="offline-info-cta"]');
    await page.waitForSelector('[data-testid="offline-create-screen"]', { timeout: 3000 });
    await shot(page, k('82-offline-create-recover-btn'));
    await expect(page.locator('[data-testid="offline-create-recover-btn"]')).toBeVisible();
    await teardown(page, ctx, k('82-offline-create-recover-btn'));
  });

  test(`83 offline-recover – screen opens from creator [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.click('[data-testid="login-offline-btn"]');
    await page.waitForSelector('[data-testid="offline-info-screen"]', { timeout: 3000 });
    await page.click('[data-testid="offline-info-cta"]');
    await page.waitForSelector('[data-testid="offline-create-screen"]', { timeout: 3000 });
    await page.click('[data-testid="offline-create-recover-btn"]');
    await page.waitForSelector('[data-testid="offline-recover-screen"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="offline-recover-screen"]')).toBeVisible();
    await expect(page.locator('[data-testid="offline-recover-file-pick"]')).toBeVisible();
    await shot(page, k('83-offline-recover-screen'));
    await teardown(page, ctx, k('83-offline-recover-screen'));
  });

  test(`84 offline-recover – browser back returns to offline-create [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.click('[data-testid="login-offline-btn"]');
    await page.waitForSelector('[data-testid="offline-info-screen"]', { timeout: 3000 });
    await page.click('[data-testid="offline-info-cta"]');
    await page.waitForSelector('[data-testid="offline-create-screen"]', { timeout: 3000 });
    await page.click('[data-testid="offline-create-recover-btn"]');
    await page.waitForSelector('[data-testid="offline-recover-screen"]', { timeout: 3000 });
    await shot(page, k('84-offline-recover-back') + '--s1');
    await page.goBack();
    await page.waitForSelector('[data-testid="offline-create-screen"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="offline-create-screen"]')).toBeVisible();
    await shot(page, k('84-offline-recover-back'));
    await teardown(page, ctx, k('84-offline-recover-back'));
  });

  test(`85 offline-recover – key step + complete → lands on home [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.click('[data-testid="login-offline-btn"]');
    await page.waitForSelector('[data-testid="offline-info-screen"]', { timeout: 3000 });
    await page.click('[data-testid="offline-info-cta"]');
    await page.waitForSelector('[data-testid="offline-create-screen"]', { timeout: 3000 });
    await page.click('[data-testid="offline-create-recover-btn"]');
    await page.waitForSelector('[data-testid="offline-recover-screen"]', { timeout: 3000 });
    // Upload mock .mun file
    const fileInput = page.locator('[data-testid="offline-recover-file-pick"] input[type="file"]');
    await fileInput.setInputFiles({ name: 'backup.mun', mimeType: 'application/octet-stream', buffer: Buffer.from('{"app":"munni","version":1}') });
    await page.waitForTimeout(200);
    // Continue to key step
    await page.locator('[data-testid="offline-recover-screen"] .m-btn.sage').first().click();
    await page.waitForSelector('[data-testid="offline-recover-key-input"]', { timeout: 3000 });
    await shot(page, k('85-offline-recover-complete') + '--s1');
    await page.fill('[data-testid="offline-recover-key-input"]', 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH');
    await page.click('[data-testid="offline-recover-start"]');
    // Wait for animation + done state
    await page.waitForSelector('[data-testid="offline-recover-success"]', { timeout: 8000 });
    await shot(page, k('85-offline-recover-complete') + '--s2');
    // Click "Go to munni" → lands on home
    await page.locator('[data-testid="offline-recover-screen"] .m-btn.sage').first().click();
    await page.waitForSelector('[data-testid="tab-home"]', { timeout: 5000 });
    await expect(page.locator('[data-testid="tab-home"]')).toBeVisible();
    await shot(page, k('85-offline-recover-complete'));
    await teardown(page, ctx, k('85-offline-recover-complete'));
  });
}
