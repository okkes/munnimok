import { titleLikeness } from './entryMatch';
import type { ReceiptItem, ReceiptPayment, TxView } from '@/db/types';

/** merchant fingerprints keyed by connector provider id */
const STORE_MERCHANT: Partial<Record<string, RegExp>> = {
  ah: /albert\s*heijn|\bah\b/i,
  jumbo: /jumbo/i,
  lidl: /lidl/i,
  bol: /bol\.com|\bbol\b/i,
  coolblue: /coolblue/i,
  'mediamarkt-nl': /media\s*markt/i,
  // the card statement abbreviates it: "AMZN Mktp NL"
  'amazon-nl': /amazon|\bamzn\b/i,
};

/** admin-curated catalog patterns win over the bundled ones so matching improves without releases (R9) */
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
  payment?: ReceiptPayment;
  merchant?: string;
}

export type AccountTailOf = (tx: TxView) => string | undefined;

const dayDiff = (a: string, b: string): number => Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000));

const AMOUNT_SLACK_CENTS = 2;

// R5: when the receipt's account tail matches at least one candidate the others drop out;
// when none matches (store cards vs IBAN tails vary) nobody is excluded
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
        Math.abs(-tx.amountCents - receipt.totalCents) <= AMOUNT_SLACK_CENTS &&
        dayDiff(tx.date, receipt.date) <= 2,
    )
    .sort((a, b) => scoreOf(receipt, b) - scoreOf(receipt, a));
  return applyPaymentFilter(receipt, base, tailOf);
}

// #554: a lookup by cost instead of walking every row (receipts x rows grew with every month of history);
// hands back exactly the rows matchCandidates' amount rule lets through
export function expensesByCost(txs: readonly TxView[]): (totalCents: number) => TxView[] {
  const byCost = new Map<number, TxView[]>();
  for (const tx of txs) {
    if (tx.deleted !== 0 || tx.txType !== 'expense') continue;
    const bucket = byCost.get(-tx.amountCents);
    if (bucket) bucket.push(tx);
    else byCost.set(-tx.amountCents, [tx]);
  }
  return (totalCents) => {
    const near: TxView[] = [];
    const last = Math.floor(totalCents + AMOUNT_SLACK_CENTS);
    for (let cost = Math.ceil(totalCents - AMOUNT_SLACK_CENTS); cost <= last; cost++) near.push(...(byCost.get(cost) ?? []));
    return near;
  };
}

type NamedReceipt = Pick<MatchableReceipt, 'source' | 'merchant'>;
type PaymentText = Pick<TxView, 'merchant' | 'description'>;

/** the fingerprint a receipt's shop goes by: its connector's, or for a photo the known shop its printed name reads as */
function fingerprintOf(receipt: NamedReceipt): RegExp | undefined {
  if (receipt.source !== 'photo') return catalogStorePatterns[receipt.source] ?? STORE_MERCHANT[receipt.source];
  if (!receipt.merchant) return undefined;
  const known = [...Object.values(catalogStorePatterns), ...Object.values(STORE_MERCHANT)];
  return known.find((pattern) => pattern?.test(receipt.merchant ?? ''));
}

/** the share of the shop's name the payment has to carry: one shared word ("van", "de") names nobody */
const NAME_SHARE = 0.5;

export type ReceiptParty = 'same' | 'unknown' | 'other';

// #650: whether the payment went to the receipt's shop, read from the bank's title and description.
// 'unknown' only where nothing names the shop (a photo nobody read): there the amount and the day speak alone (#567)
export function receiptParty(receipt: NamedReceipt, tx: PaymentText): ReceiptParty {
  const text = `${tx.merchant ?? ''} ${tx.description ?? ''}`;
  const fingerprint = fingerprintOf(receipt);
  if (fingerprint) return fingerprint.test(text) ? 'same' : 'other';
  if (receipt.merchant) return titleLikeness(receipt.merchant, text) >= NAME_SHARE ? 'same' : 'other';
  return receipt.source === 'photo' ? 'unknown' : 'other';
}

const merchantHit = (receipt: NamedReceipt, tx: PaymentText): boolean => receiptParty(receipt, tx) !== 'other';

/** how well a receipt fits a payment: the cents between them, the days between them, and whose shop it is */
export interface ReceiptFit {
  gapCents: number;
  days: number;
  party: ReceiptParty;
}

export const receiptFit = (
  receipt: NamedReceipt & Pick<MatchableReceipt, 'date' | 'totalCents'>,
  tx: PaymentText & Pick<TxView, 'date' | 'amountCents'>,
): ReceiptFit => ({
  gapCents: Math.abs(receipt.totalCents - Math.abs(tx.amountCents)),
  days: dayDiff(tx.date, receipt.date),
  party: receiptParty(receipt, tx),
});

const PARTY_RANK: Record<ReceiptParty, number> = { same: 0, unknown: 1, other: 2 };

/** best first: the amount to the cent, then the shop, then how near the amount and the day are */
export const compareFits = (a: ReceiptFit, b: ReceiptFit): number =>
  Number(a.gapCents !== 0) - Number(b.gapCents !== 0) || PARTY_RANK[a.party] - PARTY_RANK[b.party] || a.gapCents - b.gapCents || a.days - b.days;

function scoreOf(receipt: MatchableReceipt, tx: TxView): number {
  const merchant = merchantHit(receipt, tx) ? 2 : 0;
  const exact = -tx.amountCents === receipt.totalCents ? 1 : 0;
  return merchant + exact + (2 - dayDiff(tx.date, receipt.date)) * 0.1;
}

// auto-attach only a rung-1 SINGLE (exact amount, date within 2 days, merchant fingerprint);
// the rest stays for a manual pick
export function bestMatch(
  receipt: MatchableReceipt,
  txs: readonly TxView[],
  takenTxIds: ReadonlySet<string>,
  tailOf?: AccountTailOf,
): string | null {
  const rung1 = matchCandidates(receipt, txs, tailOf).filter(
    (tx) => !takenTxIds.has(tx.id) && -tx.amountCents === receipt.totalCents && merchantHit(receipt, tx),
  );
  return rung1.length === 1 ? rung1[0].id : null;
}

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
