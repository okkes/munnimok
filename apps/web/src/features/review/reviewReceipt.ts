import type { SpaceTx } from '@/application/transactions';
import type { ReceiptLinkRow, ReceiptRow } from '@/db/types';
import { rankForTx } from '@/features/shopping/receiptPick';

// auto: best match by itself (a standing proposal first, else a fitting unlinked receipt)
// picked: the person's choice; none: the person said no receipt
export type ReceiptStage = { kind: 'auto' } | { kind: 'picked'; receipt: ReceiptRow } | { kind: 'none' };

export const AUTO_STAGE: ReceiptStage = { kind: 'auto' };

/** days either side of the transaction a receipt may still be its proof */
export const AUTO_DAYS = 14;

const dayOf = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

// a looser match is the person's to pick, never picked for them: amount within a euro or 1%, date within two weeks
export function autoReceiptFor(tx: Pick<SpaceTx, 'date' | 'amountCents'>, candidates: readonly ReceiptRow[]): ReceiptRow | null {
  const best = rankForTx(tx, candidates)[0];
  if (!best) return null;
  const target = Math.abs(tx.amountCents);
  const tolerance = Math.max(100, Math.round(target * 0.01));
  const fits = Math.abs(best.totalCents - target) <= tolerance && Math.abs(dayOf(best.date) - dayOf(tx.date)) <= AUTO_DAYS;
  return fits ? best : null;
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
