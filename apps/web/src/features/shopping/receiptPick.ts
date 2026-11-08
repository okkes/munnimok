import type { AttachableReceipts } from '@/application/connections';
import type { ReceiptEntry } from '@/application/receiptLinks';
import type { ReceiptOps } from '@/application/receipts';
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

/** how many receipts a picker suggests when nothing is attached (#542: "3 or something") */
export const SUGGESTION_LIMIT = 3;

/**
 * The unmatched receipts that could prove this transaction, best first —
 * never one attached anywhere in the space, the one a proposal already asks
 * about (`excludeId`), nor one the person took off or turned down for this
 * very transaction (#496).
 */
export function candidatesFor(
  tx: Pick<SpaceTx, 'id' | 'date' | 'amountCents'>,
  inventory: AttachableReceipts | undefined,
  excludeId?: string,
): ReceiptRow[] {
  if (!inventory) return [];
  const open = inventory.rows.filter(
    (row) => !inventory.attachedTo.has(row.id) && row.id !== excludeId && !inventory.rejectedFor.get(row.id)?.includes(tx.id),
  );
  return rankForTx(tx, open);
}

/** the picker's suggestions: the attached receipt first and one more (#496), else the best three (#542) */
export function suggestionsFor(attached: ReceiptRow | null | undefined, candidates: readonly ReceiptRow[]): ReceiptRow[] {
  if (!attached) return candidates.slice(0, SUGGESTION_LIMIT);
  return [attached, ...candidates.filter((row) => row.id !== attached.id).slice(0, 1)];
}

/** the attached receipt lets go of THIS transaction: a photo nobody else holds is gone for good, a store receipt
 *  nobody else holds is unattached again (user 2026-10-08) and never offered to it again (#496) */
export async function dropAttached(ops: ReceiptOps, attached: ReceiptEntry, txId: string): Promise<void> {
  if (!attached.linkId) return;
  if (attached.data.source === 'photo') await ops.remove(attached.linkId, txId);
  else await ops.unlinkReceipt(attached.linkId, txId);
}

/** a pick for a transaction: a receipt attaches (in the attached one's place when there is one; one attached
 *  elsewhere is attached here as well — user 2026-10-08), none lets the attached one go */
export async function applyPick(ops: ReceiptOps, txId: string, attached: ReceiptEntry | null, row: ReceiptRow | null): Promise<void> {
  if (row?.id === attached?.data.id) return; // the attached one again, or none with nothing attached
  if (row && attached?.linkId) await ops.swapReceipt(attached.linkId, row, txId);
  else if (row) await ops.linkReceipt(row, txId);
  else if (attached) await dropAttached(ops, attached, txId);
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

/** the sheet's narrowing as a test on one receipt: a party, and text over names, items and the amount's digits */
export function receiptFilter(query: string, source: string | null): (row: ReceiptRow) => boolean {
  const q = query.trim().toLowerCase();
  const digits = q.replaceAll(/[\s.,€+-]/g, '');
  const amountQ = /^\d+$/.test(digits) && digits.length > 0 ? digits : null;
  return (row) => (source === null || row.source === source) && (!q || receiptMatches(row, q, amountQ));
}

/** every receipt the sheet lists: narrowed by a party and by text, newest first */
export function filterReceipts(rows: readonly ReceiptRow[], query: string, source: string | null): ReceiptRow[] {
  return rows.filter(receiptFilter(query, source)).sort((a, b) => b.date.localeCompare(a.date));
}
