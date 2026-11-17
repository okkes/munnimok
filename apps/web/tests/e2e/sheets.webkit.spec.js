import { test, expect } from '@playwright/test';
import { VARIANTS, base } from '../helpers/base.js';

// the one WebKit check (every iOS surface renders with WebKit): it sizes flex items stricter than Blink and once
// collapsed every sheet to its header on iOS only; runs in CI and via deploy/webkit-e2e.ps1 (dockerized)
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
