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
 * Whether the viewer is the one whose connection feeds the account: the
 * person who attached it, or — a link without a name on it — the viewer by
 * default. Only the owner's device holds the live connection ids the row's
 * stamp is read against (user ss 2026-10-08: an account a friend shared into
 * the space read "not fetched any more — reconnect" on the viewer's phone,
 * while the friend's connection was alive and well).
 */
export const ownsLink = (link: CoverageLink | null | undefined, mySub: string | undefined): boolean =>
  link?.attachedBy ? link.attachedBy === mySub : true;

/** The same, over every attachment of an account: mine when any of them is, or when nothing says whose it is. */
export const ownsAccount = (links: readonly CoverageLink[], mySub: string | undefined): boolean =>
  links.length === 0 || links.some((link) => ownsLink(link, mySub));

/**
 * When the account stopped being fetched: its last sync, or '' when it
 * never synced at all; null while a live connection covers it, when the
 * row is not a party's to begin with, or when it is not the viewer's to
 * tell (a friend's connection is nowhere in this device's ids).
 */
export function uncoveredSince(account: CoverageAccount, liveConnectionIds: ReadonlySet<string>, owned: boolean, now = Date.now()): string | null {
  if (!owned || account.source !== 'connector') return null;
  if (account.connectionId) return liveConnectionIds.has(account.connectionId) ? null : (account.lastSyncedAt ?? '');
  if (account.lastSyncedAt && now - Date.parse(account.lastSyncedAt) > UNCOVERED_AFTER_MS) return account.lastSyncedAt;
  return null;
}
