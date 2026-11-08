import { describe, expect, it } from 'vitest';
import { nextPayday } from './cashflow';
import type { TxView } from '@/db/types';

const tx = (over: Partial<TxView>): TxView => ({
  id: Math.random().toString(36).slice(2),
  spaceId: 's1',
  accountId: 'a1',
  date: '2026-07-01',
  amountCents: -1000,
  currency: 'EUR',
  merchant: 'X',
  txType: 'expense',
  needsReview: 0,
  fieldVersions: {},
  deleted: 0,
  ...over,
});

const salaryTxs = [
  tx({ merchant: 'Demo Corp BV', amountCents: 220_000, txType: 'income', date: '2026-05-25' }),
  tx({ merchant: 'Demo Corp BV', amountCents: 220_000, txType: 'income', date: '2026-06-25' }),
  // noise: a big one-off refund never counts as salary (single month)
  tx({ merchant: 'Belastingdienst', amountCents: 500_000, txType: 'income', date: '2026-06-02' }),
];

describe('nextPayday', () => {
  it('projects the repeating largest credit forward, before or after today', () => {
    expect(nextPayday(salaryTxs, '2026-07-10')).toEqual({
      date: '2026-07-25',
      merchant: 'Demo Corp BV',
      amountCents: 220_000,
    });
    // day already passed → next month
    expect(nextPayday(salaryTxs, '2026-07-26')?.date).toBe('2026-08-25');
  });

  it('stays silent without a salary-shaped pattern', () => {
    expect(nextPayday([], '2026-07-10')).toBeNull();
    // one month of history is not a pattern
    expect(nextPayday([tx({ merchant: 'Employer', amountCents: 200_000, date: '2026-07-01' })], '2026-07-10')).toBeNull();
    // repeated small credits (tikkies) don't qualify
    const tikkies = ['2026-05-05', '2026-06-05'].map((date) => tx({ merchant: 'Friend', amountCents: 2_000, date }));
    expect(nextPayday(tikkies, '2026-07-10')).toBeNull();
  });
});
