// The hosted web and the bundle inside a shell both carry the git commit count of their build: hosted above
// bundled means an update sits on the store. The store's own build number is a timestamp — never compare it.

export interface UpdateCheckState {
  lastCheckedAt?: number;
  dismissedBuild?: number;
}

const CHECK_INTERVAL_MS = 20 * 3600 * 1000; // roughly daily, DST-proof

export function shouldCheckForUpdate(state: UpdateCheckState, now: number): boolean {
  return now - (state.lastCheckedAt ?? 0) >= CHECK_INTERVAL_MS;
}

export function updateAvailable(bundledBuild: number, remoteBuild: number, dismissedBuild?: number): boolean {
  // a bundle built without git carries 0: no count to compare, not "older than every release"
  if (!Number.isFinite(bundledBuild) || bundledBuild <= 0 || !Number.isFinite(remoteBuild)) return false;
  return remoteBuild > bundledBuild && remoteBuild !== dismissedBuild;
}

// every environment is its own app in the stores: the page is the shell's own id, and without one no page beats another app's
export function storeUrlOf(platform: string | undefined, appId: string | null): string | null {
  if (platform === 'android') return appId ? `market://details?id=${appId}` : null;
  // both iOS channels ship via TestFlight today — the deep link opens the
  // TestFlight app where the update sits. Swap the production branch to
  // https://apps.apple.com/app/id6791102793 at public App Store launch.
  if (platform === 'ios') return 'itms-beta://';
  return null;
}

/** the store page for this shell — null when there is none to link (staging iOS lives in TestFlight) */
export function nativeStoreUrl(platform: string | undefined, channel: string): string | null {
  return storeUrlOf(platform, channel === 'staging' ? 'app.munni.dev' : 'app.munni');
}
