import { txMetaId } from '@/domain/feedIds';
import { accountStamp } from '@/domain/txType';
import type { StorageBackend } from './backend';
import type { Repo } from './repo';
import type { AccountLinkRow, AccountRow, TransactionRow, TxMetaRow, TxType } from './types';

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

function joinTx(raw: TransactionRow, meta: TxMetaRow | undefined, spaceId: string, feedSpaceId: string, stamp?: TxType): SpaceTx {
  const defaults = TRANSFORM_DEFAULTS(raw);
  return {
    ...raw,
    spaceId,
    feedSpaceId,
    catId: meta?.catId ?? defaults.catId,
    // R1 (typed-splits v2): a special account's rows WEAR ITS TYPE — the
    // stamp is live truth at the join, so server-side predictions and
    // old opinions can never mistype a savings/loan/brokerage row
    txType: stamp ?? meta?.txType ?? defaults.txType,
    // reserved (pending) charges are not review material: the bank will
    // replace them with their booked twin
    needsReview: raw.pending === 1 ? 0 : (meta?.needsReview ?? defaults.needsReview),
    notes: meta?.notes,
    titleOverride: meta?.titleOverride,
    splits: meta?.splits,
    reimbursements: meta?.reimbursements,
    linkedAccountId: meta?.linkedAccountId,
    transferPeerId: meta?.transferPeerId,
    recurringId: meta?.recurringId,
    eventId: meta?.eventId,
    loanCounted: meta?.loanCounted,
  };
}

/** attachments of a space (non-deleted; archived ones still serve history) */
export async function spaceAccountLinks(store: StorageBackend, spaceId: string): Promise<AccountLinkRow[]> {
  return (await store.bySpace('accountLink', spaceId)).filter((l) => l.deleted === 0);
}

/** R1: accountId → the stamped type, for the space's own accounts and
 *  every attached one (absent = regular, rows type freely) */
async function stampMap(store: StorageBackend, spaceId: string, links: AccountLinkRow[]): Promise<Map<string, TxType>> {
  const stamps = new Map<string, TxType>();
  const put = (account: AccountRow | undefined) => {
    if (account?.deleted !== 0) return;
    const stamp = accountStamp(account.type);
    if (stamp) stamps.set(account.id, stamp);
  };
  for (const account of await store.bySpace('account', spaceId)) put(account);
  for (const link of links) put(await store.get('account', link.accountId));
  return stamps;
}

/** the space's own (legacy merged) rows with the R1 stamp applied */
const stampOwn = (row: TransactionRow, stamps: Map<string, TxType>): TransactionRow => {
  const stamp = stamps.get(row.accountId);
  return stamp && row.txType !== stamp ? { ...row, txType: stamp } : row;
};

/** every transaction the space sees: legacy merged rows + joined feed rows */
export async function visibleTransactions(store: StorageBackend, spaceId: string): Promise<SpaceTx[]> {
  const [own, links, metas, space] = await Promise.all([
    store.bySpace('transaction', spaceId),
    spaceAccountLinks(store, spaceId),
    store.bySpace('txMeta', spaceId),
    store.get('space', spaceId),
  ]);
  // the space's own rows respect the history start too (arc 5): stored
  // in full, filtered at display — exactly like attached feed rows.
  // Rows from before the start (sync races, a start date moved newer)
  // stay in the database but out of every screen.
  const startGate = space?.historyStartDate;
  const stamps = await stampMap(store, spaceId, links);
  const legacy = own.filter((t) => t.deleted === 0 && (!startGate || t.date >= startGate));
  const metaByTx = new Map(metas.filter((m) => m.deleted === 0).map((m) => [m.txId, m]));

  const out: SpaceTx[] = legacy.map((t) => stampOwn(t, stamps));
  for (const link of links) {
    const feedTxs = (await store.bySpace('transaction', link.feedSpaceId)).filter(
      (t) =>
        t.deleted === 0 &&
        t.accountId === link.accountId &&
        (!link.historyFrom || t.date >= link.historyFrom),
    );
    for (const raw of feedTxs) out.push(joinTx(raw, metaByTx.get(raw.id), spaceId, link.feedSpaceId, stamps.get(raw.accountId)));
  }
  return out;
}

/**
 * The space's transactions WITHOUT the history gates (user design
 * 2026-08-01): recurring DETECTION reads the full stored history — a
 * yearly subscription needs charges from before the space's start date
 * to show a pattern at all, and banks may backfill years of data that
 * the display gate deliberately hides. Deletion and attachment rules
 * still apply; only the date gates are lifted. Screens keep reading
 * visibleTransactions — the extra rows serve as pattern EVIDENCE, they
 * never enter the space's lists.
 */
export async function historyTransactions(store: StorageBackend, spaceId: string): Promise<SpaceTx[]> {
  const [own, links, metas] = await Promise.all([
    store.bySpace('transaction', spaceId),
    spaceAccountLinks(store, spaceId),
    store.bySpace('txMeta', spaceId),
  ]);
  const stamps = await stampMap(store, spaceId, links);
  const metaByTx = new Map(metas.filter((m) => m.deleted === 0).map((m) => [m.txId, m]));
  const out: SpaceTx[] = own.filter((t) => t.deleted === 0).map((t) => stampOwn(t, stamps));
  for (const link of links) {
    const feedTxs = (await store.bySpace('transaction', link.feedSpaceId)).filter(
      (t) => t.deleted === 0 && t.accountId === link.accountId,
    );
    for (const raw of feedTxs) out.push(joinTx(raw, metaByTx.get(raw.id), spaceId, link.feedSpaceId, stamps.get(raw.accountId)));
  }
  return out;
}

export interface SpaceAccount extends AccountRow {
  /** present when the account arrives via an attachment */
  link?: AccountLinkRow;
}

/** every account the space sees: legacy in-space rows + attached feed accounts */
export async function visibleAccounts(store: StorageBackend, spaceId: string): Promise<SpaceAccount[]> {
  const [own, links] = await Promise.all([store.bySpace('account', spaceId), spaceAccountLinks(store, spaceId)]);
  const out: SpaceAccount[] = own.filter((a) => a.deleted === 0);
  for (const link of links) {
    const account = await store.get('account', link.accountId);
    if (account?.deleted === 0) out.push({ ...account, link });
  }
  return out;
}

/** transformation fields a space may hold an opinion on */
export type TxTransformFields = Partial<
  Pick<
    TxMetaRow,
    'catId' | 'txType' | 'needsReview' | 'notes' | 'titleOverride' | 'splits' | 'reimbursements' | 'linkedAccountId' | 'transferPeerId' | 'recurringId' | 'eventId' | 'loanCounted'
  >
>;

type TransformTx = Pick<SpaceTx, 'id' | 'spaceId' | 'feedSpaceId' | 'txType' | 'needsReview'> &
  Partial<Pick<SpaceTx, 'amountCents' | 'date' | 'linkedAccountId' | 'transferPeerId' | 'loanCounted'>>;

/** one merged view field: the overlay owns it on feed rows, raw on legacy */
const mergedField = <K extends 'linkedAccountId' | 'transferPeerId' | 'loanCounted'>(
  feed: boolean,
  raw: TransactionRow,
  meta: TxMetaRow | undefined,
  key: K,
): TransactionRow[K] => (feed ? (meta?.[key] as TransactionRow[K]) : raw[key]);

/**
 * A linkedAccountId change plans its mirror consequence off FRESH merged
 * state — the caller's snapshot may carry a stale transferPeerId or miss
 * a loanCounted written a beat ago; a loanCounted riding the SAME write
 * must gate this link's mint (the match sheet's count-it-in chip), so
 * the fields overlay the stored value.
 */
async function planLinkChange(
  repo: Repo,
  tx: TransformTx,
  fields: TxTransformFields,
): Promise<{ sourceFields: object; execute: (repo: Repo) => Promise<void> } | null> {
  const { planMirrorChange } = await import('@/application/mirrorMint');
  const raw = await repo.store.get('transaction', tx.id);
  if (!raw) return null;
  const feed = !!tx.feedSpaceId;
  const meta = feed ? await repo.store.get('txMeta', txMetaId(tx.spaceId, tx.id)) : undefined;
  const loanCounted = Object.hasOwn(fields, 'loanCounted') ? fields.loanCounted : mergedField(feed, raw, meta, 'loanCounted');
  return planMirrorChange(
    repo.store,
    {
      id: tx.id,
      accountId: raw.accountId,
      amountCents: raw.amountCents,
      date: raw.date,
      time: raw.time,
      currency: raw.currency,
      merchant: raw.merchant,
      ...(loanCounted === 1 ? { loanCounted: 1 as const } : {}),
    },
    mergedField(feed, raw, meta, 'linkedAccountId') ?? undefined,
    fields.linkedAccountId ?? undefined,
    mergedField(feed, raw, meta, 'transferPeerId') ?? undefined,
    Object.hasOwn(fields, 'transferPeerId') ? (fields.transferPeerId ?? null) : undefined,
  ).catch(() => null);
}

/**
 * The single write path for transformation edits: joined feed rows get
 * their overlay written (creating it deterministically on first edit);
 * legacy merged rows keep writing in place until migrated. The
 * mirror-mint lifecycle lives at THIS choke point (the loans-v2 lesson,
 * generalized) — every linkedAccountId writer (user edits, auto-linkers,
 * the match sheet, review confirms) mints or retires the manual counter
 * leg exactly once, and the balance rides the mirror's lifecycle.
 */
export async function writeTxTransform(repo: Repo, tx: TransformTx, fields: TxTransformFields): Promise<void> {
  const plan = Object.hasOwn(fields, 'linkedAccountId') ? await planLinkChange(repo, tx, fields) : null;
  // a pick-existing peer in `fields` outranks the plan's own idea
  const write: TxTransformFields =
    plan && !Object.hasOwn(fields, 'transferPeerId') ? { ...fields, ...(plan.sourceFields as TxTransformFields) } : fields;

  if (!tx.feedSpaceId) {
    await repo.upsert('transaction', tx.spaceId, tx.id, write);
  } else {
    await repo.upsert('txMeta', tx.spaceId, txMetaId(tx.spaceId, tx.id), {
      txId: tx.id,
      // first write materializes the current effective view alongside the edit
      txType: tx.txType,
      needsReview: tx.needsReview,
      ...write,
    });
  }

  if (plan) await plan.execute(repo).catch(() => undefined);
}
