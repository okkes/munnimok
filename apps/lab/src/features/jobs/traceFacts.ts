import type { TraceEntry } from '../../types';

const NOISE = new Set(['script', 'stylesheet', 'image', 'font', 'media', 'manifest', 'texttrack', 'ping', 'beacon', 'preflight', 'other']);

export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

export function kb(size: number | null | undefined): string {
  if (size == null) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function pathOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

export const isNoise = (entry: Pick<TraceEntry, 'kind' | 'via' | 'resourceType'>): boolean =>
  (entry.kind === 'request' || entry.kind === 'response') && entry.via === 'browser' && !!entry.resourceType && NOISE.has(entry.resourceType);

export interface TraceFilters {
  kind: string;
  text: string;
  worthReading: boolean;
}

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

export function pretty(body: string | null | undefined): string {
  if (!body) return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
