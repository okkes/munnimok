import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, freshCamtFixture, gotoGlobalSettings, gotoSpaces, shot, teardown, syncApiUp } from '../helpers/base.js';

// date-freshened copy — the static file ages out of the default
// two-month attach history window (2026-09-06 incident)
const CAMT_FIXTURE = freshCamtFixture();

// guide capture (npm run shots, never in CI): 61-feed-share and 62-feed-archive; needs deploy/docker-compose.test.yml

// the Settings members row targets the ACTIVE space: activate the target from the spaces list first
async function gotoMembersOf(page, spaceName, { unlock = false } = {}) {
  await gotoSpaces(page);
  await page.locator(`[data-testid="screen-spaces"] button:has-text("${spaceName}")`).first().click();
  await page.locator(`[data-testid^="space-row-"]:has-text("${spaceName}") .mdi-check-circle`).waitFor();
  await page.click('[data-testid="tab-settings"]');
  await page.click('[data-testid="settings-space-members-row"]');
  await page.waitForSelector('[data-testid="space-members"]');
  if (unlock) {
    // spaces are born closed to invitations: the owner opens them on the members page (#391); retried because
    // the members section can re-render mid-tap and swallow the click
    const toggle = page.locator('[data-testid="space-invite-toggle"]');
    await toggle.waitFor({ timeout: 10000 });
    for (let attempt = 0; attempt < 4 && (await toggle.getAttribute('aria-checked')) !== 'true'; attempt++) {
      await toggle.click();
      await page.waitForTimeout(500);
    }
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });
    await page.waitForSelector('[data-testid="space-members-add"]');
  }
}


for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`sync-a6 shared bank feed: import, invite, diverge, archive on leave [${V.id}]`, async ({ browser }) => {
    test.skip(!(await syncApiUp()), 'sync API not running');
    test.setTimeout(300_000);
    const run = Date.now();

    const alice = await createPage(browser, V);
    await base(alice.page, V, { userSub: `e2e-feedowner-${run}` });
    await gotoSpaces(alice.page);
    await alice.page.click('[data-testid="spaces-add"]');
    await alice.page.fill('[data-testid="space-create-name"]', 'Feed Home');
    await alice.page.click('[data-testid="space-create-save"]');
    await alice.page.waitForTimeout(3000); // push

    // the feed registers on the server, but nothing attaches by itself (#204): the result offers the explicit attach flow
    await gotoGlobalSettings(alice.page);
    await alice.page.click('[data-testid="settings-accounts-row"]');
    await alice.page.setInputFiles('[data-testid="accounts-import-input"]', CAMT_FIXTURE);
    await alice.page.waitForSelector('[data-testid="import-preview"]');
    await alice.page.click('[data-testid="import-run"]');
    await alice.page.waitForSelector('[data-testid="import-result"]');
    await expect(alice.page.locator('[data-testid="import-unattached-note"]')).toBeVisible();
    await alice.page.click('[data-testid="import-goto-attach"]');
    await alice.page.waitForSelector('[data-testid="screen-space-accounts"]', { timeout: 10000 });
    // #310: the attach sheet auto-opens; this fixture imports TWO accounts, so it lands on the pick list
    // (a single import lands on the final step `space-attach-focus`, unit-tested)
    await alice.page.waitForSelector('[data-testid="space-attach-candidates"]', { timeout: 10000 });
    await alice.page.locator('[data-testid^="space-attach-pick-"]').first().click({ timeout: 10000 });
    await alice.page.click('[data-testid="space-attach-save"]');
    await alice.page.waitForTimeout(1500); // server attach + link mirror
    await gotoGlobalSettings(alice.page);
    await alice.page.click('[data-testid="settings-accounts-row"]');
    // #227: the attachment echoes as an inert row under the space's card, which mounts collapsed (#314) — open it first
    await alice.page.locator('[data-testid^="accounts-space-head-"]', { hasText: 'Feed Home' }).click({ timeout: 15000 });
    await expect(alice.page.locator('[data-testid^="account-echo-"]').first()).toBeVisible({ timeout: 10000 });
    await shot(alice.page, k('61-feed-share') + '--s1');
    await alice.page.waitForTimeout(4000); // push feed rows + overlay

    const bob = await createPage(browser, V);
    await base(bob.page, V, { userSub: `e2e-feedmember-${run}` });
    await gotoGlobalSettings(bob.page);
    await bob.page.click('[data-testid="settings-friends-row"]');
    await expect(bob.page.locator('[data-testid="friends-copy-id"] span')).toHaveText(/^[0-9a-f]{8}-/, { timeout: 10000 });
    const bobId = (await bob.page.locator('[data-testid="friends-copy-id"] span').textContent()).trim();

    await gotoMembersOf(alice.page, 'Feed Home', { unlock: true });
    await alice.page.click('[data-testid="space-members-add"]');
    await alice.page.fill('[data-testid="space-addfriend-input"]', bobId);
    await alice.page.click('[data-testid="space-addfriend-send"]');
    await expect(alice.page.locator('[data-testid="space-addfriend-sent"]')).toBeVisible({ timeout: 10000 });
    // #304: the request field lives in the invite SHEET — close it first, or its backdrop swallows the back tap
    await alice.page.keyboard.press('Escape');
    await alice.page.waitForTimeout(500);
    // #169: the members-screen request carries the space: bob's accept makes him a member at once and pulls the space
    await bob.page.click('[data-testid="friends-back"]');
    await bob.page.click('[data-testid="settings-friends-row"]');
    await bob.page.locator('[data-testid^="friends-accept-"]').click({ timeout: 10000 });
    await alice.page.click('[data-testid="spacemembers-back"]');

    // bob sees the feed's transactions through derived access (raw + alice's overlay joined)
    await gotoSpaces(bob.page);
    await expect(bob.page.locator('[data-testid="screen-spaces"]')).toContainText('Feed Home', { timeout: 20000 });
    await bob.page.locator('[data-testid="screen-spaces"] button:has-text("Feed Home")').first().click();
    await bob.page.waitForTimeout(600); // active-space switch settles
    await bob.page.click('[data-testid="tab-transactions"]');
    await bob.page.waitForSelector('[data-testid="screen-transactions"]', { timeout: 10000 });
    await expect(bob.page.locator('[data-testid="tx-list"]')).toContainText('Jumbo Amsterdam', { timeout: 25000 });
    await shot(bob.page, k('61-feed-share') + '--s2');

    await bob.page.locator('[data-testid="tx-list"] button:has-text("Jumbo Amsterdam")').first().click();
    await bob.page.click('[data-testid="tx-detail-category-row"]');
    await bob.page.waitForSelector('[data-testid="part-cats-editor"]');
    await bob.page.click('[data-testid="part-cat-0"]');
    await bob.page.waitForSelector('[data-testid="catpicker-videoGame"]');
    await bob.page.click('[data-testid="catpicker-videoGame"]');
    await bob.page.click('[data-testid="part-cat-save"]');
    await bob.page.waitForTimeout(3500); // push

    await alice.page.click('[data-testid="tab-transactions"]');
    await alice.page.locator('[data-testid="tx-list"] button:has-text("Jumbo Amsterdam")').first().click();
    await expect(alice.page.locator('[data-testid="tx-detail-category-row"]')).toContainText('Video Game', { timeout: 20000 });
    await shot(alice.page, k('61-feed-share'));

    // #305: the shared account's echo wears the shared badge and opens a READ-ONLY info sheet (no rename, detach, delete)
    await bob.page.click('[data-testid="tx-detail-back"]');
    await gotoGlobalSettings(bob.page);
    await bob.page.click('[data-testid="settings-accounts-row"]');
    await bob.page.locator('[data-testid^="accounts-space-head-"]', { hasText: 'Feed Home' }).click({ timeout: 15000 });
    // the badge doubles as the ready signal: it appears once /me/feeds
    // answered and the entry classified as shared-with-me
    await expect(bob.page.locator('[data-testid^="echo-shared-"]').first()).toBeVisible({ timeout: 15000 });
    const sharedEcho = bob.page.locator('button[data-testid^="account-echo-"]').first();
    await sharedEcho.click();
    await bob.page.waitForSelector('[data-testid="shared-account-info"]');
    await expect(bob.page.locator('[data-testid="space-account-sheet-detach"]')).toHaveCount(0);
    await expect(bob.page.locator('[data-testid="attach-delete"]')).toHaveCount(0);
    await shot(bob.page, k('61-feed-share') + '--s3');
    await bob.page.keyboard.press('Escape');
    await bob.page.waitForTimeout(600);

    // alice (feed owner + attacher) leaves: bob keeps the history but the account freezes — the synced mirror row
    // delivers the archived state onto the space-level echo (#305)
    await alice.page.click('[data-testid="tx-detail-back"]');
    await gotoMembersOf(alice.page, 'Feed Home');
    await alice.page.waitForSelector('[data-testid="space-leave"]');
    await alice.page.click('[data-testid="space-leave"]');
    await expect(alice.page.locator('[data-testid="space-leave-confirm"]')).toBeEnabled({ timeout: 10000 });
    await alice.page.click('[data-testid="space-leave-confirm"]');
    await expect(alice.page.locator('[data-testid="screen-spaces"]')).not.toContainText('Feed Home', { timeout: 10000 });

    await expect(bob.page.locator('[data-testid^="echo-archived-"]').first()).toBeVisible({ timeout: 25000 });
    await shot(bob.page, k('62-feed-archive'));

    await teardown(bob.page, bob.ctx, k('61-feed-share') + '--bob');
    await teardown(alice.page, alice.ctx, k('61-feed-share'));
  });
}
