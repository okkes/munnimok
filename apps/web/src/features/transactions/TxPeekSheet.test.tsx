// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID, isoDaysAgo } from '@/db/seed';
import { DEMO_TXS } from '@/db/demo-data';
import { inPeriod, periodHistory } from '@/domain/periods';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';

const isoToday = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

/** #168 r4 (user): the read-only transaction peek — opened from lists
 *  that must not lose their place (drill, recurring period sheet) */
describe('TxPeekSheet (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('shows amount, title, account, category and note; a spread lists entries with values; the door opens the full page', async () => {
    const first = renderApp('/overview/expense/groceries');
    await screen.findByTestId('screen-category-drill');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-peek'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'peek_1', {
      accountId: 'demo_main',
      date: isoToday(),
      amountCents: -2345,
      currency: 'EUR',
      merchant: 'ALBERT PEEK',
      catId: 'groceries',
      txType: 'expense',
      needsReview: 0,
      notes: 'Team lunch',
    });
    // a row-level category spread: the peek must list both entries
    await repo.upsert('transaction', DEMO_SPACE_ID, 'peek_2', {
      accountId: 'demo_main',
      date: isoToday(),
      amountCents: -2400,
      currency: 'EUR',
      merchant: 'MIXED PEEK',
      catId: 'groceries',
      cats: [
        { catId: 'groceries', amountCents: 1500 },
        { catId: 'transport', amountCents: 900 },
      ],
      txType: 'expense',
      needsReview: 0,
    });
    db.close();
    first.unmount();

    renderApp('/overview/expense/groceries');
    await screen.findByTestId('screen-category-drill');
    fireEvent.click(await screen.findByTestId('tx-row-peek_1', {}, { timeout: 5000 }));

    await screen.findByTestId('tx-peek');
    expect(screen.getByTestId('tx-peek-amount').textContent).toContain('23.45');
    expect(screen.getByTestId('tx-peek-title').textContent).toContain('ALBERT PEEK');
    expect(screen.getByTestId('tx-peek-account').textContent).toContain('Demo Checking');
    expect(screen.getByTestId('tx-peek-cats').textContent).toContain('Grocery');
    expect(screen.getByTestId('tx-peek-note').textContent).toContain('Team lunch');
    // read-only peek: no counterparty on a plain expense
    expect(screen.queryByTestId('tx-peek-counter')).toBeNull();
    // the drill stays put underneath (that is the whole point)
    expect(screen.getByTestId('screen-category-drill')).toBeTruthy();

    // peeking another row swaps the face in place — a spread lists each
    // entry with its signed value
    fireEvent.click(screen.getByTestId('tx-row-peek_2'));
    await waitFor(() => expect(screen.getByTestId('tx-peek-title').textContent).toContain('MIXED PEEK'));
    const cats = screen.getByTestId('tx-peek-cats');
    expect(cats.textContent).toContain('Grocery');
    expect(cats.textContent).toContain('Transportation');
    expect(cats.textContent).toContain('15.00');
    expect(cats.textContent).toContain('9.00');
    expect(screen.queryByTestId('tx-peek-note')).toBeNull();

    // the ONE door: full details — closes the peek, opens the page
    fireEvent.click(screen.getByTestId('tx-peek-open'));
    await screen.findByTestId('screen-tx-detail', {}, { timeout: 5000 });
  }, 20_000);

  it('a linked transfer shows the counterparty line', async () => {
    // the demo savings transfers carry linkedAccountId demo_save — find
    // a period bar that holds one (never fireEvent inside waitFor)
    const periods = periodHistory('month', 1, 6);
    const depositDate = DEMO_TXS.filter((tx) => tx.cat === 'savingDeposit')
      .map((tx) => isoDaysAgo(tx.daysAgo))
      .find((date) => periods.some((p) => inPeriod(date, p)));
    expect(depositDate).toBeTruthy();
    const barIndex = periods.findIndex((p) => inPeriod(depositDate!, p));

    renderApp('/overview/saving/savingDeposit');
    await screen.findByTestId('screen-category-drill');
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid^="overview-bar-"]')).toHaveLength(6);
    });
    fireEvent.click(screen.getByTestId(`overview-bar-${barIndex}`));

    const list = await screen.findByTestId('catdrill-list', {}, { timeout: 5000 });
    fireEvent.click(list.querySelector<HTMLElement>('[data-testid^="tx-row-"]')!);
    await screen.findByTestId('tx-peek');
    expect(screen.getByTestId('tx-peek-counter').textContent).toContain('Demo Savings');
  }, 20_000);
});
