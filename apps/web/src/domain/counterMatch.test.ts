import { describe, expect, it } from 'vitest';
import { counterDuplicates } from './counterMatch';
import type { TransactionRow } from '@/db/types';

const base = (over: Partial<TransactionRow>): TransactionRow =>
  ({
    id: 'x', accountId: 'counter', date: '2026-03-10', amountCents: 5240, currency: 'EUR',
    merchant: 'M', catId: 'uncategorized', txType: 'income', needsReview: 0, deleted: 0,
    ...over,
  }) as TransactionRow;

const anchor = { id: 'src', amountCents: -5240, date: '2026-03-10' };

describe('counterDuplicates (#133 B pick-existing)', () => {
  it('offers only opposite-sign, unlinked, close-in-amount-and-date rows on the counter account', () => {
    const rows: TransactionRow[] = [
      base({ id: 'hit-exact' }),
      base({ id: 'hit-near', amountCents: 5300, date: '2026-03-12' }), // 60 cents off — inside the 2% tolerance
      base({ id: 'wrong-sign', amountCents: -5240 }),
      base({ id: 'other-account', accountId: 'elsewhere' }),
      base({ id: 'linked', linkedAccountId: 'somewhere' }),
      base({ id: 'peered', transferPeerId: 'p' }),
      base({ id: 'far-amount', amountCents: 9000 }),
      base({ id: 'far-date', date: '2026-05-01' }),
      base({ id: 'container', splits: [{ catId: 'a', amountCents: 3000 }, { catId: 'b', amountCents: 2240 }] }),
      base({ id: 'tombstone', deleted: 1 }),
      base({ id: anchor.id }), // the anchor itself never offers
    ];
    const found = counterDuplicates(rows, 'counter', anchor);
    expect(found.map((row) => row.id)).toEqual(['hit-exact', 'hit-near']);
  });

  it('sorts exact amounts first, then by date distance, and honors the limit', () => {
    const rows = [
      base({ id: 'near-amount', amountCents: 5290, date: '2026-03-10' }),
      base({ id: 'exact-far', date: '2026-03-16' }),
      base({ id: 'exact-close', date: '2026-03-11' }),
    ];
    expect(counterDuplicates(rows, 'counter', anchor).map((row) => row.id)).toEqual([
      'exact-close', 'exact-far', 'near-amount',
    ]);
    expect(counterDuplicates(rows, 'counter', anchor, 2)).toHaveLength(2);
  });
});
