import { test, expect } from '@playwright/test';
import { VARIANTS, base } from '../helpers/base.js';

/**
 * The one WebKit check (every iOS surface — Safari, the PWA, both native
 * webviews — renders with WebKit): a tall sheet opens to its full height.
 * WebKit sizes flex items stricter than Blink and once collapsed every sheet
 * to its header on iOS while Android and desktop looked perfect (user ss
 * 2026-07-26); only a real WebKit layout shows it. Runs in CI and through
 * deploy/webkit-e2e.ps1 (dockerized, no browsers on the host).
 */
const V = VARIANTS[0];

test(`webkit-a1 a tall sheet opens to its full height [${V.id}]`, async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: V.vp, deviceScaleFactor: V.dpr, locale: 'en-US' });
  const page = await ctx.newPage();
  await base(page, V, { demo: true });
  await page.click('[data-testid="tab-transactions"]');
  await page.locator('[data-testid^="tx-row-"]').first().click();
  // the split-categories editor is a `tall` (600px) sheet
  await page.click('[data-testid="tx-detail-cats-edit"]');
  await expect(page.locator('[data-testid="part-cat-0"]')).toBeVisible();

  const sheet = page.locator('.react-modal-sheet-container');
  // the collapse measured 261px of sheet and 199px of scrollport — the
  // thresholds sit far from both the broken and the correct value
  await expect.poll(async () => (await sheet.boundingBox())?.height ?? 0).toBeGreaterThan(450);
  const scroller = await page.locator('.react-modal-sheet-content-scroller').boundingBox();
  expect(scroller?.height ?? 0).toBeGreaterThan(300);
  expect((await sheet.boundingBox())?.height ?? 0).toBeLessThan(V.vp.height);
  await ctx.close();
});
