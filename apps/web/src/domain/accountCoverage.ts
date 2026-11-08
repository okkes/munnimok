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

export type CoverageAccount = Pick<AccountRow, 'source' | 'connectionId' | 'lastSyncedAt'> & Partial<Pick<AccountRow, 'id'>>;

/** #524: the viewer's connections that fetch each account, by account id, as the relay keeps them per person */
export type ReachedBy = ReadonlyMap<string, readonly string[]>;

/**
 * #524: the connections that fetch an account for the viewer — the relay's
 * per-person record where it has one, else the row's own stamp. The stamp
 * alone misleads twice: it names whoever fetched the row last (an IBAN feed
 * two people connected flips between them), and every connection of the
 * same party used to claim every account the party fed (user ss 2026-10-21:
 * the ING and ASN accounts listed under the PayPal connection).
 */
export function fetchingConnectionIds(account: CoverageAccount, reachedBy: ReachedBy | undefined): readonly string[] {
  const listed = account.id ? reachedBy?.get(account.id) : undefined;
  if (listed && listed.length > 0) return listed;
  return account.connectionId ? [account.connectionId] : [];
}

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
  reachedBy?: ReachedBy,
): string | null {
  if (owned !== true || account.source !== 'connector') return null;
  const fetching = fetchingConnectionIds(account, reachedBy);
  if (fetching.length > 0) return fetching.some((id) => liveConnectionIds.has(id)) ? null : (account.lastSyncedAt ?? '');
  if (account.lastSyncedAt && now - Date.parse(account.lastSyncedAt) > UNCOVERED_AFTER_MS) return account.lastSyncedAt;
  return null;
}

/** what one live connection says about renewing it (#528) */
export interface ConnectionRenewal {
  /** the party syncs by itself (open banking, an always-on agent): a lost session there is the person's to renew */
  unattended: boolean;
  /** only a new sign-in or consent revives the session */
  ended: boolean;
}

/** #528: why an account asks for its connection again */
export type ReconnectNeed =
  /** no live connection of the viewer's fetches it any more — since its last sync ('' = never synced) */
  | { kind: 'gone'; since: string }
  /** the connection that syncs it by itself lost its session */
  | { kind: 'signin'; connectionId: string };

/**
 * #528: an account asks for a reconnect only when it truly needs one —
 * never because its data is a few days old (user 2026-10-21: an open-banking
 * consent lasts half a year, yet "Reconnect?" showed after two quiet days):
 * when no live connection of the viewer's fetches it, or when every one
 * that does lost its session and one of them is a party that syncs by
 * itself. A party that needs the person for every sync (ING's app approval,
 * a shop's second step) is synced from Home's quick sync, not reconnected.
 */
export function reconnectNeedOf(
  account: CoverageAccount,
  owned: boolean | undefined,
  live: ReadonlyMap<string, ConnectionRenewal>,
  reachedBy: ReachedBy | undefined,
  now = Date.now(),
): ReconnectNeed | null {
  const since = uncoveredSince(account, new Set(live.keys()), owned, now, reachedBy);
  if (since !== null) return { kind: 'gone', since };
  if (owned !== true || account.source !== 'connector') return null;
  const fetching = fetchingConnectionIds(account, reachedBy).filter((id) => live.has(id));
  if (fetching.length === 0 || fetching.some((id) => !live.get(id)!.ended)) return null;
  const renewable = fetching.find((id) => live.get(id)!.unattended);
  return renewable ? { kind: 'signin', connectionId: renewable } : null;
}
