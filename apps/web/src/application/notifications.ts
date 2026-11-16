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

/** #614: the bell shows two parts of the list — what is about no space, and what is about the open one */
export const GENERAL_SCOPE = 'general';
export const scopeOf = (entry: InboxEntry): string => entry.payload?.spaceId || GENERAL_SCOPE;

const LIST_KEY = 'notifInbox';
/** read only: the one moment of before #614, the fallback for a part that has no moment of its own yet */
const SEEN_KEY = 'notifSeenAt';
const SEEN_BY_KEY = 'notifSeenBy';
const CLEARED_KEY = 'notifClearedAt';
const CLEARED_BY_KEY = 'notifClearedBy';
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

/** a meta value that maps a part of the list to a moment */
async function readMoments(store: Pick<StorageBackend, 'metaGet'>, key: string): Promise<Record<string, string>> {
  const value = (await store.metaGet(key))?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
}

/** the rows of these parts that arrived after the part was last looked at */
export async function unreadNotifCount(store: StorageBackend, scopes: readonly string[]): Promise<number> {
  const before = (await store.metaGet(SEEN_KEY))?.value as string | undefined;
  const seenBy = await readMoments(store, SEEN_BY_KEY);
  return (await readInbox(store)).filter((e) => {
    const scope = scopeOf(e);
    if (!scopes.includes(scope)) return false;
    const seen = seenBy[scope] ?? before;
    return !seen || e.ts > seen;
  }).length;
}

// per part: one moment for the whole list would mark another space's rows as read before the bell ever showed them
export async function stampNotifSeen(store: StorageBackend, scopes: readonly string[]): Promise<void> {
  const now = new Date().toISOString();
  await store.transact(['meta'], async () => {
    const seenBy = await readMoments(store, SEEN_BY_KEY);
    for (const scope of scopes) seenBy[scope] = now;
    await store.metaPut(SEEN_BY_KEY, seenBy);
  });
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

export const readClearedBy = (store: Pick<StorageBackend, 'metaGet'>): Promise<Record<string, string>> => readMoments(store, CLEARED_BY_KEY);

/**
 * #614: the person's own Clear takes what the bell showed — these parts, whatever the clocks say (#580: a remembered
 * moment may come from a clock ahead of this device's; the later one stays). Answers the rows that went.
 */
export async function clearScopesNow(store: StorageBackend, scopes: readonly string[]): Promise<InboxEntry[]> {
  let dropped: InboxEntry[] = [];
  await store.transact(['meta'], async () => {
    const clearedBy = await readClearedBy(store);
    const now = new Date().toISOString();
    for (const scope of scopes) clearedBy[scope] = clearedBy[scope] && clearedBy[scope] > now ? clearedBy[scope] : now;
    await store.metaPut(CLEARED_BY_KEY, clearedBy);
    dropped = await removeEntries(store, (e) => scopes.includes(scopeOf(e)));
  });
  return dropped;
}

/** #614: a clear of one part made on another device; nothing when the part was already cleared that far */
export async function clearScopeUpTo(store: StorageBackend, scope: string, at: string): Promise<InboxEntry[] | null> {
  let dropped: InboxEntry[] | null = null;
  await store.transact(['meta'], async () => {
    const clearedBy = await readClearedBy(store);
    if (clearedBy[scope] && clearedBy[scope] >= at) return;
    await store.metaPut(CLEARED_BY_KEY, { ...clearedBy, [scope]: at });
    dropped = await removeEntries(store, (e) => scopeOf(e) === scope && e.ts <= at);
  });
  return dropped;
}

/** inside the caller's meta transaction */
async function dropFromInbox(store: StorageBackend, at: string, goes: (entry: InboxEntry) => boolean): Promise<void> {
  await store.metaPut(CLEARED_KEY, at);
  await removeEntries(store, goes);
}

/** inside the caller's meta transaction; a once-only event that was cleared is never appended again */
async function removeEntries(store: StorageBackend, goes: (entry: InboxEntry) => boolean): Promise<InboxEntry[]> {
  const list = await readInbox(store);
  const gone = list.filter(goes);
  if (gone.length === 0) return [];
  const keys = gone.flatMap((e) => (e.payload?.dedupe ? [retiredKey(e.kind, e.payload.dedupe)] : []));
  if (keys.length > 0) await store.metaPut(RETIRED_KEY, [...keys, ...(await readRetired(store))].slice(0, RETIRED_CAP));
  await store.metaPut(LIST_KEY, list.filter((e) => !goes(e)));
  return gone;
}
