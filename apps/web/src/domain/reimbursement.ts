import type { TransactionRow, TxReimbursement, TxSplit, TxSplitCat } from '@/db/types';
import { EXPECTED_REIMBURSE_ID, RECEIVED_REIMBURSE_ID, REIMBURSED_ID, UNCATEGORIZED_ID, specialCatType } from '@/domain/categories';

// the expense owns the links; amounts are positive integer cents

export function totalReimbursedCents(tx: Pick<TransactionRow, 'reimbursements'>): number {
  return (tx.reimbursements ?? []).reduce((sum, r) => sum + r.amountCents, 0);
}

export function netAmountCents(tx: Pick<TransactionRow, 'amountCents' | 'reimbursements'>): number {
  if (tx.amountCents >= 0) return tx.amountCents;
  return Math.min(0, tx.amountCents + totalReimbursedCents(tx));
}

export function remainingCents(tx: Pick<TransactionRow, 'amountCents' | 'reimbursements'>): number {
  if (tx.amountCents >= 0) return 0;
  return Math.max(0, Math.abs(tx.amountCents) - totalReimbursedCents(tx));
}

export function clampReimbursement(
  expense: Pick<TransactionRow, 'amountCents' | 'reimbursements'>,
  creditAmountCents: number,
  requestedCents: number,
): number {
  if (expense.amountCents >= 0 || creditAmountCents <= 0 || requestedCents <= 0) return 0;
  return Math.min(requestedCents, remainingCents(expense), creditAmountCents);
}

/** keyed per (credit, part, credit part): one credit can pay different parts back (#126) */
export function withLink(
  reimbursements: TxReimbursement[] | undefined,
  txId: string,
  amountCents: number,
  partId?: string,
  creditPartId?: string,
): TxReimbursement[] {
  const rest = (reimbursements ?? []).filter((r) => r.txId !== txId || r.partId !== partId || r.creditPartId !== creditPartId);
  return amountCents > 0
    ? [...rest, { txId, amountCents, ...(partId ? { partId } : {}), ...(creditPartId ? { creditPartId } : {}) }]
    : rest;
}

/** derived: the expense rows own the links, the credit carries nothing itself */
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

/** #197: only links naming the part explicitly; whole-credit links never count here */
export function creditPartGivenCents(
  allTxs: readonly Pick<TransactionRow, 'reimbursements'>[],
  creditId: string,
  creditPartId: string,
): number {
  let sum = 0;
  for (const tx of allTxs) {
    for (const link of tx.reimbursements ?? []) {
      if (link.txId === creditId && link.creditPartId === creditPartId) sum += link.amountCents;
    }
  }
  return sum;
}

export function netCreditCents(tx: Pick<TransactionRow, 'amountCents'>, given: number): number {
  if (tx.amountCents <= 0) return tx.amountCents;
  return Math.max(0, tx.amountCents - given);
}

/** consumed first by a settlement: the expected and received reimbursement subs */
export const REIMB_CAT_IDS = [EXPECTED_REIMBURSE_ID, RECEIVED_REIMBURSE_ID];

// settled value sits in an explicit `reimbursed` slice on both sides of a link; slices carry the gross attribution
// settling eats expected/received, uncategorized, then the largest slice (ties by name); unsettling frees onto uncategorized
// #228: a special category owning the row keeps it canonical: it holds the unsettled rest and gets freed value back
export function settledCats(
  tx: Pick<TransactionRow, 'amountCents' | 'catId' | 'cats'>,
  reimbursedCents: number,
  nameOf: (catId: string) => string,
): TxSplitCat[] {
  const primary = tx.catId ?? UNCATEGORIZED_ID;
  const grossAbs = Math.abs(tx.amountCents);
  const target = Math.min(Math.max(0, reimbursedCents), grossAbs);
  const real = (tx.cats ?? []).filter((c) => c.catId !== REIMBURSED_ID);
  const claimant = real.length <= 1 && specialCatType(real[0]?.catId ?? primary) ? (real[0]?.catId ?? primary) : undefined;
  if (claimant) {
    const rest = grossAbs - target;
    const canonical = [
      ...(rest > 0 ? [{ catId: claimant, amountCents: rest }] : []),
      ...(target > 0 ? [{ catId: REIMBURSED_ID, amountCents: target }] : []),
    ];
    return canonical.length > 0 ? canonical : [{ catId: claimant, amountCents: 0 }];
  }
  const seeded: TxSplitCat[] = tx.cats?.length
    ? tx.cats.map((c) => ({ catId: c.catId, amountCents: c.amountCents }))
    : [{ catId: primary, amountCents: grossAbs }];
  return settlePartition(seeded, primary, grossAbs, reimbursedCents, nameOf);
}

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

  const delta = target - reimbursed.amountCents;
  if (delta < 0) {
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

export function creditRemainingCents(tx: Pick<TransactionRow, 'amountCents'>, given: number): number {
  return Math.max(0, tx.amountCents - given);
}

// #228: a split's settle bookkeeping lives in the part's own `cats`, never on the container

export function reimbursedInCats(cats: readonly TxSplitCat[] | undefined): number {
  return (cats ?? []).filter((c) => c.catId === REIMBURSED_ID).reduce((sum, c) => sum + c.amountCents, 0);
}

/** the compat-shadow rule: the largest entry represents the partition */
const largestEntry = (entries: readonly TxSplitCat[]): TxSplitCat =>
  entries.reduce((a, b) => (b.amountCents > a.amountCents ? b : a), entries[0]);

/** positive magnitude: the container's sign gives the direction */
export function partNetCents(part: Pick<TxSplit, 'amountCents' | 'cats'>): number {
  return Math.max(0, Math.abs(part.amountCents) - reimbursedInCats(part.cats));
}

/** same rules as a whole row; an untouched bare part stays bare */
function settledPart(part: TxSplit, settled: number, nameOf: (catId: string) => string): TxSplit {
  if (settled <= 0 && !part.cats?.some((c) => c.catId === REIMBURSED_ID)) return part;
  const next = settledCats({ amountCents: part.amountCents, catId: part.catId, cats: part.cats }, settled, nameOf);
  const real = next.filter((c) => c.catId !== REIMBURSED_ID);
  if (next.length === 1 && real.length === 1) return { ...part, catId: real[0].catId, cats: undefined };
  return { ...part, cats: next, ...(real.length ? { catId: largestEntry(real).catId } : {}) };
}

/** #228: each part settles inside its own `cats`; part amounts still sum to the container's gross */
export function settleContainerParts(
  tx: Pick<TransactionRow, 'amountCents' | 'splits'>,
  centsByPartId: ReadonlyMap<string, number>,
  nameOf: (catId: string) => string,
): TxSplit[] {
  return (tx.splits ?? []).map((part) => settledPart({ ...part }, part.id ? (centsByPartId.get(part.id) ?? 0) : 0, nameOf));
}

export function isReimbContainer(tx: Pick<TransactionRow, 'splits'>): boolean {
  return (tx.splits ?? []).length > 1;
}

export interface ReimbSettlePatch {
  catId?: string;
  cats?: TxSplitCat[] | null;
  splits?: TxSplit[] | null;
}

/** the ONE builder the write hook and the every-boot normalizer share, so they cannot drift */
export function reimbSettleFields(
  tx: Pick<TransactionRow, 'amountCents' | 'catId' | 'cats' | 'splits'>,
  totalCents: number,
  centsByPartId: ReadonlyMap<string, number>,
  nameOf: (catId: string) => string,
): ReimbSettlePatch {
  if (isReimbContainer(tx)) return { splits: settleContainerParts(tx, centsByPartId, nameOf) };
  const next = settledCats(tx, totalCents, nameOf);
  const real = next.filter((c) => c.catId !== REIMBURSED_ID);
  if (next.length === 1 && real.length === 1) {
    return { catId: real[0].catId, cats: null };
  }
  return {
    cats: next,
    ...(real.length ? { catId: largestEntry(real).catId } : {}),
  };
}

/** container-level cents (a link made before the row was split) land on the largest open part */
export function reimbCentsByPart(
  links: readonly TxReimbursement[],
  key: 'partId' | 'creditPartId',
  splits: readonly TxSplit[] | undefined,
): Map<string, number> {
  const map = new Map<string, number>();
  let loose = 0;
  for (const link of links) {
    const id = link[key];
    if (id) map.set(id, (map.get(id) ?? 0) + link.amountCents);
    else loose += link.amountCents;
  }
  if (loose > 0) {
    const target = largestOpenPartId(splits, map);
    if (target) map.set(target, (map.get(target) ?? 0) + loose);
  }
  return map;
}

/** #235: loose cents land on a part expecting reimbursement, then an uncategorized one, then the largest */
const partPreference = (part: TxSplit): number => {
  const holds = (pred: (catId: string) => boolean): boolean =>
    part.cats?.length ? part.cats.some((c) => pred(c.catId) && c.amountCents > 0) : pred(part.catId);
  if (holds((id) => REIMB_CAT_IDS.includes(id))) return 0;
  if (holds((id) => id === UNCATEGORIZED_ID)) return 1;
  return 2;
};

/** ties by array order, so both devices pick the same part */
export function largestOpenPartId(
  splits: readonly TxSplit[] | undefined,
  centsByPartId: ReadonlyMap<string, number>,
): string | undefined {
  let best: { id: string; open: number; pref: number } | undefined;
  for (const part of splits ?? []) {
    if (!part.id) continue;
    const open = part.amountCents - (centsByPartId.get(part.id) ?? 0);
    const pref = open > 0 ? partPreference(part) : 3;
    if (!best || pref < best.pref || (pref === best.pref && open > best.open)) best = { id: part.id, open, pref };
  }
  return best?.id;
}

/** waiting = an expected/received slice with value left (#211); a container answers through its parts (#228) */
export function hasUnsettledReimbursement(tx: Pick<TransactionRow, 'amountCents' | 'catId' | 'cats' | 'splits'>): boolean {
  const waiting = (catId: string, cents: number) => REIMB_CAT_IDS.includes(catId) && cents > 0;
  if (tx.splits?.length) {
    return tx.splits.some(
      (part) =>
        (part.cats?.length ? false : waiting(part.catId, part.amountCents)) ||
        part.cats?.some((c) => waiting(c.catId, c.amountCents)),
    );
  }
  if (tx.cats?.length) return tx.cats.some((c) => waiting(c.catId, c.amountCents));
  return !!tx.catId && REIMB_CAT_IDS.includes(tx.catId) && tx.amountCents !== 0;
}
