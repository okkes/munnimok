import { countsInBalance } from '@/domain/entryMatch';
import { txMetaId } from '@/domain/feedIds';
import { accountStamp } from '@/domain/txType';
import { deriveTxType } from '@/domain/txDerive';
import type { StorageBackend } from './backend';
import type { Repo } from './repo';
import type { AccountLinkRow, AccountRow, AccountType, TransactionRow, TxMetaRow, TxSplitCat, TxType, TxView } from './types';

/**
 * Feature B join layer: what a space "sees".
 *
 * Raw bank data lives once, in the account's feed space. A viewing
 * space sees a raw transaction through its attachments, dressed with
 * the space's own transformation overlay (txMeta). The space's OWN rows
 * (manual entries, statement imports without a feed) carry both halves
 * on the row itself and are served as-is.
 */

/** a transaction as a space sees it: the view (derived txType included)
 *  plus where the row came from */
export interface SpaceTx extends TxView {
  /** present when the row is a joined feed transaction (not one of the space's own rows) */
  feedSpaceId?: string;
  /** #547: the hand-typed entry linked to this bank row — the two read as one, and this is what was typed */
  entry?: LinkedEntry;
}

/** #547: what a person typed before the bank's own transaction arrived */
export interface LinkedEntry {
  id: string;
  amountCents: number;
  date: string;
  title: string;
}

/**
 * #547: an entry linked to a bank row in view IS that row — the row says
 * what was typed, and the entry itself stays out of every list and total.
 * An entry whose bank row is not in view (replaced, gated, detached) shows
 * as itself until the link is repaired.
 */
function foldEntries(rows: SpaceTx[]): SpaceTx[] {
  const linked = rows.filter((row) => !row.feedSpaceId && !!row.bankTxId);
  if (linked.length === 0) return rows;
  const inView = new Set(rows.map((row) => row.id));
  const behind = new Map<string, SpaceTx>();
  for (const entry of linked) if (inView.has(entry.bankTxId!) && !behind.has(entry.bankTxId!)) behind.set(entry.bankTxId!, entry);
  const hidden = new Set([...behind.values()].map((entry) => entry.id));
  return rows
    .filter((row) => !hidden.has(row.id))
    .map((row) => {
      const entry = behind.get(row.id);
      return entry ? { ...row, entry: { id: entry.id, amountCents: entry.amountCents, date: entry.date, title: entry.titleOverride || entry.merchant } } : row;
    });
}

/** a row as the space stores or joins it, before the view types derive */
type JoinedRow = TransactionRow & { feedSpaceId?: string };

const TRANSFORM_DEFAULTS: Pick<TransactionRow, 'catId' | 'needsReview'> = {
  catId: undefined, // renders as Uncategorized until a member categorizes it
  needsReview: 1,
};

function joinTx(raw: TransactionRow, meta: TxMetaRow | undefined, spaceId: string, feedSpaceId: string): JoinedRow {
  const defaults = TRANSFORM_DEFAULTS;
  return {
    ...raw,
    spaceId,
    feedSpaceId,
    catId: meta?.catId ?? defaults.catId,
    // reserved (pending) charges are not review material: the bank will
    // replace them with their booked twin
    needsReview: raw.pending === 1 ? 0 : (meta?.needsReview ?? defaults.needsReview),
    notes: meta?.notes,
    titleOverride: meta?.titleOverride,
    cats: meta?.cats,
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
interface SpaceAccountFacts {
  stamps: Map<string, TxType>;
  funding: Set<string>;
  /** #133 removal: what each account MEANS as a counterparty — feeds
   *  the per-row type derivation at the join */
  counter: Map<string, { funding: boolean }>;
}

async function accountFacts(store: StorageBackend, spaceId: string, links: AccountLinkRow[]): Promise<SpaceAccountFacts> {
  const stamps = new Map<string, TxType>();
  const funding = new Set<string>();
  const counter = new Map<string, { funding: boolean }>();
  const put = (account: AccountRow | undefined, type?: AccountType) => {
    if (account?.deleted !== 0) return;
    const effective = type ?? account.type;
    counter.set(account.id, { funding: effective === 'funding' });
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
  return { stamps, funding, counter };
}

/** #133: the VIEW's txType is DERIVED, row and parts alike — nothing is
 *  stored; the adjustment marker is the row's own field */
function deriveViewTypes(row: JoinedRow, facts: SpaceAccountFacts): SpaceTx {
  const counterOf = (id: string | undefined) => (id ? facts.counter.get(id) : undefined);
  const sign = row.amountCents < 0 ? -1 : 1;
  const multiPart = (row.splits ?? []).length > 1;
  const derive = (catId: string | undefined, linkedId: string | undefined, amountCents: number, multiPart: boolean, adjustment: boolean) =>
    deriveTxType({
      catId,
      linkedAccountId: linkedId,
      amountCents,
      stamp: facts.stamps.get(row.accountId),
      counterFunding: counterOf(linkedId)?.funding === true,
      multiPart,
      adjustment,
    });
  // #228: entries of a spread carry no counterparties — every entry
  // derives with the OWNER's link (the one counterparty the (split)
  // transaction has), so a settled movement row's entries still read as
  // their family
  const enrichCats = (cats: TxSplitCat[] | undefined, ownLinked: string | undefined): TxSplitCat[] | undefined =>
    cats?.map((c) =>
      c.catId === 'reimbursed'
        ? c
        : { ...c, txType: derive(c.catId, ownLinked, sign * Math.abs(c.amountCents), false, false) },
    );
  const adjustment = row.adjustment === 1;
  const txType = derive(row.catId, row.linkedAccountId, row.amountCents, multiPart, adjustment);
  const cats = enrichCats(row.cats, row.linkedAccountId);
  const splits = row.splits?.map((s) => ({
    ...s,
    txType: derive(s.catId, s.linkedAccountId, sign * Math.abs(s.amountCents), false, false),
    ...(s.cats ? { cats: enrichCats(s.cats, s.linkedAccountId) } : {}),
  }));
  return { ...row, txType, ...(cats ? { cats } : {}), ...(splits ? { splits } : {}) };
}

/** every transaction the space sees: its own rows + joined feed rows */
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
  const { stamps, funding, counter } = await accountFacts(store, spaceId, links);
  // #152: funding accounts complete the counterparty picture and nothing
  // more — their transactions never enter the space's lists
  const ownRows = own.filter(
    (t) => t.deleted === 0 && !funding.has(t.accountId) && (!startGate || t.date >= startGate),
  );
  const metaByTx = new Map(metas.filter((m) => m.deleted === 0).map((m) => [m.txId, m]));

  const facts = { stamps, funding, counter };
  const out: SpaceTx[] = ownRows.map((t) => deriveViewTypes({ ...t }, facts));
  for (const link of links) {
    if (funding.has(link.accountId)) continue;
    // #259: a link's own gate wins; a link WITHOUT one (the server's
    // connect-time mirror op carries none) falls back to the space's
    // start date — the setting must govern on every device, not only
    // the one whose heal happened to run against a populated database
    const gate = link.historyFrom ?? startGate;
    const feedTxs = (await store.bySpace('transaction', link.feedSpaceId)).filter(
      (t) => t.deleted === 0 && t.accountId === link.accountId && (!gate || t.date >= gate),
    );
    for (const raw of feedTxs) out.push(deriveViewTypes(joinTx(raw, metaByTx.get(raw.id), spaceId, link.feedSpaceId), facts));
  }
  return foldEntries(out);
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
  const { stamps, funding, counter } = await accountFacts(store, spaceId, links);
  const metaByTx = new Map(metas.filter((m) => m.deleted === 0).map((m) => [m.txId, m]));
  const facts = { stamps, funding, counter };
  const out: SpaceTx[] = own
    .filter((t) => t.deleted === 0 && !funding.has(t.accountId))
    .map((t) => deriveViewTypes({ ...t }, facts));
  for (const link of links) {
    if (funding.has(link.accountId)) continue;
    const feedTxs = (await store.bySpace('transaction', link.feedSpaceId)).filter(
      (t) => t.deleted === 0 && t.accountId === link.accountId,
    );
    for (const raw of feedTxs) out.push(deriveViewTypes(joinTx(raw, metaByTx.get(raw.id), spaceId, link.feedSpaceId), facts));
  }
  return foldEntries(out);
}

export interface SpaceAccount extends AccountRow {
  /** present when the account arrives via an attachment */
  link?: AccountLinkRow;
  /** #547: what this space's own entries add on top of the bank's balance; absent when none count */
  entriesCents?: number;
  /** #547: the balance as the bank (or the statement) gives it, when entries count on top of it */
  bankBalanceCents?: number;
}

/**
 * #547 (user 2026-11-11): "the manual entries should only impact the
 * balance of the account within that space" — the bank's number plus the
 * entries that still count, here in the join and nowhere in storage, so
 * every other space and the global overview keep the bank's number.
 */
async function withEntries(store: StorageBackend, account: SpaceAccount, entries: readonly TransactionRow[]): Promise<SpaceAccount> {
  if (account.source === 'manual') return account;
  let cents = 0;
  for (const entry of entries) {
    if (entry.accountId !== account.id) continue;
    const linked = entry.bankTxId ? await store.get('transaction', entry.bankTxId) : undefined;
    // a link to a row that is gone is no link
    if (countsInBalance(entry, account, linked?.deleted === 0 ? linked : null)) cents += entry.amountCents;
  }
  return cents === 0 ? account : { ...account, balanceCents: account.balanceCents + cents, bankBalanceCents: account.balanceCents, entriesCents: cents };
}

/** every account the space sees: its own in-space rows + attached feed
 *  accounts — the attachment's TYPE opinion applied (#152: type is a
 *  space-level fact for attached accounts) and its NAME opinion too
 *  (#239: a space may call the account by its own name) */
export async function visibleAccounts(store: StorageBackend, spaceId: string): Promise<SpaceAccount[]> {
  const [own, links] = await Promise.all([store.bySpace('account', spaceId), spaceAccountLinks(store, spaceId)]);
  const out: SpaceAccount[] = own.filter((a) => a.deleted === 0);
  for (const link of links) {
    const account = await store.get('account', link.accountId);
    if (account?.deleted === 0) {
      out.push({ ...account, name: link.displayName || account.name, type: linkEffectiveType(link, account), link });
    }
  }
  const entries = (await store.bySpace('transaction', spaceId)).filter((row) => row.deleted === 0 && row.inBalance === 1 && !!row.enteredAt);
  if (entries.length === 0) return out;
  return Promise.all(out.map((account) => withEntries(store, account, entries)));
}

/** #545: one account as a space sees it — visibleAccounts' name and type
 *  for an attached account; a row the space does not attach keeps its own */
export async function asSpaceAccount(
  store: StorageBackend,
  spaceId: string,
  account: AccountRow | undefined,
): Promise<SpaceAccount | undefined> {
  if (!account || account.spaceId === spaceId) return account;
  const link = (await spaceAccountLinks(store, spaceId)).find((l) => l.accountId === account.id);
  return link ? { ...account, name: link.displayName || account.name, type: linkEffectiveType(link, account), link } : account;
}

/** transformation fields a space may hold an opinion on */
export type TxTransformFields = Partial<
  Pick<
    TxMetaRow,
    'catId' | 'needsReview' | 'notes' | 'titleOverride' | 'cats' | 'splits' | 'reimbursements' | 'linkedAccountId' | 'transferPeerId' | 'recurringId' | 'eventId' | 'loanCounted'
  >
>;

type TransformTx = Pick<SpaceTx, 'id' | 'spaceId' | 'feedSpaceId' | 'needsReview'> &
  Partial<Pick<SpaceTx, 'amountCents' | 'date' | 'linkedAccountId' | 'transferPeerId' | 'loanCounted'>>;

/** one merged view field: the overlay owns it on feed rows, the row itself on own rows */
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
 * mirror survives sibling edits — and a linked part whose amount moved
 * RESIZES it. Returns the splits with the parts' peers applied plus the
 * plans to run after the write. (#228: parts are the smallest unit that
 * carries a counterparty — their category spreads never link.)
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
  const { partMirrorSourceId, mirrorTxId } = await import('@/domain/feedIds');
  const sign = raw.amountCents < 0 ? -1 : 1;
  const plans: Array<{ execute: (repo: Repo) => Promise<void> }> = [];
  const adjusted = [...nextParts];

  const planFor: PartPlanner = async (partId, magnitude, prevLinked, nextLinked, currentPeer, incomingPeer) =>
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
      incomingPeer,
    ).catch(() => null);
  const ownPartMid = (partId: string) => mirrorTxId(partMirrorSourceId(tx.id, partId));

  await diffPartPlans(nextParts, prevById, planFor, ownPartMid, adjusted, plans);
  return plans.length || adjusted.some((p, i) => p !== nextParts[i]) ? { splits: adjusted, plans } : null;
}

type PartPlanner = (
  partId: string,
  magnitude: number,
  prevLinked?: string,
  nextLinked?: string,
  currentPeer?: string,
  incomingPeer?: string,
) => Promise<{ sourceFields: { transferPeerId?: string | null }; execute: (repo: Repo) => Promise<void> } | null>;

type PartRow = NonNullable<TxTransformFields['splits']>[number];
type MirrorExec = { execute: (repo: Repo) => Promise<void> };

/** one SURVIVING part's plans (S3776): the part-level link/resize move,
 *  its peer riding back. A part arriving with a FOREIGN transferPeerId
 *  (the fold's relocated pick-existing link, #228) is a picked real row:
 *  it rides through and nothing is minted. */
async function planOnePartDiff(
  part: PartRow,
  prev: PartRow | undefined,
  planFor: PartPlanner,
  ownPartMid: (partId: string) => string,
): Promise<{ adjusted: PartRow; plans: MirrorExec[] }> {
  const plans: MirrorExec[] = [];
  let out = part;
  const linkMoved = (prev?.linkedAccountId ?? undefined) !== (part.linkedAccountId ?? undefined);
  const magnitudeMoved = !!prev && !!part.linkedAccountId && prev.amountCents !== part.amountCents;
  if (linkMoved || magnitudeMoved) {
    const incoming =
      linkMoved && part.transferPeerId && part.transferPeerId !== ownPartMid(part.id!) ? part.transferPeerId : undefined;
    const plan = await planFor(part.id!, part.amountCents, prev?.linkedAccountId, part.linkedAccountId, prev?.transferPeerId, incoming);
    if (plan) {
      if (!incoming && Object.hasOwn(plan.sourceFields, 'transferPeerId')) {
        out = { ...out, transferPeerId: (plan.sourceFields.transferPeerId ?? undefined) as string | undefined };
      }
      plans.push(plan);
    }
  }
  return { adjusted: out, plans };
}

/** walk the part diff: changed links plan their move (the part's peer
 *  rides back into the write), linked amount edits resize, vanished
 *  parts take their mints along */
async function diffPartPlans(
  nextParts: NonNullable<TxTransformFields['splits']>,
  prevById: Map<string, PartRow>,
  planFor: PartPlanner,
  ownPartMid: (partId: string) => string,
  adjusted: NonNullable<TxTransformFields['splits']>,
  plans: MirrorExec[],
): Promise<void> {
  for (const [index, part] of nextParts.entries()) {
    if (!part.id) continue;
    const prev = prevById.get(part.id);
    prevById.delete(part.id);
    const diff = await planOnePartDiff(part, prev, planFor, ownPartMid);
    adjusted[index] = diff.adjusted;
    plans.push(...diff.plans);
  }
  for (const gone of prevById.values()) {
    if (!gone.id) continue;
    if (gone.linkedAccountId) {
      const plan = await planFor(gone.id, gone.amountCents, gone.linkedAccountId, undefined, gone.transferPeerId);
      if (plan) plans.push(plan);
    }
  }
}

/**
 * The single write path for transformation edits: joined feed rows get
 * their overlay written (creating it deterministically on first edit);
 * the space's own rows write in place. The
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

  if (!tx.feedSpaceId) {
    await repo.upsert('transaction', tx.spaceId, tx.id, write);
  } else {
    await repo.upsert('txMeta', tx.spaceId, txMetaId(tx.spaceId, tx.id), {
      txId: tx.id,
      // first write materializes the current review state alongside the edit
      needsReview: tx.needsReview,
      ...write,
    });
  }

  if (plan) await plan.execute(repo).catch(() => undefined);
  for (const p of partPlan?.plans ?? []) await p.execute(repo).catch(() => undefined);
}

