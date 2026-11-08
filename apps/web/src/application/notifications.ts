import type { StorageBackend } from '@/db/backend';

/**
 * The in-app notification inbox (arc 6): a device-local, per-identity
 * meta list — the `txSeen` pattern. OS push/SW notifications keep firing
 * as before; this is the in-app record that works identically offline and
 * online. Clearing it travels to the person's other devices (#580,
 * application/inboxClear.ts). The service worker imports this module, so
 * it stays free of network and window code.
 */
export type InboxKind = 'whatsnew' | 'recurringDue' | 'debtRate' | 'digest' | 'planOverspent';

export interface InboxEntry {
  id: string;
  kind: InboxKind;
  /** ISO timestamp — newer than `notifSeenAt` counts as unread */
  ts: string;
  /** per-kind display bits (name, date, version, n), the space it is about (#551) and the dedupe key */
  payload?: Record<string, string>;
}

const LIST_KEY = 'notifInbox';
const SEEN_KEY = 'notifSeenAt';
const CLEARED_KEY = 'notifClearedAt';
/** the once-only events a clear took away — never appended again (What's new would return on the next open) */
const RETIRED_KEY = 'notifRetiredKeys';
const CAP = 50;
const RETIRED_CAP = 200;

const retiredKey = (kind: InboxKind, dedupeKey: string) => `${kind}:${dedupeKey}`;

async function readRetired(store: Pick<StorageBackend, 'metaGet'>): Promise<string[]> {
  const value = (await store.metaGet(RETIRED_KEY))?.value;
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [];
}

/** #551: an OS notification about one space carries its name as the title — 'munni' when there is none */
export async function notificationTitle(store: Pick<StorageBackend, 'get'>, spaceId: string | undefined): Promise<string> {
  const space = spaceId ? await store.get('space', spaceId) : undefined;
  const name = space?.deleted === 0 ? space.name.trim() : '';
  return name || 'munni';
}

export async function readInbox(store: StorageBackend): Promise<InboxEntry[]> {
  return ((await store.metaGet(LIST_KEY))?.value as InboxEntry[] | undefined) ?? [];
}

/**
 * Prepend one entry, newest first, capped. A `dedupeKey` makes the event
 * once-only (one What's-new per version, one due reminder per date) —
 * matching entries already in the list are left alone.
 */
export async function appendNotification(
  store: StorageBackend,
  kind: InboxKind,
  payload?: Record<string, string>,
  dedupeKey?: string,
): Promise<void> {
  const list = await readInbox(store);
  if (dedupeKey && list.some((e) => e.kind === kind && e.payload?.dedupe === dedupeKey)) return;
  if (dedupeKey && (await readRetired(store)).includes(retiredKey(kind, dedupeKey))) return;
  const entry: InboxEntry = {
    id: crypto.randomUUID(),
    kind,
    ts: new Date().toISOString(),
    payload: { ...payload, ...(dedupeKey ? { dedupe: dedupeKey } : {}) },
  };
  await store.metaPut(LIST_KEY, [entry, ...list].slice(0, CAP));
}

/** unread = entries newer than the last time the tab was opened */
export async function unreadNotifCount(store: StorageBackend): Promise<number> {
  const seen = (await store.metaGet(SEEN_KEY))?.value as string | undefined;
  return (await readInbox(store)).filter((e) => !seen || e.ts > seen).length;
}

/** opening the Notifications tab marks everything seen (v1: no per-row state) */
export async function stampNotifSeen(store: StorageBackend): Promise<void> {
  await store.metaPut(SEEN_KEY, new Date().toISOString());
}

/** #580: the moment up to which this device's list was cleared (ISO, UTC), if ever */
export async function readInboxClearedAt(store: Pick<StorageBackend, 'metaGet'>): Promise<string | undefined> {
  const value = (await store.metaGet(CLEARED_KEY))?.value;
  return typeof value === 'string' ? value : undefined;
}

/**
 * #580: drops every entry up to `at` (ISO, UTC) and remembers the moment;
 * false when the list was already cleared that far. A clear made here
 * passes now; one made on another device passes its own moment.
 */
export async function clearInboxUpTo(store: StorageBackend, at: string): Promise<boolean> {
  const cleared = await readInboxClearedAt(store);
  if (cleared && cleared >= at) return false;
  const list = await readInbox(store);
  const dropped = list.filter((e) => e.ts <= at);
  const keys = dropped.flatMap((e) => (e.payload?.dedupe ? [retiredKey(e.kind, e.payload.dedupe)] : []));
  if (keys.length > 0) await store.metaPut(RETIRED_KEY, [...keys, ...(await readRetired(store))].slice(0, RETIRED_CAP));
  await store.metaPut(CLEARED_KEY, at);
  await store.metaPut(LIST_KEY, list.filter((e) => e.ts > at));
  return true;
}
