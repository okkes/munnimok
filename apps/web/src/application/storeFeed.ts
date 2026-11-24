import { apiFetch } from '@/lib/api';
import { readSessionIdentity } from '@/app/session';
import { receiptFeedId, receiptFeedRef, scansFeedId, SCANS_FEED_REF, storeConnLinkId, storeFeedId } from '@/domain/feedIds';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';

// the owner's personal feeds: one that lists their connections, one per connection for its receipts, one for their own
// scans (#648) — each a server-registered sync space; feed-shaped ids must be registered before the first push (S1 guard)
const REGISTERED_KEY = 'storeFeedRegistered';
const registeredKey = (feedId: string): string => `feedRegistered:${feedId}`;

/** the demo's feeds live only on the device — the demo seed writes them */
export const DEMO_STORE_FEED_ID = 'demo_store_feed';
export const DEMO_SCANS_FEED_ID = 'demo_scans_feed';
export const demoReceiptFeedId = (connectionId: string): string => `demo_store_feed:${connectionId}`;

export function myStoreFeedId(): string | null {
  const identity = readSessionIdentity();
  if (identity?.kind === 'user') return storeFeedId(identity.sub);
  return identity?.kind === 'demo' ? DEMO_STORE_FEED_ID : null;
}

/** where one of my connections keeps its receipts; null for an identity that has no connections */
export function myReceiptFeedId(connectionId: string): string | null {
  const identity = readSessionIdentity();
  if (identity?.kind === 'user') return receiptFeedId(connectionId, identity.sub);
  return identity?.kind === 'demo' ? demoReceiptFeedId(connectionId) : null;
}

/** where my own scans live */
export function myScansFeedId(): string | null {
  const identity = readSessionIdentity();
  if (identity?.kind === 'user') return scansFeedId(identity.sub);
  return identity?.kind === 'demo' ? DEMO_SCANS_FEED_ID : null;
}

const neverSyncs = (): boolean => readSessionIdentity()?.kind !== 'user';

/** the party a space's row names for a person's own scans */
export const SCANS_STORE = 'photo';

/** the feeds that hold this identity's own receipts: its scans, and one per connection it made */
export async function myReceiptFeeds(store: StorageBackend): Promise<string[]> {
  const scans = myScansFeedId();
  const feeds = scans ? [scans] : [];
  for (const connection of await store.allRows('storeConn')) {
    const feedId = connection.deleted === 0 ? myReceiptFeedId(connection.id) : null;
    if (feedId) feeds.push(feedId);
  }
  return feeds;
}

/** an identity that never syncs has no server to say which spaces read its scans: they all do, as they always did */
export async function shareScansLocally(store: StorageBackend, repo: Repo): Promise<void> {
  const feedId = myScansFeedId();
  if (!neverSyncs() || !feedId || (await store.countBySpace('receipt', feedId)) === 0) return;
  const held = new Set((await store.allRows('storeConnLink')).filter((l) => l.deleted === 0 && l.feedSpaceId === feedId).map((l) => l.spaceId));
  for (const space of await store.allRows('space')) {
    if (space.deleted !== 0 || held.has(space.id)) continue;
    await repo.upsert('storeConnLink', space.id, storeConnLinkId(space.id, feedId), { instanceId: feedId, store: SCANS_STORE, displayName: '', feedSpaceId: feedId });
  }
}

/** register once per feed and identity; safe to call before every push; false while it cannot be reached */
async function ensureFeed(store: StorageBackend, feedId: string, accountRef: string, key: string): Promise<boolean> {
  if (neverSyncs()) return true; // nothing to register: the demo never syncs
  if ((await store.metaGet(key))?.value === feedId) return true;
  const res = await apiFetch('/feeds', {
    method: 'POST',
    body: JSON.stringify({ feedSpaceId: feedId, accountRef }),
  }).catch(() => null);
  if (!res?.ok) return false; // offline — retry on the next sync pass
  await store.metaPut(key, feedId);
  return true;
}

export async function ensureStoreFeed(store: StorageBackend): Promise<string | null> {
  const feedId = myStoreFeedId();
  return feedId && (await ensureFeed(store, feedId, 'STORES', REGISTERED_KEY)) ? feedId : null;
}

export async function ensureReceiptFeed(store: StorageBackend, connectionId: string): Promise<string | null> {
  const feedId = myReceiptFeedId(connectionId);
  return feedId && (await ensureFeed(store, feedId, receiptFeedRef(connectionId), registeredKey(feedId))) ? feedId : null;
}

export async function ensureScansFeed(store: StorageBackend): Promise<string | null> {
  const feedId = myScansFeedId();
  return feedId && (await ensureFeed(store, feedId, SCANS_FEED_REF, registeredKey(feedId))) ? feedId : null;
}

/** #648: the server lets a space's members read a feed of mine (server first: the grant is what makes it readable);
 *  an identity that never syncs shares nothing — its spaces are its own */
export async function shareFeed(spaceId: string, feedSpaceId: string): Promise<void> {
  if (neverSyncs()) return;
  const res = await apiFetch(`/spaces/${spaceId}/stores`, { method: 'POST', body: JSON.stringify({ feedSpaceId }) });
  if (!res.ok) throw new Error(`sharing the feed failed (${res.status})`);
}

/** the space stops reading the feed; the server removes the space's row for it and its links to the feed's receipts */
export async function unshareFeed(spaceId: string, feedSpaceId: string): Promise<void> {
  if (neverSyncs()) return;
  const res = await apiFetch(`/spaces/${spaceId}/stores/${feedSpaceId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`unsharing the feed failed (${res.status})`);
}

/** the feed and everything in it, gone from the server (its spaces follow through the oplog) */
export async function deleteFeed(feedSpaceId: string): Promise<void> {
  if (neverSyncs()) return;
  const res = await apiFetch(`/me/feeds/${feedSpaceId}`, { method: 'DELETE' }, { expectStatuses: [404] });
  if (!res.ok && res.status !== 404) throw new Error(`deleting the feed failed (${res.status})`);
}
