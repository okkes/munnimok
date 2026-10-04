import type { AccountRow } from '@/db/types';

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

/**
 * When the account stopped being fetched: its last sync, or '' when it
 * never synced at all; null while a live connection covers it, or when the
 * row is not a party's to begin with.
 */
export function uncoveredSince(account: CoverageAccount, liveConnectionIds: ReadonlySet<string>, now = Date.now()): string | null {
  if (account.source !== 'connector') return null;
  if (account.connectionId) return liveConnectionIds.has(account.connectionId) ? null : (account.lastSyncedAt ?? '');
  if (account.lastSyncedAt && now - Date.parse(account.lastSyncedAt) > UNCOVERED_AFTER_MS) return account.lastSyncedAt;
  return null;
}
