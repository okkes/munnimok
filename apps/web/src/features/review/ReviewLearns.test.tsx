// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID } from '@/db/seed';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';

/**
 * What the person files on one card reaches the cards still waiting: the
 * Confirm asks for the space's suggestions again. The card already on
 * screen keeps what it showed (nothing reshuffles under the person); the
 * one after it opens with what was just taught.
 */
describe('the review learns from the card just confirmed', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });
  afterEach(() => vi.unstubAllGlobals());

  const suggested = async (txId: string) => {
    const db = new MunniDB('munni_demo');
    try {
      const stored = (await db.meta.get(`reviewSuggest:${DEMO_SPACE_ID}`))?.value as { byTx?: Record<string, { predictedCatId?: string }> } | undefined;
      return stored?.byTx?.[txId];
    } finally {
      db.close();
    }
  };

  it('a shop filed on one card is the suggestion of that shop’s later cards', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('learns'), { trackOutbox: false });
    // the demo's own rows are reviewed first: these three are the whole deck
    for (const row of await db.transactions.where('spaceId').equals(DEMO_SPACE_ID).toArray()) {
      if (row.needsReview === 1) await repo.upsert('transaction', DEMO_SPACE_ID, row.id, { needsReview: 0 });
    }
    const kiosk = { accountId: 'demo_main', currency: 'EUR', merchant: 'Zorro Kiosk 12', catId: 'uncategorized', needsReview: 1 as const };
    await repo.upsert('transaction', DEMO_SPACE_ID, 'zk-1', { ...kiosk, date: '2026-01-01', amountCents: -500 });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'zk-2', { ...kiosk, date: '2026-01-02', amountCents: -730 });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'zk-3', { ...kiosk, date: '2026-01-03', amountCents: -910 });
    db.close();
    await waitFor(async () => expect(await suggested('zk-3')).toBeTruthy(), { timeout: 8000 });
    expect((await suggested('zk-3'))?.predictedCatId).not.toBe('groceries');

    cleanup();
    renderApp('/review');
    await waitFor(() => expect(screen.getByTestId('review-card').textContent).toContain('Zorro Kiosk'), { timeout: 8000 });
    // the person files this one as groceries, by itself (the similar ones stay in the deck)
    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-groceries'));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('review-category-chip').textContent).toContain('Grocer'));
    fireEvent.click(await screen.findByTestId('review-bulk-toggle'));
    fireEvent.click(screen.getByTestId('review-confirm-btn'));

    await waitFor(async () => expect((await suggested('zk-3'))?.predictedCatId).toBe('groceries'), { timeout: 8000 });
    // the card that came up meanwhile is passed over; the next one opens filed as the person taught
    fireEvent.click(screen.getByTestId('review-skip-btn'));
    await waitFor(() => expect(screen.getByTestId('review-category-chip').textContent).toContain('Grocer'), { timeout: 8000 });
  }, 40_000);
});
