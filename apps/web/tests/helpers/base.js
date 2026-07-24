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
// Single default variant: EN, light, mobile.
// Dark / TR / desktop are evaluated manually when explicitly requested.
export const VARIANTS = [
  { id: 'en-light-mobile', lang: 'en', dark: false, vp: { width: 393, height: 852 }, dpr: 2 },
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

// Inject language + theme into localStorage before page load, then navigate.
// opts.demo: pre-authenticated demo session (skips the login screen).
// opts.userSub: pre-authenticated syncing user via test auth (needs the
//               docker-compose.test.yml API on localhost:8180).
export async function base(page, variant, opts = {}) {
  await page.addInitScript((v) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('munni_lang', v.lang);
    localStorage.setItem('munni_theme', v.dark ? 'dark' : 'light');
    if (v.demo) localStorage.setItem('munni_session', JSON.stringify({ kind: 'demo' }));
    if (v.demo) indexedDB.deleteDatabase('munni_demo'); // pristine seed every run
    if (v.userSub) {
      localStorage.setItem('munni_session', JSON.stringify({ kind: 'user', sub: v.userSub, testAuth: true }));
    }
  }, { lang: variant.lang, dark: variant.dark, demo: !!opts.demo, userSub: opts.userSub ?? null });
  if (opts.extraSetup) await page.addInitScript(opts.extraSetup);
  await page.goto('/');
  const authed = opts.demo || opts.userSub;
  // brand-new accounts land on the NON-skippable onboarding (tab bar
  // hidden there) — complete it so specs start on a normal home. Specs
  // that test onboarding itself pass keepOnboarding: true.
  if (opts.userSub && !opts.keepOnboarding) await completeOnboardingIfShown(page);
  await page.waitForSelector(authed ? '[data-testid="tab-home"]' : '[data-testid="screen-login"]');
}

async function completeOnboardingIfShown(page) {
  // a brand-new user's FIRST paint can exceed a short fixed wait on a
  // cold CI stack — the old 3s timeout then declared "no onboarding"
  // and the spec waited forever for a tab bar onboarding keeps hidden.
  // Race the two possible outcomes instead of guessing.
  const onboarding = page.locator('[data-testid="screen-onboarding"]');
  const home = page.locator('[data-testid="tab-home"]');
  const winner = await Promise.race([
    onboarding.waitFor({ timeout: 30000 }).then(() => 'onboarding').catch(() => null),
    home.waitFor({ state: 'visible', timeout: 30000 }).then(() => 'home').catch(() => null),
  ]);
  if (winner !== 'onboarding') return; // returning user — no onboarding
  await page.fill('[data-testid="onboarding-name"]', 'E2E User');
  await page.click('[data-testid="onboarding-save"]');
  await page.click('[data-testid="onboarding-lock-later"]');
  await page.waitForSelector('[data-testid="screen-home"]');
}

// App-wide rows live behind the single "Global settings" door on the
// Settings tab (scope split): canonical route to that screen for tests.
export async function gotoGlobalSettings(page) {
  await page.click('[data-testid="tab-settings"]');
  await page.click('[data-testid="settings-global-row"]');
  await page.waitForSelector('[data-testid="screen-settings-global"]');
}

// Spaces left the tab bar (the Home avatar switches, Settings manages):
// canonical route to the Spaces screen for tests.
export async function gotoSpaces(page) {
  await gotoGlobalSettings(page);
  await page.click('[data-testid="settings-spaces-row"]');
  await page.waitForSelector('[data-testid="screen-spaces"]');
}

// True when the docker-compose.test.yml API (header test-auth) is reachable.
export async function syncApiUp() {
  try {
    const res = await fetch('http://localhost:8181/health', { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const body = await res.json();
    return body.capabilities?.testAuth === true;
  } catch {
    return false;
  }
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
