import type { TxSplit, TxType, TxView } from '@/db/types';
import { REIMBURSED_ID } from './categories';

// every category/type/event aggregate walks a row's parts through this: a split row is only its parts (R4),
// amounts come out signed
export interface TxSliceView {
  /** signed cents — the row's sign applied to the part's magnitude */
  amountCents: number;
  catId: string | undefined;
  effType: TxType;
  eventId: string | undefined;
  recurringId: string | undefined;
  linkedAccountId: string | undefined;
  transferPeerId: string | undefined;
  sliceId: string | undefined;
  /** the user's stored label; display defaults are the caller's job */
  label: string | undefined;
  /** true for a container PART (#211): parts aggregate as magnitudes, a whole row signed so refunds keep reducing spend */
  fromParts: boolean;
  /** the part itself, on a part's views — lists show the part the counted money came from (#579) */
  part?: TxSplit;
  index: number;
  count: number;
}

type SliceSource = Pick<
  TxView,
  'amountCents' | 'catId' | 'cats' | 'txType' | 'eventId' | 'recurringId' | 'linkedAccountId' | 'transferPeerId' | 'splits'
>;

export function txSliceViews(tx: SliceSource): TxSliceView[] {
  const parts = tx.splits?.filter((s) => s.amountCents !== 0);
  if (!parts?.length) {
    const whole = {
      effType: tx.txType,
      eventId: tx.eventId,
      recurringId: tx.recurringId,
      linkedAccountId: tx.linkedAccountId,
      transferPeerId: tx.transferPeerId,
      sliceId: undefined,
      label: undefined,
      fromParts: false,
    };
    // #211: a split-category row stays ONE transaction: each entry keeps the row's whole story, only attribution fans (#228)
    const rowCats = tx.cats?.filter((c) => c.amountCents !== 0);
    if (rowCats?.length) {
      const rowSign = tx.amountCents < 0 ? -1 : 1;
      return rowCats.map((c, index) => ({
        ...whole,
        amountCents: rowSign * Math.abs(c.amountCents),
        catId: c.catId,
        effType: c.txType ?? whole.effType,
        index,
        count: rowCats.length,
      }));
    }
    return [{ ...whole, amountCents: tx.amountCents, catId: tx.catId, index: 0, count: 1 }];
  }
  const sign = tx.amountCents < 0 ? -1 : 1;
  const views = parts.flatMap((part) => {
    const base = {
      effType: part.txType ?? tx.txType,
      // a part without its own event or recurring link inherits the row's (#126)
      eventId: part.eventId ?? tx.eventId,
      recurringId: part.recurringId ?? tx.recurringId,
      linkedAccountId: part.linkedAccountId,
      transferPeerId: part.transferPeerId,
      sliceId: part.id,
      label: part.label,
      fromParts: true,
      part,
    };
    // a part spread across categories fans one view per category, each carrying the part's type/link/event/label (#228)
    const cats = part.cats?.filter((c) => c.amountCents !== 0);
    if (cats?.length) {
      return cats.map((c) => ({
        ...base,
        amountCents: sign * Math.abs(c.amountCents),
        catId: c.catId,
        effType: c.txType ?? base.effType,
      }));
    }
    return [{ ...base, amountCents: sign * Math.abs(part.amountCents), catId: part.catId }];
  });
  return views.map((view, index) => ({ ...view, index, count: views.length }));
}

export const hasSliceOfType = (tx: SliceSource, txType: TxType): boolean =>
  txSliceViews(tx).some((view) => view.effType === txType);

// no restriction on a split beyond the amounts summing: parts repeat any kind;
// incompleteness shows as attention marks (#126)

/** floor + largest remainder: partitions `weights` onto `targetCents` summing exactly, like the pct editor */
export function largestRemainder(weights: readonly number[], weightTotal: number, targetCents: number): number[] {
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

// #141: a split resized for a sibling; ids mint fresh, transaction-specific stories (links, events, recurring, notes)
// never copy
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
      // a type that leans on a linked account belongs to that transaction alone; the bare special types travel
      ...(s.txType && !s.linkedAccountId ? { txType: s.txType } : {}),
      ...(cats ? { cats } : {}),
    };
  });
}

export function scaleCatsTo(cats: NonNullable<TxSplit['cats']>, partCents: number): TxSplit['cats'] {
  const total = cats.reduce((sum, c) => sum + Math.abs(c.amountCents), 0);
  if (total <= 0) return undefined;
  const partition = largestRemainder(cats.map((c) => Math.abs(c.amountCents)), total, partCents);
  return cats.map((c, i) => ({ catId: c.catId, amountCents: partition[i] }));
}
