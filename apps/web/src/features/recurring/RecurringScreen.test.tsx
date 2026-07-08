// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('the brand picker offers vendored icons and picking stores the logo', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('brands/index.json')
        ? new Response(JSON.stringify([{ slug: 'netflix', title: 'Netflix' }]), { status: 200 })
        : new Response('', { status: 404 }),
    );
    renderApp('/recurring');
    await screen.findByTestId('screen-recurring');

    fireEvent.click(screen.getByTestId('recurring-add'));
    fireEvent.change(await screen.findByTestId('recform-name'), { target: { value: 'Netflix' } });
    fireEvent.change(screen.getByTestId('recform-amount'), { target: { value: '13.99' } });
    fireEvent.click(screen.getByTestId('recform-logo-open'));
    fireEvent.click(await screen.findByTestId('brandpicker-netflix'));
    // the sheet row reflects the chosen brand logo
    expect(screen.getByTestId('recform-logo-open').textContent).toContain('Brand logo');
    fireEvent.click(screen.getByTestId('recform-save'));

    const db = new MunniDB('munni_demo');
    await waitFor(
      async () => {
        const rec = (await db.recurrings.toArray()).find((r) => r.name === 'Netflix');
        expect(rec?.logo).toBe('brands/netflix.svg');
      },
      { timeout: 5000 },
    );
    db.close();
    fetchMock.mockRestore();
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

describe('RecurringScreen editing (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('year view multiplies, editing toggles active, delete needs a second tap', async () => {
    renderApp('/recurring');
    await screen.findByTestId('screen-recurring');

    fireEvent.click(screen.getByTestId('recurring-add'));
    fireEvent.change(await screen.findByTestId('recform-name'), { target: { value: 'Gym' } });
    fireEvent.change(screen.getByTestId('recform-amount'), { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('recform-notify-7'));
    fireEvent.click(screen.getByTestId('recform-save'));
    const row = await screen.findByText('Gym', {}, { timeout: 5000 });

    // a monthly cost costs 12× per year
    fireEvent.click(screen.getByTestId('recurring-view-year'));
    await waitFor(() => expect(screen.getByTestId('recurring-summary').textContent).toMatch(/300/));
    fireEvent.click(screen.getByTestId('recurring-view-period'));

    // deactivating moves it into the inactive section
    fireEvent.click(row.closest('button')!);
    fireEvent.click(await screen.findByTestId('recform-active'));
    fireEvent.click(screen.getByTestId('recform-save'));
    await waitFor(() => expect(screen.getByText(/Inactive/)).toBeTruthy(), { timeout: 5000 });

    // destructive delete: first tap arms, second removes
    fireEvent.click(screen.getByText('Gym').closest('button')!);
    fireEvent.click(await screen.findByTestId('recform-delete'));
    fireEvent.click(screen.getByTestId('recform-delete'));
    await waitFor(() => expect(screen.queryByText('Gym')).toBeNull(), { timeout: 5000 });
  }, 15_000);

  it('fires a local reminder once when a due date enters the notify window', async () => {
    // arrange the recurring first (its own app instance)
    const first = renderApp('/recurring');
    await screen.findByTestId('screen-recurring');
    fireEvent.click(screen.getByTestId('recurring-add'));
    fireEvent.change(await screen.findByTestId('recform-name'), { target: { value: 'Rent' } });
    fireEvent.change(screen.getByTestId('recform-amount'), { target: { value: '740' } });
    fireEvent.change(screen.getByTestId('recform-dueday'), {
      target: { value: String(Math.min(new Date().getDate(), 28)) },
    });
    fireEvent.click(screen.getByTestId('recform-notify-7'));
    fireEvent.click(screen.getByTestId('recform-save'));
    await screen.findByText('Rent', {}, { timeout: 5000 });
    first.unmount();

    // a fresh app open inside the window fires exactly one notification
    const showNotification = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'granted' } });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ showNotification }) },
    });
    const second = renderApp('/home');
    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(showNotification.mock.calls[0][1].body).toContain('Rent');
    second.unmount();

    renderApp('/home'); // same due date -> already notified, stays quiet
    await screen.findByTestId('screen-home');
    await new Promise((r) => setTimeout(r, 150));
    expect(showNotification).toHaveBeenCalledTimes(1);
  }, 20_000);
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
