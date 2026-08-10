// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID } from '@/db/seed';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';

const rows = () => screen.getByTestId('tx-list').querySelectorAll('[data-testid^="tx-row-"]');

describe('TransactionsScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('a filter that matches only SOME parts shows exactly those, aligned as normal rows (#126 r8)', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-partfilter'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'pf1', {
      accountId: 'demo_main', date: '2020-03-01', amountCents: -3000, currency: 'EUR',
      merchant: 'PartFilter Shop', catId: 'groceries', txType: 'expense', needsReview: 0,
      splits: [
        { id: 'pfa', catId: 'groceries', amountCents: 2000, label: 'Food half' },
        { id: 'pfb', catId: 'uncategorized', amountCents: 1000, label: 'Mystery half' },
      ],
    });
    // unfiltered: the band with both branches stands
    await screen.findByTestId('tx-parts-pf1', {}, { timeout: 5000 });

    // the Uncategorized quick filter matches ONE part — the band gives
    // way to that part standing alone with the split glyph
    fireEvent.click(screen.getByTestId('tx-filter-uncat'));
    await screen.findByTestId('tx-part-solo-pf1-1');
    expect(screen.getByTestId('tx-part-solo-pf1-1').textContent).toContain('Mystery half');
    expect(screen.queryByTestId('tx-parts-pf1')).toBeNull();
    expect(screen.queryByTestId('tx-part-solo-pf1-0')).toBeNull();

    // filter off: the full band returns
    fireEvent.click(screen.getByTestId('tx-filter-uncat'));
    await screen.findByTestId('tx-parts-pf1');
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
      // the match itself is marked in the row
      expect(row.querySelector('mark')?.textContent).toBe('Albert Heijn');
    }

    fireEvent.change(screen.getByTestId('tx-search'), { target: { value: 'zzz-no-such-merchant' } });
    await waitFor(() => expect(rows().length).toBe(0));
  });

  it('the quick chip narrows to uncategorized transactions (user request: unreviewed lives on Home)', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));

    // one uncategorized expense + one categoryless transfer (excluded by design)
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-uncat'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'uncat-1', {
      accountId: 'demo_main', date: '2026-06-20', amountCents: -1250, currency: 'EUR',
      merchant: 'MYSTERY SHOP', catId: 'uncategorized', txType: 'expense', needsReview: 0,
    });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'uncat-2', {
      accountId: 'demo_main', date: '2026-06-21', amountCents: -5000, currency: 'EUR',
      merchant: 'OWN SAVINGS', catId: 'uncategorized', txType: 'transfer', needsReview: 0,
    });
    db.close();
    await waitFor(() => expect(screen.queryByText('MYSTERY SHOP')).toBeTruthy(), { timeout: 5000 });

    fireEvent.click(screen.getByTestId('tx-filter-uncat'));
    await waitFor(() => expect(rows().length).toBe(1), { timeout: 5000 });
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
    // open expectation → shows; fully settled → drops out of the filter
    // #211: modern split seeds version-stamp with an explicit cats null —
    // the boot fold must read them as PARTS, not legacy slices
    await repo.upsert('transaction', DEMO_SPACE_ID, 'open-1', {
      accountId: 'demo_main', date: '2026-06-22', amountCents: -8000, currency: 'EUR',
      merchant: 'FRONTED DINNER', catId: 'eatingOut', txType: 'expense', needsReview: 0, cats: null as never,
      splits: [{ catId: 'eatingOut', amountCents: 3000 }, { catId: 'expenseReimburse', amountCents: 5000 }],
    });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'settled-1', {
      accountId: 'demo_main', date: '2026-06-23', amountCents: 5000, currency: 'EUR',
      merchant: 'PAID BACK', catId: 'reimbursed', txType: 'income', needsReview: 0, cats: null as never,
      splits: [{ catId: 'reimbursed', amountCents: 5000 }],
    });
    db.close();
    await waitFor(() => expect(screen.queryByText('FRONTED DINNER')).toBeTruthy(), { timeout: 5000 });

    fireEvent.click(screen.getByTestId('tx-filter-unsettled'));
    // #149: the fronted dinner is a flat two-part spread — it stands as
    // the branch group now, not a plain row
    await screen.findByTestId('tx-parts-open-1', {}, { timeout: 5000 });
    await waitFor(() => expect(rows()).toHaveLength(0), { timeout: 5000 });
    expect(screen.getByText('FRONTED DINNER')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tx-filter-unsettled'));
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));
  });

  it('the filter sheet narrows by account and type; clear restores everything', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));
    const all = rows().length;

    // the demo savings account has no transactions — filter yields none
    fireEvent.click(screen.getByTestId('tx-filter-open'));
    fireEvent.click(await screen.findByTestId('filter-account-demo_save'));
    fireEvent.click(screen.getByTestId('filter-done'));
    await waitFor(() => expect(rows().length).toBe(0));
    expect(screen.getByTestId('tx-filter-count').textContent).toBe('1');

    // the clear chip resets the sheet filters
    fireEvent.click(screen.getByTestId('tx-filter-clear'));
    await waitFor(() => expect(rows().length).toBe(all));

    // kind filter: the Transfer kind selects the whole family, then the
    // detail chips narrow to plain transfers only. #133 removal: the
    // demo's pot-linked rows honestly derive TRANSFER now (R2 — the
    // saving story lives on the pot's own ledger), so Transfer is the
    // chip with rows behind it
    fireEvent.click(screen.getByTestId('tx-filter-open'));
    fireEvent.click(await screen.findByTestId('filter-kind-transfer'));
    const detail = await screen.findByTestId('filter-transfer-detail');
    expect(detail.textContent).toContain('Saving');
    fireEvent.click(screen.getByTestId('filter-type-saving'));
    fireEvent.click(screen.getByTestId('filter-type-debtPayment'));
    fireEvent.click(screen.getByTestId('filter-type-investment'));
    fireEvent.click(screen.getByTestId('filter-done'));
    await waitFor(() => {
      expect(rows().length).toBeGreaterThan(0);
      expect(rows().length).toBeLessThan(all);
    });
    // coverage instrumentation pushes this flow past vitest's 5s default
  }, 15_000);
});
