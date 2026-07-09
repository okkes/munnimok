import { txMetaId } from '@/domain/feedIds';
import type { MunniDB } from './schema';
import type { Repo } from './repo';
import type { AccountLinkRow, AccountRow, TransactionRow, TxMetaRow } from './types';

/**
 * Feature B join layer: what a space "sees".
 *
 * Raw bank data lives once, in the account's feed space. A viewing
 * space sees a raw transaction through its attachments, dressed with
 * the space's own transformation overlay (txMeta). Rows created before
 * the feed migration still carry both halves merged — those are served
 * as-is (dual-read), so mid-migration devices never show gaps.
 */

export interface SpaceTx extends TransactionRow {
  /** present when the row is a joined feed transaction (not a legacy merged row) */
  feedSpaceId?: string;
}

const TRANSFORM_DEFAULTS = (raw: TransactionRow): Pick<TransactionRow, 'catId' | 'txType' | 'needsReview'> => ({
  catId: undefined, // renders as Uncategorized until a member categorizes it
  txType: raw.amountCents >= 0 ? 'income' : 'expense',
  needsReview: 1,
});

function joinTx(raw: TransactionRow, meta: TxMetaRow | undefined, spaceId: string, feedSpaceId: string): SpaceTx {
  const defaults = TRANSFORM_DEFAULTS(raw);
  return {
    ...raw,
    spaceId,
    feedSpaceId,
    catId: meta?.catId ?? defaults.catId,
    txType: meta?.txType ?? defaults.txType,
    needsReview: meta?.needsReview ?? defaults.needsReview,
    notes: meta?.notes,
    splits: meta?.splits,
    reimbursements: meta?.reimbursements,
    linkedAccountId: meta?.linkedAccountId,
    recurringId: meta?.recurringId,
    eventId: meta?.eventId,
  };
}

/** attachments of a space (non-deleted; archived ones still serve history) */
export async function spaceAccountLinks(db: MunniDB, spaceId: string): Promise<AccountLinkRow[]> {
  return db.accountLinks.where('spaceId').equals(spaceId).filter((l) => l.deleted === 0).toArray();
}

/** every transaction the space sees: legacy merged rows + joined feed rows */
export async function visibleTransactions(db: MunniDB, spaceId: string): Promise<SpaceTx[]> {
  const [legacy, links, metas] = await Promise.all([
    db.transactions.where('spaceId').equals(spaceId).filter((t) => t.deleted === 0).toArray(),
    spaceAccountLinks(db, spaceId),
    db.txMeta.where('spaceId').equals(spaceId).filter((m) => m.deleted === 0).toArray(),
  ]);
  const metaByTx = new Map(metas.map((m) => [m.txId, m]));

  const out: SpaceTx[] = [...legacy];
  for (const link of links) {
    const feedTxs = await db.transactions
      .where('spaceId')
      .equals(link.feedSpaceId)
      .filter(
        (t) =>
          t.deleted === 0 &&
          t.accountId === link.accountId &&
          (!link.historyFrom || t.date >= link.historyFrom),
      )
      .toArray();
    for (const raw of feedTxs) out.push(joinTx(raw, metaByTx.get(raw.id), spaceId, link.feedSpaceId));
  }
  return out;
}

export interface SpaceAccount extends AccountRow {
  /** present when the account arrives via an attachment */
  link?: AccountLinkRow;
}

/** every account the space sees: legacy in-space rows + attached feed accounts */
export async function visibleAccounts(db: MunniDB, spaceId: string): Promise<SpaceAccount[]> {
  const [legacy, links] = await Promise.all([
    db.accounts.where('spaceId').equals(spaceId).filter((a) => a.deleted === 0).toArray(),
    spaceAccountLinks(db, spaceId),
  ]);
  const out: SpaceAccount[] = [...legacy];
  for (const link of links) {
    const account = await db.accounts.get(link.accountId);
    if (account?.deleted === 0) out.push({ ...account, link });
  }
  return out;
}

/** transformation fields a space may hold an opinion on */
export type TxTransformFields = Partial<
  Pick<TxMetaRow, 'catId' | 'txType' | 'needsReview' | 'notes' | 'splits' | 'reimbursements' | 'linkedAccountId' | 'recurringId' | 'eventId'>
>;

/**
 * The single write path for transformation edits: joined feed rows get
 * their overlay written (creating it deterministically on first edit);
 * legacy merged rows keep writing in place until migrated.
 */
export async function writeTxTransform(
  repo: Repo,
  tx: Pick<SpaceTx, 'id' | 'spaceId' | 'feedSpaceId' | 'txType' | 'needsReview'>,
  fields: TxTransformFields,
): Promise<void> {
  if (!tx.feedSpaceId) {
    await repo.upsert('transaction', tx.spaceId, tx.id, fields);
    return;
  }
  await repo.upsert('txMeta', tx.spaceId, txMetaId(tx.spaceId, tx.id), {
    txId: tx.id,
    // first write materializes the current effective view alongside the edit
    txType: tx.txType,
    needsReview: tx.needsReview,
    ...fields,
  });
}
