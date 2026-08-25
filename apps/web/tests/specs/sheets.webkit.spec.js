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
  // #312 r2: sheets OPEN at half the viewport at most (852 → 426). The
  // WebKit header-only collapse measured 261px of sheet with the Done
  // row clipped away — the floor sits far above it, the ceiling below
  // the old fixed `tall` height, so both the collapse AND a
  // partial-open regression are caught.
  await expect.poll(async () => (await sheet.boundingBox())?.height ?? 0).toBeGreaterThan(380);
  expect((await sheet.boundingBox())?.height ?? 0).toBeLessThan(480);
  // the collapse guard proper: this editor's content FITS the partial
  // height, so its last control must be fully on screen (the 261px
  // collapse cut it off)
  const done = await page.locator('[data-testid="part-cat-save"]').boundingBox();
  expect(done).toBeTruthy();
  expect(done.y + done.height).toBeLessThanOrEqual(V.vp.height);
  // and content that already fits NEVER grows the sheet — a scroll
  // intent on an unscrollable list is a no-op (the r2 ratchet grows a
  // sheet toward its content, not past it)
  await page.locator('.react-modal-sheet-content-scroller').evaluate((el) => {
    el.scrollTop = 10;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForTimeout(600); // past the 280ms height transition
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
  // stacked sheets step down 28px per level (Sheet.tsx depth cue) — at
  // the #312 r2 partial open both sheets sit at their halves, the child
  // one step shorter; the WebKit collapse (261px) stays far below the
  // floor
  await expect.poll(async () => (await sheets.nth(1).boundingBox())?.height ?? 0).toBeGreaterThan(350);
  const parent = (await sheets.nth(0).boundingBox())?.height ?? 0;
  const child = (await sheets.nth(1).boundingBox())?.height ?? 0;
  expect(Math.abs(parent - 28 - child)).toBeLessThanOrEqual(2);

  // #312 r2 expansion, proven on a sheet whose content is genuinely
  // long (the full category catalog): a scroll intent grows the child
  // toward near-top — far past its 398px partial — and WebKit lays the
  // grown height out for real
  await sheets
    .nth(1)
    .locator('.react-modal-sheet-content-scroller')
    .evaluate((el) => {
      el.scrollTop = 10;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  await expect.poll(async () => (await sheets.nth(1).boundingBox())?.height ?? 0).toBeGreaterThan(600);
  expect((await sheets.nth(1).boundingBox())?.height ?? 0).toBeLessThan(V.vp.height);
  await ctx.close();
});
