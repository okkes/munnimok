// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID } from '@/db/seed';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';

// pinned clock (Date only, timers stay real): a due day derived from the real date emptied the window on the 29th-31st
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(new Date('2026-08-15T10:00:00'));
afterAll(() => vi.useRealTimers());

const day = new Date().getDate();

/** fillerRecs: same-day recurring costs past the block's cap of 4, so the landing holds more than the block (#334) */
async function seedUpcomingPair({ fillerRecs = 0 } = {}) {
  // the boot chain must settle before this handle's writes (db.close trap)
  await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
  const db = new MunniDB('munni_demo');
  const repo = new Repo(new DexieBackend(db), new HlcClock('seed-334'), { trackOutbox: false });
  await repo.upsert('recurring', DEMO_SPACE_ID, 'rec334', {
    name: 'Gym 334',
    kind: 'subscription',
    amountCents: 2_500,
    every: 'month',
    dueDay: day,
    active: 1,
  });
  for (let i = 0; i < fillerRecs; i++) {
    await repo.upsert('recurring', DEMO_SPACE_ID, `rec334x${i}`, {
      name: `Filler 334 ${i}`,
      kind: 'subscription',
      amountCents: 1_000,
      every: 'month',
      dueDay: day,
      active: 1,
    });
  }
  await repo.upsert('account', DEMO_SPACE_ID, 'loan334', {
    name: 'Car loan 334',
    type: 'loan',
    source: 'manual',
    currency: 'EUR',
    balanceCents: -500_000,
    trackAsDebt: 1,
    paymentCents: 25_000,
    paymentEvery: 'month',
    paymentDay: day,
  });
  db.close();
}

describe('#334: upcoming see-all = recurring + loans together', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('home see-all navigates to /upcoming, which lists BOTH kinds in the window', async () => {
    const first = renderApp('/home');
    await screen.findByTestId('screen-home');
    // 5 recurrings: one past the block's cap
    await seedUpcomingPair({ fillerRecs: 4 });
    first.unmount();

    renderApp('/home');
    const blockLoan = await screen.findByTestId('home-upcoming-debt-loan334', {}, { timeout: 10_000 });
    await waitFor(() => expect(screen.getAllByTestId(/^home-upcoming-rec334/)).toHaveLength(4), { timeout: 10_000 });
    // costs print unsigned: the loan row wears no minus
    expect(blockLoan.textContent).toMatch(/€250/);
    expect(blockLoan.textContent).not.toMatch(/[−-]/);
    fireEvent.click(screen.getByTestId('home-seeall-upcoming'));
    await screen.findByTestId('screen-upcoming', {}, { timeout: 10_000 });
    const rec = await screen.findByTestId('upcoming-rec-rec334', {}, { timeout: 10_000 });
    const loan = await screen.findByTestId('upcoming-loan-loan334', {}, { timeout: 10_000 });
    expect(rec.textContent).toContain('Gym 334');
    expect(loan.textContent).toContain('Car loan 334');
    expect(screen.getAllByTestId(/^upcoming-rec-rec334/)).toHaveLength(5);
    expect(loan.textContent).toMatch(/€250/);
    expect(loan.textContent).not.toMatch(/[−-]/);
    expect(screen.queryByTestId('screen-recurring')).toBeNull();
  }, 30_000);

  it('rows navigate to their own details: recurring detail and debt detail', async () => {
    const first = renderApp('/upcoming');
    await screen.findByTestId('screen-upcoming');
    await seedUpcomingPair();
    first.unmount();

    renderApp('/upcoming');
    fireEvent.click(await screen.findByTestId('upcoming-rec-rec334', {}, { timeout: 10_000 }));
    expect(await screen.findByTestId('screen-recurring-detail', {}, { timeout: 10_000 })).toBeTruthy();
    cleanup();

    renderApp('/upcoming');
    fireEvent.click(await screen.findByTestId('upcoming-loan-loan334', {}, { timeout: 10_000 }));
    expect(await screen.findByTestId('debtdetail-hero', {}, { timeout: 10_000 })).toBeTruthy();
  }, 30_000);
});

describe('#336: upcoming loan rows wear the account face', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  async function seedFacedLoans() {
    // the boot chain must settle before this handle's writes (db.close trap)
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-336'), { trackOutbox: false });
    const plan = {
      type: 'loan' as const,
      source: 'manual' as const,
      currency: 'EUR',
      balanceCents: -300_000,
      trackAsDebt: 1 as const,
      paymentCents: 15_000,
      paymentEvery: 'month' as const,
      paymentDay: day,
    };
    await repo.upsert('account', DEMO_SPACE_ID, 'face336a', { ...plan, name: 'Tinted loan 336', color: '#B33771' });
    await repo.upsert('account', DEMO_SPACE_ID, 'face336b', { ...plan, name: 'Logo loan 336', logo: '/brands/acme.svg' });
    db.close();
  }

  function expectFaces(tinted: HTMLElement, logoed: HTMLElement) {
    const icon = tinted.querySelector('.mdi-hand-coin-outline');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('style') ?? '').toMatch(/#b33771|179,\s*55,\s*113/i);
    expect(tinted.querySelector('.mdi-credit-card-outline')).toBeNull();
    expect(logoed.querySelector('img')?.getAttribute('src')).toBe('/brands/acme.svg');
  }

  it('home block rows render the loan logo / colored type icon', async () => {
    const first = renderApp('/home');
    await screen.findByTestId('screen-home');
    await seedFacedLoans();
    first.unmount();

    renderApp('/home');
    const tinted = await screen.findByTestId('home-upcoming-debt-face336a', {}, { timeout: 10_000 });
    const logoed = await screen.findByTestId('home-upcoming-debt-face336b', {}, { timeout: 10_000 });
    expectFaces(tinted, logoed);
  }, 30_000);

  it('/upcoming landing rows render the loan logo / colored type icon', async () => {
    const first = renderApp('/upcoming');
    await screen.findByTestId('screen-upcoming');
    await seedFacedLoans();
    first.unmount();

    renderApp('/upcoming');
    const tinted = await screen.findByTestId('upcoming-loan-face336a', {}, { timeout: 10_000 });
    const logoed = await screen.findByTestId('upcoming-loan-face336b', {}, { timeout: 10_000 });
    expectFaces(tinted, logoed);
  }, 30_000);
});
