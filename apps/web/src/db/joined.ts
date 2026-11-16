import { countsInBalance } from '@/domain/entryMatch';
import { txMetaId } from '@/domain/feedIds';
import { accountStamp } from '@/domain/txType';
import { deriveTxType } from '@/domain/txDerive';
import type { StorageBackend } from './backend';
import type { Repo } from './repo';
import type { AccountLinkRow, AccountRow, AccountType, TransactionRow, TxMetaRow, TxSplitCat, TxType, TxView } from './types';

// raw bank data lives once in the account's feed space; a viewing space sees it via attachments, with its own txMeta overlay
// the space's own rows carry both halves and are served as-is

export interface SpaceTx extends TxView {
  /** present when the row is a joined feed transaction (not one of the space's own rows) */
  feedSpaceId?: string;
  /** #547: the hand-typed entry linked to this bank row — the two read as one, and this is what was typed */
  entry?: LinkedEntry;
}

export interface LinkedEntry {
  id: string;
  amountCents: number;
  date: string;
  title: string;
}

// an entry linked to a bank row in view IS that row (#547): the entry stays out of lists and totals;
// one whose bank row is not in view shows as itself until the link is repaired
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
    splitRef: meta?.splitRef,
    loanCounted: meta?.loanCounted,
  };
}

/** non-deleted; archived ones still serve history */
export async function spaceAccountLinks(store: StorageBackend, spaceId: string): Promise<AccountLinkRow[]> {
  return (await store.bySpace('accountLink', spaceId)).filter((l) => l.deleted === 0);
}

/** #152: the link's type wins: a global account has no meaningful type, each space decides at attach time */
export const linkEffectiveType = (link: AccountLinkRow, account: AccountRow): AccountType =>
  link.type ?? account.type;

// accountId -> stamped type (absent = regular) for own and attached accounts (R1, #152),
// plus the FUNDING accounts, whose transactions this space never shows
interface SpaceAccountFacts {
  stamps: Map<string, TxType>;
  funding: Set<string>;
  /** #133: what each account means as a counterparty, for the per-row type derivation at the join */
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

/** #133: the view's txType is derived, row and parts alike, never stored; the adjustment marker is the row's own field */
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
  // #228: entries of a spread carry no counterparties: each derives with the owner's link,
  // so a settled movement row's entries still read as their family
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

export async function visibleTransactions(store: StorageBackend, spaceId: string): Promise<SpaceTx[]> {
  const [own, links, metas, space] = await Promise.all([
    store.bySpace('transaction', spaceId),
    spaceAccountLinks(store, spaceId),
    store.bySpace('txMeta', spaceId),
    store.get('space', spaceId),
  ]);
  // the space's own rows respect the history start too: stored in full, filtered at display like attached feed rows
  const startGate = space?.historyStartDate;
  const { stamps, funding, counter } = await accountFacts(store, spaceId, links);
  // #152: funding accounts complete the counterparty picture; their transactions never enter the space's lists
  const ownRows = own.filter(
    (t) => t.deleted === 0 && !funding.has(t.accountId) && (!startGate || t.date >= startGate),
  );
  const metaByTx = new Map(metas.filter((m) => m.deleted === 0).map((m) => [m.txId, m]));

  const facts = { stamps, funding, counter };
  const out: SpaceTx[] = ownRows.map((t) => deriveViewTypes({ ...t }, facts));
  for (const link of links) {
    if (funding.has(link.accountId)) continue;
    // #259: a link without its own gate (the server's connect-time mirror op carries none) falls back to the space start date,
    // so the setting governs on every device
    const gate = link.historyFrom ?? startGate;
    const feedTxs = (await store.bySpace('transaction', link.feedSpaceId)).filter(
      (t) => t.deleted === 0 && t.accountId === link.accountId && (!gate || t.date >= gate),
    );
    for (const raw of feedTxs) out.push(deriveViewTypes(joinTx(raw, metaByTx.get(raw.id), spaceId, link.feedSpaceId), facts));
  }
  return foldEntries(out);
}

// date gates lifted: recurring detection needs pre-start charges (yearly subscriptions) that the display gate hides
// deletion and attachment rules still apply; the extra rows are pattern evidence, never in the space's lists
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
  link?: AccountLinkRow;
  /** #547: what this space's own entries add on top of the bank's balance; absent when none count */
  entriesCents?: number;
  /** #547: the balance as the bank (or the statement) gives it, when entries count on top of it */
  bankBalanceCents?: number;
}

// #547: entries change the balance only inside this space: bank number + counting entries, in the join, never stored
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

/** own in-space accounts + attached feed accounts, with the attachment's type (#152) and name (#239) opinions applied */
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

/** #545: visibleAccounts' name and type for an attached account; a row the space does not attach keeps its own */
export async function asSpaceAccount(
  store: StorageBackend,
  spaceId: string,
  account: AccountRow | undefined,
): Promise<SpaceAccount | undefined> {
  if (!account || account.spaceId === spaceId) return account;
  const link = (await spaceAccountLinks(store, spaceId)).find((l) => l.accountId === account.id);
  return link ? { ...account, name: link.displayName || account.name, type: linkEffectiveType(link, account), link } : account;
}

export type TxTransformFields = Partial<
  Pick<
    TxMetaRow,
    'catId' | 'needsReview' | 'notes' | 'titleOverride' | 'cats' | 'splits' | 'reimbursements' | 'linkedAccountId' | 'transferPeerId' | 'recurringId' | 'eventId' | 'loanCounted' | 'splitRef'
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

// planned off fresh merged state: the caller's snapshot may hold a stale transferPeerId or miss a just-written loanCounted
// a loanCounted in the SAME write gates this link's mint (match sheet's count-it-in chip): fields overlay the stored value
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

// part-level mirror plans: a part gaining, moving or losing its counterparty mints or retires its own counter leg
// keyed on row+part identity so it survives sibling edits; a linked part's amount change resizes it (#228)
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

// a part arriving with a FOREIGN transferPeerId (the fold's relocated pick-existing link, #228) is a picked real row:
// it rides through and nothing is minted
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

// single write path for transformation edits: feed rows get their overlay (deterministic id), own rows write in place
// mirror minting lives here: every linkedAccountId writer mints or retires the manual counter leg once, per row and per part
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

