import type { AccountLinkRow, AccountRow } from '@/db/types';

// #445: a party-fed account no live connection fetches any more (its connection was reconnected with a consent
// reaching other accounts, or removed); a row stamped before connection ids existed: a week without a fetch
export const UNCOVERED_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type CoverageAccount = Pick<AccountRow, 'source' | 'connectionId' | 'lastSyncedAt'> & Partial<Pick<AccountRow, 'id'>>;

/** #524: the viewer's connections that fetch each account, by account id, as the relay keeps them per person */
export type ReachedBy = ReadonlyMap<string, readonly string[]>;

// #524: the relay's per-person record where there is one, else the row's stamp, which names whoever fetched last
// (a shared IBAN feed flips between two people) and let every connection of a party claim all the party's accounts
export function fetchingConnectionIds(account: CoverageAccount, reachedBy: ReachedBy | undefined): readonly string[] {
  const listed = account.id ? reachedBy?.get(account.id) : undefined;
  if (listed && listed.length > 0) return listed;
  return account.connectionId ? [account.connectionId] : [];
}

export type CoverageLink = Pick<AccountLinkRow, 'attachedBy'>;

// only the owner's device holds the connection ids the row's stamp names; myFeeds (/me/feeds) is the ownership truth
// offline: the attacher's name on a link is the next best word; with neither, undefined and the caller stays quiet
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

// last sync, '' if never synced; null while a live connection covers it, for a non-party row,
// or when not known to be the viewer's (no banner beats a wrong one)
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

export interface ConnectionRenewal {
  /** the party syncs by itself (open banking, an always-on agent): a lost session there is the person's to renew */
  unattended: boolean;
  ended: boolean;
}

export type ReconnectNeed =
  /** no live connection of the viewer's fetches it any more — since its last sync ('' = never synced) */
  | { kind: 'gone'; since: string }
  /** the connection that syncs it by itself lost its session */
  | { kind: 'signin'; connectionId: string };

// #528: a reconnect is asked only when needed, never because data is a few days old (open-banking consent lasts half
// a year): no live connection fetches it, or all that do lost their session and one syncs by itself;
// a party needing the person per sync (ING app approval, a shop's second step) goes through Home's quick sync
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
