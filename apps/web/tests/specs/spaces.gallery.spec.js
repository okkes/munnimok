import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, gotoSpaces, shot, teardown } from '../helpers/base.js';

// Why this spec exists (test policy 2026-09-17): per-space data isolation
// as a real-browser flow — the spaces list with its active marker, creating
// a space (Home scopes to it, empty) and switching back (the demo totals
// return). It produces the gallery/guide screenshots 22-spaces-list and
// 23-spaces-create. Rename, the delete guards and the create form's
// options are unit-tested (features/spaces/SpacesScreen.test.tsx).

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`spaces-a2 create space switches scope; switching back restores data [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await gotoSpaces(page);
    // the list marks the demo space active (22-spaces-list)
    await expect(page.locator('[data-testid="space-row-demo_space"]')).toContainText('Demo');
    await expect(page.locator('[data-testid="space-row-demo_space"]')).toContainText('Active space');
    await shot(page, k('22-spaces-list'));

    await page.click('[data-testid="spaces-add"]');
    await page.fill('[data-testid="space-create-name"]', 'Holiday Fund');
    await page.waitForTimeout(400);
    await shot(page, k('23-spaces-create') + '--s1');
    await page.click('[data-testid="space-create-save"]');
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="screen-spaces"]')).toContainText('Holiday Fund');
    // new space is active and empty: home total is €0.00
    await page.click('[data-testid="tab-home"]');
    await expect(page.locator('[data-testid="home-total-balance"]')).toContainText('0.00');
    await shot(page, k('23-spaces-create') + '--s2');
    // switch back to Demo: totals return
    await gotoSpaces(page);
    await page.click('[data-testid="space-row-demo_space"]');
    await page.click('[data-testid="tab-home"]');
    // 8,080.55 + the default loan pot's €25 repayment leg (#133: the demo
    // split's bare Device-plan part links onto it at boot)
    await expect(page.locator('[data-testid="home-total-balance"]')).toContainText('8,105.55');
    await shot(page, k('23-spaces-create'));
    await teardown(page, ctx, k('23-spaces-create'));
  });
}
