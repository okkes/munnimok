# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: apps\munni\tests\specs\ux-improvements.gallery.spec.js >> ux6-no-type-badge-in-rows [en-light-mobile]
- Location: apps\munni\tests\specs\ux-improvements.gallery.spec.js:132:3

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/", waiting until "load"

```

# Test source

```ts
  1  | import fs from 'fs';
  2  | import path from 'path';
  3  | import { fileURLToPath } from 'url';
  4  | 
  5  | const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  6  | 
  7  | export const SHOTS_DIR = path.join(ROOT, 'screenshots');
  8  | export const VIDEOS_DIR = path.join(ROOT, 'videos');
  9  | 
  10 | for (const d of [SHOTS_DIR, VIDEOS_DIR]) {
  11 |   if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  12 | }
  13 | 
  14 | // All test variants: language × theme × viewport.
  15 | // id format: '{lang}-{theme}-{viewport}'
  16 | // Single default variant: EN, light, mobile.
  17 | // Dark / TR / desktop are evaluated manually when explicitly requested.
  18 | export const VARIANTS = [
  19 |   { id: 'en-light-mobile', lang: 'en', dark: false, vp: { width: 393, height: 852 }, dpr: 2 },
  20 | ];
  21 | 
  22 | // Create a browser context + page configured for the given variant.
  23 | // Includes video recording — call teardown() after the test to finalize.
  24 | export async function createPage(browser, variant) {
  25 |   const ctx = await browser.newContext({
  26 |     viewport:          variant.vp,
  27 |     deviceScaleFactor: variant.dpr,
  28 |     locale:            variant.lang === 'tr' ? 'tr-TR' : 'en-US',
  29 |     recordVideo:       { dir: VIDEOS_DIR, size: variant.vp },
  30 |   });
  31 |   const page = await ctx.newPage();
  32 |   return { page, ctx };
  33 | }
  34 | 
  35 | // Inject language + dark-mode into localStorage before page load, then navigate.
  36 | export async function base(page, variant, extraSetup) {
  37 |   await page.addInitScript((v) => {
  38 |     localStorage.clear();
  39 |     sessionStorage.clear();
  40 |     localStorage.setItem('munni_lang', JSON.stringify(v.lang));
  41 |     if (v.dark) localStorage.setItem('munni_dark', JSON.stringify(true));
  42 |   }, { lang: variant.lang, dark: variant.dark });
  43 |   if (extraSetup) await page.addInitScript(extraSetup);
> 44 |   await page.goto('/');
     |              ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  45 |   await page.waitForSelector('.m-logo');
  46 | }
  47 | 
  48 | // Wait for the m-fade animation (280ms) to finish before screenshotting.
  49 | export async function shot(page, name) {
  50 |   await page.waitForTimeout(350);
  51 |   await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: false });
  52 | }
  53 | 
  54 | // Close context and rename the recorded video to match the screenshot name.
  55 | export async function teardown(page, ctx, finalShotName) {
  56 |   const video = page.video();
  57 |   let videoPath;
  58 |   try { videoPath = await video?.path(); } catch {}
  59 |   try { await ctx.close(); } catch {}
  60 |   if (videoPath) {
  61 |     try {
  62 |       const dest = path.join(VIDEOS_DIR, `${finalShotName}.webm`);
  63 |       if (fs.existsSync(videoPath) && videoPath !== dest) {
  64 |         fs.renameSync(videoPath, dest);
  65 |       }
  66 |     } catch {
  67 |       // Cross-device rename can fail; fall back to saveAs copy
  68 |       try { await video?.saveAs(path.join(VIDEOS_DIR, `${finalShotName}.webm`)); } catch {}
  69 |     }
  70 |   }
  71 | }
  72 | 
```