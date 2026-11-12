import { describe, expect, it } from 'vitest';
import type { TransactionRow } from '@/db/types';
import { autoLinks, canCountInBalance, countsInBalance, fitsExactly, fitsLoosely, linkCandidates, titleLikeness } from './entryMatch';

const row = (over: Partial<TransactionRow>): TransactionRow =>
  ({ id: 'x', spaceId: 's1', accountId: 'bank', date: '2026-11-10', amountCents: -1250, currency: 'EUR', merchant: 'Lunch', needsReview: 0, deleted: 0, hlc: '', fieldVersions: {}, ...over }) as TransactionRow;

/** #547: a hand-typed entry on a bank account and the bank's own transaction */
describe('your entry and the bank’s transaction', () => {
  const entry = row({ id: 'e1', merchant: 'Lunch at Bagels' });

  it('fits exactly on the same account, the same amount and within two days; wider only within a week and 2 %', () => {
    expect(fitsExactly(entry, row({ id: 'b', date: '2026-11-12' }))).toBe(true);
    expect(fitsExactly(entry, row({ id: 'b', date: '2026-11-08' }))).toBe(true);
    expect(fitsExactly(entry, row({ id: 'b', date: '2026-11-13' }))).toBe(false);
    expect(fitsExactly(entry, row({ id: 'b', amountCents: -1251 }))).toBe(false);
    expect(fitsExactly(entry, row({ id: 'b', amountCents: 1250 }))).toBe(false);
    expect(fitsExactly(entry, row({ id: 'b', accountId: 'other' }))).toBe(false);

    expect(fitsLoosely(entry, row({ id: 'b', date: '2026-11-17', amountCents: -1270 }))).toBe(true);
    expect(fitsLoosely(entry, row({ id: 'b', date: '2026-11-18' }))).toBe(false);
    expect(fitsLoosely(entry, row({ id: 'b', amountCents: -1300 }))).toBe(false);
    expect(fitsLoosely(entry, row({ id: 'b', amountCents: 1250 }))).toBe(false);
  });

  it('titles are alike by the words they share', () => {
    expect(titleLikeness('Lunch at Bagels', 'BAGELS & BEANS AMSTERDAM')).toBeCloseTo(1 / 3, 5);
    expect(titleLikeness('Albert Heijn', 'ALBERT HEIJN 1234 UTRECHT')).toBe(1);
    expect(titleLikeness('', 'anything')).toBe(0);
    expect(titleLikeness(undefined, undefined)).toBe(0);
  });

  it('one exact fit is linked without asking; the nearer day wins, then the title', () => {
    const near = row({ id: 'b-near', date: '2026-11-11', merchant: 'SOMETHING ELSE' });
    const far = row({ id: 'b-far', date: '2026-11-12', merchant: 'BAGELS' });
    expect([...autoLinks([entry], [far, near], new Set())]).toEqual([['e1', 'b-near']]);
    // the same day: the title decides
    const sameDayOther = row({ id: 'b-other', date: '2026-11-11', merchant: 'PARKING' });
    const sameDayBagels = row({ id: 'b-bagels', date: '2026-11-11', merchant: 'BAGELS & BEANS' });
    expect([...autoLinks([entry], [sameDayOther, sameDayBagels], new Set())]).toEqual([['e1', 'b-bagels']]);
  });

  it('two rows that fit an entry equally well are left to the person — and so are two entries after one row', () => {
    const twinA = row({ id: 'b-a', date: '2026-11-11', merchant: 'SHOP' });
    const twinB = row({ id: 'b-b', date: '2026-11-11', merchant: 'SHOP' });
    expect(autoLinks([entry], [twinA, twinB], new Set()).size).toBe(0);

    const one = row({ id: 'b-one', date: '2026-11-10', merchant: 'SHOP' });
    const same = [row({ id: 'e1', merchant: 'Shop' }), row({ id: 'e2', merchant: 'Shop' })];
    expect(autoLinks(same, [one], new Set()).size).toBe(0);
    // a nearer entry takes the row; the other waits for its own
    const nearer = [row({ id: 'e1', merchant: 'Shop' }), row({ id: 'e2', merchant: 'Shop', date: '2026-11-09' })];
    expect([...autoLinks(nearer, [one], new Set())]).toEqual([['e1', 'b-one']]);
  });

  it('linked entries, deleted rows, taken bank rows and a pair a person took apart are left alone', () => {
    const bank = row({ id: 'b1', merchant: 'BAGELS' });
    expect(autoLinks([row({ id: 'e1', bankTxId: 'b0' })], [bank], new Set()).size).toBe(0);
    expect(autoLinks([row({ id: 'e1', deleted: 1 })], [bank], new Set()).size).toBe(0);
    expect(autoLinks([entry], [{ ...bank, deleted: 1 }], new Set()).size).toBe(0);
    expect(autoLinks([entry], [bank], new Set(['b1'])).size).toBe(0);
    expect(autoLinks([row({ id: 'e1', noBankTxIds: ['b1'] })], [bank], new Set()).size).toBe(0);
    // …but a person may still pick that very row by hand
    expect(linkCandidates(row({ id: 'e1', noBankTxIds: ['b1'] }), [bank], new Set()).map((b) => b.id)).toEqual(['b1']);
  });

  it('the rows offered for a link by hand: the exact fits first, then the wider ones, nearest first', () => {
    const exactLate = row({ id: 'exact-late', date: '2026-11-12' });
    const exactSame = row({ id: 'exact-same', date: '2026-11-10' });
    const wide = row({ id: 'wide', date: '2026-11-11', amountCents: -1260 });
    const tooFar = row({ id: 'too-far', date: '2026-12-01' });
    const taken = row({ id: 'taken' });
    expect(linkCandidates(entry, [wide, exactLate, tooFar, taken, exactSame], new Set(['taken'])).map((b) => b.id)).toEqual(['exact-same', 'exact-late', 'wide']);
  });
});

describe('an entry and the balance (#547)', () => {
  const account = { balanceAsOf: '2026-11-10' };

  it('the tick starts on for an entry dated on or after the bank’s balance; an older one is in the bank’s number already', () => {
    expect(canCountInBalance('2026-11-10', account)).toBe(true);
    expect(canCountInBalance('2026-11-12', account)).toBe(true);
    expect(canCountInBalance('2026-11-09', account)).toBe(false);
    expect(canCountInBalance('2020-01-01', {})).toBe(true);
  });

  it('it counts while the person lets it, until the bank books it or its balance has clearly passed it', () => {
    const entry = { date: '2026-11-10', inBalance: 1 as const };
    expect(countsInBalance(entry, account, null)).toBe(true);
    expect(countsInBalance({ ...entry, inBalance: 0 }, account, null)).toBe(false);
    expect(countsInBalance({ date: '2026-11-10' }, account, null)).toBe(false);
    // linked to a reserved amount: the bank's balance does not hold it yet; booked: it does
    expect(countsInBalance(entry, account, { pending: 1 })).toBe(true);
    expect(countsInBalance(entry, account, { pending: 0 })).toBe(false);
    expect(countsInBalance(entry, account, {})).toBe(false);
    // a balance two days on may still miss it; three days on has passed it
    expect(countsInBalance(entry, { balanceAsOf: '2026-11-12' }, null)).toBe(true);
    expect(countsInBalance(entry, { balanceAsOf: '2026-11-13' }, null)).toBe(false);
    expect(countsInBalance(entry, {}, null)).toBe(true);
  });
});
