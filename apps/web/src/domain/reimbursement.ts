import type { TransactionRow, TxReimbursement, TxSplit, TxSplitCat } from '@/db/types';
import { EXPECTED_REIMBURSE_ID, RECEIVED_REIMBURSE_ID, REIMBURSED_ID, UNCATEGORIZED_ID } from '@/domain/categories';

/**
 * Reimbursement math. The expense transaction owns the links; amounts are
 * integer cents and always positive. An expense can never be reimbursed
 * beyond its own size, and a credit can never give more than it is worth.
 */

/** total cents already reimbursed against an expense */
export function totalReimbursedCents(tx: Pick<TransactionRow, 'reimbursements'>): number {
  return (tx.reimbursements ?? []).reduce((sum, r) => sum + r.amountCents, 0);
}

/** effective cost after reimbursements (expense stays <= 0) */
export function netAmountCents(tx: Pick<TransactionRow, 'amountCents' | 'reimbursements'>): number {
  if (tx.amountCents >= 0) return tx.amountCents;
  return Math.min(0, tx.amountCents + totalReimbursedCents(tx));
}

/** cents of the expense still open for reimbursement */
export function remainingCents(tx: Pick<TransactionRow, 'amountCents' | 'reimbursements'>): number {
  if (tx.amountCents >= 0) return 0;
  return Math.max(0, Math.abs(tx.amountCents) - totalReimbursedCents(tx));
}

/**
 * Clamp a requested link amount to what is actually possible:
 * bounded by the open remainder of the expense and the size of the credit.
 * Returns 0 when the pair cannot be linked at all.
 */
export function clampReimbursement(
  expense: Pick<TransactionRow, 'amountCents' | 'reimbursements'>,
  creditAmountCents: number,
  requestedCents: number,
): number {
  if (expense.amountCents >= 0 || creditAmountCents <= 0 || requestedCents <= 0) return 0;
  return Math.min(requestedCents, remainingCents(expense), creditAmountCents);
}

/** add or replace the link for one credit tx — keyed per (credit, PART)
 *  since #126 r5: the same credit can pay different parts back */
export function withLink(
  reimbursements: TxReimbursement[] | undefined,
  txId: string,
  amountCents: number,
  partId?: string,
): TxReimbursement[] {
  const rest = (reimbursements ?? []).filter((r) => r.txId !== txId || r.partId !== partId);
  return amountCents > 0 ? [...rest, { txId, amountCents, ...(partId ? { partId } : {}) }] : rest;
}

/**
 * Cents a credit has given away as reimbursements. Derived — the
 * expense rows own the links, the credit carries nothing itself.
 */
export function givenCents(
  allTxs: readonly Pick<TransactionRow, 'reimbursements'>[],
  creditId: string,
): number {
  let sum = 0;
  for (const tx of allTxs) {
    for (const link of tx.reimbursements ?? []) {
      if (link.txId === creditId) sum += link.amountCents;
    }
  }
  return sum;
}

/** what a credit is still worth after refunding elsewhere (income stays >= 0) */
export function netCreditCents(tx: Pick<TransactionRow, 'amountCents'>, given: number): number {
  if (tx.amountCents <= 0) return tx.amountCents;
  return Math.max(0, tx.amountCents - given);
}

/** the categories a settlement consumes FIRST (user rule): the expected
 *  and received reimbursement subs of the locked tree */
export const REIMB_CAT_IDS = [EXPECTED_REIMBURSE_ID, RECEIVED_REIMBURSE_ID];

/**
 * Rewrite a transaction's category attribution for a given settled
 * amount (reimbursement redesign, docs/reimbursement-redesign.md):
 * slices carry the GROSS attribution and the settled value sits in an
 * explicit `reimbursed` slice on BOTH sides of a link — no more
 * categories silently shrinking to €0.
 *
 * Growing the settled amount consumes the other slices in priority
 * order: expected/received reimbursement first, then uncategorized,
 * then the largest slice (ties alphabetically by name). Shrinking it
 * (a link removed/reduced) frees the value onto "uncategorized" —
 * deliberately NOT the original category, per the user's rule.
 *
 * Legacy rows (pre-redesign) carried NET slices; the shortfall against
 * the gross amount IS their previously settled value, so normalization
 * tops the `reimbursed` slice up first — one pass through here migrates
 * any old row.
 */
export function settledSplits(
  tx: Pick<TransactionRow, 'amountCents' | 'catId' | 'splits'>,
  reimbursedCents: number,
  nameOf: (catId: string) => string,
): TxSplit[] {
  const primary = tx.catId ?? UNCATEGORIZED_ID;
  const grossAbs = Math.abs(tx.amountCents);
  const seeded: TxSplit[] = tx.splits?.length
    ? tx.splits.map((s) => ({ ...s }))
    : [{ catId: primary, amountCents: grossAbs }];
  return settlePartition(seeded, primary, grossAbs, reimbursedCents, nameOf);
}

/**
 * #211 twin for a WHOLE row: the settlement lives in the row's own
 * category partition (`cats`) — same rules, same gross invariant. A
 * stored pct never survives settlement (the shape is no longer the
 * user's own spread), so entries come out as plain materialized cents —
 * but an entry's counterparty (#133 r4) is its story and stays; the
 * mirror engine resizes the pot leg if settlement consumed from it.
 */
export function settledCats(
  tx: Pick<TransactionRow, 'amountCents' | 'catId' | 'cats'>,
  reimbursedCents: number,
  nameOf: (catId: string) => string,
): TxSplitCat[] {
  const primary = tx.catId ?? UNCATEGORIZED_ID;
  const grossAbs = Math.abs(tx.amountCents);
  const seeded: TxSplitCat[] = tx.cats?.length
    ? tx.cats.map((c) => ({
        catId: c.catId,
        amountCents: c.amountCents,
        ...(c.linkedAccountId ? { linkedAccountId: c.linkedAccountId } : {}),
        ...(c.transferPeerId ? { transferPeerId: c.transferPeerId } : {}),
      }))
    : [{ catId: primary, amountCents: grossAbs }];
  return settlePartition(seeded, primary, grossAbs, reimbursedCents, nameOf);
}

/** the shared settlement rewrite over a flat category partition */
function settlePartition<T extends { catId: string; amountCents: number }>(
  slices: (T | { catId: string; amountCents: number })[],
  primary: string,
  grossAbs: number,
  reimbursedCents: number,
  nameOf: (catId: string) => string,
): T[] {
  const target = Math.min(Math.max(0, reimbursedCents), grossAbs);
  let reimbursed = slices.find((s) => s.catId === REIMBURSED_ID);
  if (!reimbursed) {
    reimbursed = { catId: REIMBURSED_ID, amountCents: 0 };
    slices.push(reimbursed);
  }
  // legacy NET rows: the missing value was settled away before the
  // redesign — restore it as reimbursed so the sum is the gross again
  const sum = slices.reduce((total, s) => total + s.amountCents, 0);
  if (sum < grossAbs) reimbursed.amountCents += grossAbs - sum;

  const delta = target - reimbursed.amountCents;
  if (delta < 0) {
    // settled value coming back: it lands on uncategorized, never the
    // original category (user rule)
    reimbursed.amountCents = target;
    const uncat = slices.find((s) => s.catId === UNCATEGORIZED_ID);
    if (uncat) uncat.amountCents += -delta;
    else slices.push({ catId: UNCATEGORIZED_ID, amountCents: -delta });
  } else if (delta > 0) {
    consumeIntoReimbursed(slices, reimbursed, delta, nameOf);
  }

  const kept = slices.filter((s) => s.amountCents > 0);
  return (kept.length > 0 ? kept : [{ catId: primary, amountCents: 0 }]) as T[];
}

/** move `delta` cents from the other slices into `reimbursed`, in the
 *  user-ruled order: expected/received → uncategorized → largest slice
 *  (ties alphabetically by name) */
type FlatSlice = { catId: string; amountCents: number };
function consumeIntoReimbursed(slices: FlatSlice[], reimbursed: FlatSlice, delta: number, nameOf: (catId: string) => string): void {
  const takeFrom = (slice: FlatSlice | undefined) => {
    if (!slice || delta <= 0) return;
    const taken = Math.min(slice.amountCents, delta);
    slice.amountCents -= taken;
    reimbursed.amountCents += taken;
    delta -= taken;
  };
  for (const id of REIMB_CAT_IDS) takeFrom(slices.find((s) => s.catId === id));
  takeFrom(slices.find((s) => s.catId === UNCATEGORIZED_ID));
  while (delta > 0) {
    const candidates = slices.filter((s) => s.amountCents > 0 && s.catId !== REIMBURSED_ID);
    if (candidates.length === 0) break;
    candidates.sort((a, b) => b.amountCents - a.amountCents || nameOf(a.catId).localeCompare(nameOf(b.catId)));
    takeFrom(candidates[0]);
  }
}

/** cents of the credit not yet promised to any expense */
export function creditRemainingCents(tx: Pick<TransactionRow, 'amountCents'>, given: number): number {
  return Math.max(0, tx.amountCents - given);
}

/** still waiting on settlement (redesign): an expected/received slice
 *  with value left — settled rows carry only `reimbursed` and drop out.
 *  #211: the partition lives in `splits` on containers, `cats` on rows. */
export function hasUnsettledReimbursement(tx: Pick<TransactionRow, 'amountCents' | 'catId' | 'cats' | 'splits'>): boolean {
  const partition = tx.splits?.length ? tx.splits : tx.cats;
  if (partition?.length) return partition.some((s) => REIMB_CAT_IDS.includes(s.catId) && s.amountCents > 0);
  return !!tx.catId && REIMB_CAT_IDS.includes(tx.catId) && tx.amountCents !== 0;
}
