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
