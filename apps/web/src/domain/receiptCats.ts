import type { ReceiptItem, ReceiptPick, TxSplit, TxSplitCat, TxType } from '@/db/types';
import { REIMBURSED_ID, UNCATEGORIZED_ID, specialCatType } from './categories';
import { largestRemainder } from './txSlices';

/** a receipt line the transaction's money can be filed by */
export interface ReceiptLine {
  /** the line's place among the receipt's items: two identical lines are two lines */
  index: number;
  name: string;
  /** what the line says */
  printedCents: number;
  /** what was paid for it: the receipt's discounts taken off in proportion */
  paidCents: number;
}

/**
 * #567 (user): the lines a transaction can be categorised by. A line that
 * costs money is one; a discount is not — it comes off the others by their
 * size, so the paid values add up to what the receipt charged.
 */
export function receiptLines(items: readonly ReceiptItem[] | undefined): ReceiptLine[] {
  const all = items ?? [];
  // a discount the shop states on a line is that line's alone; the receipt's own discount lines are everyone's
  const costs = all
    .map((item, index) => ({ item, index, own: Math.max(0, item.totalCents + Math.min(0, item.discountCents ?? 0)) }))
    .filter(({ item }) => item.totalCents > 0);
  if (costs.length === 0) return [];
  const owed = costs.reduce((sum, { own }) => sum + own, 0);
  const off = Math.min(
    owed,
    all.reduce((sum, item) => sum - Math.min(0, item.totalCents), 0),
  );
  const paid = owed > 0 ? largestRemainder(costs.map(({ own }) => own), owed, owed - off) : costs.map(() => 0);
  return costs.map(({ item, index }, at) => ({ index, name: item.name, printedCents: item.totalCents, paidCents: paid[at] }));
}

/** the same product under one key, however the shop spaces or capitalises its name */
export const itemKey = (name: string): string => name.toLocaleLowerCase().replace(/\s+/g, ' ').trim();

/** the category a person filed a product under before, by product key */
export type ItemMemory = ReadonlyMap<string, string>;

/** what the space's receipts were filed as, line by line — the later receipt's say wins */
export function itemMemoryOf(links: readonly { date: string; items?: ReceiptItem[]; picks?: Record<string, ReceiptPick[]> }[]): ItemMemory {
  const memory = new Map<string, string>();
  for (const link of [...links].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const picks of Object.values(link.picks ?? {})) {
      for (const pick of picks) {
        const item = link.items?.[pick.line];
        if (item) memory.set(itemKey(item.name), pick.catId);
      }
    }
  }
  return memory;
}

/** #567 (user): what the person chose before outranks the reader's guess; a category that is gone suggests nothing */
export function suggestedCat(item: Pick<ReceiptItem, 'name' | 'catId'>, memory: ItemMemory, known: (catId: string) => boolean): string | undefined {
  const remembered = memory.get(itemKey(item.name));
  if (remembered && known(remembered)) return remembered;
  return item.catId && known(item.catId) ? item.catId : undefined;
}

/** every line there is a category to suggest for, at what was paid for it */
export function suggestedPicks(
  items: readonly ReceiptItem[] | undefined,
  memory: ItemMemory,
  known: (catId: string) => boolean,
): ReceiptPick[] {
  const picks: ReceiptPick[] = [];
  for (const line of receiptLines(items)) {
    const catId = suggestedCat((items ?? [])[line.index], memory, known);
    if (catId) picks.push({ line: line.index, catId, amountCents: line.paidCents });
  }
  return picks;
}

export const picksTotal = (picks: readonly ReceiptPick[]): number => picks.reduce((sum, pick) => sum + pick.amountCents, 0);

/**
 * The transaction's categories as the picks make them: one entry per
 * category, and what the picks leave of `netCents` stays under `restCatId`.
 * Picks beyond the transaction's money are the caller's to refuse.
 */
export function picksSpread(picks: readonly ReceiptPick[], netCents: number, restCatId: string): TxSplitCat[] {
  const byCat = new Map<string, number>();
  for (const pick of picks) byCat.set(pick.catId, (byCat.get(pick.catId) ?? 0) + pick.amountCents);
  const rest = netCents - picksTotal(picks);
  if (rest > 0) byCat.set(restCatId, (byCat.get(restCatId) ?? 0) + rest);
  return [...byCat].filter(([, cents]) => cents > 0).map(([catId, amountCents]) => ({ catId, amountCents }));
}

/** a transaction's money as the lines may claim it */
export interface TxMoney {
  /** what there is to file: the amount without what was paid back (user: the friends' €75 of a €100 shop is not yours to categorise) */
  netCents: number;
  settledCents: number;
  /** what each category holds now */
  held: ReadonlyMap<string, number>;
  /** where money no line claims stays: the transaction's own category, when it is an ordinary one */
  restCatId: string;
}

export function txMoneyOf(tx: { amountCents: number; catId?: string; cats?: readonly TxSplitCat[] }): TxMoney {
  const cats = tx.cats ?? [];
  const settledCents = cats.filter((c) => c.catId === REIMBURSED_ID).reduce((sum, c) => sum + c.amountCents, 0);
  const netCents = Math.max(0, Math.abs(tx.amountCents) - settledCents);
  const own = tx.catId && tx.catId !== REIMBURSED_ID && !specialCatType(tx.catId) ? tx.catId : UNCATEGORIZED_ID;
  const held = new Map<string, number>();
  const real = cats.filter((c) => c.catId !== REIMBURSED_ID);
  if (real.length === 0) held.set(own, netCents);
  for (const entry of real) held.set(entry.catId, (held.get(entry.catId) ?? 0) + entry.amountCents);
  return { netCents, settledCents, held, restCatId: own };
}

/** a payment as the filing rule reads it — a stored transaction and the review card's draft alike */
export interface FilingPayment {
  amountCents: number;
  txType: TxType;
  catId?: string;
  cats?: readonly TxSplitCat[];
  splits?: readonly TxSplit[];
  linkedAccountId?: string;
}

/**
 * #567 (user): a receipt that says the payment's own amount files the
 * payment by its lines — from what the person filed such lines under
 * before, the reader's guess where they never did. A different amount
 * leaves it to the usual prediction, and a payment that already tells a
 * story of its own (parts, a spread, a counterparty, money paid back) is
 * left alone. Lines nobody can name stay under the payment's own category;
 * without one there is nowhere to leave them, so nothing is filed.
 */
export function receiptFiling(
  payment: FilingPayment,
  receipt: { totalCents: number; items?: readonly ReceiptItem[] } | null | undefined,
  memory: ItemMemory,
  known: (catId: string) => boolean,
): { cats: TxSplitCat[]; picks: ReceiptPick[] } | null {
  if (!receipt || payment.amountCents >= 0 || payment.txType !== 'expense') return null;
  if (payment.cats?.length || payment.splits?.length || payment.linkedAccountId) return null;
  const netCents = Math.abs(payment.amountCents);
  if (receipt.totalCents !== netCents) return null;
  const picks = suggestedPicks(receipt.items, memory, known);
  const rest = netCents - picksTotal(picks);
  if (picks.length === 0 || rest < 0) return null;
  const { restCatId } = txMoneyOf(payment);
  if (rest > 0 && restCatId === UNCATEGORIZED_ID) return null;
  const cats = picksSpread(picks, netCents, restCatId);
  // every line under the category the payment already has: nothing to file
  if (cats.length === 1 && cats[0].catId === payment.catId) return null;
  return { cats, picks };
}

/**
 * Stored picks still tell the transaction's story while its categories
 * hold at least what the picks placed in each — a category changed by
 * hand since makes them history.
 */
export function picksStand(
  picks: readonly ReceiptPick[] | undefined,
  items: readonly ReceiptItem[] | undefined,
  held: ReadonlyMap<string, number>,
): boolean {
  if (!picks?.length) return false;
  const lines = new Set(receiptLines(items).map((line) => line.index));
  if (picks.some((pick) => !lines.has(pick.line))) return false;
  const placed = new Map<string, number>();
  for (const pick of picks) placed.set(pick.catId, (placed.get(pick.catId) ?? 0) + pick.amountCents);
  return [...placed].every(([catId, cents]) => (held.get(catId) ?? 0) >= cents);
}
