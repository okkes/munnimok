import { describe, expect, it } from 'vitest';
import { bestMatch, mapAhItems, mapAhSummary, matchCandidates, parseReceiptText } from './storeReceipts';
import type { MatchableReceipt } from './storeReceipts';
import type { TransactionRow } from '@/db/types';

const tx = (partial: Partial<TransactionRow>): TransactionRow =>
  ({
    id: Math.random().toString(36).slice(2),
    spaceId: 's1',
    accountId: 'a1',
    date: '2026-07-05',
    amountCents: -2350,
    currency: 'EUR',
    merchant: 'Albert Heijn',
    txType: 'expense',
    needsReview: 0,
    deleted: 0,
    ...partial,
  }) as TransactionRow;

const receipt: MatchableReceipt = { id: 'r1', source: 'ah', date: '2026-07-05', totalCents: 2350 };

describe('receipt ↔ transaction matching', () => {
  it('amount ±2c and date ±2d bound the candidates', () => {
    const txs = [
      tx({ id: 'hit' }),
      tx({ id: 'wrong-amount', amountCents: -2500 }),
      tx({ id: 'wrong-date', date: '2026-07-01' }),
      tx({ id: 'near-amount', amountCents: -2351 }),
    ];
    const ids = matchCandidates(receipt, txs).map((t) => t.id);
    expect(ids).toContain('hit');
    expect(ids).toContain('near-amount');
    expect(ids).not.toContain('wrong-amount');
    expect(ids).not.toContain('wrong-date');
  });

  it('auto-attaches only an unambiguous winner', () => {
    const clear = [tx({ id: 'only' })];
    expect(bestMatch(receipt, clear, new Set())).toBe('only');

    // two equal candidates → ambiguous → manual
    const twins = [tx({ id: 'a' }), tx({ id: 'b' })];
    expect(bestMatch(receipt, twins, new Set())).toBeNull();

    // merchant hit breaks the tie
    const tied = [tx({ id: 'ah-one' }), tx({ id: 'other', merchant: 'Snackbar' })];
    expect(bestMatch(receipt, tied, new Set())).toBe('ah-one');

    // already-taken transactions stay out of it
    expect(bestMatch(receipt, clear, new Set(['only']))).toBeNull();
  });
});

describe('AH payload mapping', () => {
  it('summary rows become matchable receipts (euros → cents)', () => {
    const mapped = mapAhSummary({
      transactionId: 'tid-1',
      transactionMoment: '2026-07-05T17:31:00Z',
      total: { amount: { amount: 23.5 } },
    });
    expect(mapped).toMatchObject({ id: 'tid-1', source: 'ah', date: '2026-07-05', totalCents: 2350 });
  });

  it('receiptUiItems keep products and drop chrome', () => {
    const items = mapAhItems([
      { type: 'product', quantity: '2', description: 'HALFVOLLE MELK', amount: '2,58' },
      { type: 'product', description: 'BROOD', amount: '1.99' },
      { type: 'divider' },
      { type: 'total', amount: '4,57' },
    ]);
    expect(items).toEqual([
      { name: 'HALFVOLLE MELK', qty: 2, totalCents: 258 },
      { name: 'BROOD', qty: undefined, totalCents: 199 },
    ]);
  });
});

describe('OCR text parsing', () => {
  it('extracts item lines and skips register noise', () => {
    const items = parseReceiptText(
      ['AH BANANEN 1,89', '2 x KAAS JONG 7,98', 'SUBTOTAAL 9,87', 'BONUSKAART 0,50-', 'TOTAAL 9,37', 'PINNEN 9,37'].join('\n'),
    );
    expect(items).toEqual([
      { name: 'AH BANANEN', qty: undefined, totalCents: 189 },
      { name: 'KAAS JONG', qty: 2, totalCents: 798 },
    ]);
  });

  it('garbage in, nothing out', () => {
    expect(parseReceiptText('')).toEqual([]);
    expect(parseReceiptText('welkom bij albert heijn\nfijne dag')).toEqual([]);
  });
});
