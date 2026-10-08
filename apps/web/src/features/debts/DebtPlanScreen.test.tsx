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

  it('one chart for all debts, one per debt: an extra aimed at one debt moves its end, the hero and the budget, and survives a reopen (user 2026-10-08)', async () => {
    renderApp('/debts/plan');
    await screen.findByTestId('screen-debtplan');
    await seedLoans();
    await screen.findByTestId('debtplan-hero');
    await screen.findByTestId('debtplan-order-loan-car');
    // the overall chart carries both walks, the minimums-only one dashed; every debt has its own
    expect(screen.getByTestId('debtplan-chart').querySelectorAll('path')).toHaveLength(2);
    expect(screen.getByTestId('debtplan-chart-baseline').getAttribute('stroke-dasharray')).toBe('5 4');
    expect(screen.getByTestId('debtplan-chart-plan').getAttribute('stroke-dasharray')).toBeNull();
    expect(screen.getByTestId('debtplan-chart-legend').textContent).toMatch(/Minimums only · free/);
    expect(screen.getByTestId('debtplan-debt-chart-loan-car').querySelectorAll('path')).toHaveLength(2);
    expect(screen.getByTestId('debtplan-debt-legend-loan-car').textContent).toMatch(/Your plan · €[1-9].* interest/);
    // the x labels never pile up: a handful, all different
    const labels = [...screen.getByTestId('debtplan-chart').querySelectorAll('text')].map((el) => el.textContent);
    expect(labels.length).toBeGreaterThan(1);
    expect(labels.length).toBeLessThanOrEqual(7);
    expect(new Set(labels).size).toBe(labels.length);
    const endBefore = screen.getByTestId('debtplan-debt-end-loan-car').textContent;
    const heroBefore = screen.getByTestId('debtplan-hero').textContent;
    fireEvent.change(screen.getByTestId('debtplan-debt-extra-loan-car'), { target: { value: '100' } });
    await waitFor(() => expect(screen.getByTestId('debtplan-debt-end-loan-car').textContent).not.toBe(endBefore));
    expect(screen.getByTestId('debtplan-hero').textContent).not.toBe(heroBefore);
    // the budget line counts it: minimums 350 + the car's 100
    expect(screen.getByTestId('debtplan-budget').textContent).toMatch(/450/);
    // a chip sets it outright
    fireEvent.click(screen.getByTestId('debtplan-debt-extra-chip-loan-car-5000'));
    await waitFor(() => expect((screen.getByTestId('debtplan-debt-extra-loan-car') as HTMLInputElement).value).toBe('50'));
    expect(screen.getByTestId('debtplan-debt-extra-chip-loan-car-5000').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('debtplan-budget').textContent).toMatch(/400/);
    // a plan that ends within months is drawn over its own horizon, labelled by month
    fireEvent.change(screen.getByTestId('debtplan-lump'), { target: { value: '9900' } });
    await waitFor(() =>
      expect([...screen.getByTestId('debtplan-chart').querySelectorAll('text')].some((el) => /’[0-9]{2}$/.test(el.textContent ?? ''))).toBe(true),
    );
    // the per-debt extra survives a reopen on this device
    cleanup();
    renderApp('/debts/plan');
    await screen.findByTestId('debtplan-hero');
    expect(((await screen.findByTestId('debtplan-debt-extra-loan-car')) as HTMLInputElement).value).toBe('50');
  }, 20_000);

  it('no active debts: the empty state points back to Debts', async () => {
    renderApp('/debts/plan');
    await screen.findByTestId('screen-debtplan');
    await screen.findByTestId('debtplan-empty');
    expect(screen.queryByTestId('debtplan-hero')).toBeNull();
  });

  it('the Debts screen offers the planner once a loan exists — as a tool with a teaser from the minimums, not another loan — and opens it', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    expect(screen.queryByTestId('debts-plan')).toBeNull();
    await seedLoans();
    const card = await screen.findByTestId('debts-plan');
    expect(card.textContent).toMatch(/Tool/);
    expect(card.querySelector('progress')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('debts-plan-preview').textContent).toMatch(/At the minimums you’re free .+ — see what a little extra does/));
    fireEvent.click(card);
    await screen.findByTestId('screen-debtplan');
    await screen.findByTestId('debtplan-hero');
  });
});
