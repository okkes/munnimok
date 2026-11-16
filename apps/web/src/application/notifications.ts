import type { StorageBackend } from '@/db/backend';

// device-local per-identity meta list (the txSeen pattern); clearing travels to other devices (#580, inboxClear.ts)
// the service worker imports this module: no network or window code
export type InboxKind = 'whatsnew' | 'recurringDue' | 'debtRate' | 'digest' | 'planOverspent';

export interface InboxEntry {
  id: string;
  kind: InboxKind;
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
export const WHATS_NEW_SEEN_KEY = 'whatsNewSeenVersion';

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

// a `dedupeKey` makes an event once-only (one What's-new per version, one due reminder per date)
export async function appendNotification(
  store: StorageBackend,
  kind: InboxKind,
  payload?: Record<string, string>,
  dedupeKey?: string,
): Promise<void> {
  // one step with the clear: the app and the worker both write this list, and a write between
  // the other's read and write loses the new entry or brings cleared ones back
  await store.transact(['meta'], async () => {
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
  });
}

// #614: `revise` answers an entry with itself, a corrected copy, or null to drop it;
// nothing is retired, so what stopped being true may be said again
export async function reviseInbox(store: StorageBackend, revise: (entry: InboxEntry) => InboxEntry | null): Promise<InboxEntry[]> {
  const dropped: InboxEntry[] = [];
  await store.transact(['meta'], async () => {
    const list = await readInbox(store);
    const next: InboxEntry[] = [];
    let changed = false;
    for (const entry of list) {
      const revised = revise(entry);
      if (revised === null) dropped.push(entry);
      else next.push(revised);
      changed ||= revised !== entry;
    }
    if (changed) await store.metaPut(LIST_KEY, next);
  });
  return dropped;
}

export async function unreadNotifCount(store: StorageBackend): Promise<number> {
  const seen = (await store.metaGet(SEEN_KEY))?.value as string | undefined;
  return (await readInbox(store)).filter((e) => !seen || e.ts > seen).length;
}

export async function stampNotifSeen(store: StorageBackend): Promise<void> {
  await store.metaPut(SEEN_KEY, new Date().toISOString());
}

export async function readInboxClearedAt(store: Pick<StorageBackend, 'metaGet'>): Promise<string | undefined> {
  const value = (await store.metaGet(CLEARED_KEY))?.value;
  return typeof value === 'string' ? value : undefined;
}

// #580: a clear made on another device; false when the list was already cleared that far
export async function clearInboxUpTo(store: StorageBackend, at: string): Promise<boolean> {
  let moved = false;
  await store.transact(['meta'], async () => {
    const cleared = await readInboxClearedAt(store);
    if (cleared && cleared >= at) return;
    await dropFromInbox(store, at, (e) => e.ts <= at);
    moved = true;
  });
  return moved;
}

/**
 * #580: the person's own Clear empties the list whatever the clocks say — the
 * remembered moment may come from a clock ahead of this device's; the later one stays.
 */
export async function clearInboxNow(store: StorageBackend): Promise<void> {
  await store.transact(['meta'], async () => {
    const cleared = await readInboxClearedAt(store);
    const now = new Date().toISOString();
    await dropFromInbox(store, cleared && cleared > now ? cleared : now, () => true);
  });
}

/** inside the caller's meta transaction */
async function dropFromInbox(store: StorageBackend, at: string, goes: (entry: InboxEntry) => boolean): Promise<void> {
  const list = await readInbox(store);
  const keys = list.filter(goes).flatMap((e) => (e.payload?.dedupe ? [retiredKey(e.kind, e.payload.dedupe)] : []));
  if (keys.length > 0) await store.metaPut(RETIRED_KEY, [...keys, ...(await readRetired(store))].slice(0, RETIRED_CAP));
  await store.metaPut(CLEARED_KEY, at);
  await store.metaPut(LIST_KEY, list.filter((e) => !goes(e)));
}
