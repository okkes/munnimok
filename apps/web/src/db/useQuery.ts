import { useEffect, useRef, useState } from 'react';
import type { StorageBackend } from './backend';

// #361: last-emitted values by cacheKey: a remount renders them at once instead of flashing loading;
// keys must carry the space id so a space switch never shows another space's rows
const LAST_VALUES = new Map<string, unknown>();

// #363: the cache belongs to ONE identity: cleared on every sign-in/out and wipe,
// and between test specs (fresh databases, same space id)
export function clearQueryCache(): void {
  LAST_VALUES.clear();
}

interface Listener {
  onNext: (value: unknown) => void;
  onError: (error: unknown) => void;
}

interface SharedQuery {
  listeners: Set<Listener>;
  unsubscribe: () => void;
  /** the last answer, for a hook that joins after the query already ran */
  last?: { value: unknown };
}

// hooks that name a cacheKey SHARE one live query per backend and key (one write re-ran the review's join five times);
// the key must determine the query, space id included
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

// undefined while loading; errors rethrow into the render so boundaries see them (as useLiveQuery);
// cacheKey opts into the remount cache and the shared query
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
