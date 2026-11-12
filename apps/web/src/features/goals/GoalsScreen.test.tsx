// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { MunniDB } from '@/db/schema';
import { DEMO_SPACE_ID } from '@/db/seed';
import { HlcClock } from '@/sync/hlc';
import { USER_TEST_DB, renderApp, renderAppAsUser } from '@/test/harness';

async function createGoal(name: string, target: string) {
  fireEvent.click(await screen.findByTestId('goals-add'));
  await screen.findByTestId('goalform-name');
  fireEvent.change(screen.getByTestId('goalform-name'), { target: { value: name } });
  fireEvent.change(screen.getByTestId('goalform-target'), { target: { value: target } });
  fireEvent.click(screen.getByTestId('goalform-save'));
  await waitFor(() => {
    expect(document.querySelector('[data-testid^="goal-card-"]')).toBeTruthy();
  });
  return document.querySelector('[data-testid^="goal-card-"]')!;
}

// the sheet's close animation never finishes in happy-dom, so completion
// is observed on the numbers, not on the sheet unmounting
async function fund(kind: 'goaldetail-fund' | 'goaldetail-withdraw', amount: string, expected: RegExp) {
  fireEvent.click(screen.getByTestId(kind));
  const input = await screen.findByTestId('goalfund-amount');
  fireEvent.change(input, { target: { value: amount } });
  fireEvent.click(screen.getByTestId('goalfund-save'));
  // the input resets in the same batch as the sheet close — once it's
  // empty, the stale close can no longer race the next open
  await waitFor(() => expect((screen.getByTestId('goalfund-amount') as HTMLInputElement).value).toBe(''));
  await waitFor(() => expect(screen.getByTestId('goaldetail-allocated').textContent).toMatch(expected), { timeout: 5000 });
}

describe('Goals (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('creates a goal; the header shows the savings honesty numbers', async () => {
    renderApp('/goals');
    await screen.findByTestId('screen-goals');
    await screen.findByTestId('goals-empty');

    // the form offers the goal-themed covers, not the event scenes
    fireEvent.click(await screen.findByTestId('goals-add'));
    await screen.findByTestId('goalform-pic-house');
    expect(screen.queryByTestId('goalform-pic-beach')).toBeNull();

    const card = await createGoal('New car', '1000');
    expect(card.textContent).toContain('New car');
    // demo savings account holds €8,150 — saved and unallocated show it
    const overview = screen.getByTestId('goals-overview');
    await waitFor(() => expect(overview.textContent).toMatch(/8.150/));
    expect(screen.queryByTestId('goals-negative-note')).toBeNull();
  }, 15_000);

  it('#449 + user 2026-10-04: the card says what is left and the pace per period; the page says how many times', async () => {
    renderApp('/goals');
    await screen.findByTestId('screen-goals');
    fireEvent.click(await screen.findByTestId('goals-add'));
    await screen.findByTestId('goalform-name');
    fireEvent.change(screen.getByTestId('goalform-name'), { target: { value: 'England' } });
    fireEvent.change(screen.getByTestId('goalform-target'), { target: { value: '1000' } });
    // the demo space counts monthly from the 1st: a date next month is two
    // periods away - this one and the next - so the thousand splits in two
    const next = new Date();
    next.setMonth(next.getMonth() + 1, 15);
    fireEvent.change(screen.getByTestId('goalform-date'), { target: { value: next.toISOString().slice(0, 10) } });
    fireEvent.click(screen.getByTestId('goalform-save'));
    const card = await waitFor(() => {
      const found = document.querySelector('[data-testid^="goal-card-"]');
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(card.textContent).toMatch(/€1,000[.,]00 to go/);
    expect(card.textContent).toMatch(/€500[.,]00 \u002f month/);

    fireEvent.click(card);
    expect((await screen.findByTestId('goaldetail-togo')).textContent).toMatch(/€1,000[.,]00 to go/);
    expect(screen.getByTestId('goaldetail-pace').textContent).toMatch(/€500[.,]00 per month, 2 more times/);
  }, 15_000);

  it('funding and withdrawing move the allocation and write history', async () => {
    renderApp('/goals');
    await screen.findByTestId('screen-goals');
    const card = await createGoal('Bike', '500');

    fireEvent.click(card);
    await screen.findByTestId('goaldetail-hero');
    await fund('goaldetail-fund', '100', /€100[.,]00/);
    await fund('goaldetail-withdraw', '40', /€60[.,]00/);

    // the amount and the history are two reads: a history line can land a moment after the amount it belongs to
    await waitFor(
      () => {
        const history = screen.getByTestId('goaldetail-history');
        expect(history.textContent).toContain('+€100.00');
        expect(history.textContent).toMatch(/-€40[.,]00/);
      },
      { timeout: 5000 },
    );
  }, 15_000);

  it('allocating more than the savings balance flags the rebalance note', async () => {
    renderApp('/goals');
    await screen.findByTestId('screen-goals');
    const card = await createGoal('House', '20000');

    fireEvent.click(card);
    await screen.findByTestId('goaldetail-hero');
    // €8,000 into €8,150 of savings is fine; the savings then drop to
    // €5,000 → unallocated −€3,000 (user must fix it)
    await fund('goaldetail-fund', '8000', /€8[.,]000[.,]00/);
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await db.accounts.update('demo_save', { balanceCents: 500_000 });
    db.close();

    cleanup();
    renderApp('/goals');
    const note = await screen.findByTestId('goals-negative-note', {}, { timeout: 5000 });
    expect(note.textContent).toMatch(/3[.,]000/);
  }, 15_000);

  it('#455: savings that shrank under a reached goal point at cashing it out', async () => {
    renderApp('/goals');
    await screen.findByTestId('screen-goals');
    const card = await createGoal('Car', '8000');
    fireEvent.click(card);
    await screen.findByTestId('goaldetail-hero');
    await fund('goaldetail-fund', '8000', /€8[.,]000[.,]00/);
    // the car was bought: the savings account dropped to €2,000
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await db.accounts.update('demo_save', { balanceCents: 200_000 });
    db.close();

    cleanup();
    renderApp('/goals');
    await screen.findByTestId('goals-negative-note', {}, { timeout: 5000 });
    expect(screen.getByTestId('goals-cashout-hint').textContent).toMatch(/Cash it out/);
  }, 15_000);

  it('#368: funding beyond the savings pool is refused with what is left; the pool is the ticked savings accounts', async () => {
    renderApp('/goals');
    await screen.findByTestId('screen-goals');
    const card = await createGoal('House', '20000');
    fireEvent.click(card);
    await screen.findByTestId('goaldetail-hero');
    fireEvent.click(screen.getByTestId('goaldetail-fund'));
    fireEvent.change(await screen.findByTestId('goalfund-amount'), { target: { value: '9000' } });
    await waitFor(() => expect(screen.getByTestId('goalfund-pool').textContent).toMatch(/8[.,]150/));
    fireEvent.click(screen.getByTestId('goalfund-save'));
    await screen.findByTestId('goalfund-pool-blocker');
    expect(screen.getByTestId('goaldetail-allocated').textContent).toMatch(/€0[.,]00/);

    cleanup();
    renderApp('/goals');
    await waitFor(() => expect(screen.getByTestId('goals-overview-saved').textContent).toMatch(/8[.,]150/));
    fireEvent.click(screen.getByTestId('goals-pool-toggle'));
    fireEvent.click(await screen.findByTestId('goalpool-acct-demo_save'));
    await waitFor(() => expect(screen.getByTestId('goals-overview-saved').textContent).toMatch(/€0[.,]00/), { timeout: 5000 });
  }, 20_000);

  it('#368: a goal due within three months is pointed at allocation', async () => {
    renderApp('/goals');
    await screen.findByTestId('screen-goals');
    fireEvent.click(await screen.findByTestId('goals-add'));
    await screen.findByTestId('goalform-name');
    const soon = new Date();
    soon.setMonth(soon.getMonth() + 2);
    fireEvent.change(screen.getByTestId('goalform-date'), { target: { value: soon.toISOString().slice(0, 10) } });
    await screen.findByTestId('goalform-shortterm');
    fireEvent.click(screen.getByTestId('goalform-shortterm-go'));
    expect(await screen.findByTestId('screen-planning')).toBeTruthy();
  }, 15_000);

  it('#455: a reached goal cashes out — the picked withdrawal leaves the saving, the rest goes back to the pool, undo restores it', async () => {
    renderApp('/goals');
    await screen.findByTestId('screen-goals');
    const card = await createGoal('Car', '1000');
    fireEvent.click(card);
    await screen.findByTestId('goaldetail-hero');
    // user 2026-11-12: cash out whenever you want — a quiet door until the goal is reached, the card once it is
    expect(screen.getByTestId('goaldetail-cashout')).toBeTruthy();
    expect(screen.queryByTestId('goaldetail-reached')).toBeNull();
    await fund('goaldetail-fund', '1000', /€1[.,]000[.,]00/);
    expect(screen.getByTestId('goaldetail-reached')).toBeTruthy();

    // €900 left the savings account to pay for the car
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const { localToday } = await import('@/application/recurring');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('transaction', 'demo_space', 'car-withdrawal', {
      accountId: 'demo_save',
      date: localToday(),
      amountCents: -90_000,
      currency: 'EUR',
      merchant: 'Naar betaalrekening',
      catId: 'savingWithdraw',
      needsReview: 0,
    });
    // …and paid the dealer from the checking account
    await repo.upsert('transaction', 'demo_space', 'car-purchase', {
      accountId: 'demo_main',
      date: localToday(),
      amountCents: -90_000,
      currency: 'EUR',
      merchant: 'Autobedrijf Jansen',
      catId: 'groceries',
      needsReview: 0,
    });

    fireEvent.click(await screen.findByTestId('goaldetail-cashout'));
    await screen.findByTestId('screen-goal-cashout');
    const confirm = screen.getByTestId('goalcashout-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(await screen.findByTestId('goalcashout-pick-car-withdrawal', {}, { timeout: 5000 }));
    expect(screen.getByTestId('goalcashout-fig-selected').textContent).toMatch(/€900[.,]00/);
    expect(screen.getByTestId('goalcashout-fig-back').textContent).toMatch(/€100[.,]00/);
    expect(screen.queryByTestId('goalcashout-over')).toBeNull();
    // what it bought is the second, optional pick: spending only — the move out of savings is not on offer there
    expect(screen.queryByTestId('goalcashout-buy-car-withdrawal')).toBeNull();
    expect(screen.queryByTestId('goalcashout-bought-total')).toBeNull();
    fireEvent.click(await screen.findByTestId('goalcashout-buy-car-purchase'));
    expect(screen.getByTestId('goalcashout-bought-total').textContent).toMatch(/€900[.,]00/);
    fireEvent.click(confirm);

    // the goal page says what paid for it and where the rest went
    const done = await screen.findByTestId('goaldetail-cashedout', {}, { timeout: 5000 });
    expect(screen.getByTestId('goaldetail-cashedout-sum').textContent).toMatch(/€900[.,]00/);
    expect(screen.getByTestId('goaldetail-cashedout-rest').textContent).toMatch(/€100[.,]00/);
    expect(done.textContent).toContain('Naar betaalrekening');
    expect(screen.getByTestId('goaldetail-bought-txs').textContent).toContain('Autobedrijf Jansen');
    expect(screen.queryByTestId('goaldetail-fund')).toBeNull();
    const activity = (await db.activities.toArray()).map((row) => row.kind);
    expect(activity).toContain('goalCashOut');

    // the period's saving does not count it — the drill names the goal instead
    cleanup();
    renderApp('/overview/saving');
    const cashouts = await screen.findByTestId('overview-cashouts', {}, { timeout: 5000 });
    expect(cashouts.textContent).toContain('Car');
    expect(cashouts.textContent).toMatch(/€900[.,]00/);
    expect(screen.queryByTestId('overview-sub-savingWithdraw')).toBeNull();
    // …and Home's tile and the Periods card mark it without counting it
    cleanup();
    renderApp('/home');
    expect(await screen.findByTestId('home-overview-cashout', {}, { timeout: 5000 })).toBeTruthy();
    cleanup();
    renderApp('/periods');
    expect((await screen.findByTestId('periods-cashout-saving', {}, { timeout: 5000 })).textContent).toMatch(/€900[.,]00/);

    // undo: the goal is back as it was
    cleanup();
    renderApp('/goals');
    fireEvent.click(await screen.findByTestId(card.getAttribute('data-testid')!, {}, { timeout: 5000 }));
    fireEvent.click(await screen.findByTestId('goaldetail-undo-cashout'));
    await screen.findByTestId('goaldetail-cashout', {}, { timeout: 5000 });
    db.close();
  }, 30_000);

  it('user 2026-11-12: a goal cashes out before it is reached; more than it held says what that does to the unallocated savings; what it bought is named afterwards', async () => {
    renderApp('/goals');
    await screen.findByTestId('screen-goals');
    const card = await createGoal('Bike', '1000');
    fireEvent.click(card);
    await screen.findByTestId('goaldetail-hero');
    await fund('goaldetail-fund', '500', /€500[.,]00/);

    const { localToday } = await import('@/application/recurring');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    const row = { date: localToday(), amountCents: -90_000, currency: 'EUR', needsReview: 0 as const };
    await repo.upsert('transaction', DEMO_SPACE_ID, 'bike-withdrawal', { ...row, accountId: 'demo_save', merchant: 'Naar betaalrekening', catId: 'savingWithdraw' });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'bike-purchase', { ...row, accountId: 'demo_main', merchant: 'Fietsenwinkel Zuid', catId: 'groceries' });

    fireEvent.click(screen.getByTestId('goaldetail-cashout'));
    await screen.findByTestId('screen-goal-cashout');
    fireEvent.click(await screen.findByTestId('goalcashout-pick-bike-withdrawal', {}, { timeout: 5000 }));
    // €400 more than the goal held: it comes out of the unallocated savings, which the demo's €8,150 cover
    const over = screen.getByTestId('goalcashout-over');
    expect(over.textContent).toMatch(/€400[.,]00/);
    expect(over.textContent).toMatch(/unallocated savings/);
    expect(over.getAttribute('data-negative')).toBe('false');
    fireEvent.click(screen.getByTestId('goalcashout-confirm'));

    await screen.findByTestId('goaldetail-cashedout', {}, { timeout: 5000 });
    expect(screen.getByTestId('goaldetail-cashedout-rest').textContent).toMatch(/€400[.,]00.*unallocated savings/);
    // nothing named yet — the goal page offers to; the screen opens on that pick alone
    expect(screen.queryByTestId('goaldetail-bought-txs')).toBeNull();
    fireEvent.click(screen.getByTestId('goaldetail-name-bought'));
    await waitFor(() => expect(screen.getByTestId('screen-goal-cashout').getAttribute('data-mode')).toBe('bought'));
    expect(screen.queryByTestId('goalcashout-list')).toBeNull();
    // the search narrows the list; a pick made before stays
    fireEvent.change(screen.getByTestId('goalcashout-search'), { target: { value: 'no such shop' } });
    await screen.findByTestId('goalcashout-bought-empty');
    fireEvent.change(screen.getByTestId('goalcashout-search'), { target: { value: 'Fietsenwinkel' } });
    fireEvent.click(await screen.findByTestId('goalcashout-buy-bike-purchase'));
    fireEvent.click(screen.getByTestId('goalcashout-confirm'));
    const bought = await screen.findByTestId('goaldetail-bought-txs', {}, { timeout: 5000 });
    expect(bought.textContent).toContain('Fietsenwinkel Zuid');
    await waitFor(async () => expect((await db.activities.toArray()).map((a) => a.kind)).toContain('goalPurchase'));
    const stored = await db.goals.toArray();
    expect(stored[0].cashOut).toMatchObject({ txIds: ['bike-withdrawal'], purchaseTxIds: ['bike-purchase'] });
    db.close();
  }, 30_000);

  it('the home block surfaces progress; the settings row reaches goals', async () => {
    renderApp('/goals');
    await screen.findByTestId('screen-goals');
    await createGoal('New car', '1000');

    cleanup();
    renderApp('/home');
    const block = await screen.findByTestId('home-goals', {}, { timeout: 5000 });
    expect(block.textContent).toContain('New car');
    fireEvent.click(screen.getByTestId('home-goals-all'));
    await screen.findByTestId('screen-goals');

    cleanup();
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-goals-row'));
    await screen.findByTestId('screen-goals');
  }, 15_000);
});

describe('Goals, west of Greenwich', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a cashed-out goal names the day it was cashed out, not the day before', async () => {
    const first = renderApp('/goals');
    await screen.findByTestId('screen-goals');
    // the boot chain settles before the seed opens its own connection
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-cashout'), { trackOutbox: false });
    await repo.upsert('goal', DEMO_SPACE_ID, 'goal_car', { name: 'Car', targetCents: 100_000, allocatedCents: 0, archived: 1, cashOut: { date: '2026-10-14', txIds: [] } });
    db.close();
    first.unmount();

    // a day string parsed as UTC midnight is the evening before here
    vi.stubEnv('TZ', 'America/New_York');
    renderApp('/goals');
    const card = await screen.findByTestId('goal-card-goal_car', {}, { timeout: 5000 });
    expect(card.textContent).toContain('Cashed out on 14 Oct 2026');
    fireEvent.click(card);
    expect((await screen.findByTestId('goaldetail-pace')).textContent).toContain('Cashed out on 14 Oct 2026');
  }, 20_000);
});

describe('Goals, signed in', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a deadline and a picture taken off a goal reach the server as null', async () => {
    // what the server is sent for the goal, as the JSON it arrives in
    const sent: Record<string, unknown>[] = [];
    renderAppAsUser('/goals', {
      api: {
        'POST /sync/s-user/push': (body) => {
          for (const op of (body as { ops: { entity: string; fields: Record<string, unknown> }[] }).ops) if (op.entity === 'goal') sent.push(op.fields);
          return { lastSeq: 0 };
        },
      },
    });
    await screen.findByTestId('screen-goals');
    fireEvent.click(await screen.findByTestId('goals-add'));
    fireEvent.click(await screen.findByTestId('goalform-pic-bike'));
    fireEvent.change(screen.getByTestId('goalform-name'), { target: { value: 'Bike' } });
    fireEvent.change(screen.getByTestId('goalform-target'), { target: { value: '900' } });
    fireEvent.change(screen.getByTestId('goalform-date'), { target: { value: '2031-06-01' } });
    fireEvent.click(screen.getByTestId('goalform-save'));
    await waitFor(() => expect(sent.at(-1)).toMatchObject({ picture: '/goals/bike.jpg', targetDate: '2031-06-01' }));

    const card = await waitFor(() => {
      const el = document.querySelector('[data-testid^="goal-card-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(card);
    fireEvent.click(await screen.findByTestId('goaldetail-edit'));
    await waitFor(() => expect((screen.getByTestId('goalform-date') as HTMLInputElement).value).toBe('2031-06-01'));
    fireEvent.click(screen.getByTestId('goalform-pic-none'));
    fireEvent.change(screen.getByTestId('goalform-date'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('goalform-save'));
    await waitFor(() => expect(sent.at(-1)).toMatchObject({ picture: null, targetDate: null }));
  }, 20_000);
});
