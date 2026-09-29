import type { ReceiptItem, ReceiptPayment, TxView } from '@/db/types';

/**
 * Store receipts domain (receipts design S2) — all pure: matching
 * fetched receipts to transactions, and parsing OCR text from photo
 * receipts into the same item shape.
 */

// ── matching ────────────────────────────────────────────────────────────

/** merchant fingerprints per party (keyed by connector provider id),
 *  tested against tx.merchant */
const STORE_MERCHANT: Partial<Record<string, RegExp>> = {
  ah: /albert\s*heijn|\bah\b/i,
  jumbo: /jumbo/i,
  lidl: /lidl/i,
  bol: /bol\.com|\bbol\b/i,
  coolblue: /coolblue/i,
  'mediamarkt-nl': /media\s*markt/i,
  'amazon-nl': /amazon/i,
};

/** operator overrides from the catalog (R9): admin-curated patterns win
 *  over the bundled fingerprints so matching improves without releases */
let catalogStorePatterns: Partial<Record<string, RegExp>> = {};

export function setCatalogStorePatterns(rules: readonly { id: string; patterns: string[] }[]): void {
  const next: Partial<Record<string, RegExp>> = {};
  for (const rule of rules) {
    const parts = rule.patterns.map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) continue;
    try {
      next[rule.id] = new RegExp(parts.join('|'), 'i');
    } catch {
      // a broken operator pattern must never break matching
    }
  }
  catalogStorePatterns = next;
}

export interface MatchableReceipt {
  id: string;
  /** 'photo', or the connector provider id that fetched it */
  source: string;
  date: string;
  totalCents: number;
  /** how it was paid, when the store exposes it (R5) */
  payment?: ReceiptPayment;
}

/** resolves a transaction's paying-account IBAN/PAN tail, when known */
export type AccountTailOf = (tx: TxView) => string | undefined;

const dayDiff = (a: string, b: string): number => Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000));

/**
 * Payment awareness (R5 ruling): when the receipt names the paying
 * account's tail AND at least one candidate's account matches it, the
 * mismatching candidates drop out; when NO candidate matches (store
 * cards vs IBAN tails vary) the tail only downranks via scoring.
 */
function applyPaymentFilter(
  receipt: MatchableReceipt,
  candidates: TxView[],
  tailOf?: AccountTailOf,
): TxView[] {
  const tail = receipt.payment?.accountTail;
  if (!tail || !tailOf) return candidates;
  const hits = candidates.filter((tx) => tailOf(tx)?.endsWith(tail));
  return hits.length > 0 ? hits : candidates;
}

/** design rule: amount ± 2 cents, date ± 2 days, merchant as tiebreaker */
export function matchCandidates(
  receipt: MatchableReceipt,
  txs: readonly TxView[],
  tailOf?: AccountTailOf,
): TxView[] {
  const base = txs
    .filter(
      (tx) =>
        tx.deleted === 0 &&
        tx.txType === 'expense' &&
        Math.abs(-tx.amountCents - receipt.totalCents) <= 2 &&
        dayDiff(tx.date, receipt.date) <= 2,
    )
    .sort((a, b) => scoreOf(receipt, b) - scoreOf(receipt, a));
  return applyPaymentFilter(receipt, base, tailOf);
}

const merchantHit = (source: string, tx: TxView): boolean =>
  (catalogStorePatterns[source] ?? STORE_MERCHANT[source])?.test(tx.merchant ?? '') ?? false;

function scoreOf(receipt: MatchableReceipt, tx: TxView): number {
  const merchant = merchantHit(receipt.source, tx) ? 2 : 0;
  const exact = -tx.amountCents === receipt.totalCents ? 1 : 0;
  return merchant + exact + (2 - dayDiff(tx.date, receipt.date)) * 0.1;
}

/**
 * Auto-attach policy (user ruling: "rung 1 is enough"): only a rung-1
 * SINGLE — exact amount, date ±2d, merchant fingerprint — attaches by
 * itself; everything else stays unlinked for a manual pick.
 */
export function bestMatch(
  receipt: MatchableReceipt,
  txs: readonly TxView[],
  takenTxIds: ReadonlySet<string>,
  tailOf?: AccountTailOf,
): string | null {
  const rung1 = matchCandidates(receipt, txs, tailOf).filter(
    (tx) => !takenTxIds.has(tx.id) && -tx.amountCents === receipt.totalCents && merchantHit(receipt.source, tx),
  );
  return rung1.length === 1 ? rung1[0].id : null;
}

/**
 * The manual picker's ladder (approved receipts v2): start at the
 * near-matches, widen on demand — same price first, then the latest
 * expenses so the picker never dead-ends.
 */
export interface CandidateLadder {
  /** amount ±2c and date ±2d, best first (rungs 1–2) */
  primary: TxView[];
  /** rung 3 (same amount, any date) + rung 4 (latest expenses) behind "show more" */
  more: TxView[];
}

export function candidateLadder(receipt: MatchableReceipt, txs: readonly TxView[]): CandidateLadder {
  const primary = matchCandidates(receipt, txs).slice(0, 8);
  const seen = new Set(primary.map((tx) => tx.id));
  const expenses = txs
    .filter((tx) => tx.deleted === 0 && tx.txType === 'expense' && !seen.has(tx.id))
    .sort((a, b) => b.date.localeCompare(a.date));
  const sameAmount = expenses.filter((tx) => -tx.amountCents === receipt.totalCents);
  const sameAmountIds = new Set(sameAmount.map((tx) => tx.id));
  const latest = expenses.filter((tx) => !sameAmountIds.has(tx.id));
  return { primary, more: [...sameAmount, ...latest].slice(0, 12) };
}

// ── OCR text → items (photo receipts) ───────────────────────────────────

/** register noise a Dutch receipt prints around the products */
const OCR_SKIP = /totaal|subtotaal|bonus|korting|te betalen|pinnen|betaald|wisselgeld|btw|koopzegels|airmiles|spaar|statiegeld retour/i;
// input is a single OCR line hard-capped at 60 chars below, so the
// lazy group's backtracking is bounded — not super-linear in practice
const OCR_ITEM = /^(?:(\d{1,2})\s*[x×]\s*)?(.{2,40}?)\s+(\d{1,4}[.,]\d{2})\s*-?$/; // NOSONAR(S5852) bounded input

export function parseReceiptText(text: string): ReceiptItem[] {
  const items: ReceiptItem[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim().slice(0, 60);
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
