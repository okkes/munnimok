import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, freshCamtFixture, gotoGlobalSettings, gotoSpaces, shot, teardown, syncApiUp } from '../helpers/base.js';

// date-freshened copy — the static file ages out of the default
// two-month attach history window (2026-09-06 incident)
const CAMT_FIXTURE = freshCamtFixture();

// Guide capture (npm run shots — never in CI): a shared bank feed across two
// users — import, invite, the overlay that diverges per space, the archive on
// leave (61-feed-share, 62-feed-archive). Needs deploy/docker-compose.test.yml.

// the space-settings doors are gone (user remark: Settings is the one
// place) — the Settings members row targets the ACTIVE space, so the
// target space is activated from the spaces list first
async function gotoMembersOf(page, spaceName, { unlock = false } = {}) {
  await gotoSpaces(page);
  await page.locator(`[data-testid="screen-spaces"] button:has-text("${spaceName}")`).first().click();
  // the check-circle badge appearing on the row = the switch settled
  await page.locator(`[data-testid^="space-row-"]:has-text("${spaceName}") .mdi-check-circle`).waitFor();
  await page.click('[data-testid="tab-settings"]');
  await page.click('[data-testid="settings-space-members-row"]');
  await page.waitForSelector('[data-testid="space-members"]');
  if (unlock) {
    // arc 4: spaces are born closed to invitations — the OWNER opens them.
    // #391: the switch lives on the members page (owner-only row), no
    // Settings detour anymore. Retried: the members section can re-render
    // mid-tap and swallow the click.
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

    // alice: fresh user, creates the shared space (becomes active)
    const alice = await createPage(browser, V);
    await base(alice.page, V, { userSub: `e2e-feedowner-${run}` });
    await gotoSpaces(alice.page);
    await alice.page.click('[data-testid="spaces-add"]');
    await alice.page.fill('[data-testid="space-create-name"]', 'Feed Home');
    await alice.page.click('[data-testid="space-create-save"]');
    await alice.page.waitForTimeout(3000); // push

    // alice imports a statement — the feed registers on the server but
    // #204: nothing attaches by itself; the result offers the explicit
    // attach flow where alice picks the account, type and history
    await gotoGlobalSettings(alice.page);
    await alice.page.click('[data-testid="settings-accounts-row"]');
    await alice.page.setInputFiles('[data-testid="accounts-import-input"]', CAMT_FIXTURE);
    await alice.page.waitForSelector('[data-testid="import-preview"]');
    await alice.page.click('[data-testid="import-run"]');
    await alice.page.waitForSelector('[data-testid="import-result"]');
    await expect(alice.page.locator('[data-testid="import-unattached-note"]')).toBeVisible();
    await alice.page.click('[data-testid="import-goto-attach"]');
    await alice.page.waitForSelector('[data-testid="screen-space-accounts"]', { timeout: 10000 });
    // #310: the attach sheet auto-opens on arrival. This CAMT fixture
    // imports TWO accounts, so the door can't know which one — the
    // sheet lands on the pick list (a single import would land on the
    // final step, `space-attach-focus`, covered by unit specs)
    await alice.page.waitForSelector('[data-testid="space-attach-candidates"]', { timeout: 10000 });
    await alice.page.locator('[data-testid^="space-attach-pick-"]').first().click({ timeout: 10000 });
    await alice.page.click('[data-testid="space-attach-save"]');
    await alice.page.waitForTimeout(1500); // server attach + link mirror
    await gotoGlobalSettings(alice.page);
    await alice.page.click('[data-testid="settings-accounts-row"]');
    // #227: the "via <space>" subtitle is gone — the attachment now
    // echoes as an inert row under the space's own card, which mounts
    // COLLAPSED since #314 r2 — open it before looking for the echo
    await alice.page.locator('[data-testid^="accounts-space-head-"]', { hasText: 'Feed Home' }).click({ timeout: 15000 });
    await expect(alice.page.locator('[data-testid^="account-echo-"]').first()).toBeVisible({ timeout: 10000 });
    await shot(alice.page, k('61-feed-share') + '--s1');
    await alice.page.waitForTimeout(4000); // push feed rows + overlay

    // bob: fresh user; alice friends him inline from the members section
    const bob = await createPage(browser, V);
    await base(bob.page, V, { userSub: `e2e-feedmember-${run}` });
    await gotoGlobalSettings(bob.page);
    await bob.page.click('[data-testid="settings-friends-row"]');
    await expect(bob.page.locator('[data-testid="friends-copy-id"] span')).toHaveText(/^[0-9a-f]{8}-/, { timeout: 10000 });
    const bobId = (await bob.page.locator('[data-testid="friends-copy-id"] span').textContent()).trim();

    await gotoMembersOf(alice.page, 'Feed Home', { unlock: true });
    // #304: the request field lives inside the one invite sheet now
    await alice.page.click('[data-testid="space-members-add"]');
    await alice.page.fill('[data-testid="space-addfriend-input"]', bobId);
    await alice.page.click('[data-testid="space-addfriend-send"]');
    await expect(alice.page.locator('[data-testid="space-addfriend-sent"]')).toBeVisible({ timeout: 10000 });
    // #304: the request field lives inside the invite SHEET — close it
    // first, or its backdrop swallows the back tap below
    await alice.page.keyboard.press('Escape');
    await alice.page.waitForTimeout(500);
    // #169: the members-screen request CARRIES the space — bob's accept
    // makes him a member on the spot (no second invite, no banner) and
    // the accept handler pulls the fresh space immediately
    await bob.page.click('[data-testid="friends-back"]');
    await bob.page.click('[data-testid="settings-friends-row"]');
    await bob.page.locator('[data-testid^="friends-accept-"]').click({ timeout: 10000 });
    await alice.page.click('[data-testid="spacemembers-back"]');

    // bob makes the shared space active — and sees the FEED's
    // transactions through derived access (raw + alice's overlay joined)
    await gotoSpaces(bob.page);
    await expect(bob.page.locator('[data-testid="screen-spaces"]')).toContainText('Feed Home', { timeout: 20000 });
    await bob.page.locator('[data-testid="screen-spaces"] button:has-text("Feed Home")').first().click();
    await bob.page.waitForTimeout(600); // active-space switch settles
    await bob.page.click('[data-testid="tab-transactions"]');
    await bob.page.waitForSelector('[data-testid="screen-transactions"]', { timeout: 10000 });
    await expect(bob.page.locator('[data-testid="tx-list"]')).toContainText('Jumbo Amsterdam', { timeout: 25000 });
    await shot(bob.page, k('61-feed-share') + '--s2');

    // bob recategorizes a feed transaction; the shared overlay reaches alice
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

    // #305: bob meets the shared account inside ITS space section. The
    // echo wears the shared badge and answers with the READ-ONLY info
    // sheet (facts, no owner levers: no rename, no detach, no delete)
    await bob.page.click('[data-testid="tx-detail-back"]');
    await gotoGlobalSettings(bob.page);
    await bob.page.click('[data-testid="settings-accounts-row"]');
    // #314 r2: the space card mounts collapsed — open Feed Home's first
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

    // alice (feed owner + attacher) leaves the space: bob keeps the shared
    // history but the account freezes — the synced mirror row delivers the
    // archived state onto the space-level echo (#305: the pill moved here
    // from the retired shared section; bob's open screen updates live)
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
