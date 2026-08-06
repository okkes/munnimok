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
  return parts.map((part, index) => ({
    amountCents: sign * Math.abs(part.amountCents),
    catId: part.catId,
    effType: part.txType ?? tx.txType,
    // a part without its own event still belongs to the row's (the
    // row-level attachment predates per-part events and stays honest)
    eventId: part.eventId ?? tx.eventId,
    linkedAccountId: part.linkedAccountId,
    transferPeerId: part.transferPeerId,
    sliceId: part.id,
    label: part.label,
    index,
    count: parts.length,
  }));
}

/** does ANY part of this row carry the given effective type? (filters) */
export const hasSliceOfType = (tx: SliceSource, txType: TxType): boolean =>
  txSliceViews(tx).some((view) => view.effType === txType);
