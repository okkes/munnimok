import { useEffect, useRef, useState } from 'react';
import type { StorageBackend } from './backend';

/** #361: last-emitted values by explicit cacheKey — a REMOUNT renders
 * the previous data instantly instead of flashing the loading state
 * while the subscription warms (every home-tab return re-created the
 * hooks from scratch). Session-scoped; keys must carry the space id so
 * a space switch never shows another space's rows. */
const LAST_VALUES = new Map<string, unknown>();

/** #363: the cache belongs to ONE identity — the data provider clears it
 *  on every sign-in/out and wipe, so a new account never renders the last
 *  user's rows; the test harness clears it between specs (fresh databases
 *  under the same space id) */
export function clearQueryCache(): void {
  LAST_VALUES.clear();
}

interface Listener {
  onNext: (value: unknown) => void;
  onError: (error: unknown) => void;
}

/** one live query serving every hook that asked for the same key */
interface SharedQuery {
  listeners: Set<Listener>;
  unsubscribe: () => void;
  /** the last answer, for a hook that joins after the query already ran */
  last?: { value: unknown };
}

/**
 * 2026-10-09 (user: Confirm stalled 3–4 s on the review): the review alone
 * mounted FIVE hooks over the space's transactions — the deck, the part
 * cards, the bulk sheet — and every one of them was its own live query, so
 * one write re-ran the whole join five times (measured: 83 joins for one
 * bulk confirm). Hooks that name a cacheKey now SHARE one live query per
 * backend and key: the first hook opens it, later ones join (and read the
 * last answer at once), the last one leaving closes it. The key is the
 * contract — it must determine the query (space id included), exactly as
 * the remount cache above already demands.
 */
const SHARED = new WeakMap<StorageBackend, Map<string, SharedQuery>>();

function joinShared(
  backend: StorageBackend,
  key: string,
  query: () => Promise<unknown>,
  listener: Listener,
): () => void {
  let registry = SHARED.get(backend);
  if (!registry) {
    registry = new Map();
    SHARED.set(backend, registry);
  }
  let shared = registry.get(key);
  if (shared) {
    shared.listeners.add(listener);
    if (shared.last) listener.onNext(shared.last.value);
  } else {
    const created: SharedQuery = { listeners: new Set([listener]), unsubscribe: () => undefined };
    registry.set(key, created);
    shared = created;
    created.unsubscribe = backend.subscribe(
      query,
      (value) => {
        created.last = { value };
        for (const l of created.listeners) l.onNext(value);
      },
      (error) => {
        for (const l of created.listeners) l.onError(error);
      },
    );
  }
  const joined = shared;
  return () => {
    joined.listeners.delete(listener);
    if (joined.listeners.size > 0) return;
    joined.unsubscribe();
    if (registry.get(key) === joined) registry.delete(key);
  };
}

/**
 * Live query over the storage seam (replaces dexie-react-hooks'
 * useLiveQuery on the way to E2): undefined while loading, then the
 * result, re-emitted on every relevant data change. Errors rethrow into
 * the render so boundaries see them — same contract as useLiveQuery.
 * An optional `cacheKey` opts into the remount cache above and into the
 * shared subscription (one live query per key).
 */
export function useQuery<T>(backend: StorageBackend, query: () => Promise<T>, deps: unknown[]): T | undefined;
export function useQuery<T, I>(
  backend: StorageBackend,
  query: () => Promise<T>,
  deps: unknown[],
  initial: I,
  cacheKey?: string,
): T | I;
export function useQuery<T, I>(
  backend: StorageBackend,
  query: () => Promise<T>,
  deps: unknown[],
  initial?: I,
  cacheKey?: string,
): T | I | undefined {
  const seed = (key: string | undefined): { value?: T | I } =>
    key !== undefined && LAST_VALUES.has(key) ? { value: LAST_VALUES.get(key) as T } : { value: initial };
  const [state, setState] = useState<{ value?: T | I; error?: unknown }>(() => seed(cacheKey));
  // a CHANGED key resets synchronously (render-time reset pattern) — the
  // old key's rows must not survive even one frame under the new key
  const keyRef = useRef(cacheKey);
  if (keyRef.current !== cacheKey) {
    keyRef.current = cacheKey;
    setState(seed(cacheKey));
  }
  useEffect(
    () => {
      const onNext = (value: unknown) => {
        if (cacheKey !== undefined) LAST_VALUES.set(cacheKey, value);
        setState({ value: value as T });
      };
      const onError = (error: unknown) => setState({ error });
      return cacheKey === undefined
        ? backend.subscribe(query, onNext, onError)
        : joinShared(backend, cacheKey, query, { onNext, onError });
    },
    // the query closure is rebuilt every render — deps decide re-subscription
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backend, ...deps],
  );
  if (state.error !== undefined) throw state.error;
  return state.value;
}
