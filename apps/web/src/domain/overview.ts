import type { AccountRow, TxType, TxView } from '@/db/types';
import { REIMBURSED_ID, mainCatOf } from './categories';
import { inPeriod } from './periods';
import { txSliceViews } from './txSlices';
import type { TxSliceView } from './txSlices';
import { accountStamp } from './txType';
import type { Period } from './periods';

// family buckets (saved, debt, invested, funded) come from the SPECIAL CATEGORIES; the sub carries the direction
// a linked pair never double-counts: its regular leg wears the locked Transfer category
// the settled `reimbursed` value is bookkeeping on both sides of a link: expense counts net, the credit is no income

export type OverviewKind = 'income' | 'expense' | 'saving' | 'investment' | 'funding' | 'debt';

export const OVERVIEW_KINDS: OverviewKind[] = ['income', 'expense', 'saving', 'investment', 'funding', 'debt'];

const FAMILY_MAIN: Partial<Record<OverviewKind, string>> = {
  saving: 'saving',
  investment: 'investment',
  funding: 'funding',
  debt: 'debt',
};

/** +1 = money entered the family's story, −1 = it left; the SUB carries the direction, whichever leg */
const SPECIAL_CONTRIB: Record<string, 1 | -1> = {
  savingDeposit: 1,
  savingWithdraw: -1,
  savingInterest: 1,
  savingFees: -1,
  loanRepayment: 1,
  debtBorrowed: -1,
  debtInterest: -1,
  debtFees: -1,
  investContribution: 1,
  investWithdraw: -1,
  investDividend: 1,
  investFees: -1,
  fundingOut: 1, // -500 into the family pot = +500 funded (user rule)
  fundingIn: -1,
};

const countableViews = (tx: TxView): TxSliceView[] => txSliceViews(tx).filter((view) => view.catId !== REIMBURSED_ID);

function viewInKind(kind: OverviewKind, view: TxSliceView): boolean {
  const familyMain = FAMILY_MAIN[kind];
  if (familyMain) return mainCatOf(view.catId) === familyMain;
  // income/expense: type-driven, minus the funding family (standard-
  // typed since the type retired, but the pot is not income/spending)
  return view.effType === kind && mainCatOf(view.catId) !== 'funding';
}

function viewContribution(kind: OverviewKind, view: TxSliceView, tx: TxView, accountsById?: Map<string, AccountRow>): number {
  switch (kind) {
    case 'income':
      return view.amountCents; // income parts are positive by construction
    case 'expense':
      return -view.amountCents; // spent is a positive number; refunds reduce it
    default: {
      const sign = SPECIAL_CONTRIB[view.catId ?? ''];
      if (sign !== undefined) return sign * Math.abs(view.amountCents);
      // invest Buy/Sell/General on the brokerage's OWN ledger move cash
      // within the account — no new money invested, no bucket movement
      if (kind === 'investment' && accountStamp(accountsById?.get(tx.accountId)?.type)) return 0;
      return -view.amountCents; // legacy family rows: the checking-side flip
    }
  }
}

// an UNSPLIT row keeps the classic contract: membership is the caller's txsForKind filter
export function contributionCents(kind: OverviewKind, tx: TxView, accountsById?: Map<string, AccountRow>): number {
  return countableViews(tx)
    .filter((view) => !view.fromParts || viewInKind(kind, view))
    .reduce((sum, view) => sum + viewContribution(kind, view, tx, accountsById), 0);
}

// #455: what a goal cashed out (both legs) leaves the saving bucket: spending saved money on its goal is no setback
function rowsForKind(kind: OverviewKind, txs: TxView[], period: Period, cashedOut?: ReadonlySet<string>): TxView[] {
  return txs.filter(
    (tx) =>
      tx.deleted === 0 &&
      inPeriod(tx.date, period) &&
      !(kind === 'saving' && cashedOut?.has(tx.id)) &&
      countableViews(tx).some((view) => viewInKind(kind, view)),
  );
}

export function txsForKind(
  kind: OverviewKind,
  txs: TxView[],
  accountsById: Map<string, AccountRow>,
  period: Period,
  cashedOut?: ReadonlySet<string>,
): TxView[] {
  return collapsePairedLegs(kind, rowsForKind(kind, txs, period, cashedOut), accountsById).kept;
}

/** the ledger a family's rows are stamped by: the leg that carries the meaning when a linked pair lands in the bucket twice */
const FAMILY_STAMP: Partial<Record<OverviewKind, TxType>> = { saving: 'saving', investment: 'investment', debt: 'debtPayment' };

// a linked pair whose legs BOTH land in a family bucket counts once: the family ledger's leg, else the positive one
// income and expense stay untouched: a pair there is a transfer wearing the wrong category, the person's to fix
export function collapsePairedLegs(
  kind: OverviewKind,
  rows: TxView[],
  accountsById: Map<string, AccountRow>,
): { kept: TxView[]; counterparts: Map<string, TxView> } {
  const counterparts = new Map<string, TxView>();
  if (!FAMILY_MAIN[kind]) return { kept: rows, counterparts };
  const byId = new Map(rows.map((row) => [row.id, row]));
  const reverse = new Map<string, TxView>();
  for (const row of rows) {
    if (row.transferPeerId && byId.has(row.transferPeerId)) reverse.set(row.transferPeerId, row);
  }
  const stamp = FAMILY_STAMP[kind];
  const onLedger = (row: TxView) => !!stamp && accountStamp(accountsById.get(row.accountId)?.type) === stamp;
  const dropped = new Set<string>();
  const settled = (id: string) => dropped.has(id) || counterparts.has(id);
  for (const row of rows) {
    if (settled(row.id)) continue;
    const peer = peerOf(row, byId, reverse);
    if (!peer || settled(peer.id)) continue;
    const keep = countingLeg(row, peer, onLedger);
    const drop = keep === row ? peer : row;
    dropped.add(drop.id);
    counterparts.set(keep.id, drop);
  }
  return { kept: dropped.size === 0 ? rows : rows.filter((row) => !dropped.has(row.id)), counterparts };
}

function peerOf(row: TxView, byId: Map<string, TxView>, reverse: Map<string, TxView>): TxView | undefined {
  const peer = (row.transferPeerId ? byId.get(row.transferPeerId) : undefined) ?? reverse.get(row.id);
  return peer && peer.id !== row.id ? peer : undefined;
}

/** the leg that counts: the family ledger's, else the positive one */
function countingLeg(row: TxView, peer: TxView, onLedger: (tx: TxView) => boolean): TxView {
  const mine = onLedger(row);
  const theirs = onLedger(peer);
  if (mine !== theirs) return mine ? row : peer;
  return row.amountCents < peer.amountCents ? peer : row;
}

export interface OverviewSummary {
  incomeCents: number;
  expenseCents: number;
  savingCents: number;
  investmentCents: number;
  fundingCents: number;
  debtCents: number;
}

export function overviewSummarySeries(
  txs: TxView[],
  accountsById: Map<string, AccountRow>,
  periods: readonly Period[],
  cashedOut?: ReadonlySet<string>,
): OverviewSummary[] {
  return periods.map((period) => overviewSummary(txs, accountsById, period, cashedOut));
}

export function overviewSummary(
  txs: TxView[],
  accountsById: Map<string, AccountRow>,
  period: Period,
  cashedOut?: ReadonlySet<string>,
): OverviewSummary {
  const total = (kind: OverviewKind) =>
    txsForKind(kind, txs, accountsById, period, cashedOut).reduce((sum, tx) => sum + contributionCents(kind, tx, accountsById), 0);
  return {
    incomeCents: total('income'),
    expenseCents: total('expense'),
    savingCents: total('saving'),
    investmentCents: total('investment'),
    fundingCents: total('funding'),
    debtCents: total('debt'),
  };
}

export interface CatBreakdownSub {
  catId: string;
  totalCents: number;
  count: number;
}

export interface CatBreakdownGroup {
  /** main category id (or the sub's own id when it has no parent) */
  catId: string;
  totalCents: number;
  subs: CatBreakdownSub[];
}

interface CatalogLookup {
  byId: (id: string | undefined) => { id: string; parentId?: string };
}

/** positive cents; slices under the same parent sum instead of double-counting the whole amount */
export function categoryContributionCents(
  kind: OverviewKind,
  tx: TxView,
  catId: string,
  catalog: CatalogLookup,
  accountsById?: Map<string, AccountRow>,
): number {
  let cents = 0;
  // the settled value is bookkeeping (countableViews); expected/received
  // reimbursement count under their own family (user ss 2026-10-06)
  for (const view of countableViews(tx)) {
    const cat = catalog.byId(view.catId);
    if (cat.id !== catId && cat.parentId !== catId) continue;
    // typed parts answer to their OWN kind (a loan part never lands in
    // the expense breakdown); whole rows — category spreads included
    // (#211) — keep the kind's signed math
    if (view.fromParts && !viewInKind(kind, view)) continue;
    cents += view.fromParts ? Math.abs(view.amountCents) : viewContribution(kind, view, tx, accountsById);
  }
  return cents;
}

export function txsForCategory(
  kind: OverviewKind,
  txs: TxView[],
  accountsById: Map<string, AccountRow>,
  period: Period,
  catId: string,
  catalog: CatalogLookup,
  cashedOut?: ReadonlySet<string>,
): { txs: TxView[]; totalCents: number; counterparts: Map<string, TxView> } {
  const { kept, counterparts } = collapsePairedLegs(kind, rowsForKind(kind, txs, period, cashedOut), accountsById);
  const matches = kept.filter((tx) => categoryContributionCents(kind, tx, catId, catalog, accountsById) !== 0);
  matches.sort((a, b) => b.date.localeCompare(a.date));
  const listed = new Map<string, TxView>();
  for (const tx of matches) {
    const peer = counterparts.get(tx.id);
    if (peer) listed.set(tx.id, peer);
  }
  return {
    txs: matches,
    totalCents: matches.reduce((sum, tx) => sum + categoryContributionCents(kind, tx, catId, catalog, accountsById), 0),
    counterparts: listed,
  };
}

export function categoryBreakdown(
  kind: OverviewKind,
  txs: TxView[],
  accountsById: Map<string, AccountRow>,
  period: Period,
  catalog: CatalogLookup,
  cashedOut?: ReadonlySet<string>,
): CatBreakdownGroup[] {
  const groups = new Map<string, CatBreakdownGroup & { subMap: Map<string, CatBreakdownSub> }>();
  const add = (catId: string | undefined, cents: number) => {
    const cat = catalog.byId(catId);
    const mainId = cat.parentId ?? cat.id;
    let group = groups.get(mainId);
    if (!group) {
      group = { catId: mainId, totalCents: 0, subs: [], subMap: new Map() };
      groups.set(mainId, group);
    }
    group.totalCents += cents;
    let sub = group.subMap.get(cat.id);
    if (!sub) {
      sub = { catId: cat.id, totalCents: 0, count: 0 };
      group.subMap.set(cat.id, sub);
    }
    sub.totalCents += cents;
    sub.count += 1;
  };
  for (const tx of txsForKind(kind, txs, accountsById, period, cashedOut)) {
    for (const view of countableViews(tx)) {
      if (view.fromParts && !viewInKind(kind, view)) continue;
      add(view.catId, view.fromParts ? Math.abs(view.amountCents) : viewContribution(kind, view, tx, accountsById));
    }
  }
  return [...groups.values()]
    .map(({ subMap, ...group }) => ({ ...group, subs: [...subMap.values()].sort((a, b) => b.totalCents - a.totalCents) }))
    .sort((a, b) => b.totalCents - a.totalCents);
}
