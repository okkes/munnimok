import type { AttachableReceipts } from '@/application/connections';
import type { ReceiptEntry } from '@/application/receiptLinks';
import type { ReceiptOps } from '@/application/receipts';
import type { ReceiptRow } from '@/db/types';
import type { SpaceTx } from '@/db/joined';
import { compareFits, receiptFit } from '@/domain/storeReceipts';
import { LOCALES } from '@/i18n';
import type { Lang } from '@/i18n';
import { partyName } from '@/features/connectors/logos';
import { fmtCents } from '@/lib/money';
import { txTitle } from '@/lib/text';

// neutral module: the review's helpers and the detail's section both import it without a cycle through the components

/** what a receipt is told by against a payment */
export type ReceiptTx = Pick<SpaceTx, 'date' | 'amountCents' | 'merchant' | 'description'>;

// #650: the amount alone put another shop's receipt first when it happened to cost nearly the same
export function rankForTx(tx: ReceiptTx, receipts: readonly ReceiptRow[]): ReceiptRow[] {
  return receipts
    .map((receipt) => ({ receipt, fit: receiptFit(receipt, tx) }))
    .sort((a, b) => compareFits(a.fit, b.fit))
    .map(({ receipt }) => receipt);
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
  tx: ReceiptTx & Pick<SpaceTx, 'id'>,
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

// a photo nobody else holds is deleted; a store receipt nobody else holds is unattached
// and never offered to this transaction again (#496)
export async function dropAttached(ops: ReceiptOps, attached: ReceiptEntry, txId: string): Promise<void> {
  if (!attached.linkId) return;
  if (attached.data.source === 'photo') await ops.remove(attached.linkId, txId);
  else await ops.unlinkReceipt(attached.linkId, txId);
}

// a receipt attaches in the attached one's place; one attached elsewhere is attached here as well
// none lets the attached one go
export async function applyPick(ops: ReceiptOps, txId: string, attached: ReceiptEntry | null, row: ReceiptRow | null): Promise<void> {
  if (row?.id === attached?.data.id) return; // the attached one again, or none with nothing attached
  if (row && attached?.linkId) await ops.swapReceipt(attached.linkId, row, txId);
  else if (row) await ops.linkReceipt(row, txId);
  else if (attached) await dropAttached(ops, attached, txId);
}

/** unknown here (another space's row) = nothing; the picker's note counts instead */
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

export function attachedElsewhere(attachedTo: ReadonlyMap<string, readonly string[]> | undefined, txId: string): Map<string, string[]> {
  const elsewhere = new Map<string, string[]>();
  for (const [receiptId, txIds] of attachedTo ?? []) {
    const others = txIds.filter((id) => id !== txId);
    if (others.length > 0) elsewhere.set(receiptId, others);
  }
  return elsewhere;
}

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

export function receiptFilter(query: string, source: string | null): (row: ReceiptRow) => boolean {
  const q = query.trim().toLowerCase();
  const digits = q.replaceAll(/[\s.,€+-]/g, '');
  const amountQ = /^\d+$/.test(digits) && digits.length > 0 ? digits : null;
  return (row) => (source === null || row.source === source) && (!q || receiptMatches(row, q, amountQ));
}

export function filterReceipts(rows: readonly ReceiptRow[], query: string, source: string | null): ReceiptRow[] {
  return rows.filter(receiptFilter(query, source)).sort((a, b) => b.date.localeCompare(a.date));
}
