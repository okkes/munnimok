import type { ReceiptItem, ReceiptSource, TransactionRow } from '@/db/types';

/**
 * Store receipts domain (receipts design S2) — all pure: matching
 * fetched receipts to transactions, mapping the AH payload shapes, and
 * parsing OCR text from photo receipts into the same item shape.
 */

// ── matching ────────────────────────────────────────────────────────────

/** merchant fingerprints per store, tested against tx.merchant */
const STORE_MERCHANT: Partial<Record<ReceiptSource, RegExp>> = {
  ah: /albert\s*heijn|\bah\b/i,
  jumbo: /jumbo/i,
  bol: /bol\.com|\bbol\b/i,
  coolblue: /coolblue/i,
  mediamarkt: /media\s*markt/i,
  amazon: /amazon/i,
};

export interface MatchableReceipt {
  id: string;
  source: ReceiptSource;
  date: string;
  totalCents: number;
}

const dayDiff = (a: string, b: string): number => Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000));

/** design rule: amount ± 2 cents, date ± 2 days, merchant as tiebreaker */
export function matchCandidates(receipt: MatchableReceipt, txs: readonly TransactionRow[]): TransactionRow[] {
  return txs
    .filter(
      (tx) =>
        tx.deleted === 0 &&
        tx.txType === 'expense' &&
        Math.abs(-tx.amountCents - receipt.totalCents) <= 2 &&
        dayDiff(tx.date, receipt.date) <= 2,
    )
    .sort((a, b) => scoreOf(receipt, b) - scoreOf(receipt, a));
}

function scoreOf(receipt: MatchableReceipt, tx: TransactionRow): number {
  const merchantHit = STORE_MERCHANT[receipt.source]?.test(tx.merchant ?? '') ? 2 : 0;
  const exact = -tx.amountCents === receipt.totalCents ? 1 : 0;
  return merchantHit + exact + (2 - dayDiff(tx.date, receipt.date)) * 0.1;
}

/**
 * Auto-attach only when the winner is unambiguous; everything else
 * lands in the unmatched list for a manual pick.
 */
export function bestMatch(receipt: MatchableReceipt, txs: readonly TransactionRow[], takenTxIds: ReadonlySet<string>): string | null {
  const candidates = matchCandidates(receipt, txs).filter((tx) => !takenTxIds.has(tx.id));
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].id;
  const [first, second] = candidates;
  return scoreOf(receipt, first) > scoreOf(receipt, second) ? first.id : null;
}

// ── AH payload mapping (mobile-services v2 shapes) ──────────────────────

export interface AhReceiptSummary {
  transactionId: string;
  transactionMoment: string;
  total?: { amount?: { amount?: number } };
}

export interface AhReceiptUiItem {
  type: string;
  quantity?: string | number;
  description?: string;
  amount?: string;
}

const euroToCents = (value: number | string | undefined): number => {
  const n = typeof value === 'string' ? Number.parseFloat(value.replace(',', '.')) : value;
  return Number.isFinite(n) ? Math.round((n as number) * 100) : 0;
};

export function mapAhSummary(row: AhReceiptSummary): MatchableReceipt & { storeId: string } {
  return {
    id: row.transactionId,
    storeId: row.transactionId,
    source: 'ah',
    date: row.transactionMoment.slice(0, 10),
    totalCents: euroToCents(row.total?.amount?.amount),
  };
}

/** the detail's receiptUiItems: keep the products, drop dividers/totals */
export function mapAhItems(uiItems: readonly AhReceiptUiItem[]): ReceiptItem[] {
  const items: ReceiptItem[] = [];
  for (const item of uiItems) {
    if (item.type !== 'product' || !item.description) continue;
    const qty = typeof item.quantity === 'string' ? Number.parseInt(item.quantity, 10) : item.quantity;
    items.push({
      name: item.description,
      qty: qty !== undefined && Number.isFinite(qty) && qty > 1 ? qty : undefined,
      totalCents: euroToCents(item.amount),
    });
  }
  return items;
}

// ── OCR text → items (photo receipts) ───────────────────────────────────

/** register noise a Dutch receipt prints around the products */
const OCR_SKIP = /totaal|subtotaal|bonus|korting|te betalen|pinnen|betaald|wisselgeld|btw|koopzegels|airmiles|spaar|statiegeld retour/i;
const OCR_ITEM = /^(?:(\d{1,2})\s*[x×]\s*)?(.{2,40}?)\s+(\d{1,4}[.,]\d{2})\s*-?$/;

export function parseReceiptText(text: string): ReceiptItem[] {
  const items: ReceiptItem[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || OCR_SKIP.test(line)) continue;
    const match = OCR_ITEM.exec(line);
    if (!match) continue;
    const [, qty, name, price] = match;
    const totalCents = Math.round(Number.parseFloat(price.replace(',', '.')) * 100);
    if (totalCents <= 0) continue;
    items.push({
      name: name.trim(),
      qty: qty ? Number.parseInt(qty, 10) : undefined,
      totalCents,
    });
  }
  return items;
}
