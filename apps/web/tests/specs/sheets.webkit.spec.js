import { test, expect } from '@playwright/test';
import { VARIANTS, base } from '../helpers/base.js';

/**
 * WebKit engine guard — geometry assertions only, no gallery shots.
 * Every iOS surface (Safari, PWA, both native webviews) renders with
 * WebKit, and WebKit applies flex sizing stricter than Blink: basis 0%
 * overrides `height` on the main axis and min-height:0 drops the
 * content minimum, which collapsed every sheet to its header on iOS
 * while Android/desktop looked perfect (user ss 2026-07-26 — a `tall`
 * 600px sheet measured 261px). jsdom cannot catch this (no layout) and
 * Chromium grows the item to content anyway; only WebKit tells the
 * truth. Runs in CI and via deploy/webkit-e2e.ps1 (dockerized, no
 * browsers on the host) — the config defines the webkit project only
 * in those two environments.
 */
const V = VARIANTS[0];

async function openSplitEditor(page) {
  await page.click('[data-testid="tab-transactions"]');
  await page.locator('[data-testid^="tx-row-"]').first().click();
  // the split-categories editor is a `tall` (600px) sheet (#211)
  await page.click('[data-testid="tx-detail-cats-edit"]');
  await expect(page.locator('[data-testid="part-cat-0"]')).toBeVisible();
}

test(`sheet-w1 a tall sheet opens PARTIAL and expands on intent [${V.id}]`, async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: V.vp, deviceScaleFactor: V.dpr, locale: 'en-US' });
  const page = await ctx.newPage();
  await base(page, V, { demo: true });
  await openSplitEditor(page);

  const sheet = page.locator('.react-modal-sheet-container');
  // #312 r4: sheets WRAP their content under the half cap (852 → 426).
  // The WebKit header-only collapse clipped the Done row away — the
  // last-control-visible assert is the collapse guard; the ceiling
  // catches a wrap regression back to fixed heights.
  const done = await page.locator('[data-testid="part-cat-save"]').boundingBox();
  expect(done).toBeTruthy();
  expect(done.y + done.height).toBeLessThanOrEqual(V.vp.height);
  expect((await sheet.boundingBox())?.height ?? 0).toBeLessThan(480);
  // content that already fits NEVER grows — an unscrollable list clamps
  // scrollTop to zero, so the growth trigger has nothing to eat
  await page.locator('.react-modal-sheet-content-scroller').evaluate((el) => {
    el.scrollTop = 10;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  expect((await sheet.boundingBox())?.height ?? 0).toBeLessThan(480);
  await ctx.close();
});

test(`sheet-w2 a stacked child keeps the depth step-down [${V.id}]`, async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: V.vp, deviceScaleFactor: V.dpr, locale: 'en-US' });
  const page = await ctx.newPage();
  await base(page, V, { demo: true });
  await openSplitEditor(page);

  await page.click('[data-testid="part-cat-0"]'); // stacks the category picker
  const sheets = page.locator('.react-modal-sheet-container');
  await expect(sheets).toHaveCount(2);
  // the catalog's content overflows, so the stacked child fills its
  // depth-stepped half cap (852/2 − 28 = 398); the collapse (261 with
  // the list clipped) stays far below
  await expect.poll(async () => (await sheets.nth(1).boundingBox())?.height ?? 0).toBeGreaterThan(350);
  expect((await sheets.nth(1).boundingBox())?.height ?? 0).toBeLessThan(410);

  // #312 r4: growth is PACED — the gesture is eaten 1:1. A big scroll
  // grows the child toward near-top and leaves the remainder to the
  // content; WebKit lays the grown height out for real.
  await sheets
    .nth(1)
    .locator('.react-modal-sheet-content-scroller')
    .evaluate((el) => {
      el.scrollTop = 500;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  await expect.poll(async () => (await sheets.nth(1).boundingBox())?.height ?? 0).toBeGreaterThan(600);
  expect((await sheets.nth(1).boundingBox())?.height ?? 0).toBeLessThan(V.vp.height);
  await ctx.close();
});
