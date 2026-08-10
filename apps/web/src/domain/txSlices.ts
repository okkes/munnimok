import type { TransactionRow, TxSplit, TxType } from '@/db/types';
import { REIMBURSED_ID } from './categories';

/**
 * The canonical slice fan-out (typed-splits v2, approved plan): every
 * reader that aggregates by category, type or event walks a row's PARTS
 * through this one helper. An unsplit row is one view of the whole; a
 * split row is exactly its parts — the parent is a container (R4) and
 * contributes nothing itself. Amounts come out SIGNED (the row's sign
 * applied to the part magnitudes), so consumers keep their existing
 * sign math.
 */
export interface TxSliceView {
  /** signed cents — the row's sign applied to the part's magnitude */
  amountCents: number;
  catId: string | undefined;
  /** the part's effective type: its own, else the row's */
  effType: TxType;
  eventId: string | undefined;
  recurringId: string | undefined;
  linkedAccountId: string | undefined;
  transferPeerId: string | undefined;
  /** stable part id when the part carries one (typed parts do) */
  sliceId: string | undefined;
  /** the user's stored label; display defaults are the caller's job */
  label: string | undefined;
  index: number;
  count: number;
}

type SliceSource = Pick<
  TransactionRow,
  'amountCents' | 'catId' | 'txType' | 'eventId' | 'recurringId' | 'linkedAccountId' | 'transferPeerId' | 'splits'
>;

export function txSliceViews(tx: SliceSource): TxSliceView[] {
  const parts = tx.splits?.filter((s) => s.amountCents !== 0);
  if (!parts?.length) {
    return [
      {
        amountCents: tx.amountCents,
        catId: tx.catId,
        effType: tx.txType,
        eventId: tx.eventId,
        recurringId: tx.recurringId,
        linkedAccountId: tx.linkedAccountId,
        transferPeerId: tx.transferPeerId,
        sliceId: undefined,
        label: undefined,
        index: 0,
        count: 1,
      },
    ];
  }
  const sign = tx.amountCents < 0 ? -1 : 1;
  const views = parts.flatMap((part) => {
    const base = {
      effType: part.txType ?? tx.txType,
      // a part without its own event still belongs to the row's (the
      // row-level attachment predates per-part events and stays honest);
      // recurring links inherit the same way (#126 r7)
      eventId: part.eventId ?? tx.eventId,
      recurringId: part.recurringId ?? tx.recurringId,
      linkedAccountId: part.linkedAccountId,
      transferPeerId: part.transferPeerId,
      sliceId: part.id,
      label: part.label,
    };
    // v2.1: a part spread across categories fans one view per category
    // entry — the part's story (type/link/event/label) rides on each
    const cats = part.cats?.filter((c) => c.amountCents !== 0);
    if (cats?.length) {
      return cats.map((c) => ({
        ...base,
        amountCents: sign * Math.abs(c.amountCents),
        catId: c.catId,
      }));
    }
    return [{ ...base, amountCents: sign * Math.abs(part.amountCents), catId: part.catId }];
  });
  return views.map((view, index) => ({ ...view, index, count: views.length }));
}

/** does ANY part of this row carry the given effective type? (filters) */
export const hasSliceOfType = (tx: SliceSource, txType: TxType): boolean =>
  txSliceViews(tx).some((view) => view.effType === txType);

// conflictingPartKinds retired 2026-08-07 (#126 r7, user rule): NO
// restriction on a split beyond the amounts summing — parts repeat any
// kind freely; incompleteness surfaces as attention marks, not refusals.

/**
 * The presentation discriminator (v2.1): a split renders as PARTS (labels,
 * spine, type chips) only when some part actually tells a part story —
 * its own type, link, event, label or category spread. A plain
 * multi-category assignment keeps the classic slice look everywhere.
 * `id` deliberately doesn't count: the editor mints ids on every save.
 */
export const hasTypedParts = (tx: Pick<TransactionRow, 'splits'>): boolean =>
  !!tx.splits?.some(
    (s) => s.label !== undefined || s.txType !== undefined || s.linkedAccountId !== undefined
      || s.eventId !== undefined || !!s.cats?.length,
  );

/** floor + largest remainder: `weights` partitioned onto `targetCents`,
 *  summing exactly — the same fairness rule the pct editor uses */
function largestRemainder(weights: readonly number[], weightTotal: number, targetCents: number): number[] {
  const raw = weights.map((w) => (w * targetCents) / weightTotal);
  const floors = raw.map(Math.floor);
  let rest = targetCents - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((value, i) => ({ frac: value - Math.floor(value), i })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i] += 1;
    rest -= 1;
  }
  return floors;
}

/**
 * #141: the same split, resized for a sibling — a proportional largest-
 * remainder partition of the target's amount. Category spreads scale
 * within each part; transaction-specific stories (linked accounts,
 * events, recurring links, notes) never copy; ids mint fresh so two
 * rows never share part identities.
 */
export function scaleSplitsTo(source: readonly TxSplit[], targetAbsCents: number, mintId: () => string): TxSplit[] {
  const parts = source.filter((s) => s.catId !== REIMBURSED_ID);
  const weightTotal = parts.reduce((sum, s) => sum + Math.abs(s.amountCents), 0);
  if (parts.length < 2 || weightTotal <= 0 || targetAbsCents <= 0) return [];
  const partition = largestRemainder(parts.map((s) => Math.abs(s.amountCents)), weightTotal, targetAbsCents);
  return parts.map((s, i) => {
    const cats = s.cats?.length ? scaleCatsTo(s.cats, partition[i]) : undefined;
    return {
      id: mintId(),
      catId: s.catId,
      amountCents: partition[i],
      ...(s.label ? { label: s.label } : {}),
      // a type that leans on a linked account is that transaction's own
      // reality — the bare special types (saving, debtPayment…) travel
      ...(s.txType && !s.linkedAccountId ? { txType: s.txType } : {}),
      ...(cats ? { cats } : {}),
    };
  });
}

function scaleCatsTo(cats: NonNullable<TxSplit['cats']>, partCents: number): TxSplit['cats'] {
  const total = cats.reduce((sum, c) => sum + Math.abs(c.amountCents), 0);
  if (total <= 0) return undefined;
  const partition = largestRemainder(cats.map((c) => Math.abs(c.amountCents)), total, partCents);
  return cats.map((c, i) => ({ catId: c.catId, amountCents: partition[i] }));
}
