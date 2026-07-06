import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// ─── Tests ──────────────────────────────────────────────────────────────────

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`shell-a1 home tab default [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await expect(page.locator('[data-testid="screen-home"]')).toBeVisible();
    await expect(page).toHaveURL(/#\/home$/);
    await shot(page, k('01-shell-home'));
    await teardown(page, ctx, k('01-shell-home'));
  });

  test(`shell-a2 tab navigation [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.click('[data-testid="tab-transactions"]');
    await expect(page.locator('[data-testid="screen-transactions"]')).toBeVisible();
    await shot(page, k('02-shell-tabs') + '--s1');
    await page.click('[data-testid="tab-spaces"]');
    await expect(page.locator('[data-testid="screen-spaces"]')).toBeVisible();
    await shot(page, k('02-shell-tabs') + '--s2');
    await page.click('[data-testid="tab-settings"]');
    await expect(page.locator('[data-testid="screen-settings"]')).toBeVisible();
    await shot(page, k('02-shell-tabs'));
    await teardown(page, ctx, k('02-shell-tabs'));
  });

  test(`shell-a3 browser back returns to previous tab [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.click('[data-testid="tab-transactions"]');
    await expect(page.locator('[data-testid="screen-transactions"]')).toBeVisible();
    await shot(page, k('03-shell-back') + '--s1');
    await page.goBack();
    await expect(page.locator('[data-testid="screen-home"]')).toBeVisible();
    await expect(page).toHaveURL(/#\/home$/);
    await shot(page, k('03-shell-back'));
    await teardown(page, ctx, k('03-shell-back'));
  });

  test(`shell-a4 language switch to Dutch [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.click('[data-testid="tab-settings"]');
    await expect(page.locator('[data-testid="settings-language-row"]')).toBeVisible();
    await shot(page, k('04-shell-language') + '--s1');
    await page.click('[data-testid="settings-language-row"]');
    await expect(page.locator('[data-testid="lang-option-nl"]')).toBeVisible();
    await page.waitForTimeout(500); // sheet slide-in
    await shot(page, k('04-shell-language') + '--s2');
    await page.click('[data-testid="lang-option-nl"]');
    await page.waitForTimeout(500); // sheet slide-out
    await expect(page.locator('[data-testid="tab-settings"]')).toContainText('Instellingen');
    await shot(page, k('04-shell-language'));
    await teardown(page, ctx, k('04-shell-language'));
  });

  test(`shell-a5 dark mode toggle [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V);
    await page.click('[data-testid="tab-settings"]');
    await expect(page.locator('[data-testid="settings-theme-toggle"]')).toBeVisible();
    await page.click('[data-testid="settings-theme-toggle"]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await shot(page, k('05-shell-dark'));
    await teardown(page, ctx, k('05-shell-dark'));
  });
}
