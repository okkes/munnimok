import type { TraceEntry } from '../../types';

/** the browser's resource types an adapter author skips: scripts, styles, pictures, fonts, media, beacons */
const NOISE = new Set(['script', 'stylesheet', 'image', 'font', 'media', 'manifest', 'texttrack', 'ping', 'beacon', 'preflight', 'other']);

/** `mm:ss.d` from milliseconds since the recording started */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

/** a size as the eye reads it */
export function kb(size: number | null | undefined): string {
  if (size == null) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** the host of an address, or the address itself when it is not one */
export function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** the path and query of an address, so a table column stays readable */
export function pathOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** whether an entry is a browser call nobody reads: a script, a picture, a font … */
export const isNoise = (entry: Pick<TraceEntry, 'kind' | 'via' | 'resourceType'>): boolean =>
  (entry.kind === 'request' || entry.kind === 'response') && entry.via === 'browser' && !!entry.resourceType && NOISE.has(entry.resourceType);

export interface TraceFilters {
  kind: string;
  text: string;
  worthReading: boolean;
}

/** the entries the operator asked to see */
export function filterEntries(entries: readonly TraceEntry[], filters: TraceFilters): TraceEntry[] {
  const needle = filters.text.trim().toLowerCase();
  return entries.filter((e) => {
    if (filters.kind && e.kind !== filters.kind) return false;
    if (filters.worthReading && isNoise(e)) return false;
    if (!needle) return true;
    const hay = `${e.url ?? ''} ${e.text ?? ''} ${e.method ?? ''} ${e.contentType ?? ''} ${e.status ?? ''}`.toLowerCase();
    return hay.includes(needle);
  });
}

/** one line that says what an entry is */
export function entryLine(entry: TraceEntry): string {
  switch (entry.kind) {
    case 'navigation':
      return `→ ${entry.url ?? ''}`;
    case 'request':
      return `${entry.method ?? 'GET'} ${entry.url ?? ''}`;
    case 'response':
      return `${entry.status ?? '?'} ${entry.method ?? 'GET'} ${entry.url ?? ''}`;
    case 'console':
      return `[${entry.level ?? 'log'}] ${entry.text ?? ''}`;
    case 'dom':
      return `document ${entry.text ?? ''} ${entry.url ?? ''}`;
    default:
      return entry.text ?? '';
  }
}

/** a JSON body pretty-printed when it parses, as it came otherwise */
export function pretty(body: string | null | undefined): string {
  if (!body) return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
