/** a moment as the operator's locale writes it, or a dash */
export const when = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : '—');

/** "3 min ago" / "2 h ago" / "4 d ago" — a glance at freshness, with the exact moment on hover */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 60_000) return 'just now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** the first dozen characters of an id — enough to recognise, short enough to read */
export const shortId = (id: string, n = 12): string => (id.length > n ? `${id.slice(0, n)}…` : id);

/** "60 min" / "1 h 30 min" / "2 d" */
export function minutes(total: number): string {
  if (total < 60) return `${total} min`;
  if (total % 1440 === 0) return `${total / 1440} d`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** the tier a runtime names (docs/connectors/architecture.md) */
export const TIER: Record<string, string> = {
  http: 'T1 · http',
  browser_once: 'T2 · browser once',
  browser_interactive: 'T3 · browser interactive',
  browser_persistent: 'T4 · browser persistent',
};
export const tierOf = (runtime: string | undefined): string => (runtime ? (TIER[runtime] ?? runtime) : '—');

/** the relay renders every key camelCase; an error code or a session state reads back as the wire spells it */
export const snake = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
