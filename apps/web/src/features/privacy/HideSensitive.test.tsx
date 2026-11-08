// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { MunniDB } from '@/db/schema';
import { DEMO_SPACE_ID } from '@/db/seed';
import type { Insight } from '@/domain/insights';
import { DisplayMoneyProvider, useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { useInsightText } from '@/features/insights/insightText';
import { hashPin, writeLockConfig } from '@/features/lock/lock';
import { HlcClock } from '@/sync/hlc';
import { renderApp, renderWithData } from '@/test/harness';
import { MASK, useHideSensitive } from './sensitive';

const state = () => screen.getByTestId('settings-hide-sensitive-state').textContent;

/** rows the lean demo lacks, written once the boot chain has settled (the db.close trap) */
async function seed(write: (repo: Repo) => Promise<void>) {
  const first = renderApp('/home');
  await screen.findByTestId('screen-home');
  await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
  const db = new MunniDB('munni_demo');
  await write(new Repo(new DexieBackend(db), new HlcClock('seed-hide'), { trackOutbox: false }));
  db.close();
  first.unmount();
}

describe('hide sensitive figures (#530)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
    useHideSensitive.getState().set(false);
  });

  it('switched on in Global settings, Home shows the balance, its accounts, income, savings and safe to spend as stars — spending stays', async () => {
    renderApp('/settings/global');
    fireEvent.click(await screen.findByTestId('settings-hide-sensitive'));
    expect(state()).toBe('ON');
    // a device preference, kept like the theme — no space row carries it
    expect(localStorage.getItem('munni_hide_sensitive')).toBe('1');
    cleanup();

    renderApp('/home');
    await waitFor(() => expect(screen.getByTestId('home-total-balance').textContent).toBe(MASK), { timeout: 5000 });
    for (const kind of ['income', 'saving', 'investment']) expect(screen.getByTestId(`home-overview-${kind}`).textContent).toContain(MASK);
    expect(screen.getByTestId('home-overview-expense').textContent).not.toContain(MASK);
    expect((await screen.findByTestId('home-cashflow-amount')).textContent).toBe(MASK);

    fireEvent.click(screen.getByTestId('home-balance-band'));
    expect((await screen.findByTestId('band-row-demo_main')).textContent).toContain(MASK);

    // the breakdown keeps what comes off readable, never what is there or what is left
    fireEvent.click(screen.getByTestId('home-cashflow'));
    await screen.findByTestId('cashflow-breakdown');
    expect(screen.getByTestId('cashflow-headline').textContent).toBe(MASK);
    expect(screen.getByTestId('cashflow-accounts-total').textContent).toBe(MASK);
    expect(screen.getByTestId('cashflow-total').textContent).toBe(MASK);
    expect(screen.queryByTestId('cashflow-bar')).toBeNull();
  }, 20_000);

  it('the info button on the balance says why and leads to the setting, which flashes', async () => {
    useHideSensitive.getState().set(true);
    renderApp('/home');
    fireEvent.click(await screen.findByTestId('home-band-hidden-info', {}, { timeout: 5000 }));
    await screen.findByTestId('privacy-info-sheet');
    fireEvent.click(screen.getByTestId('privacy-info-open'));
    await screen.findByTestId('screen-settings-global');
    await waitFor(() => expect(screen.getByTestId('settings-hide-sensitive').dataset.flash).toBe('1'), { timeout: 3000 });
  }, 20_000);

  it('without the hide mode there is no info button and every figure reads', async () => {
    renderApp('/home');
    await waitFor(() => expect(screen.getByTestId('home-total-balance').textContent).toMatch(/€[1-9]/), { timeout: 5000 });
    expect(screen.queryByTestId('home-band-hidden-info')).toBeNull();
    expect(screen.getByTestId('home-overview-income').textContent).not.toContain(MASK);
  }, 20_000);

  it('switching it off asks for the app lock first where one is set', async () => {
    useHideSensitive.getState().set(true);
    renderApp('/settings/global');
    await screen.findByTestId('settings-hide-sensitive');
    writeLockConfig({ enabled: true, pinSalt: 's', pinHash: await hashPin('1234', 's'), timeoutSec: 60 });
    fireEvent.click(screen.getByTestId('settings-hide-sensitive'));
    const pin = await screen.findByTestId('pin-challenge-pin');
    fireEvent.change(pin, { target: { value: '87654321' } });
    expect(await screen.findByTestId('pin-challenge-error')).toBeTruthy();
    expect(state()).toBe('ON');
    fireEvent.change(pin, { target: { value: '1234' } });
    await waitFor(() => expect(state()).toBe('OFF'));
  }, 20_000);

  it('without an app lock one tap switches it off', async () => {
    useHideSensitive.getState().set(true);
    renderApp('/settings/global');
    fireEvent.click(await screen.findByTestId('settings-hide-sensitive'));
    expect(state()).toBe('OFF');
    expect(screen.queryByTestId('pin-challenge-sheet')).toBeNull();
    expect(localStorage.getItem('munni_hide_sensitive')).toBeNull();
  }, 20_000);

  it('the screens one tap behind the hidden tiles keep income and savings hidden; spending reads', async () => {
    useHideSensitive.getState().set(true);
    renderApp('/overview/income');
    await waitFor(() => expect(screen.getByTestId('overview-total').textContent).toBe(MASK), { timeout: 5000 });
    cleanup();
    renderApp('/overview/expense');
    await waitFor(() => expect(screen.getByTestId('overview-total').textContent).toMatch(/€/), { timeout: 5000 });
    cleanup();
    renderApp('/periods');
    await waitFor(() => expect(screen.getByTestId('periods-value-income').textContent).toBe(MASK), { timeout: 5000 });
    expect(screen.getByTestId('periods-value-saving').textContent).toBe(MASK);
    expect(screen.getByTestId('periods-delta-income').textContent).not.toMatch(/€/);
    expect(screen.getByTestId('periods-value-expense').textContent).toMatch(/€/);
  }, 20_000);
});

/** what owns a balance, wherever it shows — the lens decides once, every screen asks it */
describe('hide sensitive figures beyond Home (#530)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
    useHideSensitive.getState().set(false);
  });

  it('the lens hides a figure in the display or its own currency, and any formatter a screen wraps with it', async () => {
    function Probe() {
      const { fmtSensitive, sensitive } = useDisplayMoney();
      const owned = sensitive((cents: number) => `${cents}c`);
      return <p data-testid="probe">{[fmtSensitive(123_456, 'EUR'), fmtSensitive(123_456, 'EUR', { asRecorded: true }), owned(500)].join('|')}</p>;
    }
    renderWithData(
      <DisplayMoneyProvider>
        <Probe />
      </DisplayMoneyProvider>,
    );
    expect((await screen.findByTestId('probe')).textContent).toBe('€1,234.56|€1,234.56|500c');
    act(() => useHideSensitive.getState().set(true));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe(`${MASK}|${MASK}|${MASK}`));
  }, 20_000);

  it('the financial accounts list hides every balance the moment the mode turns on', async () => {
    renderApp('/accounts');
    // the space cards mount collapsed (#314)
    fireEvent.click(await screen.findByTestId('accounts-space-head-demo_space', {}, { timeout: 10_000 }));
    const row = await screen.findByTestId('account-row-demo_main', {}, { timeout: 10_000 });
    await waitFor(() => expect(row.textContent).toContain('3,420.55'));
    act(() => useHideSensitive.getState().set(true));
    await waitFor(() => expect(screen.getByTestId('account-row-demo_main').textContent).toContain(MASK));
    expect(screen.getByTestId('account-row-demo_main').textContent).not.toContain('3,420.55');
  }, 20_000);

  it('debts hide what is owed and the loan’s size, on their screen and Home’s block — the payment stays', async () => {
    await seed((repo) =>
      repo.upsert('account', DEMO_SPACE_ID, 'loan_car', {
        name: 'Car loan',
        type: 'loan',
        source: 'manual',
        currency: 'EUR',
        balanceCents: -500_000,
        originalCents: 1_000_000,
        paymentCents: 25_000,
        paymentEvery: 'month',
        paymentDay: 15,
      }),
    );
    useHideSensitive.getState().set(true);
    renderApp('/debts');
    await waitFor(() => expect(screen.getByTestId('debt-remaining-loan_car').textContent).toBe(MASK), { timeout: 5000 });
    expect(screen.getByTestId('debts-total-owed').textContent).toBe(MASK);
    const card = screen.getByTestId('debt-card-loan_car');
    expect(card.textContent).toContain('250.00');
    expect(card.textContent).not.toMatch(/5,000|10,000/);
    cleanup();
    renderApp('/home');
    await waitFor(() => expect(screen.getByTestId('home-debts-owed').textContent).toBe(MASK), { timeout: 5000 });
  }, 20_000);

  it('goals hide the savings, what a goal holds and what is still to go — its target stays', async () => {
    await seed((repo) => repo.upsert('goal', DEMO_SPACE_ID, 'goal_trip', { name: 'Trip', targetCents: 300_000, allocatedCents: 0 }));
    useHideSensitive.getState().set(true);
    renderApp('/goals');
    await waitFor(() => expect(screen.getByTestId('goals-overview-saved').textContent).toContain(MASK), { timeout: 5000 });
    expect(screen.getByTestId('goals-overview-unallocated').textContent).toContain(MASK);
    expect(screen.getByTestId('goal-card-goal_trip').textContent).toContain(`${MASK} / €3,000.00`);
  }, 20_000);

  it('planning hides what is left to give and the pool behind it, here and on Home', async () => {
    useHideSensitive.getState().set(true);
    renderApp('/planning');
    fireEvent.click(await screen.findByTestId('plan-start-empty', {}, { timeout: 5000 }));
    await waitFor(() => expect(screen.getByTestId('plan-toallocate').textContent).toBe(MASK));
    expect(screen.getByTestId('plan-pool-line').textContent).toContain(MASK);
    expect(screen.getByTestId('plan-pool-line').textContent).not.toContain('3,420.55');
    cleanup();
    renderApp('/home');
    await waitFor(() => expect(screen.getByTestId('home-planning-left').textContent).toBe(MASK), { timeout: 5000 });
  }, 20_000);

  it('trends hide the net worth and every figure of the cash flow', async () => {
    useHideSensitive.getState().set(true);
    renderApp('/trends');
    fireEvent.click(await screen.findByTestId('trends-view-networth'));
    expect((await screen.findByTestId('trends-worth-now')).textContent).toBe(MASK);
    fireEvent.click(screen.getByTestId('trends-view-cashflow'));
    await waitFor(() => expect(screen.getByTestId('trends-flow-scrub').textContent).toContain(MASK));
    expect(screen.getByTestId('trends-flow-net').textContent).toContain(MASK);
    expect(screen.getByTestId('trends-flow-scrub').textContent).not.toMatch(/€\d/);
  }, 20_000);

  it('the portfolio hides its worth, gains and the size of a position', async () => {
    await seed(async (repo) => {
      await repo.upsert('holding', DEMO_SPACE_ID, 'h_acme', { name: 'ACME', assetClass: 'stock', currency: 'EUR', priceSource: 'manual', manualPriceCents: 5_000 });
      await repo.upsert('lot', DEMO_SPACE_ID, 'lot_acme', { holdingId: 'h_acme', kind: 'buy', date: '2026-01-05', quantity: 3, priceCents: 4_000, totalCents: -12_000 });
    });
    renderApp('/portfolio');
    await waitFor(() => expect(screen.getByTestId('pf-total').textContent).toContain('150.00'), { timeout: 5000 });
    act(() => useHideSensitive.getState().set(true));
    await waitFor(() => expect(screen.getByTestId('pf-total').textContent).toBe(MASK));
    const row = screen.getByTestId('pf-holding-h_acme');
    expect(row.textContent).not.toMatch(/150\.00|3 /);
    fireEvent.click(row);
    expect((await screen.findByTestId('pfdetail-value')).textContent).toBe(MASK);
    expect(screen.getByTestId('pfdetail-qty').textContent).toContain(MASK);
  }, 20_000);

  it('insight texts hide a salary or a debt they quote — what a change would save stays', async () => {
    const base = { topic: 'debt', severity: 'win', impactCents: 0, icon: 'flag-checkered' } as const;
    const insights: Insight[] = [
      {
        ...base,
        id: 'salary',
        kind: 'salary',
        topic: 'income',
        severity: 'alert',
        titleKey: 'ins.salary.title',
        detailKey: 'ins.salary.detail',
        params: { name: 'ACME', from: { date: '2026-07-20' }, to: { date: '2026-07-25' }, amount: { money: 250_000 } },
      },
      { ...base, id: 'clear', kind: 'debtclear', titleKey: 'ins.debtclear.title', detailKey: 'ins.debtclear.detailPlain', params: { name: 'Card', amount: { money: 34_000 } } },
      {
        ...base,
        id: 'acc',
        kind: 'debtacc',
        titleKey: 'ins.debtacc.title',
        detailKey: 'ins.debtacc.detail',
        params: { name: 'DUO', extra: { money: 5_000 }, months: 14, interest: { money: 258_100 } },
      },
    ];
    function Details() {
      const text = useInsightText('EUR');
      return insights.map((insight) => (
        <p key={insight.id} data-testid={`detail-${insight.id}`}>
          {text.detail(insight)}
        </p>
      ));
    }
    useHideSensitive.getState().set(true);
    renderWithData(
      <DisplayMoneyProvider>
        <Details />
      </DisplayMoneyProvider>,
    );
    expect((await screen.findByTestId('detail-salary')).textContent).toContain(MASK);
    expect(screen.getByTestId('detail-salary').textContent).not.toContain('2,500.00');
    expect(screen.getByTestId('detail-clear').textContent).toContain(MASK);
    expect(screen.getByTestId('detail-acc').textContent).toContain('€50.00');
    expect(screen.getByTestId('detail-acc').textContent).toContain('€2,581.00');
  }, 20_000);
});
