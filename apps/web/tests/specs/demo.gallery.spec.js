import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// Why this spec exists (test policy 2026-09-17): the sign-in start in a real
// browser — the login gate, "Continue as demo user", the on-device seed and
// the first Home paint with the seeded total. It produces the gallery/guide
// screenshot 06-demo-login. The seeded transaction list and the demo
// sign-out wipe are unit-tested (app/screens.test.tsx,
// features/settings/SettingsScreen.test.tsx).

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`demo-a1 login screen then continue as demo [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await expect(page.locator('[data-testid="login-demo-btn"]')).toBeVisible();
    await shot(page, k('06-demo-login') + '--s1');
    await page.click('[data-testid="login-demo-btn"]');
    await page.waitForSelector('[data-testid="home-total-balance"]');
    // checking €3,420.55 + savings €8,150.00 − the v2 loans €3,490.00
    // 8,080.55 + the default loan pot's €25 repayment leg (#133: the demo
    // split's bare Device-plan part links onto it at boot — settled value)
    await expect(page.locator('[data-testid="home-total-balance"]')).toContainText('8,105.55');
    await shot(page, k('06-demo-login'));
    await teardown(page, ctx, k('06-demo-login'));
  });
}
