import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown, syncApiUp } from '../helpers/base.js';

// Two-device sync e2e against the real API + Postgres
// (deploy/docker-compose.test.yml). Skips when the stack isn't running.

async function addCashAccount(page, name, balance) {
  await page.click('[data-testid="tab-settings"]');
  await page.click('[data-testid="settings-accounts-row"]');
  await page.click('[data-testid="accounts-add"]');
  await page.click('[data-testid="accttype-cash"]');
  await page.fill('[data-testid="acctform-name"]', name);
  await page.fill('[data-testid="acctform-balance"]', balance);
  await page.click('[data-testid="acctform-save"]');
  await page.waitForTimeout(500);
}

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`sync-a1 two devices converge through the real API [${V.id}]`, async ({ browser }) => {
    test.skip(!(await syncApiUp()), 'sync API not running (docker compose -f deploy/docker-compose.test.yml up -d)');
    test.setTimeout(120_000);
    const sub = `e2e-${Date.now()}`;

    // device A: first login creates + pushes the personal space
    const a = await createPage(browser, V);
    await base(a.page, V, { userSub: sub });
    await addCashAccount(a.page, 'Sync Wallet', '12,34');
    await expect(a.page.locator('[data-testid="screen-accounts"]')).toContainText('Sync Wallet');
    await shot(a.page, k('25-sync-devices') + '--s1');
    await a.page.waitForTimeout(3500); // nudge debounce (2s) + push

    // device B: brand-new context discovers the space and pulls everything
    const b = await createPage(browser, V);
    await base(b.page, V, { userSub: sub });
    await b.page.click('[data-testid="tab-settings"]');
    await b.page.click('[data-testid="settings-accounts-row"]');
    await expect(b.page.locator('[data-testid="screen-accounts"]')).toContainText('Sync Wallet', { timeout: 15000 });
    await expect(b.page.locator('[data-testid="screen-accounts"]')).toContainText('12.34');
    await shot(b.page, k('25-sync-devices') + '--s2');

    // device B renames it; device A sees the rename after its next pull (reload)
    await b.page.click('[data-testid="screen-accounts"] button:has-text("Sync Wallet")');
    await b.page.fill('[data-testid="acctedit-name"]', 'Renamed on B');
    await b.page.click('[data-testid="acctedit-save"]');
    await b.page.waitForTimeout(3500);

    await a.page.reload();
    await a.page.waitForSelector('[data-testid="tab-home"]');
    await a.page.click('[data-testid="tab-settings"]');
    await a.page.click('[data-testid="settings-accounts-row"]');
    await expect(a.page.locator('[data-testid="screen-accounts"]')).toContainText('Renamed on B', { timeout: 15000 });
    await shot(a.page, k('25-sync-devices'));

    await teardown(b.page, b.ctx, k('25-sync-devices') + '--b');
    await teardown(a.page, a.ctx, k('25-sync-devices'));
  });

  test(`sync-a3 shared space: invite via UI, member data converges [${V.id}]`, async ({ browser }) => {
    test.skip(!(await syncApiUp()), 'sync API not running');
    test.setTimeout(150_000);
    const run = Date.now();

    // alice: create a space to share
    const alice = await createPage(browser, V);
    await base(alice.page, V, { userSub: `e2e-owner-${run}` });
    await alice.page.click('[data-testid="tab-spaces"]');
    await alice.page.click('[data-testid="spaces-add"]');
    await alice.page.fill('[data-testid="space-create-name"]', 'Shared Home');
    await alice.page.click('[data-testid="space-create-save"]');
    await alice.page.waitForTimeout(3000); // push

    // friendship: bob requests, alice accepts
    const bob = await createPage(browser, V);
    await base(bob.page, V, { userSub: `e2e-member-${run}` });
    await alice.page.click('[data-testid="tab-settings"]');
    await alice.page.click('[data-testid="settings-friends-row"]');
    await expect(alice.page.locator('[data-testid="friends-copy-id"] span')).toHaveText(/^[0-9a-f]{8}-/, { timeout: 10000 });
    const aliceId = (await alice.page.locator('[data-testid="friends-copy-id"] span').textContent()).trim();
    await bob.page.click('[data-testid="tab-settings"]');
    await bob.page.click('[data-testid="settings-friends-row"]');
    await bob.page.fill('[data-testid="friends-add-input"]', aliceId);
    await bob.page.click('[data-testid="friends-add-send"]');
    await alice.page.click('[data-testid="friends-back"]');
    await alice.page.click('[data-testid="settings-friends-row"]');
    await alice.page.locator('[data-testid^="friends-accept-"]').click();
    await alice.page.waitForTimeout(500);

    // alice invites bob to the shared space via the members section
    await alice.page.click('[data-testid="tab-spaces"]');
    await alice.page.click('[data-testid="screen-spaces"] button:has-text("Shared Home") >> nth=0');
    await alice.page.locator('[data-testid^="space-edit-"]:right-of(:text("Shared Home"))').first().click();
    await alice.page.waitForSelector('[data-testid="space-members"]');
    await shot(alice.page, k('33-space-share') + '--s1');
    await alice.page.locator('[data-testid^="space-invite-"]').first().click();
    await alice.page.waitForTimeout(800);

    // bob: accept the invite banner; the shared space + its data arrive
    await bob.page.click('[data-testid="tab-spaces"]');
    await expect(bob.page.locator('[data-testid="space-invites"]')).toContainText('Shared Home', { timeout: 10000 });
    await shot(bob.page, k('33-space-share') + '--s2');
    await bob.page.locator('[data-testid^="space-invite-accept-"]').click();
    await expect(bob.page.locator('[data-testid="screen-spaces"]')).toContainText('Shared Home', { timeout: 15000 });
    await shot(bob.page, k('33-space-share'));

    // roles: alice (owner) demotes bob to reader, then back to contributor
    // (reopen the settings sheet so the members list includes bob)
    await alice.page.keyboard.press('Escape');
    await alice.page.waitForTimeout(700);
    await alice.page.locator('[data-testid^="space-edit-"]:right-of(:text("Shared Home"))').first().click();
    await alice.page.waitForSelector('[data-testid^="space-role-"]', { timeout: 10000 });
    await alice.page.locator('[data-testid^="space-role-"]').selectOption('reader');
    await alice.page.waitForTimeout(500);
    await expect(alice.page.locator('[data-testid^="space-role-"]')).toHaveValue('reader');
    await shot(alice.page, k('57-space-roles'));
    await alice.page.locator('[data-testid^="space-role-"]').selectOption('contributor');
    await alice.page.waitForTimeout(500);

    // bob leaves the space: it disappears from his list, alice keeps it
    await bob.page.locator('[data-testid^="space-edit-"]:right-of(:text("Shared Home"))').first().click();
    await bob.page.waitForSelector('[data-testid="space-leave"]');
    await bob.page.click('[data-testid="space-leave"]'); // arm
    await bob.page.click('[data-testid="space-leave"]'); // confirm
    await expect(bob.page.locator('[data-testid="screen-spaces"]')).not.toContainText('Shared Home', { timeout: 10000 });
    await shot(bob.page, k('57-space-roles') + '--s1');

    await teardown(bob.page, bob.ctx, k('33-space-share') + '--bob');
    await teardown(alice.page, alice.ctx, k('33-space-share'));
  });

  test(`sync-a4 onboarding shows once for brand-new users, sets currency [${V.id}]`, async ({ browser }) => {
    test.skip(!(await syncApiUp()), 'sync API not running');
    const sub = `e2e-onboard-${Date.now()}`;

    const a = await createPage(browser, V);
    await base(a.page, V, { userSub: sub });
    // brand-new user -> redirected to onboarding
    await a.page.waitForSelector('[data-testid="screen-onboarding"]');
    await a.page.fill('[data-testid="onboarding-name"]', 'Okkes Test');
    await a.page.click('[data-testid="onboarding-country"]');
    await a.page.waitForSelector('[data-testid="onboarding-country-search"]');
    await a.page.fill('[data-testid="onboarding-country-search"]', 'Turk');
    await a.page.click('[data-testid="onboarding-country-TR"]');
    await expect(a.page.locator('[data-testid="onboarding-currency-hint"]')).toContainText('TRY');
    await shot(a.page, k('37-onboarding'));
    await a.page.click('[data-testid="onboarding-save"]');
    await a.page.waitForSelector('[data-testid="screen-home"]');
    // currency applied to the personal space: home total renders in TRY
    await expect(a.page.locator('[data-testid="home-total-balance"]')).toContainText('TRY');
    // reload: onboarding never comes back
    await a.page.reload();
    await a.page.waitForSelector('[data-testid="screen-home"]');
    await expect(a.page.locator('[data-testid="screen-onboarding"]')).toHaveCount(0);
    await teardown(a.page, a.ctx, k('37-onboarding'));
  });

  test(`sync-a2 personal space exists exactly once for a returning user [${V.id}]`, async ({ browser }) => {
    test.skip(!(await syncApiUp()), 'sync API not running');
    const sub = `e2e-solo-${Date.now()}`;

    const a = await createPage(browser, V);
    await base(a.page, V, { userSub: sub });
    await a.page.waitForTimeout(3000); // personal space pushed

    // same user, fresh device: must NOT create a second personal space
    const b = await createPage(browser, V);
    await base(b.page, V, { userSub: sub });
    await b.page.click('[data-testid="tab-spaces"]');
    await b.page.waitForTimeout(2000);
    await expect(b.page.locator('[data-testid="screen-spaces"] [data-testid^="space-row-"]')).toHaveCount(1, {
      timeout: 15000,
    });
    await shot(b.page, k('26-sync-single-space'));
    await teardown(b.page, b.ctx, k('26-sync-single-space'));
    await teardown(a.page, a.ctx, k('26-sync-single-space') + '--a');
  });
}
