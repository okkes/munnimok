import type { NavFeatureId } from './navFeatures';

// No imports beyond the type: the identity wipes (app/data, the offline profile registry) call in here, and the registry is loaded by the session itself.
const CACHE_KEY = 'munni_nav_tabs';

/** per identity, per space: the bar this device drew last */
type NavCache = Record<string, Record<string, string[]>>;

function readCache(): NavCache {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as NavCache) : {};
  } catch {
    return {};
  }
}

export function cachedNavTabs(who: string, spaceId: string): unknown {
  return readCache()[who]?.[spaceId];
}

export function rememberNavTabs(who: string, spaceId: string, tabs: readonly NavFeatureId[]): void {
  try {
    const cache = readCache();
    if (cache[who]?.[spaceId]?.join() === tabs.join()) return;
    cache[who] = { ...cache[who], [spaceId]: [...tabs] };
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // a full or blocked storage only costs the first frame after a cold start
  }
}

/** an identity wiped from this device leaves nothing behind — its space ids and their bars included */
export function forgetNavCache(who: string): void {
  try {
    const cache = readCache();
    if (!(who in cache)) return;
    delete cache[who];
    if (Object.keys(cache).length === 0) localStorage.removeItem(CACHE_KEY);
    else localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // storage may be unavailable mid-wipe; a stale entry only costs a first frame
  }
}
