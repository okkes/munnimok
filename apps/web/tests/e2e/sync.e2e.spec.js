import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, gotoGlobalSettings, gotoSpaces, shot, teardown, syncApiOrFail } from '../helpers/base.js';

// Critical flows only a real API + Postgres + two browsers can prove: two
// devices converge, an edit shows live on the other device, a shared space
// reaches the friend it was offered to, and a brand-new account onboards
// once. Runs against deploy/docker-compose.test.yml: a stack that is down
// skips them on a developer's machine and fails them on CI.

async function addCashAccount(page, name, balance) {
  await gotoGlobalSettings(page);
  await page.click('[data-testid="settings-accounts-row"]');
  await page.click('[data-testid="accounts-add"]');
  await page.click('[data-testid="chooser-manual-door"]');
  await page.click('[data-testid="space-accounts-add"]');
  await page.click('[data-testid="chooser-manual"]');
  await page.click('[data-testid="chooser-accttype-cash"]');
  await page.fill('[data-testid="chooser-acctform-name"]', name);
  await page.fill('[data-testid="chooser-acctform-balance"]', balance);
  await page.click('[data-testid="chooser-acctform-save"]');
  await expect(page.locator('[data-testid="screen-space-accounts"]')).toContainText(name);
}

async function openAccounts(page) {
  await gotoGlobalSettings(page);
  await page.click('[data-testid="settings-accounts-row"]');
  // space cards mount collapsed — open the (only) space's card
  await page.locator('[data-testid^="accounts-space-head-"]').first().click({ timeout: 15000 });
}

// the Settings members row targets the ACTIVE space: activate it first
async function gotoMembersOf(page, spaceName, { unlock = false } = {}) {
  await gotoSpaces(page);
  await page.locator(`[data-testid="screen-spaces"] button:has-text("${spaceName}")`).first().click();
  await page.locator(`[data-testid^="space-row-"]:has-text("${spaceName}") .mdi-check-circle`).waitFor();
  await page.click('[data-testid="tab-settings"]');
  await page.click('[data-testid="settings-space-members-row"]');
  await page.waitForSelector('[data-testid="space-members"]');
  if (!unlock) return;
  // spaces are born closed to invitations — the owner opens them (the members
  // list can re-render under the tap and swallow it: retry until it holds)
  const toggle = page.locator('[data-testid="space-invite-toggle"]');
  await expect(async () => {
    if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 1500 });
  }).toPass({ timeout: 15_000 });
  await page.waitForSelector('[data-testid="space-members-add"]');
}

async function friendIdOf(page) {
  await gotoGlobalSettings(page);
  await page.click('[data-testid="settings-friends-row"]');
  const id = page.locator('[data-testid="friends-copy-id"] span');
  await expect(id).toHaveText(/^[0-9a-f]{8}-/, { timeout: 10000 });
  return ((await id.textContent()) ?? '').trim();
}

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`sync-a1 two devices converge; a returning user has one personal space [${V.id}]`, async ({ browser }) => {
    test.skip(!(await syncApiOrFail()), 'sync API not running (docker compose -f deploy/docker-compose.test.yml up -d)');
    test.setTimeout(120_000);
    const sub = `e2e-${Date.now()}`;

    const a = await createPage(browser, V);
    await base(a.page, V, { userSub: sub });
    await addCashAccount(a.page, 'Sync Wallet', '12,34');
    await shot(a.page, k('25-sync-devices') + '--s1');

    // a second device of the same user pulls the space and everything in it
    const b = await createPage(browser, V);
    await base(b.page, V, { userSub: sub });
    await openAccounts(b.page);
    await expect(b.page.locator('[data-testid="screen-accounts"]')).toContainText('Sync Wallet', { timeout: 20000 });
    await expect(b.page.locator('[data-testid="screen-accounts"]')).toContainText('12.34');
    await shot(b.page, k('25-sync-devices') + '--s2');
    await gotoSpaces(b.page);
    await expect(b.page.locator('[data-testid="screen-spaces"] [data-testid^="space-row-"]')).toHaveCount(1);
    await shot(b.page, k('26-sync-single-space'));

    // B renames; A sees it after its next pull
    await openAccounts(b.page);
    await b.page.click('[data-testid="screen-accounts"] button:has-text("Sync Wallet")');
    await b.page.fill('[data-testid="acctedit-name"]', 'Renamed on B');
    await b.page.click('[data-testid="acctedit-save"]');
    await expect(async () => {
      await a.page.reload();
      await a.page.waitForSelector('[data-testid="tab-home"]');
      await openAccounts(a.page);
      await expect(a.page.locator('[data-testid="screen-accounts"]')).toContainText('Renamed on B', { timeout: 5000 });
    }).toPass({ timeout: 45_000, intervals: [2000, 4000] });
    await shot(a.page, k('25-sync-devices'));
    await teardown(b.page, b.ctx, k('25-sync-devices') + '--b');
    await teardown(a.page, a.ctx, k('25-sync-devices'));
  });

  test(`sync-a2 an edit on one device shows on the other without a reload [${V.id}]`, async ({ browser }) => {
    test.skip(!(await syncApiOrFail()), 'sync API not running');
    test.setTimeout(120_000);
    const sub = `e2e-live-${Date.now()}`;

    const a = await createPage(browser, V);
    await base(a.page, V, { userSub: sub });
    await addCashAccount(a.page, 'Live Wallet', '100');
    await a.page.click('[data-testid="tab-transactions"]');
    await a.page.click('[data-testid="tx-add"]');
    await a.page.fill('[data-testid="txform-amount"]', '10');
    await a.page.fill('[data-testid="txform-merchant"]', 'Live Cafe');
    await a.page.click('[data-testid="txform-save"]');
    // saving opens the new transaction's page — A stays on it
    await expect(a.page.locator('[data-testid="screen-tx-detail"]')).toContainText('Live Cafe');

    const b = await createPage(browser, V);
    await base(b.page, V, { userSub: sub });
    await b.page.click('[data-testid="tab-transactions"]');
    await expect(b.page.locator('[data-testid="tx-list"]')).toContainText('Live Cafe', { timeout: 20000 });
    await b.page.locator('[data-testid^="tx-row-"]', { hasText: 'Live Cafe' }).click();
    await a.page.waitForSelector('[data-testid="tx-detail-notes"]');
    await b.page.waitForSelector('[data-testid="tx-detail-notes"]');

    // A files a category, B writes a note — each sees the other's change live
    await a.page.click('[data-testid="tx-detail-category-row"]');
    await a.page.click('[data-testid="part-cat-0"]');
    await a.page.waitForSelector('[data-testid="catpicker-search"]');
    await a.page.click('[data-testid="catpicker-coffee"]');
    await a.page.click('[data-testid="part-cat-save"]');
    await b.page.fill('[data-testid="tx-detail-notes"]', 'note from B');
    await b.page.locator('[data-testid="tx-detail-notes"]').blur();
    await expect(a.page.locator('[data-testid="tx-detail-notes"]')).toHaveValue('note from B', { timeout: 20000 });
    await expect(b.page.locator('[data-testid="tx-detail-category-row"]')).toContainText('Coffee', { timeout: 20000 });
    await shot(a.page, k('58-sync-live'));
    await teardown(b.page, b.ctx, k('58-sync-live') + '--b');
    await teardown(a.page, a.ctx, k('58-sync-live'));
  });

  test(`sync-a3 a shared space reaches the friend it is offered to [${V.id}]`, async ({ browser }) => {
    test.skip(!(await syncApiOrFail()), 'sync API not running');
    test.setTimeout(180_000);
    const run = Date.now();

    const alice = await createPage(browser, V);
    await base(alice.page, V, { userSub: `e2e-owner-${run}` });
    await gotoSpaces(alice.page);
    await alice.page.click('[data-testid="spaces-add"]');
    await alice.page.fill('[data-testid="space-create-name"]', 'Shared Home');
    await alice.page.click('[data-testid="space-create-save"]');
    await expect(alice.page.locator('[data-testid="screen-spaces"]')).toContainText('Shared Home');

    // they become friends first: the invitation goes to a friend
    const bob = await createPage(browser, V);
    await base(bob.page, V, { userSub: `e2e-member-${run}` });
    const bobId = await friendIdOf(bob.page);
    await friendIdOf(alice.page);
    await alice.page.fill('[data-testid="friends-add-input"]', bobId);
    await alice.page.click('[data-testid="friends-add-send"]');
    await expect(alice.page.locator('[data-testid="friends-sent"]')).toBeVisible({ timeout: 10000 });
    await bob.page.click('[data-testid="friends-back"]');
    await bob.page.click('[data-testid="settings-friends-row"]');
    await bob.page.locator('[data-testid^="friends-accept-"]').click({ timeout: 15000 });

    await alice.page.click('[data-testid="friends-back"]');
    await gotoMembersOf(alice.page, 'Shared Home', { unlock: true });
    await shot(alice.page, k('33-space-share') + '--s1');
    await alice.page.click('[data-testid="space-members-add"]');
    await alice.page.locator('[data-testid^="space-invite-row-"]').first().click();
    await alice.page.click('[data-testid="space-invite-send"]');

    await expect(async () => {
      await gotoSpaces(bob.page);
      await expect(bob.page.locator('[data-testid="space-invites"]')).toContainText('Shared Home', { timeout: 5000 });
    }).toPass({ timeout: 30_000, intervals: [2000, 4000] });
    await shot(bob.page, k('33-space-share') + '--s2');
    await bob.page.locator('[data-testid^="space-invite-accept-"]').click();
    await expect(bob.page.locator('[data-testid="screen-spaces"]')).toContainText('Shared Home', { timeout: 15000 });
    await shot(bob.page, k('33-space-share'));
    await teardown(bob.page, bob.ctx, k('33-space-share') + '--bob');
    await teardown(alice.page, alice.ctx, k('33-space-share'));
  });

  test(`sync-a4 a brand-new account onboards once and keeps its currency [${V.id}]`, async ({ browser }) => {
    test.skip(!(await syncApiOrFail()), 'sync API not running');
    const sub = `e2e-onboard-${Date.now()}`;

    const a = await createPage(browser, V);
    await base(a.page, V, { userSub: sub, keepOnboarding: true });
    await a.page.waitForSelector('[data-testid="screen-onboarding"]');
    await a.page.fill('[data-testid="onboarding-name"]', 'Okkes Test');
    await a.page.click('[data-testid="onboarding-country"]');
    await a.page.fill('[data-testid="onboarding-country-search"]', 'Turk');
    await a.page.click('[data-testid="onboarding-country-TR"]');
    await shot(a.page, k('37-onboarding'));
    await a.page.click('[data-testid="onboarding-save"]');
    await a.page.waitForSelector('[data-testid="onboarding-lock-step"]');
    await shot(a.page, k('37-onboarding') + '--s1');
    await a.page.click('[data-testid="onboarding-lock-later"]');
    await a.page.waitForSelector('[data-testid="screen-home"]');
    await a.page.reload();
    await a.page.waitForSelector('[data-testid="screen-home"]');
    await expect(a.page.locator('[data-testid="screen-onboarding"]')).toHaveCount(0);
    await teardown(a.page, a.ctx, k('37-onboarding'));
  });
}
