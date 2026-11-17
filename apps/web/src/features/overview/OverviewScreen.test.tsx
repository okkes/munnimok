// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { DEMO_TXS } from '@/db/demo-data';
import { Repo } from '@/db/repo';
import { MunniDB } from '@/db/schema';
import { DEMO_SPACE_ID, isoDaysAgo } from '@/db/seed';
import { inPeriod, periodHistory } from '@/domain/periods';
import { HlcClock } from '@/sync/hlc';
import { renderApp } from '@/test/harness';

// /€[1-9]/ (not /€\d/) so the assertion cannot pass on the €0.00 that
// renders before the live query has delivered the seeded transactions
describe('Overview (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('home shows the four period tiles with money values', async () => {
    renderApp('/home');
    await screen.findByTestId('home-overview-expense');
    // the demo seed guarantees a purchase inside the current period (dm102, daysAgo 0)
    await waitFor(() => expect(screen.getByTestId('home-overview-expense').textContent).toMatch(/€[1-9]/));
    expect(screen.getByTestId('home-overview-income')).toBeTruthy();
    expect(screen.getByTestId('home-overview-saving')).toBeTruthy();
    expect(screen.getByTestId('home-overview-investment')).toBeTruthy();
  });

  it('tapping a tile opens the drill-down with total, chart and category groups', async () => {
    renderApp('/home');
    await screen.findByTestId('home-overview-expense');
    fireEvent.click(screen.getByTestId('home-overview-expense'));

    await screen.findByTestId('screen-overview');
    await waitFor(() => expect(screen.getByTestId('overview-total').textContent).toMatch(/€[1-9]/));
    expect(screen.getByTestId('overview-barchart')).toBeTruthy();
    expect(screen.getByTestId('overview-stackedbar')).toBeTruthy();

    const group = await waitFor(() => {
      const el = document.querySelector('[data-testid^="overview-group-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    const catId = group.getAttribute('data-testid')!.replace('overview-group-', '');
    fireEvent.click(group);
    expect(await screen.findByTestId(`overview-subs-${catId}`)).toBeTruthy();
    expect(document.querySelectorAll(`[data-testid="overview-subs-${catId}"] .m-num`).length).toBeGreaterThan(0);
  });

  it('category rows open the in-context drill with total, bars and payments', async () => {
    renderApp('/overview/expense');
    await screen.findByTestId('screen-overview');
    await waitFor(() => expect(screen.getByTestId('overview-total').textContent).toMatch(/€[1-9]/));

    const group = await waitFor(() => {
      const el = document.querySelector('[data-testid^="overview-group-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(group);
    const all = await waitFor(() => {
      const el = document.querySelector('[data-testid^="overview-all-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(all);

    await screen.findByTestId('screen-category-drill');
    await waitFor(() => expect(screen.getByTestId('catdrill-total').textContent).toMatch(/€[1-9]/));
    expect(screen.getByTestId('overview-barchart')).toBeTruthy();
    const list = await screen.findByTestId('catdrill-list');
    expect(list.querySelectorAll('[data-testid^="tx-row-"]').length).toBeGreaterThan(0);

    fireEvent.click(list.querySelector('[data-testid^="tx-row-"]')!);
    expect(await screen.findByTestId('screen-tx-detail')).toBeTruthy();
    expect(screen.queryByTestId('tx-peek')).toBeNull();
  });

  it('#454 (user): the chosen period is forgotten on the way back Home or to another tab; a detour keeps it', async () => {
    renderApp('/overview/expense');
    await screen.findByTestId('screen-overview');
    await waitFor(() => expect(screen.getByTestId('overview-total').textContent).toMatch(/€[1-9]/));
    const current = screen.getByTestId('overview-total').textContent;
    fireEvent.click(screen.getByTestId('overview-bar-0'));
    await waitFor(() => expect(screen.getByTestId('overview-total').textContent).not.toBe(current));
    const older = screen.getByTestId('overview-total').textContent;

    cleanup();
    renderApp('/overview/expense');
    await waitFor(() => expect(screen.getByTestId('overview-total').textContent).toBe(older));

    fireEvent.click(screen.getByTestId('tab-settings'));
    await screen.findByTestId('screen-settings');
    cleanup();
    renderApp('/overview/expense');
    await waitFor(() => expect(screen.getByTestId('overview-total').textContent).toBe(current));

    fireEvent.click(screen.getByTestId('overview-bar-0'));
    await waitFor(() => expect(screen.getByTestId('overview-total').textContent).toBe(older));
    cleanup();
    renderApp('/home');
    await screen.findByTestId('screen-home');
    cleanup();
    renderApp('/overview/expense');
    await waitFor(() => expect(screen.getByTestId('overview-total').textContent).toBe(current));
  }, 25_000);

  it('user ss 2026-10-06: a category detour keeps the unfolded group and the scroll offset; Home forgets them', async () => {
    renderApp('/overview/expense');
    await screen.findByTestId('screen-overview');
    await waitFor(() => expect(screen.getByTestId('overview-total').textContent).toMatch(/€[1-9]/));
    const group = await waitFor(() => {
      const el = document.querySelector('[data-testid^="overview-group-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    const catId = group.getAttribute('data-testid')!.replace('overview-group-', '');
    fireEvent.click(group);
    await screen.findByTestId(`overview-subs-${catId}`);
    fireEvent.scroll(screen.getByTestId('overview-list'), { target: { scrollTop: 140 } });
    fireEvent.click(screen.getByTestId(`overview-all-${catId}`));
    await screen.findByTestId('screen-category-drill');

    cleanup();
    renderApp('/overview/expense');
    expect(await screen.findByTestId(`overview-subs-${catId}`)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('overview-list').scrollTop).toBe(140));

    cleanup();
    renderApp('/home');
    await screen.findByTestId('screen-home');
    cleanup();
    renderApp('/overview/expense');
    await waitFor(() => expect(document.querySelector('[data-testid^="overview-group-"]')).toBeTruthy());
    expect(screen.queryByTestId(`overview-subs-${catId}`)).toBeNull();
    expect(screen.getByTestId('overview-list').scrollTop).toBe(0);
  }, 25_000);

  it('the drill period selector swaps the list to the chosen period', async () => {
    renderApp('/overview/expense/groceries');
    await screen.findByTestId('screen-category-drill');
    await waitFor(() => expect(screen.getByTestId('catdrill-total').textContent).toMatch(/€/));
    const label = screen.getByTestId('catdrill-period').textContent;

    fireEvent.click(screen.getByTestId('overview-bar-0'));
    await waitFor(() => expect(screen.getByTestId('catdrill-period').textContent).not.toBe(label));
  });

  it('selecting an older period updates the total', async () => {
    renderApp('/overview/expense');
    await screen.findByTestId('screen-overview');
    await waitFor(() => expect(screen.getByTestId('overview-total').textContent).toMatch(/€[1-9]/));
    const current = screen.getByTestId('overview-total').textContent;

    fireEvent.click(screen.getByTestId('overview-bar-0'));
    await waitFor(() => expect(screen.getByTestId('overview-total').textContent).not.toBe(current));
  });

  it('the Invested headline is the sum of its groups and Home’s tile — a Buy on the brokerage’s own ledger invests nothing new', async () => {
    const first = renderApp('/home');
    await screen.findByTestId('screen-home');
    // the boot chain settles before the seed opens its own connection
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-invest'), { trackOutbox: false });
    await repo.upsert('account', DEMO_SPACE_ID, 'acc_broker', { name: 'Broker', type: 'brokerage', source: 'manual', currency: 'EUR', balanceCents: 500_000 });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'tx_buy', {
      accountId: 'acc_broker', date: isoDaysAgo(0), amountCents: -50_000, currency: 'EUR', merchant: 'ACME shares', catId: 'investBuy', needsReview: 0,
    });
    db.close();
    first.unmount();

    renderApp('/overview/investment');
    await screen.findByTestId('overview-sub-investBuy', {}, { timeout: 5000 });
    const headline = screen.getByTestId('overview-total').textContent ?? '';
    expect(headline).toMatch(/€/);
    expect(screen.getByTestId('overview-group-investment').textContent).toContain(headline);
    cleanup();
    renderApp('/home');
    await waitFor(() => expect(screen.getByTestId('home-overview-investment').textContent).toContain(headline), { timeout: 5000 });
  }, 20_000);

  it('saving uses the checking-side sign mechanic (deposits count positive)', async () => {
    // never fireEvent inside waitFor: the clicks mutate the DOM, re-running the callback forever and starving waitFor's timeout
    const periods = periodHistory('month', 1, 6);
    const depositDate = DEMO_TXS.filter((tx) => tx.cat === 'savingDeposit')
      .map((tx) => isoDaysAgo(tx.daysAgo))
      .find((date) => periods.some((p) => inPeriod(date, p)));
    expect(depositDate).toBeTruthy();
    const barIndex = periods.findIndex((p) => inPeriod(depositDate!, p));

    renderApp('/overview/saving');
    await screen.findByTestId('screen-overview');
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid^="overview-bar-"]')).toHaveLength(6);
    });

    fireEvent.click(screen.getByTestId(`overview-bar-${barIndex}`));
    // demo savingDeposit rows are negative on the checking account ->
    // shown as a positive amount saved once the live query has delivered
    await waitFor(() => expect(screen.getByTestId('overview-total').textContent).toMatch(/€[1-9]/));
    expect(screen.getByTestId('overview-total').textContent).not.toContain('-');
  });
});
