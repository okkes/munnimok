import { describe, expect, it } from 'vitest';
import { filterTxs, hasActiveFilter } from './txFilter';
import type { TransactionRow } from '@/db/types';

const tx = (partial: Partial<TransactionRow>): TransactionRow =>
  ({
    id: 'x',
    spaceId: 's',
    accountId: 'a1',
    date: '2026-07-01',
    amountCents: -100,
    currency: 'EUR',
    merchant: 'Albert Heijn',
    txType: 'expense',
    needsReview: 0,
    deleted: 0,
    fieldVersions: {},
    ...partial,
  }) as TransactionRow;

describe('filterTxs', () => {
  const rows = [
    tx({ id: '1', merchant: 'Albert Heijn 1842', description: 'AH AMSTERDAM' }),
    tx({ id: '2', merchant: 'Spotify', accountId: 'a2' }),
    tx({ id: '3', merchant: 'Incasso<br>ING', description: 'RENTE<br>PERIODE', needsReview: 1 }),
  ];

  it('no filter returns everything', () => {
    expect(filterTxs(rows, {})).toHaveLength(3);
  });

  it('query matches merchant and description, case-insensitive', () => {
    expect(filterTxs(rows, { query: 'albert' }).map((t) => t.id)).toEqual(['1']);
    expect(filterTxs(rows, { query: 'AMSTERDAM' }).map((t) => t.id)).toEqual(['1']);
    expect(filterTxs(rows, { query: '  spoti ' }).map((t) => t.id)).toEqual(['2']);
    expect(filterTxs(rows, { query: 'nomatch' })).toHaveLength(0);
  });

  it('query sees through bank <br> noise', () => {
    // raw text contains "Incasso<br>ING"; users search the cleaned form
    expect(filterTxs(rows, { query: 'incasso · ing' }).map((t) => t.id)).toEqual(['3']);
    expect(filterTxs(rows, { query: 'rente' }).map((t) => t.id)).toEqual(['3']);
  });

  it('account and review filters combine with query', () => {
    expect(filterTxs(rows, { accountId: 'a2' }).map((t) => t.id)).toEqual(['2']);
    expect(filterTxs(rows, { onlyNeedsReview: true }).map((t) => t.id)).toEqual(['3']);
    expect(filterTxs(rows, { accountId: 'a1', onlyNeedsReview: true, query: 'rente' }).map((t) => t.id)).toEqual(['3']);
    expect(filterTxs(rows, { accountId: 'a2', onlyNeedsReview: true })).toHaveLength(0);
  });

  it('hasActiveFilter ignores whitespace-only queries', () => {
    expect(hasActiveFilter({})).toBe(false);
    expect(hasActiveFilter({ query: '   ' })).toBe(false);
    expect(hasActiveFilter({ query: 'a' })).toBe(true);
    expect(hasActiveFilter({ accountId: 'a1' })).toBe(true);
    expect(hasActiveFilter({ onlyNeedsReview: true })).toBe(true);
  });
});
