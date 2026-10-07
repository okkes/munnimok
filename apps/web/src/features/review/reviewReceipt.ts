import type { SpaceTx } from '@/application/transactions';
import type { ReceiptRow } from '@/db/types';
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
