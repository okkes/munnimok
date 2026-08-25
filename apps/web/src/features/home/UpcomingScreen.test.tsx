// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID } from '@/db/seed';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';

// due TODAY on every calendar day (day-1 cadences lapse mid-month)
const day = Math.min(new Date().getDate(), 28);

/** one recurring cost + one tracked loan plan, both due inside the window */
async function seedUpcomingPair() {
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

/**
 * #334 (user): the home coming-up block mixes recurring costs and loan
 * payments — its see-all must land on the combined /upcoming list (both
 * kinds, segmented), never the recurring-only manager.
 */
describe('#334: upcoming see-all = recurring + loans together', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('home see-all navigates to /upcoming, which lists BOTH kinds in the window', async () => {
    const first = renderApp('/home');
    await screen.findByTestId('screen-home');
    await seedUpcomingPair();
    first.unmount();

    renderApp('/home');
    // the block itself carries both rows…
    await screen.findByTestId('home-upcoming-rec334', {}, { timeout: 10_000 });
    await screen.findByTestId('home-upcoming-debt-loan334', {}, { timeout: 10_000 });
    // …and see-all lands on the combined screen, not the recurring manager
    fireEvent.click(screen.getByTestId('home-seeall-upcoming'));
    await screen.findByTestId('screen-upcoming', {}, { timeout: 10_000 });
    const rec = await screen.findByTestId('upcoming-rec-rec334', {}, { timeout: 10_000 });
    const loan = await screen.findByTestId('upcoming-loan-loan334', {}, { timeout: 10_000 });
    expect(rec.textContent).toContain('Gym 334');
    expect(loan.textContent).toContain('Car loan 334');
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
