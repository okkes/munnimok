import type { AccountLinkRow, AccountRow } from '@/db/types';

/**
 * #445: a party-fed account no live connection fetches any more. The
 * server's ingest stamps the connection that fetched a row; when that
 * connection is gone — reconnected with a consent that reaches other
 * accounts, or removed — nothing fetches the row again, and until now
 * nothing said so (prod 2026-10-04: "last synced four days ago", for a
 * reason only the relay's tables showed). A row the ingest stamped before
 * connection ids existed is read the slow way: a week without a fetch.
 */
export const UNCOVERED_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type CoverageAccount = Pick<AccountRow, 'source' | 'connectionId' | 'lastSyncedAt'>;

export type CoverageLink = Pick<AccountLinkRow, 'attachedBy'>;

/**
 * Whose feed an account sits in — the one fact that says whether this
 * device's connection ids may be read against the row at all: only the
 * owner's device holds the ids the row's stamp names. `myFeeds` is what
 * /me/feeds answered (the ownership source of truth: the feeds the viewer
 * registered; a device that syncs nothing counts every feed on it, see
 * useMyFeedIds). While that answer is out of reach (offline) the attacher's
 * name on a link is the next best word; with neither, nothing can be told
 * and the caller stays quiet. User ss 2026-10-09: a friend's ING account,
 * attached before links carried a name, read "not fetched any more —
 * reconnect" on the viewer's desktop while the friend's consent was alive
 * and syncing — a nameless link had defaulted to "mine".
 */
export function ownsFeed(
  feedSpaceId: string,
  myFeeds: ReadonlySet<string> | undefined,
  links: readonly CoverageLink[],
  mySub: string | undefined,
): boolean | undefined {
  if (myFeeds) return myFeeds.has(feedSpaceId);
  const named = links.filter((link) => link.attachedBy);
  if (named.length === 0) return undefined;
  return named.some((link) => link.attachedBy === mySub);
}

/**
 * When the account stopped being fetched: its last sync, or '' when it
 * never synced at all; null while a live connection covers it, when the
 * row is not a party's to begin with, or when it is not known to be the
 * viewer's to tell (a friend's connection is nowhere in this device's ids;
 * an unknown owner is read the same way — no banner beats a wrong one).
 */
export function uncoveredSince(
  account: CoverageAccount,
  liveConnectionIds: ReadonlySet<string>,
  owned: boolean | undefined,
  now = Date.now(),
): string | null {
  if (owned !== true || account.source !== 'connector') return null;
  if (account.connectionId) return liveConnectionIds.has(account.connectionId) ? null : (account.lastSyncedAt ?? '');
  if (account.lastSyncedAt && now - Date.parse(account.lastSyncedAt) > UNCOVERED_AFTER_MS) return account.lastSyncedAt;
  return null;
}
