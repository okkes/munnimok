import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useData } from '@/app/data';
import { identityKey, useSession } from '@/app/session';
import { logActivity } from '@/application/activity';
import { useQuery } from '@/db/useQuery';
import { MAX_NAV_PICKS, navUsableFor, resolveNavTabs, storedNavTabs } from './navFeatures';
import type { NavFeatureId } from './navFeatures';

const CACHE_KEY = 'munni_nav_tabs';

/** Tailwind's md — where AppLayout swaps the bottom bar for the side panel */
const SIDE_NAV_QUERY = '(min-width: 48rem)';
const subscribeSideNav = (listener: () => void) => {
  const mql = globalThis.matchMedia?.(SIDE_NAV_QUERY);
  mql?.addEventListener?.('change', listener);
  return () => mql?.removeEventListener?.('change', listener);
};
const readSideNav = () => globalThis.matchMedia?.(SIDE_NAV_QUERY)?.matches ?? false;

/** true where the side panel lists every feature instead of the bottom bar */
export const useSideNavShown = (): boolean => useSyncExternalStore(subscribeSideNav, readSideNav, () => false);

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

function writeCache(who: string, spaceId: string, tabs: readonly NavFeatureId[]): void {
  try {
    const cache = readCache();
    if (cache[who]?.[spaceId]?.join() === tabs.join()) return;
    cache[who] = { ...cache[who], [spaceId]: [...tabs] };
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // a full or blocked storage only costs the first frame after a cold start
  }
}

/**
 * The active space's bar after Home. Until the space row has loaded, the
 * bar this device drew for the space last (a cold start would otherwise
 * flash the default bar), else the default one.
 */
export function useNavTabs(): NavFeatureId[] {
  const { store, spaceId } = useData();
  const identity = useSession((s) => s.identity);
  const usable = useMemo(() => navUsableFor(identity?.kind), [identity?.kind]);
  const who = identity ? identityKey(identity) : '';
  // null = no row: the default bar
  const row = useQuery(store, async () => (await store.get('space', spaceId)) ?? null, [spaceId], undefined, `nav:${spaceId}`);
  const resolved = useMemo(() => (row === undefined ? undefined : resolveNavTabs(row?.navTabs, usable)), [row, usable]);
  useEffect(() => {
    if (resolved && who) writeCache(who, spaceId, resolved);
  }, [resolved, who, spaceId]);
  return resolved ?? resolveNavTabs(readCache()[who]?.[spaceId], usable);
}

export interface NavOps {
  add: (id: NavFeatureId) => Promise<void>;
  remove: (id: NavFeatureId) => Promise<void>;
  /** the feature by id — a render that lags the store cannot move the wrong one */
  move: (id: NavFeatureId, to: number) => Promise<void>;
  /** back to the default bar (the field cleared, so later defaults reach it too) */
  reset: () => Promise<void>;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * The bar's edits: one LWW write of the whole list on the space row (like
 * homeBlocks) and a line in the space's history. Every op reads the row
 * FRESH — two quick taps against the render's copy lost the first one
 * (the balance band's lesson).
 */
export function useNavOps(spaceId: string, readOnly: boolean): NavOps {
  const { store, repo } = useData();
  const identity = useSession((s) => s.identity);
  const usable = navUsableFor(identity?.kind);

  const edit = async (change: (current: NavFeatureId[]) => NavFeatureId[] | null): Promise<void> => {
    if (readOnly) return;
    const live = await store.get('space', spaceId);
    if (!live) return;
    const current = resolveNavTabs(live.navTabs, usable);
    const next = change(current);
    if (next === null ? live.navTabs == null : sameList(next, current)) return;
    // null, not undefined: JSON drops an undefined field on its way to the server
    await repo.upsert('space', spaceId, spaceId, { navTabs: next === null ? null : storedNavTabs(live.navTabs, next, usable) });
    void logActivity(store, repo, spaceId, 'navEdit');
  };

  return {
    add: (id) =>
      edit((current) => {
        if (current.includes(id) || current.length >= MAX_NAV_PICKS || !usable(id)) return current;
        // Settings closes the bar by convention: while it is last, a new pick lands before it
        const at = current.at(-1) === 'settings' ? current.length - 1 : current.length;
        return [...current.slice(0, at), id, ...current.slice(at)];
      }),
    remove: (id) => edit((current) => current.filter((entry) => entry !== id)),
    move: (id, to) =>
      edit((current) => {
        if (!current.includes(id)) return current;
        const next = current.filter((entry) => entry !== id);
        next.splice(Math.min(Math.max(0, to), next.length), 0, id);
        return next;
      }),
    reset: () => edit(() => null),
  };
}
