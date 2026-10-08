import type { ReceiptRow } from '@/db/types';
import type { SpaceTx } from '@/db/joined';
import { LOCALES } from '@/i18n';
import type { Lang } from '@/i18n';
import { partyName } from '@/features/connectors/logos';
import { fmtCents } from '@/lib/money';
import { txTitle } from '@/lib/text';

/**
 * The receipt-picking rules the review card and the transaction detail
 * share (user 2026-10-07: "I want that on the transaction details page
 * too") — a neutral module, so the review's helpers and the detail's
 * section both import it without a cycle through the components.
 */

const dayDiff = (a: string, b: string): number => Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000));

/** best receipt candidates for THIS transaction: amount first, then date */
export function rankForTx(tx: Pick<SpaceTx, 'date' | 'amountCents'>, receipts: readonly ReceiptRow[]): ReceiptRow[] {
  const target = Math.abs(tx.amountCents);
  return [...receipts].sort((a, b) => {
    const amountGap = Math.abs(a.totalCents - target) - Math.abs(b.totalCents - target);
    if (amountGap !== 0) return amountGap;
    return dayDiff(a.date, tx.date) - dayDiff(b.date, tx.date);
  });
}

/**
 * "29 May · bol.com · €157.33" — the transaction a receipt already sits on,
 * as the picker's note under the row tells it (user 2026-10-08: the same
 * receipt may be picked again, but it must be clear where it already is).
 * Unknown here (another space's row) = nothing, the note counts instead.
 */
export function describeTxFor(
  txs: readonly SpaceTx[] | undefined,
  lang: Lang,
  currency: string,
): (txId: string) => string | undefined {
  return (txId) => {
    const tx = txs?.find((row) => row.id === txId);
    if (!tx) return undefined;
    const day = new Date(tx.date).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });
    return `${day} · ${txTitle(tx)} · ${fmtCents(tx.amountCents, tx.currency || currency, lang)}`;
  };
}

/** the transactions OTHER than this one each receipt is attached to — the picker notes those under a row */
export function attachedElsewhere(attachedTo: ReadonlyMap<string, readonly string[]> | undefined, txId: string): Map<string, string[]> {
  const elsewhere = new Map<string, string[]>();
  for (const [receiptId, txIds] of attachedTo ?? []) {
    const others = txIds.filter((id) => id !== txId);
    if (others.length > 0) elsewhere.set(receiptId, others);
  }
  return elsewhere;
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
