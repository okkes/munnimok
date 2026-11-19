import type { ReceiptLinkRow, ReceiptRow } from '@/db/types';
import { compareFits, receiptFit } from '@/domain/storeReceipts';
import type { ReceiptTx } from '@/features/shopping/receiptPick';

// auto: best match by itself (a standing proposal first, else a fitting unlinked receipt)
// picked: the person's choice; none: the person said no receipt
export type ReceiptStage = { kind: 'auto' } | { kind: 'picked'; receipt: ReceiptRow } | { kind: 'none' };

export const AUTO_STAGE: ReceiptStage = { kind: 'auto' };

/** days either side of the payment a receipt of its shop may still be its proof (an order is charged when it ships) */
export const AUTO_DAYS = 14;
/** where nothing names the shop the day has to speak for it */
export const AUTO_DAYS_UNNAMED = 2;

// #650: picked for the person only when nothing argues against it — money that went out, the amount to the cent, the shop
// the payment names (a photo nobody named: the day), and no second receipt fitting as well. Anything looser is theirs to pick
export function autoReceiptFor(tx: ReceiptTx, candidates: readonly ReceiptRow[]): ReceiptRow | null {
  if (tx.amountCents >= 0) return null;
  const fits = candidates
    .map((receipt) => ({ receipt, fit: receiptFit(receipt, tx) }))
    .filter(({ fit }) => fit.gapCents === 0 && fit.party !== 'other' && fit.days <= (fit.party === 'same' ? AUTO_DAYS : AUTO_DAYS_UNNAMED))
    .sort((a, b) => compareFits(a.fit, b.fit));
  if (fits.length === 0) return null;
  if (fits.length > 1 && compareFits(fits[0].fit, fits[1].fit) === 0) return null;
  return fits[0].receipt;
}

export function markedReceiptId(stage: ReceiptStage, attachedId: string | null | undefined, autoId: string | null | undefined): string | null {
  if (stage.kind === 'picked') return stage.receipt.id;
  if (stage.kind === 'none') return null;
  return attachedId ?? autoId ?? null;
}

/** the receipt the transaction holds once the card is confirmed as it stands — the one whose lines may file it (#567) */
export function cardReceipt(
  stage: ReceiptStage,
  attached: ReceiptRow | null | undefined,
  proposal: ReceiptLinkRow | undefined,
  auto: ReceiptRow | null,
): Pick<ReceiptRow, 'id' | 'totalCents' | 'items'> | null {
  if (stage.kind === 'none') return null;
  if (stage.kind === 'picked') return stage.receipt;
  if (attached) return attached;
  if (proposal) return { id: proposal.receiptId ?? proposal.id, totalCents: proposal.totalCents, items: proposal.items };
  return auto;
}

export type ReceiptSettlement =
  | { kind: 'keep' }
  | { kind: 'accept'; proposal: ReceiptLinkRow }
  | { kind: 'reject'; proposal: ReceiptLinkRow }
  | { kind: 'pick'; receipt: ReceiptRow | null; reject?: ReceiptLinkRow };

// #496: an attached receipt can be changed on the card: another pick replaces it, "no receipt" lets it go
// a passed-over proposal is rejected
export function receiptSettlement(
  stage: ReceiptStage,
  attached: ReceiptRow | null | undefined,
  proposal: ReceiptLinkRow | undefined,
  auto: ReceiptRow | null,
): ReceiptSettlement {
  if (attached) {
    if (stage.kind === 'picked' && stage.receipt.id !== attached.id) return { kind: 'pick', receipt: stage.receipt };
    return stage.kind === 'none' ? { kind: 'pick', receipt: null } : { kind: 'keep' };
  }
  if (stage.kind === 'picked') {
    if (proposal && (proposal.receiptId ?? proposal.id) === stage.receipt.id) return { kind: 'accept', proposal };
    return { kind: 'pick', receipt: stage.receipt, reject: proposal };
  }
  if (stage.kind === 'none') return proposal ? { kind: 'reject', proposal } : { kind: 'keep' };
  if (proposal) return { kind: 'accept', proposal };
  return auto ? { kind: 'pick', receipt: auto } : { kind: 'keep' };
}
