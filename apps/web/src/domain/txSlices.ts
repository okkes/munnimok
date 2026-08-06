import type { TransactionRow, TxType } from '@/db/types';

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
  'amountCents' | 'catId' | 'txType' | 'eventId' | 'linkedAccountId' | 'transferPeerId' | 'splits'
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
      // row-level attachment predates per-part events and stays honest)
      eventId: part.eventId ?? tx.eventId,
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
