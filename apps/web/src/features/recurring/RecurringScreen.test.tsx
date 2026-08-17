// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_TEST_DB, renderApp, renderAppAsUser } from '@/test/harness';
import { resetApiCapabilitiesCache } from '@/lib/api';
import { DEMO_SPACE_ID } from '@/db/seed';
import { reconcileRecurringLinks } from '@/application/recurring';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthsAgo = (n: number, day = 7) => {
  const now = new Date();
  return iso(new Date(now.getFullYear(), now.getMonth() - n, day));
};

/** four clean monthly Netflix charges ending this month */
async function seedNetflixPattern(db: MunniDB) {
  const repo = new Repo(new DexieBackend(db), new HlcClock('seed-rec'), { trackOutbox: false });
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

  it('a sustained price change badges the row, the detail and the yearly totals', async () => {
    // seed a recurring with linked charges: 13.99, 13.99, 15.99, 15.99
    const first = renderApp('/recurring');
    await screen.findByTestId('screen-recurring');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-price'), { trackOutbox: false });
    await repo.upsert('recurring', DEMO_SPACE_ID, 'rec_price', {
      name: 'Streamo',
      kind: 'subscription',
      amountCents: 1599,
      every: 'month',
      dueDay: 7,
      active: 1,
    });
    for (let i = 0; i < 4; i++) {
      await repo.upsert('transaction', DEMO_SPACE_ID, `str_${i}`, {
        accountId: 'demo_main',
        date: monthsAgo(3 - i, Math.min(new Date().getDate(), 28)),
        amountCents: i < 2 ? -1399 : -1599,
        currency: 'EUR',
        merchant: 'STREAMO',
        catId: 'subs',
        txType: 'expense',
        needsReview: 0,
        recurringId: 'rec_price',
      });
    }
    first.unmount();

    renderApp('/recurring');
    await screen.findByTestId('screen-recurring');
    // the +€2.00 delta wears itself openly on the row (S2)…
    const badge = await screen.findByTestId('recurring-pricechange-rec_price', {}, { timeout: 5000 });
    expect(badge.textContent).toContain('2.00');
    // …the screen carries the honest annual figure (S1)
    expect(screen.getByTestId('recurring-year-total').textContent).toMatch(/year/);

    // the detail tells the whole story with its yearly impact
    fireEvent.click(screen.getByTestId('recurring-row-rec_price'));
    const card = await screen.findByTestId('recdetail-pricechange', {}, { timeout: 5000 });
    expect(card.textContent).toContain('€13.99');
    expect(card.textContent).toContain('€15.99');
    expect(card.textContent).toContain('+€24.00');
    db.close();
  }, 20_000);

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

  it('detects a monthly pattern; the inbox shows its evidence; dismissing removes it for good', async () => {
    const db = new MunniDB('munni_demo');
    // the demo seed only runs once — let the app create it first
    renderApp('/recurring');
    await screen.findByTestId('screen-recurring');
    await seedNetflixPattern(db);

    // notification-style entry on the tab → the suggestions screen
    fireEvent.click(await screen.findByTestId('recurring-suggestions-banner', {}, { timeout: 5000 }));
    await screen.findByTestId('screen-recurring-suggestions');
    const card = await screen.findByTestId('recsuggest-card-netflix com');
    expect(card.textContent).toContain('NETFLIX.COM');
    // the card carries its evidence: all four matched charges
    expect(card.querySelectorAll('[data-testid^="recsuggest-tx-"]')).toHaveLength(4);

    fireEvent.click(screen.getByTestId('recurring-dismiss-netflix com'));
    // the demo data may yield suggestions of its own — only Netflix must go
    await waitFor(() => expect(screen.queryByTestId('recurring-dismiss-netflix com')).toBeNull(), { timeout: 5000 });
    // the dismissal is persisted, not just hidden
    expect(await db.recurringDismissals.count()).toBe(1);
    db.close();
  }, 15_000);

  it('detection reads PAST the space start date — pre-start charges are the evidence', async () => {
    const db = new MunniDB('munni_demo');
    renderApp('/recurring');
    await screen.findByTestId('screen-recurring');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-gate'), { trackOutbox: false });
    // the space starts on the 1st of THIS month — all four charges that
    // make the pattern are display-gated; detection must still see them.
    // Charges ride TODAY's day-of-month (like the Netflix seed): a fixed
    // day-1 cadence went 15+ days overdue mid-month and detection rightly
    // dropped it as lapsed — a run-day flake, not the gate under test.
    await repo.upsert('space', DEMO_SPACE_ID, DEMO_SPACE_ID, { historyStartDate: monthsAgo(0, 1) });
    for (let i = 1; i <= 4; i++) {
      await repo.upsert('transaction', DEMO_SPACE_ID, `gym_${i}`, {
        accountId: 'demo_main',
        date: monthsAgo(i, Math.min(new Date().getDate(), 28)),
        amountCents: -2999,
        currency: 'EUR',
        merchant: 'BASIC-FIT',
        catId: 'subs',
        txType: 'expense',
        needsReview: 0,
      });
    }
    fireEvent.click(await screen.findByTestId('recurring-suggestions-banner', {}, { timeout: 5000 }));
    await screen.findByTestId('screen-recurring-suggestions');
    // the pattern shows although every charge predates the start date
    const card = await screen.findByTestId('recsuggest-card-basic fit', {}, { timeout: 5000 });
    expect(card.querySelectorAll('[data-testid^="recsuggest-tx-"]').length).toBeGreaterThanOrEqual(3);
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
    // the search starts prefilled with the cost's name; a tap clears it
    const search = (await screen.findByTestId('brandpicker-search')) as HTMLInputElement;
    expect(search.value).toBe('Netflix');
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

  it('accepting a suggestion prefills the sheet, links past payments, detail lists them', async () => {
    const db = new MunniDB('munni_demo');
    const first = renderApp('/recurring');
    await screen.findByTestId('screen-recurring');
    await seedNetflixPattern(db);

    fireEvent.click(await screen.findByTestId('recurring-suggestions-banner', {}, { timeout: 5000 }));
    await screen.findByTestId('screen-recurring-suggestions');
    fireEvent.click(await screen.findByTestId('recurring-accept-netflix com'));
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
    first.unmount();

    // the detail screen shows the full payment history for the new cost
    const rec = (await db.recurrings.toArray()).find((r) => r.name === 'NETFLIX.COM')!;
    renderApp(`/recurring/${rec.id}`);
    await screen.findByTestId('screen-recurring-detail');
    const payments = await screen.findByTestId('recdetail-payments', {}, { timeout: 5000 });
    await waitFor(() => expect(payments.querySelectorAll('[data-testid^="tx-row-"]')).toHaveLength(4));
    // stats carry the annualized figure now (subscription intelligence S1)
    expect(screen.getByTestId('recdetail-stats').textContent).toContain('Per year');
    db.close();
  }, 20_000);

  it('#192 r2: a DUO pattern lives on the DEBTS screen — tracked in place, gone from the recurring inbox', async () => {
    const db = new MunniDB('munni_demo');
    renderApp('/recurring');
    await screen.findByTestId('screen-recurring');
    // four steady monthly DUO charges — a textbook student-loan pattern
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-duo'), { trackOutbox: false });
    for (let i = 0; i < 4; i++) {
      await repo.upsert('transaction', DEMO_SPACE_ID, `duo_${i}`, {
        accountId: 'demo_main', date: monthsAgo(i, Math.min(new Date().getDate(), 28)),
        amountCents: -10_400, currency: 'EUR', merchant: 'Dienst Uitvoering Onderwijs',
        catId: 'extraOther', txType: 'expense', needsReview: 0,
      });
    }
    cleanup();

    // the recurring inbox stays quiet about it: no DUO card there
    renderApp('/recurring/suggestions');
    await screen.findByTestId('screen-recurring-suggestions');
    await waitFor(
      () => {
        const settled =
          document.querySelector('[data-testid^="recsuggest-card-"]') ?? screen.queryByTestId('recsuggest-empty');
        expect(settled).toBeTruthy();
      },
      { timeout: 5000 },
    );
    expect(screen.queryByTestId('recsuggest-card-dienst uitvoering onderwijs')).toBeNull();
    cleanup();

    // the DEBTS screen carries the suggestion card itself
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    const key = 'dienst uitvoering onderwijs';
    await screen.findByTestId(`debts-suggestion-${key}`, {}, { timeout: 5000 });

    // tracking opens the loan chooser RIGHT HERE, prefilled — no detour
    fireEvent.click(screen.getByTestId(`debts-loan-track-${key}`));
    fireEvent.click(await screen.findByTestId('chooser-accttype-loan'));
    await waitFor(() => expect((screen.getByTestId('chooser-acctform-name') as HTMLInputElement).value).toBe('Dienst Uitvoering Onderwijs'));
    expect((screen.getByTestId('chooser-acctform-payment') as HTMLInputElement).value).toBe('104.00');
    expect((screen.getByTestId('chooser-acctform-payday') as HTMLInputElement).value).toBe(String(Math.min(new Date().getDate(), 28)));
    expect(screen.getByTestId('screen-debts')).toBeTruthy();
    db.close();
  }, 20_000);

  it('#192 r2: dismissing a loan suggestion on the debts screen retires it for good', async () => {
    const db = new MunniDB('munni_demo');
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-duo2'), { trackOutbox: false });
    for (let i = 0; i < 4; i++) {
      await repo.upsert('transaction', DEMO_SPACE_ID, `duo_${i}`, {
        accountId: 'demo_main', date: monthsAgo(i, Math.min(new Date().getDate(), 28)),
        amountCents: -10_400, currency: 'EUR', merchant: 'Dienst Uitvoering Onderwijs',
        catId: 'extraOther', txType: 'expense', needsReview: 0,
      });
    }
    const key = 'dienst uitvoering onderwijs';
    await screen.findByTestId(`debts-suggestion-${key}`, {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId(`debts-loan-dismiss-${key}`));
    await waitFor(() => expect(screen.queryByTestId(`debts-suggestion-${key}`)).toBeNull());
    expect(await db.recurringDismissals.count()).toBe(1);
    db.close();
  }, 20_000);
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

    // a monthly cost costs 12× per year — and shows up next period too
    fireEvent.click(screen.getByTestId('recurring-view-year'));
    await waitFor(() => expect(screen.getByTestId('recurring-summary').textContent).toMatch(/300/));
    fireEvent.click(screen.getByTestId('recurring-view-next'));
    await waitFor(() => expect(screen.getByTestId('recurring-summary').textContent).toMatch(/25/));
    fireEvent.click(screen.getByTestId('recurring-view-period'));

    // a row now opens the detail screen; editing sits behind the pencil
    fireEvent.click(row.closest('button')!);
    fireEvent.click(await screen.findByTestId('recdetail-edit'));
    fireEvent.click(await screen.findByTestId('recform-active'));
    fireEvent.click(screen.getByTestId('recform-save'));
    await screen.findByTestId('recdetail-inactive', {}, { timeout: 5000 });

    // destructive delete: first tap arms, second removes — then back on the list
    fireEvent.click(screen.getByTestId('recdetail-edit'));
    fireEvent.click(await screen.findByTestId('recform-delete'));
    fireEvent.click(screen.getByTestId('recform-delete'));
    await screen.findByTestId('screen-recurring', {}, { timeout: 5000 });
    await waitFor(() => expect(screen.queryByText('Gym')).toBeNull(), { timeout: 5000 });
  }, 15_000);

  it('#188/#189: a recurring lives only in ranges it OCCURS in; pre-start occurrences neither list nor count', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seedDb = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(seedDb), new HlcClock('seed-188'), { trackOutbox: false });
    const Y = new Date().getFullYear();
    // the space started June 1st — March happened before its memory
    await repo.upsert('space', DEMO_SPACE_ID, DEMO_SPACE_ID, { historyStartDate: `${Y}-06-01` });
    const base = { kind: 'fixed' as const, active: 1 as const, every: 'year' as const, dueDay: 15 };
    // starts NEXT January — belongs to "next year" alone (the user's Goudse)
    await repo.upsert('recurring', DEMO_SPACE_ID, 'future-ins', { ...base, name: 'Goudse insurance', amountCents: 20_000, dueMonth: 1, since: `${Y + 1}-01-01` });
    // yearly each March — this year's occurrence is OLDER than the space
    await repo.upsert('recurring', DEMO_SPACE_ID, 'spring-tax', { ...base, name: 'Spring tax', amountCents: 12_000, dueMonth: 3, since: `${Y - 3}-03-10` });
    // a plain monthly lives everywhere
    await repo.upsert('recurring', DEMO_SPACE_ID, 'gym-188', { ...base, every: 'month', name: 'Gym 188', amountCents: 2_500, dueDay: Math.min(new Date().getDate(), 28) });
    seedDb.close();
    cleanup();
    renderApp('/recurring');
    await screen.findByTestId('screen-recurring');

    // current period: only the monthly occurs here
    await screen.findByText('Gym 188', {}, { timeout: 5000 });
    expect(screen.queryByText('Goudse insurance')).toBeNull();
    expect(screen.queryByText('Spring tax')).toBeNull();

    // this year: March sits before the space start — still hidden (#189),
    // and its €120 must not read as "remaining"
    fireEvent.click(screen.getByTestId('recurring-view-year'));
    await waitFor(() => expect(screen.getByTestId('recurring-summary').textContent).not.toMatch(/120/));
    expect(screen.queryByText('Spring tax')).toBeNull();
    expect(screen.queryByText('Goudse insurance')).toBeNull();

    // next year: both yearly costs occur — they belong here
    fireEvent.click(screen.getByTestId('recurring-view-nextyear'));
    await screen.findByText('Goudse insurance', {}, { timeout: 5000 });
    await screen.findByText('Spring tax');

    // All: everything, with only the honest annual figure (no range math)
    fireEvent.click(screen.getByTestId('recurring-view-all'));
    await screen.findByText('Goudse insurance');
    await screen.findByText('Spring tax');
    await screen.findByText('Gym 188');
    expect(screen.getByTestId('recurring-year-total')).toBeTruthy();
    expect(screen.queryByTestId('recurring-luxury-line')).toBeNull();
  }, 20_000);

  it('custom cadence: every 2 weeks needs an anchor date and shows its rhythm', async () => {
    renderApp('/recurring');
    await screen.findByTestId('screen-recurring');

    fireEvent.click(screen.getByTestId('recurring-add'));
    fireEvent.change(await screen.findByTestId('recform-name'), { target: { value: 'Cleaner' } });
    fireEvent.change(screen.getByTestId('recform-amount'), { target: { value: '45' } });
    fireEvent.click(screen.getByTestId('recform-every-custom'));
    fireEvent.change(await screen.findByTestId('recform-everyn'), { target: { value: '2' } });
    fireEvent.blur(screen.getByTestId('recform-everyn'));
    fireEvent.change(screen.getByTestId('recform-every-unit'), { target: { value: 'week' } });

    // no first-due date yet → the save button refuses
    expect((screen.getByTestId('recform-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('recform-firstdue'), { target: { value: iso(new Date()) } });
    expect((screen.getByTestId('recform-save') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('recform-save'));

    // the list row says the rhythm instead of a monthly due day
    const row = await screen.findByText('Cleaner', {}, { timeout: 5000 });
    await waitFor(() => expect(row.closest('button')!.textContent).toContain('Every 2 weeks'));

    // reopening the form lands on the custom chip with everything restored
    fireEvent.click(row.closest('button')!);
    fireEvent.click(await screen.findByTestId('recdetail-edit'));
    expect(((await screen.findByTestId('recform-everyn')) as HTMLInputElement).value).toBe('2');
    expect((screen.getByTestId('recform-every-unit') as HTMLSelectElement).value).toBe('week');
    expect((screen.getByTestId('recform-firstdue') as HTMLInputElement).value).toBe(iso(new Date()));
  }, 15_000);

  it('fires a local reminder once when a due date enters the notify window', async () => {
    // arrange the recurring first (its own app instance)
    const first = renderApp('/recurring');
    await screen.findByTestId('screen-recurring');
    fireEvent.click(screen.getByTestId('recurring-add'));
    fireEvent.change(await screen.findByTestId('recform-name'), { target: { value: 'Rent' } });
    fireEvent.change(screen.getByTestId('recform-amount'), { target: { value: '740' } });
    // stay inside the 7-day notify window on EVERY calendar day: clamping
    // to 28 pushed the due date a month out on the 29th-31st, and this
    // test failed only on those days (caught 2026-07-29)
    const today = new Date().getDate();
    fireEvent.change(screen.getByTestId('recform-dueday'), {
      target: { value: String(today <= 28 ? today : 1) },
    });
    fireEvent.blur(screen.getByTestId('recform-dueday')); // draft commits on blur
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

describe('brand picker online search (user identity)', () => {
  const netflixRemote = {
    name: 'Netflix',
    domain: 'netflix.com',
    logoUrl: 'https://img.logo.dev/netflix.com?token=pk',
  };

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
    resetApiCapabilitiesCache(); // each test scripts its own /health
  });

  async function openPickerAndSearch(api: Record<string, () => unknown>) {
    renderAppAsUser('/recurring', {
      api: {
        'GET /brands/index.json': () => [{ slug: 'netflix', title: 'Netflix' }],
        ...api,
      },
    });
    await screen.findByTestId('screen-recurring');
    fireEvent.click(screen.getByTestId('recurring-add'));
    await screen.findByTestId('recform-name');
    fireEvent.click(screen.getByTestId('recform-logo-open'));
    fireEvent.change(await screen.findByTestId('brandpicker-search'), { target: { value: 'netflix' } });
  }

  it('keeps the vendored segment first when logo.dev hits arrive below it', async () => {
    await openPickerAndSearch({
      'GET /health': () => ({ capabilities: { gocardless: false, logos: true } }),
      'GET /logos/search': () => [netflixRemote],
    });

    const remote = await screen.findByTestId('brandpicker-remote', {}, { timeout: 3000 });
    expect(screen.getByTestId('brandpicker-remote-netflix.com')).toBeTruthy();
    // the local segment leads and its hit SURVIVES the online answer
    // (user bug: local matches vanished the moment logo.dev responded)
    const local = screen.getByTestId('brandpicker-local');
    expect(local.compareDocumentPosition(remote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('brandpicker-netflix')).toBeTruthy();
    expect(screen.queryByTestId('brandpicker-offline-note')).toBeNull();

    // picking a remote hit stores its logo.dev URL
    fireEvent.click(screen.getByTestId('brandpicker-remote-netflix.com'));
    expect(screen.getByTestId('recform-logo-open').textContent).toContain('Brand logo');
  }, 15_000);

  it('says so when online search is unavailable and keeps the vendored set', async () => {
    await openPickerAndSearch({
      'GET /health': () => ({ capabilities: { gocardless: false, logos: false } }),
    });

    await screen.findByTestId('brandpicker-offline-note', {}, { timeout: 3000 });
    expect(screen.queryByTestId('brandpicker-remote')).toBeNull();
    expect(screen.getByTestId('brandpicker-netflix')).toBeTruthy();
  }, 15_000);
});

describe('reconcileRecurringLinks', () => {
  it('links matching unlinked expenses at most once per billing cycle', async () => {
    const db = new MunniDB(`munni_test_rec_${Math.random().toString(36).slice(2)}`);
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
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

    expect(await reconcileRecurringLinks(new DexieBackend(db), repo, 's1')).toBe(2); // g1 + g3
    expect((await db.transactions.get('g1'))?.recurringId).toBe('rec1');
    expect((await db.transactions.get('g2'))?.recurringId).toBeUndefined();
    expect((await db.transactions.get('g3'))?.recurringId).toBe('rec1');
    expect((await db.transactions.get('g4'))?.recurringId).toBeUndefined();
    // idempotent
    expect(await reconcileRecurringLinks(new DexieBackend(db), repo, 's1')).toBe(0);
    db.close();
  });
});
