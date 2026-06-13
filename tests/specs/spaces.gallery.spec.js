import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TWO_PROFILES = [
  { id: 'p_personal', name: 'Personal', icon: 'user', active: false, accountIds: [], picture: 'av1', isDemo: false, creatorId: 'dmo-0001' },
  { id: 'p_biz',      name: 'Business', icon: 'user', active: true,  accountIds: [], picture: 'av3', isDemo: false, creatorId: 'dmo-0001' },
];

const SHARED_SPACE_PROFILES = [
  { id: 'p_shared', name: 'Family', icon: 'users', active: true, accountIds: [], picture: 'av4', isDemo: false, creatorId: 'dmo-0001',
    members: [{ userId: 'usr-other', displayName: 'Alice', permission: 'contributor', accountIds: [] }] },
];

const SHARED_MEMBER_PROFILES = [
  { id: 'p_mine',       name: 'Personal',   icon: 'user',  active: true,  accountIds: [], picture: 'av1', isDemo: false, creatorId: 'dmo-0001' },
  { id: 'p_shared_ext', name: 'Family',     icon: 'users', active: false, accountIds: [], picture: 'av4',
    isDemo: false, isShared: true, creatorId: 'usr-owner', ownerId: 'usr-owner', ownerDisplay: 'Alice',
    members: [{ userId: 'usr-owner', displayName: 'Alice', permission: 'owner', accountIds: [] }] },
];

// Set profiles in localStorage after demo login (doLogin overwrites munni_profiles_bank via activateDemo=true)
async function setProfiles(page, profiles) {
  await page.evaluate((ps) => {
    localStorage.setItem('munni_profiles_bank', JSON.stringify(ps));
    window.dispatchEvent(new CustomEvent('munni-ls', { detail: { key: 'munni_profiles_bank' } }));
  }, profiles);
}

// Pending invite setup — set in extraSetup (before page load); doLogin does not touch invitations
function pendingInviteSetup() {
  localStorage.setItem('munni_global_invitations', JSON.stringify([
    { id: 'inv_1', type: 'profile', toId: 'dmo-0001', fromId: 'usr-sender', fromDisplay: 'Bob',
      profileId: 'p_ext', profileName: "Bob's Space", profileIcon: 'users', status: 'pending' },
  ]));
  localStorage.setItem('munni_global_users', JSON.stringify({
    'usr-sender': { displayName: 'Bob', updatedAt: Date.now() },
  }));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Demo login → optionally override profiles → navigate to spaces screen
async function goToSpaces(page, profilesOverride = null) {
  await page.click('[data-testid="login-demo-btn"]');
  await page.waitForSelector('[data-testid="tab-home"]', { timeout: 5000 });
  if (profilesOverride) await setProfiles(page, profilesOverride);
  await page.click('[data-testid="tab-profile"]');
  await page.waitForSelector('[data-testid="spaces-nav-link"]', { timeout: 3000 });
  await page.click('[data-testid="spaces-nav-link"]');
  await page.waitForSelector('[data-testid="spaces-screen"]', { timeout: 3000 });
}

// Demo login → override profiles → navigate to space detail at given row index
async function goToSpaceDetail(page, profilesOverride = null, idx = 0) {
  await goToSpaces(page, profilesOverride);
  const btns = page.locator('[data-testid="space-row-detail-btn"]');
  await btns.nth(idx).click();
  await page.waitForSelector('[data-testid="space-detail-screen"]', { timeout: 3000 });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  // -------------------------------------------------------------------------
  // Group A — Spaces list
  // -------------------------------------------------------------------------

  test(`01 spaces-list – single demo space [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSpaces(page);
    await expect(page.locator('[data-testid="space-row"]').first()).toBeVisible();
    // Default bank profile is isDemo:true → Demo badge visible
    await expect(page.locator('[data-testid="space-row"]').first()).toContainText('Demo');
    await shot(page, k('01-spaces-list-single'));
    await teardown(page, ctx, k('01-spaces-list-single'));
  });

  test(`02 spaces-list – multiple spaces with active indicator [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSpaces(page, TWO_PROFILES);
    const rows = page.locator('[data-testid="space-row"]');
    await expect(rows).toHaveCount(2);
    await shot(page, k('02-spaces-list-multiple'));
    await teardown(page, ctx, k('02-spaces-list-multiple'));
  });

  test(`03 spaces-list – shared badge on space with members [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSpaces(page, SHARED_SPACE_PROFILES);
    await expect(page.locator('[data-testid="space-row"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="space-row"]').first()).toContainText('Shared');
    await shot(page, k('03-spaces-list-shared-badge'));
    await teardown(page, ctx, k('03-spaces-list-shared-badge'));
  });

  test(`04 spaces-list – pending invite section [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, pendingInviteSetup);
    await goToSpaces(page);
    await expect(page.locator('[data-testid="space-invite-section"]')).toBeVisible();
    await expect(page.locator('[data-testid="space-invite-row"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="space-invite-row"]').first()).toContainText("Bob's Space");
    await shot(page, k('04-spaces-list-invite'));
    await teardown(page, ctx, k('04-spaces-list-invite'));
  });

  // -------------------------------------------------------------------------
  // Group B — New space sheet
  // -------------------------------------------------------------------------

  test(`05 spaces-new – sheet opens empty [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSpaces(page);
    await shot(page, k('05-spaces-new-sheet-empty') + '--s1');
    await page.click('[data-testid="profile-new-btn"]');
    await page.waitForSelector('[data-testid="space-new-sheet"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="space-new-sheet"]')).toBeVisible();
    await expect(page.locator('[data-testid="space-new-name-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="space-new-create-btn"]')).toBeVisible();
    await shot(page, k('05-spaces-new-sheet-empty'));
    await teardown(page, ctx, k('05-spaces-new-sheet-empty'));
  });

  test(`06 spaces-new – name typed enables create [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSpaces(page);
    await page.click('[data-testid="profile-new-btn"]');
    await page.waitForSelector('[data-testid="space-new-sheet"]', { timeout: 3000 });
    await shot(page, k('06-spaces-new-name-typed') + '--s1');
    await page.fill('[data-testid="space-new-name-input"]', 'Work');
    await shot(page, k('06-spaces-new-name-typed'));
    await teardown(page, ctx, k('06-spaces-new-name-typed'));
  });

  test(`07 spaces-new – demo type pre-selected, real disabled [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSpaces(page);
    await page.click('[data-testid="profile-new-btn"]');
    await page.waitForSelector('[data-testid="space-new-sheet"]', { timeout: 3000 });
    // Real button has opacity 0.5 for bank/demo login users
    const realOpacity = await page.locator('[data-testid="space-new-type-real"]').evaluate(el => el.style.opacity);
    expect(realOpacity).toBe('0.5');
    await shot(page, k('07-spaces-new-demo-type'));
    await teardown(page, ctx, k('07-spaces-new-demo-type'));
  });

  test(`08 spaces-new – name too long shows error [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSpaces(page);
    await page.click('[data-testid="profile-new-btn"]');
    await page.waitForSelector('[data-testid="space-new-sheet"]', { timeout: 3000 });
    await shot(page, k('08-spaces-new-name-too-long') + '--s1');
    await page.fill('[data-testid="space-new-name-input"]', 'A'.repeat(31));
    await page.click('[data-testid="space-new-create-btn"]');
    await expect(page.locator('[data-testid="space-new-error"]')).toBeVisible();
    await shot(page, k('08-spaces-new-name-too-long'));
    await teardown(page, ctx, k('08-spaces-new-name-too-long'));
  });

  test(`09 spaces-new – invalid chars shows error [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSpaces(page);
    await page.click('[data-testid="profile-new-btn"]');
    await page.waitForSelector('[data-testid="space-new-sheet"]', { timeout: 3000 });
    await shot(page, k('09-spaces-new-invalid-chars') + '--s1');
    await page.fill('[data-testid="space-new-name-input"]', 'Work@2025');
    await page.click('[data-testid="space-new-create-btn"]');
    await expect(page.locator('[data-testid="space-new-error"]')).toBeVisible();
    await shot(page, k('09-spaces-new-invalid-chars'));
    await teardown(page, ctx, k('09-spaces-new-invalid-chars'));
  });

  test(`10 spaces-new – duplicate name shows error [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    // TWO_PROFILES injected after login so "Personal" exists
    await goToSpaces(page, TWO_PROFILES);
    await page.click('[data-testid="profile-new-btn"]');
    await page.waitForSelector('[data-testid="space-new-sheet"]', { timeout: 3000 });
    await shot(page, k('10-spaces-new-duplicate') + '--s1');
    await page.fill('[data-testid="space-new-name-input"]', 'personal');
    await page.click('[data-testid="space-new-create-btn"]');
    await expect(page.locator('[data-testid="space-new-error"]')).toBeVisible();
    await shot(page, k('10-spaces-new-duplicate'));
    await teardown(page, ctx, k('10-spaces-new-duplicate'));
  });

  test(`11 spaces-new – real type click has no effect for demo user [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSpaces(page);
    await page.click('[data-testid="profile-new-btn"]');
    await page.waitForSelector('[data-testid="space-new-sheet"]', { timeout: 3000 });
    // Click Real type — should be a no-op (disabled)
    await page.locator('[data-testid="space-new-type-real"]').click({ force: true });
    await page.waitForTimeout(150);
    // Demo type should still be visually selected
    await expect(page.locator('[data-testid="space-new-type-demo"]')).toBeVisible();
    await shot(page, k('11-spaces-new-real-disabled'));
    await teardown(page, ctx, k('11-spaces-new-real-disabled'));
  });

  // -------------------------------------------------------------------------
  // Group C — Accept / decline invite
  // -------------------------------------------------------------------------

  test(`12 spaces-invite – join button opens rename sheet [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, pendingInviteSetup);
    await goToSpaces(page);
    await shot(page, k('12-spaces-invite-join-sheet') + '--s1');
    // First button in the invite row is "Join"
    await page.locator('[data-testid="space-invite-row"]').first().locator('button').first().click();
    await page.waitForSelector('[data-testid="space-rename-invite-sheet"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="space-rename-invite-sheet"]')).toBeVisible();
    await shot(page, k('12-spaces-invite-join-sheet'));
    await teardown(page, ctx, k('12-spaces-invite-join-sheet'));
  });

  test(`13 spaces-invite – decline removes invite section [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, pendingInviteSetup);
    await goToSpaces(page);
    await expect(page.locator('[data-testid="space-invite-row"]')).toHaveCount(1);
    await shot(page, k('13-spaces-invite-decline') + '--s1');
    // Second button in the invite row is "Decline"
    await page.locator('[data-testid="space-invite-row"]').first().locator('button').nth(1).click();
    await page.waitForTimeout(300);
    // Invite section should disappear (status changed to "declined", filtered out)
    await expect(page.locator('[data-testid="space-invite-section"]')).not.toBeVisible();
    await shot(page, k('13-spaces-invite-decline'));
    await teardown(page, ctx, k('13-spaces-invite-decline'));
  });

  // -------------------------------------------------------------------------
  // Group D — Space detail
  // -------------------------------------------------------------------------

  test(`14 spaces-detail – active only space (delete disabled) [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSpaceDetail(page);
    await expect(page.locator('[data-testid="space-detail-screen"]')).toBeVisible();
    await expect(page.locator('[data-testid="space-detail-name"]')).toBeVisible();
    await expect(page.locator('[data-testid="space-detail-delete-btn"]')).toBeDisabled();
    await shot(page, k('14-spaces-detail-active-only'));
    await teardown(page, ctx, k('14-spaces-detail-active-only'));
  });

  test(`15 spaces-detail – inactive space (delete enabled) [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    // Open detail for first space (Personal — inactive, not the active Business space)
    await goToSpaceDetail(page, TWO_PROFILES, 0);
    await expect(page.locator('[data-testid="space-detail-delete-btn"]')).not.toBeDisabled();
    await shot(page, k('15-spaces-detail-inactive'));
    await teardown(page, ctx, k('15-spaces-detail-inactive'));
  });

  test(`16 spaces-detail – demo space shows lock in members [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    // Default bank profile is isDemo:true → lock in members section
    await goToSpaceDetail(page);
    await expect(page.locator('[data-testid="space-detail-screen"]')).toBeVisible();
    await expect(page.getByText(/demo spaces cannot have members/i)).toBeVisible();
    await shot(page, k('16-spaces-detail-demo-space'));
    await teardown(page, ctx, k('16-spaces-detail-demo-space'));
  });

  test(`17 spaces-detail – tap name enters edit mode [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSpaceDetail(page, TWO_PROFILES, 0);
    await shot(page, k('17-spaces-detail-rename') + '--s1');
    await page.click('[data-testid="space-detail-name"]');
    await page.waitForSelector('[data-testid="space-detail-name-input"]', { timeout: 2000 });
    await expect(page.locator('[data-testid="space-detail-name-input"]')).toBeVisible();
    await shot(page, k('17-spaces-detail-rename'));
    await teardown(page, ctx, k('17-spaces-detail-rename'));
  });

  test(`18 spaces-detail – rename too long shows error [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSpaceDetail(page, TWO_PROFILES, 0);
    await page.click('[data-testid="space-detail-name"]');
    await page.waitForSelector('[data-testid="space-detail-name-input"]', { timeout: 2000 });
    await shot(page, k('18-spaces-detail-rename-error') + '--s1');
    await page.fill('[data-testid="space-detail-name-input"]', 'A'.repeat(31));
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="space-detail-name-error"]')).toBeVisible();
    await shot(page, k('18-spaces-detail-rename-error'));
    await teardown(page, ctx, k('18-spaces-detail-rename-error'));
  });

  test(`19 spaces-detail – delete confirm sheet [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    // First space (Personal) is inactive and not the only one — delete is enabled
    await goToSpaceDetail(page, TWO_PROFILES, 0);
    await shot(page, k('19-spaces-detail-delete-confirm') + '--s1');
    await page.click('[data-testid="space-detail-delete-btn"]');
    await page.waitForSelector('[data-testid="space-delete-sheet"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="space-delete-sheet"]')).toBeVisible();
    await shot(page, k('19-spaces-detail-delete-confirm'));
    await teardown(page, ctx, k('19-spaces-detail-delete-confirm'));
  });

  test(`20 spaces-detail – leave confirm sheet for shared space [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    // Second profile (index 1) is an isShared space — leave button visible
    await goToSpaceDetail(page, SHARED_MEMBER_PROFILES, 1);
    await shot(page, k('20-spaces-detail-leave-confirm') + '--s1');
    await page.click('[data-testid="space-detail-leave-btn"]');
    await page.waitForSelector('[data-testid="space-leave-sheet"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="space-leave-sheet"]')).toBeVisible();
    await shot(page, k('20-spaces-detail-leave-confirm'));
    await teardown(page, ctx, k('20-spaces-detail-leave-confirm'));
  });

  // -------------------------------------------------------------------------
  // Group E — Navigation
  // -------------------------------------------------------------------------

  test(`21 spaces-back – browser back from detail returns to list [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSpaceDetail(page);
    await shot(page, k('21-spaces-back-from-detail') + '--s1');
    await page.goBack();
    await page.waitForSelector('[data-testid="spaces-screen"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="spaces-screen"]')).toBeVisible();
    await shot(page, k('21-spaces-back-from-detail'));
    await teardown(page, ctx, k('21-spaces-back-from-detail'));
  });

  test(`22 spaces-back – browser back from list returns to profile [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await goToSpaces(page);
    await shot(page, k('22-spaces-back-from-list') + '--s1');
    await page.goBack();
    await page.waitForSelector('[data-testid="spaces-nav-link"]', { timeout: 3000 });
    await expect(page.locator('[data-testid="spaces-nav-link"]')).toBeVisible();
    await shot(page, k('22-spaces-back-from-list'));
    await teardown(page, ctx, k('22-spaces-back-from-list'));
  });
}
