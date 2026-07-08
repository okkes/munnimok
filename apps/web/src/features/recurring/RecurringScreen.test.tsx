// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID } from '@/db/seed';
import { reconcileRecurringLinks } from '@/application/recurring';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
import { MunniDB } from '@/db/schema';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthsAgo = (n: number, day = 7) => {
  const now = new Date();
  return iso(new Date(now.getFullYear(), now.getMonth() - n, day));
};

/** four clean monthly Netflix charges ending this month */
async function seedNetflixPattern(db: MunniDB) {
  const repo = new Repo(db, new HlcClock('seed-rec'), { trackOutbox: false });
  for (let i = 0; i < 4; i++) {
    await repo.upsert('transaction', DEMO_SPACE_ID, `nfx_${i}`, {
      accountId: 'demo_main',
      date: monthsAgo(i, Math.min(new Date().getDate(), 28)),
      amountCents: -1399,
      currency: 'EUR',
      merchant: 'NETFLIX.COM',
      catId: 'subs',
      txType: 'expense',
      needsReview: 0,
    });
  }
}

describe('RecurringScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('creates a recurring cost from the sheet and shows it with period stats', async () => {
    renderApp('/recurring');
    await screen.findByTestId('screen-recurring');

    fireEvent.click(screen.getByTestId('recurring-add'));
    fireEvent.change(await screen.findByTestId('recform-name'), { target: { value: 'Rent' } });
    fireEvent.click(screen.getByTestId('recform-kind-fixed'));
    fireEvent.change(screen.getByTestId('recform-amount'), { target: { value: '740' } });
    fireEvent.click(screen.getByTestId('recform-save'));

    await waitFor(() => expect(screen.getByText('Rent')).toBeTruthy(), { timeout: 5000 });
    // summary shows the expected total for this period
    expect(screen.getByTestId('recurring-summary').textContent).toMatch(/740/);
    expect(screen.getByText(/Fixed costs/)).toBeTruthy();
  }, 15_000);

  it('luxury subscriptions show the badge and the luxury line', async () => {
    renderApp('/recurring');
    await screen.findByTestId('screen-recurring');

    fireEvent.click(screen.getByTestId('recurring-add'));
    fireEvent.change(await screen.findByTestId('recform-name'), { target: { value: 'Spotify' } });
    fireEvent.change(screen.getByTestId('recform-amount'), { target: { value: '9.99' } });
    fireEvent.click(screen.getByTestId('recform-luxury'));
    fireEvent.click(screen.getByTestId('recform-save'));

    await waitFor(() => expect(screen.getByText('Spotify')).toBeTruthy(), { timeout: 5000 });
    expect(screen.getByTestId('recurring-luxury-line')).toBeTruthy();
  }, 15_000);

  it('detects a monthly pattern; dismissing removes it for good', async () => {
    const db = new MunniDB('munni_demo');
    // the demo seed only runs once — let the app create it first
    renderApp('/recurring');
    await screen.findByTestId('screen-recurring');
    await seedNetflixPattern(db);

    const suggestions = await screen.findByTestId('recurring-suggestions', {}, { timeout: 5000 });
    expect(suggestions.textContent).toContain('NETFLIX.COM');

    fireEvent.click(screen.getByTestId('recurring-dismiss-netflix com'));
    // the demo data may yield suggestions of its own — only Netflix must go
    await waitFor(() => expect(screen.queryByTestId('recurring-dismiss-netflix com')).toBeNull(), { timeout: 5000 });
    // the dismissal is persisted, not just hidden
    expect(await db.recurringDismissals.count()).toBe(1);
    db.close();
  }, 15_000);

  it('accepting a suggestion prefills the sheet and links past payments on save', async () => {
    const db = new MunniDB('munni_demo');
    renderApp('/recurring');
    await screen.findByTestId('screen-recurring');
    await seedNetflixPattern(db);

    await screen.findByTestId('recurring-suggestions', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('recurring-accept-netflix com'));
    const name = (await screen.findByTestId('recform-name')) as HTMLInputElement;
    expect(name.value).toBe('NETFLIX.COM');
    expect((screen.getByTestId('recform-amount') as HTMLInputElement).value).toBe('13.99');

    fireEvent.click(screen.getByTestId('recform-save'));
    // accepted suggestion reconciles: past charges get linked (one per month)
    await waitFor(
      async () => {
        const linked = await db.transactions.filter((t) => !!t.recurringId).count();
        expect(linked).toBe(4);
      },
      { timeout: 5000 },
    );
    db.close();
  }, 15_000);
});

describe('reconcileRecurringLinks', () => {
  it('links matching unlinked expenses at most once per billing cycle', async () => {
    const db = new MunniDB(`munni_test_rec_${Math.random().toString(36).slice(2)}`);
    const repo = new Repo(db, new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('space', 's1', 's1', { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await repo.upsert('recurring', 's1', 'rec1', {
      name: 'Gym',
      kind: 'subscription',
      amountCents: 2499,
      every: 'month',
      dueDay: 10,
      active: 1,
      merchantKey: 'basic fit',
    });
    // two charges in one month (double-billing) + one the next month + a mismatch
    const rows: [string, string, number][] = [
      ['g1', '2026-06-10', -2499],
      ['g2', '2026-06-24', -2499],
      ['g3', '2026-07-10', -2599], // within 25% tolerance
      ['g4', '2026-07-12', -9900], // way off — not this subscription
    ];
    for (const [id, date, amountCents] of rows) {
      await repo.upsert('transaction', 's1', id, {
        accountId: 'a',
        date,
        amountCents,
        currency: 'EUR',
        merchant: 'Basic-Fit 123',
        txType: 'expense',
        needsReview: 0,
      });
    }

    expect(await reconcileRecurringLinks(db, repo, 's1')).toBe(2); // g1 + g3
    expect((await db.transactions.get('g1'))?.recurringId).toBe('rec1');
    expect((await db.transactions.get('g2'))?.recurringId).toBeUndefined();
    expect((await db.transactions.get('g3'))?.recurringId).toBe('rec1');
    expect((await db.transactions.get('g4'))?.recurringId).toBeUndefined();
    // idempotent
    expect(await reconcileRecurringLinks(db, repo, 's1')).toBe(0);
    db.close();
  });
});
