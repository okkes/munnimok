import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { ReceiptRow, TransactionRow } from '@/db/types';
import { bestMatch } from '@/domain/storeReceipts';
import type { AccountTailOf } from '@/domain/storeReceipts';
import { receiptLinkId } from '@/domain/feedIds';
import { visibleTransactions } from '@/db/joined';
import { linkedTxIds, writeProposedLink } from './receiptLinks';

/**
 * Receipts v3 matching, per space: fetched receipts live ONCE in the
 * owner's store feed (the server's ingest writes them — #367), and the
 * matcher runs per INCLUDED space, linking rung-1 singles by writing
 * snapshot `receiptLink` rows. A candidate a human already reviewed is
 * never attached behind their back: it becomes a proposal (§5.7).
 */

export interface MatchOutcome {
  /** attached by the matcher */
  linked: number;
  /** waiting in "Matches to check" */
  proposed: number;
}

/** the spaces a connection is included in (storeConnLink, deleted spaces drop) */
export async function includedSpaces(store: StorageBackend, connectionId: string): Promise<string[]> {
  const localSpaceIds = new Set((await store.allRows('space')).filter((s) => s.deleted === 0).map((s) => s.id));
  return (await store.allRows('storeConnLink'))
    .filter((l) => l.deleted === 0 && l.instanceId === connectionId && localSpaceIds.has(l.spaceId))
    .map((l) => l.spaceId);
}

/** IBAN tails of the space's accounts — payment-aware matching (R5) */
async function accountTailResolver(store: StorageBackend): Promise<AccountTailOf> {
  const accounts = await store.allRows('account');
  const ibanByAccount = new Map(accounts.filter((a) => a.iban).map((a) => [a.id, a.iban!.replaceAll(/\D/g, '')]));
  return (tx: TransactionRow) => ibanByAccount.get(tx.accountId);
}

/**
 * Match the given global receipts into ONE space: a rung-1 single becomes
 * a PROPOSAL — never an attachment (user rule 2026-10-05: a receipt the
 * matcher attached behind the person's back read as "it just linked
 * itself"). A transaction still to review carries the proposal into its
 * review card; a reviewed one lists it under Matches to check and on
 * Home. Receipts already attached in the space are skipped, as are
 * transactions that already carry or are already proposed a receipt and
 * the transactions a human rejected for a receipt.
 */
export async function matchReceiptsIntoSpace(
  storage: StorageBackend,
  repo: Repo,
  spaceId: string,
  receipts: readonly ReceiptRow[],
): Promise<MatchOutcome> {
  // the space's VIEW: own rows and attached feed rows alike, the derived
  // types telling expenses from movements
  const [txs, links] = await Promise.all([visibleTransactions(storage, spaceId), storage.bySpace('receiptLink', spaceId)]);
  const linkById = new Map(links.filter((l) => l.deleted === 0).map((l) => [l.id, l]));
  // a transaction that carries a receipt (as its first holder or a further one — user 2026-10-08), or is already
  // asked about one, is spoken for
  const taken = new Set([...linkById.values()].flatMap((l) => [...linkedTxIds(l), l.proposedTxId]).filter((id): id is string => !!id));
  const tailOf = await accountTailResolver(storage);

  const outcome: MatchOutcome = { linked: 0, proposed: 0 };
  for (const receipt of receipts) {
    if (receipt.deleted !== 0) continue;
    const link = linkById.get(receiptLinkId(spaceId, receipt.id));
    if (link?.txId || link?.proposedTxId) continue;
    const rejected = new Set(link?.rejectedTxIds ?? []);
    const txId = bestMatch(receipt, rejected.size ? txs.filter((tx) => !rejected.has(tx.id)) : txs, taken, tailOf);
    if (!txId) continue;
    taken.add(txId);
    await writeProposedLink(repo, spaceId, receipt, txId);
    outcome.proposed += 1;
  }
  return outcome;
}

/**
 * Re-evaluate a whole space against every global receipt: after a sync
 * landed new rows, and when a connection joins the space (R5).
 * `connectionId` narrows the pass to one connection; omitted = all.
 */
export async function reevaluateSpace(
  storage: StorageBackend,
  repo: Repo,
  spaceId: string,
  connectionId?: string,
): Promise<MatchOutcome> {
  const feeds = new Set((await storage.allRows('storeConn')).filter((c) => c.deleted === 0).map((c) => c.spaceId));
  const receipts: ReceiptRow[] = [];
  for (const feedId of feeds) {
    receipts.push(...(await storage.bySpace('receipt', feedId)));
  }
  const scoped = connectionId ? receipts.filter((r) => r.instanceId === connectionId) : receipts;
  return matchReceiptsIntoSpace(storage, repo, spaceId, scoped);
}
