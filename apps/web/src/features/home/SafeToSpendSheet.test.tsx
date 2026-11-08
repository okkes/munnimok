// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { MunniDB } from '@/db/schema';
import { DEMO_SPACE_ID } from '@/db/seed';
import { cashWalletId } from '@/domain/defaultAccounts';
import { planId } from '@/domain/planning';
import { HlcClock } from '@/sync/hlc';
import { renderApp } from '@/test/harness';

/**
 * Safe to spend (#541) on the lean demo: checking €3,420.55, savings
 * €8,150.00 and an empty cash wallet; the space runs monthly periods from
 * the 1st; no recurring costs, loans or plan of its own.
 */

const WALLET = cashWalletId(DEMO_SPACE_ID);
const now = new Date();
const periodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

/** rows the lean demo lacks, written once the boot chain has settled (the db.close trap) */
async function seed(write: (repo: Repo) => Promise<void>) {
  const first = renderApp('/home');
  await screen.findByTestId('screen-home');
  await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
  const db = new MunniDB('munni_demo');
  await write(new Repo(new DexieBackend(db), new HlcClock('seed-spend'), { trackOutbox: false }));
  db.close();
  first.unmount();
}

async function openBreakdown() {
  renderApp('/home');
  fireEvent.click(await screen.findByTestId('home-cashflow', {}, { timeout: 5000 }));
  return screen.findByTestId('cashflow-breakdown');
}

describe('safe to spend (#541)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('sums the checking and cash accounts and takes off what is still due this period, each with its reason', async () => {
    // due today and not paid yet: it comes off
    await seed((repo) =>
      repo.upsert('recurring', DEMO_SPACE_ID, 'rec_gym', { name: 'Gym', kind: 'subscription', amountCents: 2_055, every: 'month', dueDay: now.getDate(), active: 1 }),
    );
    await openBreakdown();
    expect(screen.getByTestId('cashflow-account-demo_main')).toBeTruthy();
    expect(screen.getByTestId(`cashflow-account-${WALLET}`)).toBeTruthy();
    expect(screen.queryByTestId('cashflow-account-demo_save')).toBeNull();
    expect(screen.getByTestId('cashflow-due-rec_gym').textContent).toContain('Recurring cost');
    expect(screen.getByTestId('cashflow-headline').textContent).toContain('3,400.00');
    // the Home block and the breakdown tell the same number
    expect(screen.getByTestId('cashflow-total').textContent).toBe(screen.getByTestId('home-cashflow-amount').textContent);
    // no plan yet: the set-asides wait for one
    expect(screen.getByTestId('cashflow-noplan')).toBeTruthy();
  }, 20_000);

  it('the picked accounts make the sum, and the balance band highlights them under Safe to spend', async () => {
    await openBreakdown();
    fireEvent.click(screen.getByTestId('cashflow-accounts-change'));
    fireEvent.click(await screen.findByTestId('cashflow-pick-demo_save'));
    fireEvent.click(screen.getByTestId('cashflow-pick-save'));
    await waitFor(() => expect(screen.getByTestId('cashflow-headline').textContent).toContain('11,570.55'));

    fireEvent.click(screen.getByTestId('home-balance-band'));
    fireEvent.click(await screen.findByTestId('band-mode-spendable'));
    await waitFor(() => expect(screen.getByTestId('band-mode-label').textContent).toContain('Safe to spend'));
    expect(screen.getByTestId('home-total-balance').textContent).toContain('11,570.55');
    expect(screen.getByTestId('band-row-demo_save').dataset.included).toBe('1');
    expect(screen.getByTestId('band-row-demo_main').dataset.included).toBe('1');
  }, 20_000);

  it('a pick without any account is refused at the list', async () => {
    await openBreakdown();
    fireEvent.click(screen.getByTestId('cashflow-accounts-change'));
    fireEvent.click(await screen.findByTestId('cashflow-pick-demo_main'));
    // Enter ticks a row too, as it did while the row was a button
    fireEvent.keyDown(screen.getByTestId(`cashflow-pick-${WALLET}`), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('cashflow-pick-save'));
    expect(await screen.findByTestId('cashflow-pick-blocker')).toBeTruthy();
    expect(screen.getByTestId('cashflow-pick')).toBeTruthy();
  }, 20_000);

  it('the plan’s set-asides are switches: switched on, the money given to a goal comes off too', async () => {
    await seed(async (repo) => {
      const plan = planId(DEMO_SPACE_ID, 'actual', periodStart);
      await repo.upsert('plan', DEMO_SPACE_ID, plan, { kind: 'actual', periodStart });
      await repo.upsert('goal', DEMO_SPACE_ID, 'goal_trip', { name: 'Trip', targetCents: 300_000, allocatedCents: 0 });
      await repo.upsert('planSubject', DEMO_SPACE_ID, 'psub_trip', { planId: plan, segment: 'goals', order: 0, name: 'Trip', sourceId: 'goal_trip', fundedCents: 42_055 });
    });
    await openBreakdown();
    const goals = await screen.findByTestId('cashflow-setaside-goals');
    expect(goals.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('cashflow-headline').textContent).toContain('3,420.55');

    fireEvent.click(goals);
    await waitFor(() => expect(screen.getByTestId('cashflow-headline').textContent).toContain('3,000.00'));
    expect(screen.getByTestId('cashflow-setaside-goals').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('cashflow-setasides-total').textContent).toMatch(/€[1-9]/);
  }, 20_000);
});
