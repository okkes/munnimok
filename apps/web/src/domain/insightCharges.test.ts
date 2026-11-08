import { describe, expect, it } from 'vitest';
import type { RecurringRow, TxView } from '@/db/types';
import { billChanged, chargeMoment, duplicateCharge, missedCharge, salaryLate } from './insightCharges';
import type { InsightInputs } from './insightModel';
import { periodHistory } from './periods';

let seq = 0;
const tx = (partial: Partial<TxView>): TxView =>
  ({
    id: `t${String((seq += 1)).padStart(4, '0')}`,
    spaceId: 's1',
    accountId: 'main',
    date: '2026-07-05',
    amountCents: -1000,
    currency: 'EUR',
    merchant: 'Albert Heijn',
    catId: 'groceries',
    txType: 'expense',
    needsReview: 0,
    deleted: 0,
    ...partial,
  }) as TxView;

const rec = (partial: Partial<RecurringRow>): RecurringRow =>
  ({ id: 'r1', spaceId: 's1', name: 'Netflix', kind: 'subscription', amountCents: 1399, every: 'month', dueDay: 1, active: 1, deleted: 0, ...partial }) as RecurringRow;

const catalog = {
  byId: (id: string | undefined) => ({ id: id ?? 'uncategorized', parentId: undefined }),
  childrenOf: () => [] as { id: string }[],
};

const inputs = (partial: Partial<InsightInputs>, today = '2026-07-12'): InsightInputs => {
  const [y, m, d] = today.split('-').map(Number);
  return {
    txs: [],
    recurrings: [],
    budgets: [],
    loans: [],
    accountsById: new Map(),
    catalog,
    periods: periodHistory('month', 1, 7, new Date(y, m - 1, d, 12)),
    today,
    currency: 'EUR',
    ...partial,
  };
};

describe('a bill that grew', () => {
  const energy = rec({ id: 'energy', name: 'Vattenfall', kind: 'fixed', catId: 'housingUtility', amountCents: 15_300, dueDay: 5 });
  const bill = (date: string, cents: number) => tx({ date, amountCents: -cents, merchant: 'Vattenfall', catId: 'housingUtility', recurringId: 'energy' });
  const history = [bill('2026-04-05', 15_000), bill('2026-05-05', 15_300), bill('2026-06-05', 15_300)];

  it('this bill against the one before: the rise, both amounts, a yearly figure', () => {
    const hits = billChanged(inputs({ recurrings: [energy], txs: [...history, bill('2026-07-05', 18_400)] }));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 'bill:energy:2026-07-05', kind: 'creep', topic: 'bills', severity: 'leak', impactCents: 3_100 * 12 });
    expect(hits[0].params).toMatchObject({
      name: 'Vattenfall',
      delta: { money: 3_100, currency: 'EUR' },
      from: { money: 15_300, currency: 'EUR' },
      to: { money: 18_400, currency: 'EUR' },
    });
  });

  it('a bill paid in two goes is one bill', () => {
    const split = [bill('2026-07-05', 10_000), bill('2026-07-06', 8_400)];
    const hits = billChanged(inputs({ recurrings: [energy], txs: [...history, ...split] }));
    expect(hits[0].params.to).toEqual({ money: 18_400, currency: 'EUR' });
  });

  it('small changes, old news and subscriptions stay quiet', () => {
    expect(billChanged(inputs({ recurrings: [energy], txs: [...history, bill('2026-07-05', 15_600)] }))).toHaveLength(0);
    // the last bill is from April: nothing new in the last two periods
    expect(billChanged(inputs({ recurrings: [energy], txs: history.slice(0, 2) }))).toHaveLength(0);
    // a subscription answers to the sustained rule (priceCreep)
    expect(billChanged(inputs({ recurrings: [{ ...energy, kind: 'subscription' }], txs: [...history, bill('2026-07-05', 18_400)] }))).toHaveLength(0);
  });
});

describe('a recurring charge that did not come', () => {
  const spotify = rec({ id: 'spotify', name: 'Spotify', amountCents: 1_199, dueDay: 3, merchantKey: 'spotify', since: '2026-01-03' });
  const charge = (date: string, partial: Partial<TxView> = {}) =>
    tx({ date, amountCents: -1_199, merchant: 'Spotify', catId: 'subs', recurringId: 'spotify', ...partial });
  const paid = [charge('2026-04-03'), charge('2026-05-03'), charge('2026-06-03')];
  const lifeGoesOn = tx({ date: '2026-07-10', amountCents: -4_210 });

  it('normally €11.99 around the 3rd, nothing since — and the account shows newer rows', () => {
    const hits = missedCharge(inputs({ recurrings: [spotify], txs: [...paid, lifeGoesOn] }));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 'missed:spotify:2026-07-03', kind: 'missed', topic: 'subscriptions', severity: 'alert', actionTo: '/recurring/spotify' });
    expect(hits[0].params).toEqual({ name: 'Spotify', amount: { money: 1_199, currency: 'EUR' }, date: { date: '2026-07-03' } });
  });

  it('a charge that came unlinked, a feed that has not synced, a due date still in its grace: quiet', () => {
    const unlinked = tx({ date: '2026-07-06', amountCents: -1_199, merchant: 'Spotify', catId: 'subs' });
    expect(missedCharge(inputs({ recurrings: [spotify], txs: [...paid, unlinked, lifeGoesOn] }))).toHaveLength(0);
    expect(missedCharge(inputs({ recurrings: [spotify], txs: paid }))).toHaveLength(0);
    expect(missedCharge(inputs({ recurrings: [spotify], txs: [...paid, lifeGoesOn] }, '2026-07-06'))).toHaveLength(0);
  });

  it('"normally" needs the two dates before paid; a stopped or funding cost says nothing', () => {
    expect(missedCharge(inputs({ recurrings: [spotify], txs: [charge('2026-06-03'), lifeGoesOn] }))).toHaveLength(0);
    expect(missedCharge(inputs({ recurrings: [spotify], txs: [charge('2026-04-03'), charge('2026-06-03'), lifeGoesOn] }))).toHaveLength(0);
    expect(missedCharge(inputs({ recurrings: [{ ...spotify, active: 0 }], txs: [...paid, lifeGoesOn] }))).toHaveLength(0);
    expect(missedCharge(inputs({ recurrings: [{ ...spotify, catId: 'fundingOut' }], txs: [...paid, lifeGoesOn] }))).toHaveLength(0);
  });
});

describe('the same charge twice', () => {
  const buy = (partial: Partial<TxView>) => tx({ date: '2026-07-03', amountCents: -3_995, merchant: 'Bol.com', catId: 'electronics', ...partial });

  it('minutes apart by the card line’s clock', () => {
    const a = buy({ description: 'BOL.COM 03.07.2026 14U02 KV007' });
    const b = buy({ description: 'BOL.COM 03.07.2026 14U06 KV007' });
    const hits = duplicateCharge(inputs({ txs: [a, b] }));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: `dup:${a.id}:${b.id}`, kind: 'duplicate', severity: 'alert', subKey: 'ins.dup.subMinutes', actionTo: `/transactions/${b.id}` });
    expect(hits[0].params).toMatchObject({ amount: { money: 3_995, currency: 'EUR' }, mins: 4, date: { date: '2026-07-03' } });
  });

  it('without a clock: the same day and €20 or more', () => {
    const hits = duplicateCharge(inputs({ txs: [buy({}), buy({})] }));
    expect(hits[0]).toMatchObject({ subKey: 'ins.dup.subDay', detailKey: 'ins.dup.detailDay' });
    expect(hits[0].params.mins).toBeUndefined();
    // two coffees on one day are a morning, not a double charge
    const coffee = (partial: Partial<TxView>) => buy({ amountCents: -350, merchant: 'Koffiebar', ...partial });
    expect(duplicateCharge(inputs({ txs: [coffee({}), coffee({})] }))).toHaveLength(0);
  });

  it('far apart, three alike, refunded, reserved, on two accounts or long ago: quiet', () => {
    const at = (clock: string) => buy({ description: `BOL.COM 03.07.2026 ${clock}` });
    expect(duplicateCharge(inputs({ txs: [at('14U02'), at('14U14')] }))).toHaveLength(0);
    expect(duplicateCharge(inputs({ txs: [buy({}), buy({}), buy({})] }))).toHaveLength(0);
    const refund = tx({ date: '2026-07-05', amountCents: 3_995, merchant: 'Bol.com', catId: 'electronics' });
    expect(duplicateCharge(inputs({ txs: [buy({}), buy({}), refund] }))).toHaveLength(0);
    expect(duplicateCharge(inputs({ txs: [buy({}), buy({ pending: 1 })] }))).toHaveLength(0);
    expect(duplicateCharge(inputs({ txs: [buy({}), buy({ accountId: 'card' })] }))).toHaveLength(0);
    expect(duplicateCharge(inputs({ txs: [buy({ date: '2026-05-03' }), buy({ date: '2026-05-03' })] }))).toHaveLength(0);
    // a movement between own accounts is no purchase
    expect(duplicateCharge(inputs({ txs: [buy({ catId: 'savingDeposit', txType: 'saving' }), buy({ catId: 'savingDeposit', txType: 'saving' })] }))).toHaveLength(0);
  });

  it('chargeMoment reads the bank line’s clock, else the row’s own time', () => {
    const ing = chargeMoment({ date: '2026-10-31', merchant: 'Albert Heijn 1842 >S-GRAVENH30.10.2026 18U08 KV007' });
    const later = chargeMoment({ date: '2026-10-31', merchant: 'x', description: 'Pasvolgnr: 007 30-10-2026 18:15' });
    expect(later! - ing!).toBe(7);
    expect(chargeMoment({ date: '2026-07-03', merchant: 'Shop', time: '09:30' })! - chargeMoment({ date: '2026-07-03', merchant: 'Shop', time: '09:00' })!).toBe(30);
    expect(chargeMoment({ date: '2026-07-03', merchant: 'Albert Heijn 1470' })).toBeNull();
  });
});

describe('pay that is late', () => {
  const pay = (date: string, partial: Partial<TxView> = {}) =>
    tx({ date, amountCents: 250_000, merchant: 'ACME BV', catId: 'salary', txType: 'income', ...partial });
  const sixMonths = ['2026-01-23', '2026-02-24', '2026-03-24', '2026-04-24', '2026-05-23', '2026-06-25'].map((d) => pay(d));
  const groceries = tx({ date: '2026-07-27', amountCents: -6_240 });

  it('the salary usually lands between the 23rd and the 25th — three days past it, nothing yet', () => {
    const hits = salaryLate(inputs({ txs: [...sixMonths, groceries] }, '2026-07-29'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 'salary:acme:2026-07-23', kind: 'salary', topic: 'income', severity: 'alert', titleKey: 'ins.salary.title' });
    expect(hits[0].params).toEqual({ name: 'ACME BV', from: { date: '2026-07-23' }, to: { date: '2026-07-25' }, amount: { money: 250_000 } });
  });

  it('before the window closes, after an early payday, or with a feed that has not synced: quiet', () => {
    expect(salaryLate(inputs({ txs: [...sixMonths, groceries] }, '2026-07-26'))).toHaveLength(0);
    expect(salaryLate(inputs({ txs: [...sixMonths, pay('2026-07-20'), groceries] }, '2026-07-29'))).toHaveLength(0);
    expect(salaryLate(inputs({ txs: sixMonths }, '2026-07-29'))).toHaveLength(0);
  });

  it('other regular pay is named; small, irregular or foreign income is no salary', () => {
    const invoices = sixMonths.map((t) => ({ ...t, id: `${t.id}f`, merchant: 'Client X', catId: 'freelance', amountCents: 120_000 }));
    const named = salaryLate(inputs({ txs: [...invoices, groceries] }, '2026-07-29'));
    expect(named[0]).toMatchObject({ titleKey: 'ins.salary.titleNamed', params: { name: 'Client X' } });

    const cashback = sixMonths.map((t) => ({ ...t, id: `${t.id}c`, merchant: 'Cashback', amountCents: 500 }));
    expect(salaryLate(inputs({ txs: [...cashback, groceries] }, '2026-07-29'))).toHaveLength(0);
    const gap = sixMonths.filter((t) => !t.date.startsWith('2026-05'));
    expect(salaryLate(inputs({ txs: [...gap, groceries] }, '2026-07-29'))).toHaveLength(0);
    const dollars = sixMonths.map((t) => ({ ...t, currency: 'USD' }));
    expect(salaryLate(inputs({ txs: [...dollars, groceries] }, '2026-07-29'))).toHaveLength(0);
  });

  it('a whole month without pay is flagged in the month after too', () => {
    // June never came; in July the June window is the newest that closed with nothing in it
    const noJune = sixMonths.filter((t) => !t.date.startsWith('2026-06'));
    const hits = salaryLate(inputs({ txs: [...noJune, tx({ date: '2026-07-02', amountCents: -1_000 })] }, '2026-07-04'));
    expect(hits[0]?.id).toBe('salary:acme:2026-06-23');
  });
});
