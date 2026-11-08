import type { SpaceTx } from '@/application/transactions';
import type { ReceiptLinkRow, ReceiptRow } from '@/db/types';
import { rankForTx } from '@/features/shopping/receiptPick';

/**
 * User 2026-10-06: "automatically select the best matching receipt during
 * the review, like categories" — the card shows the receipt it will attach
 * on confirm and the person can change it. What the card holds:
 * - auto: the best match by itself (a standing proposal first, else the
 *   unlinked receipt that really fits), nothing when none does
 * - picked: the one the person chose from the suggestions or the search
 * - none: the person said no receipt
 */
export type ReceiptStage = { kind: 'auto' } | { kind: 'picked'; receipt: ReceiptRow } | { kind: 'none' };

export const AUTO_STAGE: ReceiptStage = { kind: 'auto' };

/** days either side of the transaction a receipt may still be its proof */
export const AUTO_DAYS = 14;

const dayOf = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/**
 * The best-ranked unlinked receipt when it really fits: the amount within a
 * euro or one percent, the date within two weeks. Anything looser is a
 * suggestion to pick, never a pick made for the person.
 */
export function autoReceiptFor(tx: Pick<SpaceTx, 'date' | 'amountCents'>, candidates: readonly ReceiptRow[]): ReceiptRow | null {
  const best = rankForTx(tx, candidates)[0];
  if (!best) return null;
  const target = Math.abs(tx.amountCents);
  const tolerance = Math.max(100, Math.round(target * 0.01));
  const fits = Math.abs(best.totalCents - target) <= tolerance && Math.abs(dayOf(best.date) - dayOf(tx.date)) <= AUTO_DAYS;
  return fits ? best : null;
}

/** the receipt the card's sheet marks: the person's pick, nothing after "no receipt", else the attached one or the
 *  best match the card holds */
export function markedReceiptId(stage: ReceiptStage, attachedId: string | null | undefined, autoId: string | null | undefined): string | null {
  if (stage.kind === 'picked') return stage.receipt.id;
  if (stage.kind === 'none') return null;
  return attachedId ?? autoId ?? null;
}

/** what the confirm writes for the card's receipt */
export type ReceiptSettlement =
  | { kind: 'keep' }
  | { kind: 'accept'; proposal: ReceiptLinkRow }
  | { kind: 'reject'; proposal: ReceiptLinkRow }
  /** the receipt goes on the transaction (in the attached one's place), or — null — the attached one lets go; a
   *  proposal the person passed over is turned down first */
  | { kind: 'pick'; receipt: ReceiptRow | null; reject?: ReceiptLinkRow };

/**
 * The card's receipt on confirm (user 2026-10-06): a proposal accepted, the
 * best match linked, the person's own pick honoured (a passed-over proposal
 * turned down), "no receipt" left alone. #496: an attached receipt can be
 * changed on the card too — another pick takes its place, "no receipt"
 * lets it go, untouched it stays.
 */
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
    // picking the proposal's own receipt is its yes
    if (proposal && (proposal.receiptId ?? proposal.id) === stage.receipt.id) return { kind: 'accept', proposal };
    return { kind: 'pick', receipt: stage.receipt, reject: proposal };
  }
  if (stage.kind === 'none') return proposal ? { kind: 'reject', proposal } : { kind: 'keep' };
  if (proposal) return { kind: 'accept', proposal };
  return auto ? { kind: 'pick', receipt: auto } : { kind: 'keep' };
}
