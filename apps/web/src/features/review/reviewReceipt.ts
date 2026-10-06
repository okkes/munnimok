import type { SpaceTx } from '@/application/transactions';
import type { ReceiptRow } from '@/db/types';
import { partyName } from '@/features/connectors/logos';
import { rankForTx } from '@/features/shopping/ReceiptSection';

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

/** the parties behind a set of receipts, for the filter chips — each once, by name */
export function receiptParties(rows: readonly ReceiptRow[]): { source: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const row of rows) {
    if (!seen.has(row.source)) seen.set(row.source, row.merchant ?? partyName(row.source));
  }
  return [...seen].map(([source, label]) => ({ source, label })).sort((a, b) => a.label.localeCompare(b.label));
}

/** merchant, item names and the amount's digits are all searchable (the Fetched receipts screen's rule) */
function receiptMatches(receipt: ReceiptRow, q: string, amountQ: string | null): boolean {
  const text = `${receipt.merchant ?? ''} ${partyName(receipt.source)} ${(receipt.items ?? []).map((i) => i.name).join(' ')}`.toLowerCase();
  if (text.includes(q)) return true;
  return !!amountQ && String(Math.abs(receipt.totalCents)).includes(amountQ);
}

/** every receipt the sheet lists: narrowed by a party and by text, newest first */
export function filterReceipts(rows: readonly ReceiptRow[], query: string, source: string | null): ReceiptRow[] {
  const q = query.trim().toLowerCase();
  const digits = q.replaceAll(/[\s.,€+-]/g, '');
  const amountQ = /^\d+$/.test(digits) && digits.length > 0 ? digits : null;
  return rows
    .filter((row) => (source === null || row.source === source) && (!q || receiptMatches(row, q, amountQ)))
    .sort((a, b) => b.date.localeCompare(a.date));
}
