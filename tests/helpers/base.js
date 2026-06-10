import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SHOTS_DIR = path.join(ROOT, 'screenshots');
export const VIDEOS_DIR = path.join(ROOT, 'videos');

for (const d of [SHOTS_DIR, VIDEOS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// All test variants: language × theme × viewport.
// id format: '{lang}-{theme}-{viewport}'
export const VARIANTS = [
  { id: 'en-light-mobile',  lang: 'en', dark: false, vp: { width: 393,  height: 852 }, dpr: 2 },
  { id: 'en-light-desktop', lang: 'en', dark: false, vp: { width: 1280, height: 900 }, dpr: 1 },
  { id: 'tr-dark-mobile',   lang: 'tr', dark: true,  vp: { width: 393,  height: 852 }, dpr: 2 },
  { id: 'tr-dark-desktop',  lang: 'tr', dark: true,  vp: { width: 1280, height: 900 }, dpr: 1 },
];

// Create a browser context + page configured for the given variant.
// Includes video recording — call teardown() after the test to finalize.
export async function createPage(browser, variant) {
  const ctx = await browser.newContext({
    viewport:          variant.vp,
    deviceScaleFactor: variant.dpr,
    locale:            variant.lang === 'tr' ? 'tr-TR' : 'en-US',
    recordVideo:       { dir: VIDEOS_DIR, size: variant.vp },
  });
  const page = await ctx.newPage();
  return { page, ctx };
}

// Inject language + dark-mode into localStorage before page load, then navigate.
export async function base(page, variant, extraSetup) {
  await page.addInitScript((v) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('munni_lang', JSON.stringify(v.lang));
    if (v.dark) localStorage.setItem('munni_dark', JSON.stringify(true));
  }, { lang: variant.lang, dark: variant.dark });
  if (extraSetup) await page.addInitScript(extraSetup);
  await page.goto('/');
  await page.waitForSelector('.m-logo');
}

// Wait for the m-fade animation (280ms) to finish before screenshotting.
export async function shot(page, name) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: false });
}

// Close context and rename the recorded video to match the screenshot name.
export async function teardown(page, ctx, finalShotName) {
  const video = page.video();
  let videoPath;
  try { videoPath = await video?.path(); } catch {}
  try { await ctx.close(); } catch {}
  if (videoPath) {
    try {
      const dest = path.join(VIDEOS_DIR, `${finalShotName}.webm`);
      if (fs.existsSync(videoPath) && videoPath !== dest) {
        fs.renameSync(videoPath, dest);
      }
    } catch {
      // Cross-device rename can fail; fall back to saveAs copy
      try { await video?.saveAs(path.join(VIDEOS_DIR, `${finalShotName}.webm`)); } catch {}
    }
  }
}
