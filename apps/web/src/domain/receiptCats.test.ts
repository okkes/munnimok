import { describe, expect, it } from 'vitest';
import type { ReceiptItem } from '@/db/types';
import { itemKey, itemMemoryOf, picksSpread, picksStand, receiptFiling, receiptLines, suggestedCat, suggestedPicks, txMoneyOf } from './receiptCats';

// the ticket's own receipt: four lines of 110 together, 10 off, 100 paid
const ITEMS: ReceiptItem[] = [
  { name: 'Eggs', totalCents: 3000 },
  { name: 'Ice cream', totalCents: 2500 },
  { name: 'Ben & Jerry', totalCents: 4500 },
  { name: 'Gift card', totalCents: 1000 },
  { name: 'Discount', totalCents: -1000, kind: 'discount' },
];
const known = (catId: string) => catId !== 'gone';

/** #567: a transaction categorised by the lines of its receipt */
describe('receipt lines as categories', () => {
  it('a line that costs money is a line; a discount comes off the others by their size, to the cent', () => {
    const lines = receiptLines(ITEMS);
    expect(lines.map((line) => line.name)).toEqual(['Eggs', 'Ice cream', 'Ben & Jerry', 'Gift card']);
    expect(lines.map((line) => line.printedCents)).toEqual([3000, 2500, 4500, 1000]);
    expect(lines.map((line) => line.paidCents)).toEqual([2727, 2273, 4091, 909]);
    expect(lines.reduce((sum, line) => sum + line.paidCents, 0)).toBe(10_000);
    // the index is the line's place among ALL items, discount lines included
    expect(receiptLines([{ name: 'Off', totalCents: -50, kind: 'discount' }, { name: 'Milk', totalCents: 150 }])).toEqual([
      { index: 1, name: 'Milk', printedCents: 150, paidCents: 100 },
    ]);
  });

  it('no discount leaves every line at its printed value; a receipt without paid lines has none; a discount never pays out', () => {
    expect(receiptLines([{ name: 'Milk', totalCents: 129 }, { name: 'Bread', totalCents: 199 }]).map((line) => line.paidCents)).toEqual([129, 199]);
    expect(receiptLines(undefined)).toEqual([]);
    expect(receiptLines([{ name: 'Off', totalCents: -100, kind: 'discount' }])).toEqual([]);
    expect(receiptLines([{ name: 'Milk', totalCents: 100 }, { name: 'Off', totalCents: -500, kind: 'discount' }])[0].paidCents).toBe(0);
  });

  it('what a person filed before is remembered by product, the later receipt winning — and outranks the reader’s guess', () => {
    const memory = itemMemoryOf([
      { date: '2026-11-10', items: [{ name: 'Eggs', totalCents: 300 }], picks: { t2: [{ line: 0, catId: 'breakfast', amountCents: 300 }] } },
      { date: '2026-11-01', items: [{ name: '  EGGS ', totalCents: 300 }, { name: 'Soap', totalCents: 200 }], picks: { t1: [{ line: 0, catId: 'groceries', amountCents: 300 }, { line: 1, catId: 'gone', amountCents: 200 }, { line: 9, catId: 'x', amountCents: 1 }] } },
      { date: '2026-11-11', items: [{ name: 'Eggs', totalCents: 300 }] },
    ]);
    expect(itemKey('  EGGS   free  range ')).toBe('eggs free range');
    expect(memory.get('eggs')).toBe('breakfast');
    expect(suggestedCat({ name: 'eggs', catId: 'snacks' }, memory, known)).toBe('breakfast');
    // nothing remembered: the reader's guess; a category that is gone suggests nothing
    expect(suggestedCat({ name: 'Bread', catId: 'groceries' }, memory, known)).toBe('groceries');
    expect(suggestedCat({ name: 'Soap', catId: 'household' }, memory, known)).toBe('household');
    expect(suggestedCat({ name: 'Soap' }, memory, known)).toBeUndefined();
    expect(suggestedCat({ name: 'Tea', catId: 'gone' }, memory, known)).toBeUndefined();
  });

  it('the suggestions as picks: every line with a category, at what was paid for it', () => {
    const memory = itemMemoryOf([{ date: '2026-11-01', items: ITEMS, picks: { t1: [{ line: 0, catId: 'groceries', amountCents: 2727 }] } }]);
    const items = ITEMS.map((item, index) => (index === 2 ? { ...item, catId: 'snacks' } : item));
    expect(suggestedPicks(items, memory, known)).toEqual([
      { line: 0, catId: 'groceries', amountCents: 2727 },
      { line: 2, catId: 'snacks', amountCents: 4091 },
    ]);
    expect(suggestedPicks(undefined, memory, known)).toEqual([]);
  });

  it('the picks make the transaction’s categories: one entry per category, the rest under the transaction’s own', () => {
    const picks = [
      { line: 0, catId: 'groceries', amountCents: 2727 },
      { line: 1, catId: 'snacks', amountCents: 2273 },
      { line: 2, catId: 'snacks', amountCents: 4091 },
    ];
    expect(picksSpread(picks, 10_000, 'household')).toEqual([
      { catId: 'groceries', amountCents: 2727 },
      { catId: 'snacks', amountCents: 6364 },
      { catId: 'household', amountCents: 909 },
    ]);
    // the rest joins its own category when a line was filed there too; nothing left adds nothing
    expect(picksSpread(picks, 10_000, 'groceries')).toEqual([
      { catId: 'groceries', amountCents: 3636 },
      { catId: 'snacks', amountCents: 6364 },
    ]);
    expect(picksSpread(picks, 9091, 'household')).toHaveLength(2);
    expect(picksSpread([], 500, 'household')).toEqual([{ catId: 'household', amountCents: 500 }]);
  });

  it('a transaction’s money: what was paid back is not there to file; the rest stays under its own ordinary category', () => {
    expect(txMoneyOf({ amountCents: -10_000, catId: 'groceries' })).toEqual({
      netCents: 10_000,
      settledCents: 0,
      held: new Map([['groceries', 10_000]]),
      restCatId: 'groceries',
    });
    // €100 paid, €75 paid back (the ticket's example): €25 to file
    const shared = txMoneyOf({
      amountCents: -10_000,
      catId: 'groceries',
      cats: [
        { catId: 'groceries', amountCents: 1500 },
        { catId: 'sweets', amountCents: 1000 },
        { catId: 'reimbursed', amountCents: 7500 },
      ],
    });
    expect(shared.netCents).toBe(2500);
    expect(shared.settledCents).toBe(7500);
    expect(shared.held).toEqual(new Map([['groceries', 1500], ['sweets', 1000]]));
    // no category yet, or one that is a movement's: the rest has no ordinary home
    expect(txMoneyOf({ amountCents: -500 }).restCatId).toBe('uncategorized');
    expect(txMoneyOf({ amountCents: -500, catId: 'reimbursed' }).restCatId).toBe('uncategorized');
  });

  it('a receipt that says the payment’s own amount files it by its lines; anything else leaves it to the person', () => {
    const memory = itemMemoryOf([{ date: '2026-11-01', items: ITEMS, picks: { t1: [{ line: 0, catId: 'breakfast', amountCents: 2727 }] } }]);
    const items = ITEMS.map((item, index) => (index === 2 ? { ...item, catId: 'sweets' } : item));
    const payment = { amountCents: -10_000, txType: 'expense' as const, catId: 'groceries' };
    const receipt = { totalCents: 10_000, items };
    // the remembered line, the reader's guess, and the lines nobody named under the payment's own category
    expect(receiptFiling(payment, receipt, memory, known)).toEqual({
      cats: [
        { catId: 'breakfast', amountCents: 2727 },
        { catId: 'sweets', amountCents: 4091 },
        { catId: 'groceries', amountCents: 3182 },
      ],
      picks: [
        { line: 0, catId: 'breakfast', amountCents: 2727 },
        { line: 2, catId: 'sweets', amountCents: 4091 },
      ],
    });

    // a different amount: the usual prediction decides (user)
    expect(receiptFiling(payment, { totalCents: 9990, items }, memory, known)).toBeNull();
    expect(receiptFiling(payment, null, memory, known)).toBeNull();
    // money in, a movement, a payment with parts, a spread, a counterparty: not the receipt's to file
    expect(receiptFiling({ ...payment, amountCents: 10_000 }, receipt, memory, known)).toBeNull();
    expect(receiptFiling({ ...payment, txType: 'transfer' }, receipt, memory, known)).toBeNull();
    expect(receiptFiling({ ...payment, splits: [{ catId: 'groceries', amountCents: 10_000 }] }, receipt, memory, known)).toBeNull();
    expect(receiptFiling({ ...payment, cats: [{ catId: 'reimbursed', amountCents: 7500 }] }, receipt, memory, known)).toBeNull();
    expect(receiptFiling({ ...payment, linkedAccountId: 'savings' }, receipt, memory, known)).toBeNull();
    // nothing to suggest; lines nobody named with no category to leave them under; lines that say more than was paid
    expect(receiptFiling(payment, { totalCents: 10_000, items: ITEMS }, new Map(), known)).toBeNull();
    expect(receiptFiling({ ...payment, catId: undefined }, receipt, memory, known)).toBeNull();
    const over = [{ name: 'Eggs', totalCents: 12_000 }];
    expect(receiptFiling(payment, { totalCents: 10_000, items: over }, new Map([['eggs', 'breakfast']]), known)).toBeNull();
    // every line named: it files without a category of its own to fall back on
    const all = [{ name: 'Eggs', totalCents: 10_000 }];
    expect(receiptFiling({ ...payment, catId: undefined }, { totalCents: 10_000, items: all }, memory, known)?.cats).toEqual([{ catId: 'breakfast', amountCents: 10_000 }]);
    // … and when that is the category it already has, there is nothing to file
    expect(receiptFiling({ ...payment, catId: 'breakfast' }, { totalCents: 10_000, items: all }, memory, known)).toBeNull();
  });

  it('stored picks stand while the transaction’s categories still hold them; a change by hand makes them history', () => {
    const picks = [
      { line: 0, catId: 'groceries', amountCents: 2727 },
      { line: 2, catId: 'snacks', amountCents: 4091 },
    ];
    expect(picksStand(picks, ITEMS, new Map([['groceries', 5909], ['snacks', 4091]]))).toBe(true);
    expect(picksStand(picks, ITEMS, new Map([['groceries', 10_000]]))).toBe(false);
    expect(picksStand(picks, ITEMS, new Map([['groceries', 2000], ['snacks', 8000]]))).toBe(false);
    // a pick on a line the receipt no longer has (read again), or none at all
    expect(picksStand([{ line: 4, catId: 'groceries', amountCents: 1 }], ITEMS, new Map([['groceries', 10_000]]))).toBe(false);
    expect(picksStand([], ITEMS, new Map())).toBe(false);
    expect(picksStand(undefined, ITEMS, new Map())).toBe(false);
  });
});
