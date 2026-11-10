import { describe, expect, it } from 'vitest';
import { nativeStoreUrl, shouldCheckForUpdate, storeUrlOf, updateAvailable } from './updateCheck';

describe('update check', () => {
  it('checks roughly daily', () => {
    const now = Date.now();
    expect(shouldCheckForUpdate({}, now)).toBe(true);
    expect(shouldCheckForUpdate({ lastCheckedAt: now - 1 * 3600_000 }, now)).toBe(false);
    expect(shouldCheckForUpdate({ lastCheckedAt: now - 21 * 3600_000 }, now)).toBe(true);
  });

  it('newer remote build means update — unless that build was dismissed', () => {
    expect(updateAvailable(600, 640)).toBe(true);
    expect(updateAvailable(640, 640)).toBe(false);
    expect(updateAvailable(650, 640)).toBe(false);
    expect(updateAvailable(600, 640, 640)).toBe(false); // dismissed
    expect(updateAvailable(600, 650, 640)).toBe(true); // NEXT release nudges again
    expect(updateAvailable(Number.NaN, 640)).toBe(false);
    expect(updateAvailable(0, 640)).toBe(false); // a bundle built without git carries 0 — no count to compare, not "older than everything"
  });

  it('links the right store per platform and channel', () => {
    expect(nativeStoreUrl('android', 'production')).toBe('market://details?id=app.munni');
    expect(nativeStoreUrl('android', 'staging')).toBe('market://details?id=app.munni.dev');
    expect(nativeStoreUrl('ios', 'production')).toBe('itms-beta://'); // TestFlight until the App Store launch
    expect(nativeStoreUrl('ios', 'staging')).toBe('itms-beta://'); // TestFlight has no store page
    expect(nativeStoreUrl(undefined, 'production')).toBeNull();
  });

  it('the store page is the shell’s own app — every environment has its own store identity', () => {
    expect(storeUrlOf('android', 'app.munni.nas.prod')).toBe('market://details?id=app.munni.nas.prod');
    expect(storeUrlOf('android', 'app.munni.nas.dev')).toBe('market://details?id=app.munni.nas.dev');
    expect(storeUrlOf('android', null)).toBeNull(); // no page beats another app’s page
    expect(storeUrlOf('ios', 'app.munni.nas.prod')).toBe('itms-beta://'); // TestFlight opens on its own list of apps
    expect(storeUrlOf('ios', null)).toBe('itms-beta://');
    expect(storeUrlOf(undefined, 'app.munni.nas.prod')).toBeNull();
  });
});
