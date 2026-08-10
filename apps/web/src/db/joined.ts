import { txMetaId } from '@/domain/feedIds';
import { accountStamp } from '@/domain/txType';
import type { StorageBackend } from './backend';
import type { Repo } from './repo';
import type { AccountLinkRow, AccountRow, AccountType, TransactionRow, TxMetaRow, TxType } from './types';

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

/** #152: what the SPACE says an attached account is — the link's type
 *  wins over the account row's own (global accounts carry no meaningful
 *  type anymore; each space decides at attach time) */
export const linkEffectiveType = (link: AccountLinkRow, account: AccountRow): AccountType =>
  link.type ?? account.type;

/** R1 + #152: accountId → the stamped type for the space's own accounts
 *  and every attached one (absent = regular, rows type freely) — plus
 *  the set of FUNDING accounts, whose transactions this space never
 *  shows at all */
async function accountFacts(
  store: StorageBackend,
  spaceId: string,
  links: AccountLinkRow[],
): Promise<{ stamps: Map<string, TxType>; funding: Set<string> }> {
  const stamps = new Map<string, TxType>();
  const funding = new Set<string>();
  const put = (account: AccountRow | undefined, type?: AccountType) => {
    if (account?.deleted !== 0) return;
    const effective = type ?? account.type;
    if (effective === 'funding') {
      funding.add(account.id);
      return;
    }
    const stamp = accountStamp(effective);
    if (stamp) stamps.set(account.id, stamp);
  };
  for (const account of await store.bySpace('account', spaceId)) put(account);
  for (const link of links) {
    const account = await store.get('account', link.accountId);
    put(account, account ? linkEffectiveType(link, account) : undefined);
  }
  return { stamps, funding };
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
  const { stamps, funding } = await accountFacts(store, spaceId, links);
  // #152: funding accounts complete the counterparty picture and nothing
  // more — their transactions never enter the space's lists
  const legacy = own.filter(
    (t) => t.deleted === 0 && !funding.has(t.accountId) && (!startGate || t.date >= startGate),
  );
  const metaByTx = new Map(metas.filter((m) => m.deleted === 0).map((m) => [m.txId, m]));

  const out: SpaceTx[] = legacy.map((t) => stampOwn(t, stamps));
  for (const link of links) {
    if (funding.has(link.accountId)) continue;
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
  const { stamps, funding } = await accountFacts(store, spaceId, links);
  const metaByTx = new Map(metas.filter((m) => m.deleted === 0).map((m) => [m.txId, m]));
  const out: SpaceTx[] = own
    .filter((t) => t.deleted === 0 && !funding.has(t.accountId))
    .map((t) => stampOwn(t, stamps));
  for (const link of links) {
    if (funding.has(link.accountId)) continue;
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

/** every account the space sees: legacy in-space rows + attached feed
 *  accounts — the attachment's TYPE opinion applied (#152: type is a
 *  space-level fact for attached accounts) */
export async function visibleAccounts(store: StorageBackend, spaceId: string): Promise<SpaceAccount[]> {
  const [own, links] = await Promise.all([store.bySpace('account', spaceId), spaceAccountLinks(store, spaceId)]);
  const out: SpaceAccount[] = own.filter((a) => a.deleted === 0);
  for (const link of links) {
    const account = await store.get('account', link.accountId);
    if (account?.deleted === 0) out.push({ ...account, type: linkEffectiveType(link, account), link });
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
 * A splits write plans the PART-level mirror consequences (typed-splits
 * v2): each part that gained, moved or lost its counterparty mints or
 * retires its own counter leg — keyed on row+part identity, so a part's
 * mirror survives sibling edits. Returns the splits with the parts'
 * peers applied plus the plans to run after the write.
 */
async function planPartLinkChanges(
  repo: Repo,
  tx: TransformTx,
  fields: TxTransformFields,
): Promise<{ splits: TxTransformFields['splits']; plans: Array<{ execute: (repo: Repo) => Promise<void> }> } | null> {
  const nextParts = fields.splits;
  if (!nextParts) return null; // clearing splits: row-level linking owns any cleanup
  const raw = await repo.store.get('transaction', tx.id);
  if (!raw) return null;
  const feed = !!tx.feedSpaceId;
  const meta = feed ? await repo.store.get('txMeta', txMetaId(tx.spaceId, tx.id)) : undefined;
  const prevParts = (feed ? meta?.splits : raw.splits) ?? [];
  const prevById = new Map(prevParts.filter((p) => p.id).map((p) => [p.id!, p]));
  const { planMirrorChange } = await import('@/application/mirrorMint');
  const { partMirrorSourceId } = await import('@/domain/feedIds');
  const sign = raw.amountCents < 0 ? -1 : 1;
  const plans: Array<{ execute: (repo: Repo) => Promise<void> }> = [];
  const adjusted = [...nextParts];

  const planFor = async (partId: string, magnitude: number, prevLinked?: string, nextLinked?: string, currentPeer?: string) =>
    planMirrorChange(
      repo.store,
      {
        id: partMirrorSourceId(tx.id, partId),
        accountId: raw.accountId,
        amountCents: sign * Math.abs(magnitude),
        date: raw.date,
        time: raw.time,
        currency: raw.currency,
        merchant: raw.merchant,
      },
      prevLinked,
      nextLinked,
      currentPeer,
      undefined,
    ).catch(() => null);

  await diffPartPlans(nextParts, prevById, planFor, adjusted, plans);
  return plans.length || adjusted.some((p, i) => p !== nextParts[i]) ? { splits: adjusted, plans } : null;
}

type PartPlanner = (
  partId: string,
  magnitude: number,
  prevLinked?: string,
  nextLinked?: string,
  currentPeer?: string,
) => Promise<{ sourceFields: { transferPeerId?: string | null }; execute: (repo: Repo) => Promise<void> } | null>;

/** walk the part diff: changed links plan their move (the part's peer
 *  rides back into the write), vanished parts take their mints along */
async function diffPartPlans(
  nextParts: NonNullable<TxTransformFields['splits']>,
  prevById: Map<string, NonNullable<TxTransformFields['splits']>[number]>,
  planFor: PartPlanner,
  adjusted: NonNullable<TxTransformFields['splits']>,
  plans: Array<{ execute: (repo: Repo) => Promise<void> }>,
): Promise<void> {
  for (const [index, part] of nextParts.entries()) {
    if (!part.id) continue;
    const prev = prevById.get(part.id);
    prevById.delete(part.id);
    if ((prev?.linkedAccountId ?? undefined) === (part.linkedAccountId ?? undefined)) continue;
    const plan = await planFor(part.id, part.amountCents, prev?.linkedAccountId, part.linkedAccountId, prev?.transferPeerId);
    if (!plan) continue;
    if (Object.hasOwn(plan.sourceFields, 'transferPeerId')) {
      adjusted[index] = { ...part, transferPeerId: (plan.sourceFields.transferPeerId ?? undefined) as string | undefined };
    }
    plans.push(plan);
  }
  for (const gone of prevById.values()) {
    if (!gone.id || !gone.linkedAccountId) continue;
    const plan = await planFor(gone.id, gone.amountCents, gone.linkedAccountId, undefined, gone.transferPeerId);
    if (plan) plans.push(plan);
  }
}

/**
 * The single write path for transformation edits: joined feed rows get
 * their overlay written (creating it deterministically on first edit);
 * legacy merged rows keep writing in place until migrated. The
 * mirror-mint lifecycle lives at THIS choke point (the loans-v2 lesson,
 * generalized) — every linkedAccountId writer (user edits, auto-linkers,
 * the match sheet, review confirms) mints or retires the manual counter
 * leg exactly once — row-level AND per part — and the balance rides the
 * mirror's lifecycle.
 */
export async function writeTxTransform(repo: Repo, tx: TransformTx, fields: TxTransformFields): Promise<void> {
  const plan = Object.hasOwn(fields, 'linkedAccountId') ? await planLinkChange(repo, tx, fields) : null;
  const partPlan = Object.hasOwn(fields, 'splits') ? await planPartLinkChanges(repo, tx, fields) : null;
  // a pick-existing peer in `fields` outranks the plan's own idea
  let write: TxTransformFields =
    plan && !Object.hasOwn(fields, 'transferPeerId') ? { ...fields, ...(plan.sourceFields as TxTransformFields) } : fields;
  if (partPlan) write = { ...write, splits: partPlan.splits };

  // #133 phase 1: a write that changes WHAT the row is (category,
  // counterparty or parts) without naming a type gets the compat txType
  // DERIVED here — no surface asks for types anymore, while old devices
  // and historical readers keep seeing coherent values
  if (!Object.hasOwn(write, 'txType') && ['catId', 'linkedAccountId', 'splits'].some((key) => Object.hasOwn(write, key))) {
    const derived = await deriveWriteTxType(repo, tx, write);
    if (derived) write = { ...write, txType: derived };
  }

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
  for (const p of partPlan?.plans ?? []) await p.execute(repo).catch(() => undefined);
}

/** #133: the derived compat txType for a choke write — computed from the
 *  MERGED current row (overlay wins on feed rows) with the write's own
 *  changes applied on top. Module-level for S3776. */
async function deriveWriteTxType(repo: Repo, tx: TransformTx, write: TxTransformFields): Promise<TxType | undefined> {
  const { deriveTxType } = await import('@/domain/txDerive');
  const raw = await repo.store.get('transaction', tx.id);
  if (!raw) return undefined;
  const feed = !!tx.feedSpaceId;
  const meta = feed ? await repo.store.get('txMeta', txMetaId(tx.spaceId, tx.id)) : undefined;
  const current = <K extends keyof TxTransformFields>(key: K): TxTransformFields[K] => {
    if (Object.hasOwn(write, key)) return write[key];
    const stored = feed
      ? ((meta as TxTransformFields | undefined)?.[key] ?? (raw as TxTransformFields)[key])
      : (raw as TxTransformFields)[key];
    return stored as TxTransformFields[K];
  };
  const linkedAccountId = current('linkedAccountId');
  const linked = linkedAccountId ? await repo.store.get('account', linkedAccountId) : undefined;
  const account = await repo.store.get('account', raw.accountId);
  const parts = (current('splits') ?? []).filter((s) => s.catId !== 'reimbursed');
  // #152: both sides resolve through the SPACE's lens — the attachment
  // owns the type of attached accounts
  const spaceTypeOf = async (row: AccountRow | undefined): Promise<AccountType | undefined> => {
    if (!row) return undefined;
    if (row.spaceId === tx.spaceId) return row.type;
    const links = await spaceAccountLinks(repo.store, tx.spaceId);
    const link = links.find((l) => l.accountId === row.id);
    return link ? linkEffectiveType(link, row) : row.type;
  };
  return deriveTxType({
    catId: current('catId'),
    linkedAccountId,
    amountCents: raw.amountCents,
    stamp: accountStamp(await spaceTypeOf(account)),
    counterDefaultFor: linked?.defaultFor,
    counterFunding: (await spaceTypeOf(linked)) === 'funding',
    multiPart: parts.length > 1,
    adjustment: raw.adjustment === 1 || raw.txType === 'adjustment',
  });
}
