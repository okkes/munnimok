// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID } from '@/db/seed';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
import { MunniDB } from '@/db/schema';

describe('ReviewScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('walks the queue with progress: confirm clears the flag and advances', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    // demo seed ships 3 flagged transactions, all different merchants
    expect(screen.getByText('1 / 3')).toBeTruthy();

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(() => expect(screen.getByText('2 / 3')).toBeTruthy(), { timeout: 5000 });

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(() => expect(screen.getByText('3 / 3')).toBeTruthy(), { timeout: 5000 });

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    // queue drained — the empty state replaces the card
    expect(await screen.findByTestId('review-empty')).toBeTruthy();
  }, 15_000);

  it('a picked category is staged and written on confirm', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    const db = new MunniDB('munni_demo');
    const current = (await db.transactions.filter((t) => t.needsReview === 1).toArray())
      .sort((a, b) => b.date.localeCompare(a.date))[0];

    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('catpicker-coffee'));
    // staged, not yet written — the chip shows the choice
    expect(screen.getByTestId('review-category-chip').textContent).toContain('Coffee');
    expect((await db.transactions.get(current.id))?.catId).not.toBe('coffee');

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(
      async () => {
        expect(await db.transactions.get(current.id)).toMatchObject({ catId: 'coffee', needsReview: 0 });
      },
      { timeout: 5000 },
    );
    db.close();
  }, 15_000);

  it('bulk confirm reaches the other flagged items of the same merchant', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');

    // two more flagged charges from the same merchant as the newest card
    const db = new MunniDB('munni_demo');
    const repo = new Repo(db, new HlcClock('seed-rev'), { trackOutbox: false });
    const newest = (await db.transactions.filter((t) => t.needsReview === 1).toArray())
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    for (const [id, offset] of [['bulk1', 40], ['bulk2', 70]] as const) {
      await repo.upsert('transaction', DEMO_SPACE_ID, id, {
        accountId: newest.accountId,
        date: `2025-0${offset > 50 ? 1 : 2}-15`,
        amountCents: newest.amountCents,
        currency: 'EUR',
        merchant: newest.merchant,
        txType: 'expense',
        needsReview: 1,
      });
    }

    // both extra rows must be visible AND selected before confirming
    await waitFor(
      () => expect(screen.getByTestId('review-bulk').textContent).toContain('2'),
      { timeout: 5000 },
    );
    // expanding reveals the internally-scrollable list with every similar row
    fireEvent.click(screen.getByTestId('review-bulk-expand'));
    const bulkList = await screen.findByTestId('review-bulk-list');
    expect(bulkList.className).toContain('overflow-y-auto');
    expect(bulkList.querySelectorAll('[data-testid^="review-bulk-"]')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(
      async () => {
        expect((await db.transactions.get('bulk1'))?.needsReview).toBe(0);
        expect((await db.transactions.get('bulk2'))?.needsReview).toBe(0);
      },
      { timeout: 5000 },
    );
    db.close();
  }, 15_000);

  it('a matching recurring cost offers itself and confirm links the payment', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');

    // a Netflix subscription + a flagged Netflix charge arrive
    const db = new MunniDB('munni_demo');
    const repo = new Repo(db, new HlcClock('seed-link'), { trackOutbox: false });
    await repo.upsert('recurring', DEMO_SPACE_ID, 'rec-nfx', {
      name: 'Netflix',
      kind: 'subscription',
      amountCents: 1399,
      every: 'month',
      dueDay: 7,
      active: 1,
      merchantKey: 'netflix com',
    });
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await repo.upsert('transaction', DEMO_SPACE_ID, 'tx-nfx', {
      accountId: 'demo_main',
      date: iso,
      amountCents: -1399,
      currency: 'EUR',
      merchant: 'NETFLIX.COM',
      catId: 'subs',
      txType: 'expense',
      needsReview: 1,
    });

    // the newest card is the Netflix charge, with the link chip pre-enabled
    await waitFor(() => expect(screen.getByTestId('review-card').textContent).toContain('NETFLIX.COM'), { timeout: 5000 });
    const chip = await screen.findByTestId('review-link-recurring');
    expect(chip.textContent).toContain('Netflix');

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(
      async () => expect((await db.transactions.get('tx-nfx'))?.recurringId).toBe('rec-nfx'),
      { timeout: 5000 },
    );
    db.close();
  }, 15_000);

  it('skip moves on and the skipped pile can be revisited', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    const firstMerchant = screen.getByTestId('review-card').textContent;

    fireEvent.click(screen.getByTestId('review-skip-btn'));
    await waitFor(() => expect(screen.getByTestId('review-card').textContent).not.toBe(firstMerchant));

    fireEvent.click(screen.getByTestId('review-skip-btn'));
    fireEvent.click(screen.getByTestId('review-skip-btn'));
    // everything skipped: the pile note offers a second pass
    const note = await screen.findByTestId('review-skipped-note');
    expect(note.textContent).toContain('3');
    fireEvent.click(screen.getByTestId('review-reset-skipped'));
    expect(await screen.findByTestId('review-card')).toBeTruthy();
  }, 15_000);
});
