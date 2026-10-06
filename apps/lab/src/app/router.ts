import { useEffect, useState } from 'react';

/**
 * A hash router in forty lines: the lab's screens live behind `#/…`, so
 * a reload, a bookmark and the browser's back button all work without
 * a server rewrite (the same shape the member app uses). `segments` is
 * the path split on `/`, decoded; `[]` is the dashboard.
 */
export type Segments = readonly string[];

export function parseHash(hash: string): Segments {
  const path = hash.replace(/^#/, '').replace(/^\/+/, '').split('?')[0];
  if (!path) return [];
  return path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s));
}

/** the query after the path (`#/jobs?provider=ah`): a narrowed list is a link */
export function parseHashQuery(hash: string): URLSearchParams {
  const at = hash.indexOf('?');
  return new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
}

export const hrefOf = (to: string): string => `#/${to.replace(/^\/+/, '')}`;

export function navigate(to: string): void {
  globalThis.location.hash = hrefOf(to);
}

/** the current hash query, following every hash change (a new object per change, so effects re-run) */
export function useRouteQuery(): URLSearchParams {
  const [query, setQuery] = useState(() => parseHashQuery(globalThis.location.hash));
  useEffect(() => {
    const onChange = () => setQuery(parseHashQuery(globalThis.location.hash));
    globalThis.addEventListener('hashchange', onChange);
    return () => globalThis.removeEventListener('hashchange', onChange);
  }, []);
  return query;
}

/** the current segments, following every hash change */
export function useRoute(): Segments {
  const [segments, setSegments] = useState<Segments>(() => parseHash(globalThis.location.hash));
  useEffect(() => {
    const onChange = () => setSegments(parseHash(globalThis.location.hash));
    globalThis.addEventListener('hashchange', onChange);
    return () => globalThis.removeEventListener('hashchange', onChange);
  }, []);
  return segments;
}
