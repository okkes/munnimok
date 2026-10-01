// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';

const demoRepo = (db: MunniDB) => new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });

/** two loans the three orders disagree on: the card carries the higher rate, the car the smaller balance */
async function seedLoans() {
  const db = new MunniDB('munni_demo');
  const repo = demoRepo(db);
  await repo.upsert('account', 'demo_space', 'loan-car', {
    name: 'Car loan', type: 'loan', source: 'manual', currency: 'EUR', balanceCents: -400_000,
    interestPctYear: 5, paymentCents: 20_000, paymentEvery: 'month',
  });
  await repo.upsert('account', 'demo_space', 'loan-card', {
    name: 'Credit card', type: 'credit', source: 'manual', currency: 'EUR', balanceCents: -600_000,
    interestPctYear: 12, paymentCents: 15_000, paymentEvery: 'month', trackAsDebt: 1,
  });
  db.close();
}

const orderNames = () =>
  [...screen.getByTestId('debtplan-order').querySelectorAll('[data-testid^="debtplan-order-"]')].map((el) => (el as HTMLElement).textContent ?? '');

describe('Payoff planner (#413)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('names the debt-free month, orders the loans per strategy, compares the three, and reacts to an extra per month', async () => {
    renderApp('/debts/plan');
    await screen.findByTestId('screen-debtplan');
    await seedLoans();
    await screen.findByTestId('debtplan-hero');
    expect((await screen.findByTestId('debtplan-free')).textContent).toMatch(/Debt-free/);
    // avalanche: the 12% card before the 5% car
    await waitFor(() => expect(orderNames()[0]).toMatch(/Credit card/));
    expect(orderNames()[1]).toMatch(/Car loan/);
    expect(screen.getByTestId('debtplan-order-loan-card').textContent).toMatch(/12% interest/);
    expect(screen.getByTestId('debtplan-order-loan-card').textContent).toMatch(/paid off/);
    // the comparison lists all three with a date and the interest
    for (const s of ['avalanche', 'snowball', 'tsunami']) expect(screen.getByTestId(`debtplan-compare-${s}`).textContent).toMatch(/free .+ · €/);
    // snowball: the smaller car first
    fireEvent.click(screen.getByTestId('debtplan-strategy-snowball'));
    await waitFor(() => expect(orderNames()[0]).toMatch(/Car loan/));
    expect(screen.getByTestId('debtplan-strategy-snowball').getAttribute('aria-pressed')).toBe('true');
    // an extra per month: the hero says how much earlier than the minimums
    const before = screen.getByTestId('debtplan-hero').textContent;
    fireEvent.click(screen.getByTestId('debtplan-extra-chip-10000'));
    await waitFor(() => expect(screen.getByTestId('debtplan-vs').textContent).toMatch(/months earlier/));
    expect(screen.getByTestId('debtplan-hero').textContent).not.toBe(before);
    expect((screen.getByTestId('debtplan-extra') as HTMLInputElement).value).toBe('100');
    // the ladder applies on tap: +€25 on top of the €100
    fireEvent.click(screen.getByTestId('debtplan-ladder-2500'));
    await waitFor(() => expect((screen.getByTestId('debtplan-extra') as HTMLInputElement).value).toBe('125'));
    expect(screen.getByTestId('debtplan-chart')).toBeTruthy();
    // the inputs survive a reopen on this device
    cleanup();
    renderApp('/debts/plan');
    await screen.findByTestId('debtplan-hero');
    expect(screen.getByTestId('debtplan-strategy-snowball').getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByTestId('debtplan-extra') as HTMLInputElement).value).toBe('125');
  }, 20_000);

  it('tsunami: the weight chips write to the loan and the heaviest goes first', async () => {
    renderApp('/debts/plan');
    await screen.findByTestId('screen-debtplan');
    await seedLoans();
    await screen.findByTestId('debtplan-hero');
    fireEvent.click(screen.getByTestId('debtplan-strategy-tsunami'));
    await screen.findByTestId('debtplan-stress-loan-car-5');
    // unranked: both sit in the middle, the rate decides — the card first
    expect(orderNames()[0]).toMatch(/Credit card/);
    fireEvent.click(screen.getByTestId('debtplan-stress-loan-car-5'));
    await waitFor(() => expect(orderNames()[0]).toMatch(/Car loan/));
    expect(screen.getByTestId('debtplan-stress-loan-car-5').getAttribute('aria-pressed')).toBe('true');
    const db = new MunniDB('munni_demo');
    try {
      await waitFor(async () => expect((await db.accounts.get('loan-car'))?.debtStress).toBe(5));
    } finally {
      db.close();
    }
  }, 15_000);

  it('a payment that does not beat its interest is flagged and the plan says so', async () => {
    renderApp('/debts/plan');
    await screen.findByTestId('screen-debtplan');
    const db = new MunniDB('munni_demo');
    await demoRepo(db).upsert('account', 'demo_space', 'loan-trap', {
      name: 'Trap', type: 'loan', source: 'manual', currency: 'EUR', balanceCents: -1_000_000, interestPctYear: 24, paymentCents: 10_000, paymentEvery: 'month',
    });
    db.close();
    await screen.findByTestId('debtplan-hero');
    expect((await screen.findByTestId('debtplan-free')).textContent).toMatch(/Not paid off at this pace/);
    expect(screen.getByTestId('debtplan-order-loan-trap').textContent).toMatch(/never at this payment/);
    // enough extra and it is a plan again
    fireEvent.click(screen.getByTestId('debtplan-extra-chip-25000'));
    await waitFor(() => expect(screen.getByTestId('debtplan-free').textContent).toMatch(/Debt-free/));
  });

  it('no active debts: the empty state points back to Debts', async () => {
    renderApp('/debts/plan');
    await screen.findByTestId('screen-debtplan');
    await screen.findByTestId('debtplan-empty');
    expect(screen.queryByTestId('debtplan-hero')).toBeNull();
  });

  it('the Debts screen offers the planner once a loan exists and opens it', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    expect(screen.queryByTestId('debts-plan')).toBeNull();
    await seedLoans();
    fireEvent.click(await screen.findByTestId('debts-plan'));
    await screen.findByTestId('screen-debtplan');
    await screen.findByTestId('debtplan-hero');
  });
});
