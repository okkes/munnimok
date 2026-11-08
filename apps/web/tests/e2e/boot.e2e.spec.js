import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// Critical flow: the demo sign-in lands on Home with the seeded data, every
// tab mounts, and the browser's back button returns to the previous tab
// (the history API — only a real browser proves it).

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`boot-a1 the demo sign-in lands on Home; the tabs mount and back returns [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await expect(page.locator('[data-testid="login-demo-btn"]')).toBeVisible();
    await shot(page, k('06-demo-login') + '--s1');
    await page.click('[data-testid="login-demo-btn"]');
    await expect(page.locator('[data-testid="home-total-balance"]')).toContainText(/€[1-9]/);
    await expect(page).toHaveURL(/#\/home$/);
    await shot(page, k('06-demo-login'));
    await shot(page, k('01-shell-home'));

    await page.click('[data-testid="tab-transactions"]');
    await expect(page.locator('[data-testid="screen-transactions"]')).toBeVisible();
    await shot(page, k('02-shell-tabs') + '--s1');
    await shot(page, k('03-shell-back') + '--s1');
    await page.goBack();
    await expect(page.locator('[data-testid="screen-home"]')).toBeVisible();
    await expect(page).toHaveURL(/#\/home$/);
    await shot(page, k('03-shell-back'));

    await page.click('[data-testid="tab-planning"]');
    await expect(page.locator('[data-testid="screen-planning"]')).toBeVisible();
    await shot(page, k('02-shell-tabs') + '--s2');
    await page.click('[data-testid="tab-settings"]');
    await expect(page.locator('[data-testid="screen-settings"]')).toBeVisible();
    await shot(page, k('02-shell-tabs'));
    await teardown(page, ctx, k('06-demo-login'));
  });
}
