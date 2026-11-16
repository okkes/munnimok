// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { clearTxFilters, presetTxFilters } from './txFilters';
import { DEMO_SPACE_ID } from '@/db/seed';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';

const rows = () => screen.getByTestId('tx-list').querySelectorAll('[data-testid^="tx-row-"]');

/** the boot chain still writes rows after the first paint: count once the list holds still */
async function settledRows(): Promise<number> {
  await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
  let last = -1;
  await waitFor(
    () => {
      const now = rows().length;
      const steady = now === last && now > 3;
      last = now;
      expect(steady).toBe(true);
    },
    { interval: 250, timeout: 8000 },
  );
  return last;
}

describe('TransactionsScreen (demo identity)', () => {
  beforeEach(async () => {
    // the previous spec's boot chain must settle before the db goes away, or its dying writes race this spec's seeds
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
    // #140: the lens survives remounts, so each spec clears it
    clearTxFilters();
  });

  it('a filter that matches only SOME parts shows exactly those, aligned as normal rows (#126 r8)', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-partfilter'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'pf1', {
      accountId: 'demo_main', date: '2020-03-01', amountCents: -3000, currency: 'EUR',
      merchant: 'PartFilter Shop', catId: 'groceries', needsReview: 0,
      splits: [
        { id: 'pfa', catId: 'groceries', amountCents: 2000, label: 'Food half' },
        { id: 'pfb', catId: 'uncategorized', amountCents: 1000, label: 'Mystery half' },
      ],
    });
    await screen.findByTestId('tx-parts-pf1', {}, { timeout: 5000 });

    fireEvent.click(screen.getByTestId('tx-filter-uncat'));
    await screen.findByTestId('tx-part-solo-pf1-1');
    expect(screen.getByTestId('tx-part-solo-pf1-1').textContent).toContain('Mystery half');
    expect(screen.queryByTestId('tx-parts-pf1')).toBeNull();
    expect(screen.queryByTestId('tx-part-solo-pf1-0')).toBeNull();

    fireEvent.click(screen.getByTestId('tx-filter-uncat'));
    await screen.findByTestId('tx-parts-pf1');
    db.close();
  }, 15_000);

  it('#492: the whole history is listed — a page at a time, as deep again after the detour', async () => {
    const first = renderApp('/transactions');
    await screen.findByTestId('tx-list');
    const demoRows = await settledRows();
    expect(screen.queryByTestId('tx-list-more')).toBeNull();
    const db = new MunniDB('munni_demo');
    // hundreds of rows through the coverage-instrumented list: every step gets a real budget
    const slow = { timeout: 20_000 };
    try {
      const repo = new Repo(new DexieBackend(db), new HlcClock('seed-history'), { trackOutbox: false });
      await repo.batch(async () => {
        for (let i = 0; i < 150; i += 1) {
          await repo.upsert('transaction', DEMO_SPACE_ID, `hist${i}`, {
            accountId: 'demo_main', date: `2019-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
            amountCents: -(100 + i), currency: 'EUR', merchant: `History shop ${i}`, catId: 'groceries', needsReview: 0,
          });
        }
      });
      await waitFor(() => expect(rows()).toHaveLength(120), slow);
      // read, not assumed: boot background steps may move a demo row, and seeded rows reach the list in bursts
      let behind = 0;
      await waitFor(() => {
        behind = Number(/\((\d+)/.exec(screen.getByTestId('tx-list-more').textContent ?? '')?.[1]);
        expect(120 + behind).toBeGreaterThanOrEqual(150 + demoRows - 3);
      }, slow);
      // a boot step may still add a demo row
      fireEvent.click(screen.getByTestId('tx-list-more'));
      await waitFor(() => expect(rows()).toHaveLength(240), slow);
      fireEvent.click(screen.getByTestId('tx-list-more'));
      await waitFor(() => {
        expect(rows().length).toBeGreaterThanOrEqual(120 + behind);
        expect(screen.queryByTestId('tx-list-more')).toBeNull();
      }, slow);
      expect(screen.getByTestId('tx-row-hist0')).toBeTruthy();
      // the second boot may still converge the demo by a row (#546's pass runs every boot until no default is left)
      first.unmount();
      cleanup();
      renderApp('/transactions');
      await screen.findByTestId('tx-list');
      await waitFor(() => {
        expect(rows().length).toBeGreaterThan(240);
        expect(screen.queryByTestId('tx-list-more')).toBeNull();
      }, slow);
      fireEvent.change(screen.getByTestId('tx-search'), { target: { value: 'History shop' } });
      await waitFor(() => expect(rows()).toHaveLength(120), slow);
    } finally {
      // a failure must not leave this spec's handle holding the demo database the next spec deletes
      db.close();
    }
  }, 120_000);

  it('#140/#148 r2: the lens survives a remount (detail detour); the new-only preset shows first-seen arrivals', async () => {
    const first = renderApp('/transactions');
    await screen.findByTestId('tx-list');
    const fullCount = await settledRows();
    fireEvent.change(screen.getByTestId('tx-search'), { target: { value: 'heijn' } });
    await waitFor(() => expect(rows().length).toBeLessThan(fullCount));
    first.unmount();
    cleanup();
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    expect((screen.getByTestId('tx-search') as HTMLInputElement).value).toBe('heijn');
    await waitFor(() => expect(rows().length).toBeLessThan(fullCount));
    cleanup();
    // #148 r2: NEW = first seen by this device within 24h; the demo seed was there on first render, so the lens starts empty
    presetTxFilters({ newOnly: true });
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    expect((screen.getByTestId('tx-search') as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(rows()).toHaveLength(0));
    const db2 = new MunniDB('munni_demo');
    const repo2 = new Repo(new DexieBackend(db2), new HlcClock('seed-newlens'), { trackOutbox: false });
    await repo2.upsert('transaction', DEMO_SPACE_ID, 'fresh1', {
      accountId: 'demo_main', date: '2020-04-01', amountCents: -1234, currency: 'EUR',
      merchant: 'Fresh Arrival', catId: 'groceries', needsReview: 0,
    });
    await screen.findByTestId('tx-row-fresh1', {}, { timeout: 5000 });
    expect(rows()).toHaveLength(1);
    db2.close();
    clearTxFilters();
    cleanup();
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    await waitFor(() => expect(rows()).toHaveLength(fullCount + 1));
  }, 15_000);

  it('#243 r2: the linked chip keeps EVERY row and uncollapses the pairs', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-pairlens'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'leg-out', {
      accountId: 'demo_main', date: '2020-05-01', amountCents: -7000, currency: 'EUR',
      merchant: 'To savings', catId: 'savingDeposit', needsReview: 0,
      linkedAccountId: 'demo_save', transferPeerId: 'leg-in',
    });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'leg-in', {
      accountId: 'demo_save', date: '2020-05-01', amountCents: 7000, currency: 'EUR',
      merchant: 'From checking', catId: 'savingDeposit', needsReview: 0,
      linkedAccountId: 'demo_main', transferPeerId: 'leg-out',
    });
    await screen.findByTestId('tx-row-leg-out', {}, { timeout: 5000 });
    expect(screen.queryByTestId('tx-row-leg-in')).toBeNull();
    // set-based asserts — background mirror mints keep exact counts racy
    const snap = () => new Set([...rows()].map((r) => r.getAttribute('data-testid')));
    const collapsed = snap();
    // #243: the chip uncollapses pairs without narrowing: every row of the collapsed view stays
    fireEvent.click(screen.getByTestId('tx-filter-counter'));
    await screen.findByTestId('tx-row-leg-in');
    const uncollapsed = snap();
    for (const id of collapsed) expect(uncollapsed.has(id), `${id} vanished`).toBe(true);
    fireEvent.click(screen.getByTestId('tx-filter-counter'));
    await waitFor(() => expect(screen.queryByTestId('tx-row-leg-in')).toBeNull());
    expect(screen.getByTestId('tx-row-leg-out')).toBeTruthy();
    for (const id of snap()) expect(uncollapsed.has(id), `${id} appeared from nowhere`).toBe(true);
    db.close();
  }, 15_000);

  it('search narrows the list to matching merchants', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));
    const before = rows().length;

    fireEvent.change(screen.getByTestId('tx-search'), { target: { value: 'Albert Heijn' } });
    await waitFor(() => {
      const after = rows().length;
      expect(after).toBeGreaterThan(0);
      expect(after).toBeLessThan(before);
    });
    for (const row of rows()) {
      expect(row.textContent).toContain('Albert Heijn');
      expect(row.querySelector('mark')?.textContent).toBe('Albert Heijn');
    }

    fireEvent.change(screen.getByTestId('tx-search'), { target: { value: 'zzz-no-such-merchant' } });
    await waitFor(() => expect(rows()).toHaveLength(0));
  });

  it('the quick chip narrows to uncategorized transactions (user request: unreviewed lives on Home)', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));

    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-uncat'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'uncat-1', {
      accountId: 'demo_main', date: '2026-06-20', amountCents: -1250, currency: 'EUR',
      merchant: 'MYSTERY SHOP', catId: 'uncategorized', needsReview: 0,
    });
    // #133: the view derives the type: a categoryless row reads as a transfer through its link, so the link must be explicit
    await repo.upsert('transaction', DEMO_SPACE_ID, 'uncat-2', {
      accountId: 'demo_main', date: '2026-06-21', amountCents: -5000, currency: 'EUR',
      merchant: 'OWN SAVINGS', catId: 'uncategorized', needsReview: 0,
      linkedAccountId: 'demo_save',
    });
    db.close();
    await waitFor(() => expect(screen.queryByText('MYSTERY SHOP')).toBeTruthy(), { timeout: 5000 });

    fireEvent.click(screen.getByTestId('tx-filter-uncat'));
    await waitFor(() => expect(rows()).toHaveLength(1), { timeout: 5000 });
    expect(screen.getByText('MYSTERY SHOP')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tx-filter-uncat'));
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));
    // coverage instrumentation pushes this flow past vitest's 5s default
  }, 15_000);

  it('the unsettled-reimbursements chip shows only open expected/received value', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));

    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-unsettled'), { trackOutbox: false });
    // #211: modern split seeds stamp an explicit cats null: the boot fold must read them as parts, not legacy slices
    await repo.upsert('transaction', DEMO_SPACE_ID, 'open-1', {
      accountId: 'demo_main', date: '2026-06-22', amountCents: -8000, currency: 'EUR',
      merchant: 'FRONTED DINNER', catId: 'eatingOut', needsReview: 0, cats: null as never,
      splits: [{ catId: 'eatingOut', amountCents: 3000 }, { catId: 'expenseReimburse', amountCents: 5000 }],
    });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'settled-1', {
      accountId: 'demo_main', date: '2026-06-23', amountCents: 5000, currency: 'EUR',
      merchant: 'PAID BACK', catId: 'reimbursed', needsReview: 0, cats: null as never,
      splits: [{ catId: 'reimbursed', amountCents: 5000 }],
    });
    db.close();
    await waitFor(() => expect(screen.queryByText('FRONTED DINNER')).toBeTruthy(), { timeout: 5000 });

    fireEvent.click(screen.getByTestId('tx-filter-unsettled'));
    // #149: a flat two-part spread stands as the branch group, not a plain row
    await screen.findByTestId('tx-parts-open-1', {}, { timeout: 5000 });
    await waitFor(() => expect(rows()).toHaveLength(0), { timeout: 5000 });
    expect(screen.getByText('FRONTED DINNER')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tx-filter-unsettled'));
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));
  });

  it('the filter sheet narrows by account — the cash wallet among the others', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));
    const all = rows().length;

    fireEvent.click(screen.getByTestId('tx-filter-open'));
    expect(await screen.findByTestId('filter-account-defaultacct_cash_demo_space')).toBeTruthy();
    expect(screen.getByTestId('filter-account-demo_main').querySelector('.mdi')).toBeTruthy();

    // the demo savings account has no transactions — filter yields none
    fireEvent.click(screen.getByTestId('filter-account-demo_save'));
    fireEvent.click(screen.getByTestId('filter-done'));
    await waitFor(() => expect(rows()).toHaveLength(0));
    expect(screen.getByTestId('tx-filter-count').textContent).toBe('1');

    fireEvent.click(screen.getByTestId('tx-filter-clear'));
    await waitFor(() => expect(rows()).toHaveLength(all));
    // coverage instrumentation pushes this flow past vitest's 5s default
  }, 15_000);

  it('the filter sheet narrows by amount: between two typed sizes, whichever way the money went (user 2026-10-06)', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));
    const all = rows().length;

    fireEvent.click(screen.getByTestId('tx-filter-open'));
    fireEvent.change(await screen.findByTestId('filter-amount-min'), { target: { value: '1000000' } });
    fireEvent.click(screen.getByTestId('filter-done'));
    await waitFor(() => expect(rows()).toHaveLength(0));
    expect(screen.getByTestId('tx-filter-count').textContent).toBe('1');

    fireEvent.click(screen.getByTestId('tx-filter-open'));
    fireEvent.change(screen.getByTestId('filter-amount-min'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('filter-amount-max'), { target: { value: '0,01' } });
    fireEvent.click(screen.getByTestId('filter-done'));
    await waitFor(() => expect(rows()).toHaveLength(0));
    expect(screen.getByTestId('tx-filter-count').textContent).toBe('1');

    fireEvent.click(screen.getByTestId('tx-filter-clear'));
    await waitFor(() => expect(rows()).toHaveLength(all));
    fireEvent.click(screen.getByTestId('tx-filter-open'));
    expect((await screen.findByTestId('filter-amount-max')).getAttribute('value')).toBe('');
  }, 15_000);

  it('#237 (a): a same-sign wallet pair collapses to the PURCHASE, wearing the funding note', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-wallet'), { trackOutbox: false });
    await repo.upsert('account', DEMO_SPACE_ID, 'wl', {
      name: 'Wallet PayPal', type: 'checking', source: 'camt053', currency: 'EUR', balanceCents: 0,
    });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'wbank', {
      accountId: 'demo_main', date: '2020-04-01', amountCents: -799, currency: 'EUR',
      merchant: 'PayPal top-up', catId: 'transferOut', needsReview: 0,
      linkedAccountId: 'wl', transferPeerId: 'wpur',
    });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'wpur', {
      accountId: 'wl', date: '2020-04-01', amountCents: -799, currency: 'EUR',
      merchant: 'Vueling Wallet', catId: 'holiday', needsReview: 0,
      transferPeerId: 'wbank',
    });

    await screen.findByTestId('tx-row-wpur', {}, { timeout: 5000 });
    expect(screen.queryByTestId('tx-row-wbank')).toBeNull();
    expect(screen.getByTestId('tx-row-wpur').textContent).toContain('→ Wallet PayPal');
    db.close();
  }, 15_000);

});
