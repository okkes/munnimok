import { describe, expect, it } from 'vitest';
import type { AccountRow, RecurringRow, SpaceRow, SpendSetAside, TxView } from '@/db/types';
import { isDefaultSpendPick, isSpendAccount, safeToSpend } from './safeToSpend';

const account = (id: string, type: AccountRow['type'], balanceCents: number, over: Partial<AccountRow> = {}): AccountRow => ({
  id,
  spaceId: 's1',
  name: id,
  type,
  source: 'manual',
  currency: 'EUR',
  balanceCents,
  fieldVersions: {},
  deleted: 0,
  ...over,
});

const rec = (over: Partial<RecurringRow>): RecurringRow => ({
  id: 'rent',
  spaceId: 's1',
  name: 'Rent',
  kind: 'fixed',
  amountCents: 85_000,
  every: 'month',
  dueDay: 20,
  active: 1,
  fieldVersions: {},
  deleted: 0,
  ...over,
});

const tx = (over: Partial<TxView>): TxView => ({
  id: Math.random().toString(36).slice(2),
  spaceId: 's1',
  accountId: 'main',
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

type Space = Pick<SpaceRow, 'periodType' | 'periodDay' | 'spendAccountIds' | 'spendSetAsides'>;
const MONTH: Space = { periodType: 'month', periodDay: 1 };
const TODAY = '2026-07-10';
const NO_PLAN = null;
const held = (over: Partial<Record<SpendSetAside, number>> = {}): Record<SpendSetAside, number> => ({
  goals: 0,
  events: 0,
  expenses: 0,
  budgets: 0,
  ahead: 0,
  ...over,
});

const main = account('main', 'checking', 150_000);
const wallet = account('wallet', 'cash', 2_000, { defaultFor: 'cash' });
const savings = account('savings', 'savings', 900_000);
const card = account('card', 'credit', -20_000, { paymentCents: 20_000, paymentDay: 25 });
const carLoan = account('car', 'loan', -500_000, { paymentCents: 25_000, paymentDay: 15 });

const run = (over: Partial<Parameters<typeof safeToSpend>[0]> = {}) =>
  safeToSpend({ accounts: [main, wallet, savings], space: MONTH, recurrings: [], txs: [], held: NO_PLAN, today: TODAY, ...over });

describe('safe to spend — the accounts (#541)', () => {
  it('sums every checking and cash account until the space picks its own', () => {
    const result = run({ accounts: [main, wallet, savings, card, account('old', 'checking', 99_999, { archived: 1 })] })!;
    expect(result.accounts.map((a) => a.id)).toEqual(['main', 'wallet']);
    expect(result.balanceCents).toBe(152_000);
  });

  it('a picked list wins — savings and a credit card count once picked, what is owed taking off', () => {
    const result = run({ accounts: [main, wallet, savings, card], space: { ...MONTH, spendAccountIds: ['main', 'card'] } })!;
    expect(result.accounts.map((a) => a.id)).toEqual(['main', 'card']);
    expect(result.balanceCents).toBe(130_000);
    expect(isSpendAccount(savings, { spendAccountIds: ['savings'] })).toBe(true);
    // a loan is never money to spend, picked or not
    expect(isSpendAccount(carLoan, { spendAccountIds: ['car'] })).toBe(false);
  });

  it('a pick that equals the default is no pick, so later accounts join by themselves', () => {
    expect(isDefaultSpendPick(new Set(['main', 'wallet']), [main, wallet, savings])).toBe(true);
    expect(isDefaultSpendPick(new Set(['main']), [main, wallet, savings])).toBe(false);
    expect(isDefaultSpendPick(new Set(['main', 'wallet', 'savings']), [main, wallet, savings])).toBe(false);
  });

  it('says nothing without an account money is spent from; an emptied pick sums nothing', () => {
    expect(run({ accounts: [carLoan, account('broker', 'brokerage', 10_000)] })).toBeNull();
    const emptied = run({ space: { ...MONTH, spendAccountIds: ['gone'] } })!;
    expect(emptied.accounts).toEqual([]);
    expect(emptied.balanceCents).toBe(0);
  });
});

describe('safe to spend — the hard facts', () => {
  it('a recurring cost still due before the period ends comes off, with its date', () => {
    const result = run({ recurrings: [rec({}), rec({ id: 'gym', name: 'Gym', amountCents: 3_000, dueDay: 5 })] })!;
    // the gym's 5th is behind us — its payment went by, linked or not, and never counts twice
    expect(result.dues).toEqual([{ kind: 'recurring', id: 'rent', name: 'Rent', dates: ['2026-07-20'], cents: 85_000 }]);
    expect(result.dueCents).toBe(85_000);
    expect(result.cents).toBe(152_000 - 85_000);
  });

  it('a cost paid early this period is no longer due; a stopped one never is', () => {
    const paidEarly = tx({ date: '2026-07-08', amountCents: -85_000, recurringId: 'rent' });
    expect(run({ recurrings: [rec({})], txs: [paidEarly] })!.dues).toEqual([]);
    expect(run({ recurrings: [rec({ active: 0 })] })!.dues).toEqual([]);
  });

  it('every occurrence still ahead counts — a weekly cost in a monthly period — the payments covering the nearest first', () => {
    const weekly = rec({ id: 'box', name: 'Veg box', amountCents: 2_500, every: 'week', since: '2026-07-02', dueDay: 1 });
    const paidOn = (date: string) => tx({ date, amountCents: -2_500, recurringId: 'box' });
    // Jul 2, 9, 16, 23, 30: the 9th's box went by without a link — the three ahead stay open
    const result = run({ recurrings: [weekly], txs: [paidOn('2026-07-02')] })!;
    expect(result.dues[0]).toMatchObject({ dates: ['2026-07-16', '2026-07-23', '2026-07-30'], cents: 7_500 });
    // the 16th's box paid early: the 23rd and the 30th are left
    const early = run({ recurrings: [weekly], txs: [paidOn('2026-07-02'), paidOn('2026-07-09'), paidOn('2026-07-10')] })!;
    expect(early.dues[0]).toMatchObject({ dates: ['2026-07-23', '2026-07-30'], cents: 5_000 });
  });

  it('a loan payment still due comes off; one paid this period, or a loan among the picked accounts, does not', () => {
    const due = run({ accounts: [main, wallet, carLoan] })!;
    expect(due.dues).toEqual([{ kind: 'loan', id: 'car', name: 'car', dates: ['2026-07-15'], cents: 25_000 }]);
    const paid = tx({ date: '2026-07-03', amountCents: -25_000, linkedAccountId: 'car' });
    expect(run({ accounts: [main, wallet, carLoan], txs: [paid] })!.dues).toEqual([]);
    // the card pays like a checking account once picked: its balance counts, paying it moves money between them
    expect(run({ accounts: [main, card], space: { ...MONTH, spendAccountIds: ['main', 'card'] } })!.dues).toEqual([]);
    expect(run({ accounts: [main, card] })!.dues.map((d) => d.id)).toEqual(['card']);
  });

  it('a transfer to a picked account is no cost; a recurring payment to a loan with a plan is listed once, as the loan', () => {
    const toSavings = rec({ id: 'save', name: 'Savings', amountCents: 10_000, dueDay: 25, linkedAccountId: 'savings' });
    expect(run({ recurrings: [toSavings] })!.dues.map((d) => d.id)).toEqual(['save']);
    expect(run({ recurrings: [toSavings], space: { ...MONTH, spendAccountIds: ['main', 'savings'] } })!.dues).toEqual([]);
    const loanRec = rec({ id: 'carrec', name: 'Car payment', amountCents: 25_000, dueDay: 15, linkedAccountId: 'car' });
    expect(run({ accounts: [main, carLoan], recurrings: [loanRec] })!.dues.map((d) => d.id)).toEqual(['car']);
  });

  it('the window is the space’s own period: a period from the 21st ends on the 20th', () => {
    const result = run({ space: { periodType: 'month', periodDay: 21 }, recurrings: [rec({ dueDay: 15 }), rec({ id: 'late', name: 'Late', dueDay: 25 })] })!;
    expect(result.period).toEqual({ start: '2026-06-21', end: '2026-07-20' });
    expect(result.dues.map((d) => d.id)).toEqual(['rent']);
    expect(result.days).toBe(11);
  });
});

describe('safe to spend — the plan’s set-asides', () => {
  it('offers nothing while the space plans nothing', () => {
    expect(run()!.setAsides).toEqual([]);
  });

  it('only the picked set-asides come off; the rest stay on offer with their amounts', () => {
    const result = run({
      space: { ...MONTH, spendSetAsides: ['goals', 'ahead'] },
      held: held({ goals: 20_000, events: 5_000, expenses: 40_000, ahead: 30_000 }),
    })!;
    expect(result.setAsides).toEqual([
      { kind: 'goals', cents: 20_000, picked: true },
      { kind: 'events', cents: 5_000, picked: false },
      { kind: 'expenses', cents: 40_000, picked: false },
      { kind: 'budgets', cents: 0, picked: false },
      { kind: 'ahead', cents: 30_000, picked: true },
    ]);
    expect(result.setAsideCents).toBe(50_000);
    expect(result.cents).toBe(152_000 - 50_000);
  });

  it('a fully planned period no longer leaves nothing: the result is what the facts and the picks leave, per day', () => {
    const result = run({ recurrings: [rec({})], held: held({ expenses: 152_000 }) })!;
    expect(result.cents).toBe(67_000);
    // Jul 10 – Jul 31, both counted
    expect(result.days).toBe(22);
    expect(result.perDayCents).toBe(Math.floor(67_000 / 22));
  });
});
