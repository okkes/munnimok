import { test, expect } from '@playwright/test';
import { base } from '../helpers/base.js';

/**
 * The ONE engine guard: sheets are laid out by the browser, so neither
 * jsdom (no layout) nor our Chromium gallery run can see a WebKit-only
 * collapse — and WebKit is what every iOS browser, PWA and native
 * webview runs. This spec exists because exactly that happened
 * (2026-07-26): `flex: 1 1 0%` overrides `height` on the main axis and,
 * with the content minimum removed, WebKit legally resolved the sheet
 * body to zero — sheets opened header-only on iOS while Blink grew them
 * to content. Assertions are geometric on purpose; no screenshots, this
 * is not a gallery spec.
 */

const IPHONE = { id: 'en-light-mobile', lang: 'en', dark: false, vp: { width: 393, height: 852 }, dpr: 2 };

test(`sheet-w1 a sized sheet opens to its full height in WebKit`, async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: IPHONE.vp, deviceScaleFactor: IPHONE.dpr, locale: 'en-US' });
  const page = await ctx.newPage();
  await base(page, IPHONE, { demo: true });

  await page.click('[data-testid="tab-transactions"]');
  await page.locator('[data-testid^="tx-row-"]').first().click();
  await page.click('[data-testid="tx-detail-cats-edit"]');

  const sheet = page.locator('.react-modal-sheet-container').first();
  const scroller = page.locator('.react-modal-sheet-content-scroller').first();
  await expect(sheet).toBeVisible();

  // the collapsed bug measured 261px of sheet / 199px of scrollport for
  // a `tall` (600px) sheet — assert well clear of that, not exact px
  await expect
    .poll(async () => (await sheet.boundingBox())?.height ?? 0, { timeout: 15000 })
    .toBeGreaterThan(450);
  expect((await scroller.boundingBox())?.height ?? 0).toBeGreaterThan(300);
  // and it must never swallow the whole viewport either
  expect((await sheet.boundingBox())?.height ?? 0).toBeLessThan(IPHONE.vp.height);

  await ctx.close();
});
