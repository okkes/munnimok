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
 * The review card's rows and what arrives on them (#565): every row stands
 * on every card — disabled where the filing cannot use it — and what munni
 * worked out about a row was prepared when it landed. The card's link
 * questions: the counterparty (#339, #555, #556), the recurring cost
 * (#525) and the web search on the title (#506).
 */
describe('the review card: prepared suggestions and every row standing', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });
  afterEach(() => vi.unstubAllGlobals());

  /** the demo boots once, then the rows land the way a sync lands them */
  async function land(write: (repo: Repo) => Promise<void>) {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const db = new MunniDB('munni_demo');
    await write(new Repo(new DexieBackend(db), new HlcClock('cardrows'), { trackOutbox: false }));
    db.close();
  }

  /** the pass prepared the row (it runs as the rows land, never when the card opens) */
  async function prepared(txId: string) {
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const stored = (await db.meta.get(`reviewSuggest:${DEMO_SPACE_ID}`))?.value as { byTx?: Record<string, unknown> } | undefined;
      expect(stored?.byTx?.[txId]).toBeTruthy();
    }, { timeout: 8000 });
    db.close();
  }

  async function openReview(title: string) {
    cleanup();
    renderApp('/review');
    await waitFor(() => expect(screen.getByTestId('review-card').textContent).toContain(title), { timeout: 8000 });
  }

  const flagged = { accountId: 'demo_main', currency: 'EUR', needsReview: 1 as const };

  it('#565: the history\'s category is on the card from its first frame, and every row stands — the unusable ones disabled', async () => {
    await land(async (repo) => {
      for (const [id, date] of [['bj-1', '2025-12-01'], ['bj-2', '2025-12-08']] as const) {
        await repo.upsert('transaction', DEMO_SPACE_ID, id, { ...flagged, needsReview: 0, date, amountCents: -640, merchant: 'Bakkerij Jansen 1201', catId: 'groceries' });
      }
      await repo.upsert('transaction', DEMO_SPACE_ID, 'bj-new', { ...flagged, date: '2026-01-01', amountCents: -720, merchant: 'Bakkerij Jansen 1201', catId: 'uncategorized' });
    });
    await prepared('bj-new');
    cleanup();
    renderApp('/review');
    const card = await screen.findByTestId('review-card', {}, { timeout: 8000 });
    expect(card.textContent).toContain('Bakkerij Jansen');
    // no waiting: the suggestion is there when the card is
    expect(screen.getByTestId('review-category-chip').textContent).toContain('Grocery');
    // an ordinary category takes no counterparty and so no counter transaction — both stand disabled
    expect((screen.getByTestId('review-counter-row') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('review-countertx-row') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('review-recurring-row') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('review-event-row') as HTMLButtonElement).disabled).toBe(false);
  }, 30_000);

  it('#525: before any category a recurring cost can be linked — it files its category, and taking it off frees the choice again', async () => {
    await land(async (repo) => {
      await repo.upsert('recurring', DEMO_SPACE_ID, 'rec-gym', {
        name: 'Gym', kind: 'fixed', amountCents: 2999, every: 'month', dueDay: 1, active: 1, catId: 'gym', merchantKey: 'basic fit',
      });
      await repo.upsert('transaction', DEMO_SPACE_ID, 'gym-1', { ...flagged, date: '2026-01-01', amountCents: -1500, merchant: 'Kwartier Noord', catId: 'uncategorized' });
    });
    await openReview('Kwartier Noord');
    expect(screen.getByTestId('review-category-chip').textContent).toContain('Pick a category');
    // the recurring row is open on the uncategorized card
    fireEvent.click(screen.getByTestId('review-recurring-row'));
    fireEvent.click(await screen.findByTestId('recpick-rec-gym'));
    // linking it filed its category at once
    await waitFor(() => expect(screen.getByTestId('review-category-chip').textContent).toContain('Gym Membership'));
    // taking the recurring off: the category is the person's again
    fireEvent.click(screen.getByTestId('review-recurring-row'));
    fireEvent.click(await screen.findByTestId('recpick-none'));
    await waitFor(() => expect(screen.getByTestId('review-recurring-row').textContent).not.toContain('Gym'));
    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-groceries'));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('review-card').textContent).toContain('Grocer'));
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const row = await db.transactions.get('gym-1');
      expect(row).toMatchObject({ catId: 'groceries', needsReview: 0 });
      expect(row?.recurringId ?? null).toBeNull();
    }, { timeout: 8000 });
    db.close();
  }, 30_000);

  it('#525: a recurring link the auto-linker made is the person\'s to take off — the confirm clears it', async () => {
    await land(async (repo) => {
      await repo.upsert('recurring', DEMO_SPACE_ID, 'rec-paper', {
        name: 'Newspaper', kind: 'subscription', amountCents: 1200, every: 'month', dueDay: 1, active: 1, catId: 'groceries', merchantKey: 'krant',
      });
      await repo.upsert('transaction', DEMO_SPACE_ID, 'paper-1', { ...flagged, date: '2026-01-01', amountCents: -1200, merchant: 'Krant', catId: 'groceries', recurringId: 'rec-paper' });
    });
    await openReview('Krant');
    await waitFor(() => expect(screen.getByTestId('review-recurring-row').textContent).toContain('Newspaper'));
    fireEvent.click(screen.getByTestId('review-recurring-row'));
    fireEvent.click(await screen.findByTestId('recpick-none'));
    await waitFor(() => expect(screen.getByTestId('review-recurring-row').textContent).not.toContain('Newspaper'));
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const row = await db.transactions.get('paper-1');
      expect(row?.needsReview).toBe(0);
      expect(row?.recurringId ?? null).toBeNull();
    }, { timeout: 8000 });
    db.close();
  }, 30_000);

  it('#555: a debt payment never confirms without its loan; #556: each loan says what it is paid, and the one this payment fits leads', async () => {
    await land(async (repo) => {
      const loan = { type: 'loan' as const, source: 'manual' as const, currency: 'EUR', paymentEvery: 'month' as const };
      await repo.upsert('account', DEMO_SPACE_ID, 'loan-a', { ...loan, name: 'ING Loan 1', balanceCents: -43792, paymentCents: 5520 });
      await repo.upsert('account', DEMO_SPACE_ID, 'loan-b', { ...loan, name: 'ING Loan 2', balanceCents: -274631, paymentCents: 6324 });
      // filed as a debt payment, an amount neither plan fits: munni cannot tell the loan
      await repo.upsert('transaction', DEMO_SPACE_ID, 'repay-1', { ...flagged, date: '2026-01-01', amountCents: -4000, merchant: 'ING BANK NV', catId: 'loanRepayment' });
    });
    await openReview('ING BANK NV');
    expect(screen.getByTestId('review-counter-row').textContent).toContain('No counter account');
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    // refused: the counterparty is named as missing, nothing linked behind the person's back
    await screen.findByTestId('review-counter-required');
    const db = new MunniDB('munni_demo');
    expect((await db.transactions.get('repay-1'))?.needsReview).toBe(1);
    fireEvent.click(screen.getByTestId('review-counter-row'));
    expect((await screen.findByTestId('counter-plan-loan-a')).textContent).toContain('55.20');
    expect(screen.getByTestId('counter-plan-loan-b').textContent).toContain('63.24');
    expect(screen.queryByTestId('counter-plan-fits-loan-a')).toBeNull();
    fireEvent.click(screen.getByTestId('counter-pick-loan-a'));
    await waitFor(() => expect(screen.getByTestId('review-counter-row').textContent).toContain('ING Loan 1'));
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(async () => expect(await db.transactions.get('repay-1')).toMatchObject({ linkedAccountId: 'loan-a', needsReview: 0 }), { timeout: 8000 });
    db.close();
  }, 30_000);

  it('#565/#556: the payment a loan\'s plan fits arrives linked to that loan, and the list marks it', async () => {
    await land(async (repo) => {
      const loan = { type: 'loan' as const, source: 'manual' as const, currency: 'EUR', paymentEvery: 'month' as const };
      await repo.upsert('account', DEMO_SPACE_ID, 'loan-a', { ...loan, name: 'ING Loan 1', balanceCents: -43792, paymentCents: 5520 });
      await repo.upsert('account', DEMO_SPACE_ID, 'loan-b', { ...loan, name: 'ING Loan 2', balanceCents: -274631, paymentCents: 6324 });
      await repo.upsert('transaction', DEMO_SPACE_ID, 'repay-2', { ...flagged, date: '2026-01-01', amountCents: -6324, merchant: 'ING BANK NV', catId: 'loanRepayment' });
    });
    await prepared('repay-2');
    await openReview('ING BANK NV');
    expect(screen.getByTestId('review-counter-row').textContent).toContain('ING Loan 2');
    fireEvent.click(screen.getByTestId('review-counter-row'));
    await screen.findByTestId('counter-plan-fits-loan-b');
    const rows = screen.getByTestId('counter-accounts').querySelectorAll('[data-testid^="counter-pick-"]');
    expect(rows[0].getAttribute('data-testid')).toBe('counter-pick-loan-b');
  }, 30_000);

  it('#339: with a counterparty standing the picker offers only what that account can mean — no lens, no counter chips, no create door, until it is removed', async () => {
    await land(async (repo) => {
      await repo.upsert('transaction', DEMO_SPACE_ID, 'pot-1', { ...flagged, date: '2026-01-01', amountCents: -2500, merchant: 'Naar spaarrekening', catId: 'savingDeposit', linkedAccountId: 'demo_save' });
    });
    await openReview('Naar spaarrekening');
    await waitFor(() => expect(screen.getByTestId('review-counter-row').textContent).toContain('Demo Savings'));
    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-clear-counter');
    expect(screen.queryByTestId('catpicker-special-filter')).toBeNull();
    expect(screen.queryByTestId('catpicker-counter-filter')).toBeNull();
    expect(screen.queryByTestId('catpicker-create-custom')).toBeNull();
    // the remove door brings all three back in place
    fireEvent.click(screen.getByTestId('catpicker-clear-counter'));
    await screen.findByTestId('catpicker-special-filter');
    expect(screen.getByTestId('catpicker-counter-filter')).toBeTruthy();
    expect(screen.getByTestId('catpicker-create-custom')).toBeTruthy();
  }, 30_000);

  it('#339: a category picked through a counter chip links that account at once — no second question', async () => {
    await land(async (repo) => {
      await repo.upsert('transaction', DEMO_SPACE_ID, 'chip-1', { ...flagged, date: '2026-01-01', amountCents: -2500, merchant: 'Onbekende overboeking', catId: 'uncategorized' });
    });
    await openReview('Onbekende overboeking');
    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-counter-demo_save'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    await waitFor(() => expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBe('demo_save'));
    expect(screen.queryByTestId('counter-accounts')).toBeNull();
  }, 30_000);

  it('#506: the title is one tap from a web search for it', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    await land(async (repo) => {
      await repo.upsert('transaction', DEMO_SPACE_ID, 'vague-1', { ...flagged, date: '2026-01-01', amountCents: -447, merchant: 'PM *Z2U HongKong', catId: 'uncategorized' });
    });
    await openReview('PM *Z2U HongKong');
    fireEvent.click(screen.getByTestId('review-search-web'));
    expect(open).toHaveBeenCalledWith('https://www.google.com/search?q=PM%20*Z2U%20HongKong', '_blank', 'noopener');
  }, 30_000);

  it('#537: a split part’s event picker lists an archived event too, labelled — and files the part under it', async () => {
    await land(async (repo) => {
      await repo.upsert('event', DEMO_SPACE_ID, 'ev-old', { name: 'Hotel Les Sorbiers', archived: 1 });
      await repo.upsert('transaction', DEMO_SPACE_ID, 'split-1', {
        ...flagged, date: '2026-01-01', amountCents: -1000, merchant: 'Gedeelde lunch', catId: 'restaurants',
        splits: [{ id: 'p1', catId: 'restaurants', amountCents: 600 }, { id: 'p2', catId: 'groceries', amountCents: 400 }],
      });
    });
    await openReview('Gedeelde lunch');
    await screen.findByTestId('review-part-deck');
    fireEvent.click(screen.getByTestId('deck-event-0'));
    await screen.findByTestId('deck-event-list');
    await screen.findByTestId('deck-event-ev-old-archived');
    fireEvent.click(screen.getByTestId('deck-event-ev-old'));
    await waitFor(() => expect(screen.getByTestId('deck-event-0').textContent).toContain('Hotel Les Sorbiers'));
  }, 30_000);
});
