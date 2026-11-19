// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { CLIENT_PROTOCOL } from '@/lib/protocol';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID } from '@/db/seed';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';

describe('ReviewScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  // #330: the demo cards wear their seeded category, so the split door warns on the first press: walk through to the editor
  const openSplitEditor = async () => {
    fireEvent.click(await screen.findByTestId('review-split-row'));
    fireEvent.click(await screen.findByTestId('split-reset-continue', {}, { timeout: 10_000 }));
    await screen.findByTestId('split-editor');
  };

  it('walks the queue with progress: confirm clears the flag and advances', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    expect(screen.getByText('1 / 3')).toBeTruthy();

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(() => expect(screen.getByText('2 / 3')).toBeTruthy(), { timeout: 5000 });

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(() => expect(screen.getByText('3 / 3')).toBeTruthy(), { timeout: 5000 });

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    expect(await screen.findByTestId('review-empty')).toBeTruthy();
  }, 15_000);

  it('the outgoing card flies out WITH the next card, never before it (user ss 2026-10-06: the slide played twice on a phone)', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    const first = screen.getByTestId('review-card').textContent;
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    expect(document.querySelector('.m-card-out')).toBeNull();
    await waitFor(() => expect(screen.getByText('2 / 3')).toBeTruthy(), { timeout: 5000 });
    await waitFor(() => expect(document.querySelector('.m-card-out')).toBeTruthy());
    expect(screen.getByTestId('review-card').textContent).not.toBe(first);
    await waitFor(() => expect(document.querySelector('.m-card-out')).toBeNull(), { timeout: 2000 });
  }, 15_000);

  it('#133 C: no kind row — a ◆ pick asks the counterparty; #228: the card\'s own Counterparty row carries it', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');

    expect(screen.queryByTestId('review-kind-row')).toBeNull();
    expect(screen.getByTestId('review-counter-row').textContent).toContain('No counter account');

    fireEvent.click(screen.getByTestId('review-category-chip'));
    await screen.findByTestId('part-cats-editor');
    expect(screen.queryByTestId('split-counter-row')).toBeNull();
    expect(screen.queryByTestId('split-type-row')).toBeNull();
    fireEvent.click(screen.getByTestId('part-cat-0'));
    await screen.findByTestId('speccat-savingDeposit');
    // #133: a regular account's outgoing row sees exactly one saving sub; Take out and Fees live on the pot's own ledger
    expect(screen.queryByTestId('catpicker-savingWithdraw')).toBeNull();
    expect(screen.queryByTestId('catpicker-savingFees')).toBeNull();
    expect(screen.queryByTestId('catpicker-savingInterest')).toBeNull();
    fireEvent.click(screen.getByTestId('catpicker-savingDeposit'));

    await screen.findByTestId('counter-accounts');
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    await waitFor(() => expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBe('demo_save'));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('review-counter-row').textContent).toContain('Demo Savings'));
    expect(screen.queryByTestId('review-cat-counter-savingDeposit')).toBeNull();
  }, 15_000);

  it('#268: a row-level pick keeps bulk — confirm walks each sibling through its own counter queue', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('revpick'), { trackOutbox: false });
    // dated OLDEST so they lead the queue; no category is predicted, so the counterparty may come first (#565)
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'rv1', {
      accountId: 'demo_main', date: '2026-01-02', amountCents: -500, currency: 'EUR',
      merchant: 'Weekgeld Sam', needsReview: 1,
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'rv2', {
      accountId: 'demo_main', date: '2026-01-03', amountCents: -500, currency: 'EUR',
      merchant: 'Weekgeld Sam', needsReview: 1,
    });
    // the pot's twin in another currency: the card's row wears the leg's currency
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'rvc', {
      accountId: 'demo_save', date: '2026-01-02', amountCents: 500, currency: 'USD',
      merchant: 'Pot side', catId: 'uncategorized', needsReview: 0,
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'rvc2', {
      accountId: 'demo_save', date: '2026-01-03', amountCents: 500, currency: 'EUR',
      merchant: 'Pot side two', catId: 'uncategorized', needsReview: 0,
    });
    seed.close();
    cleanup();
    renderApp('/review');
    await screen.findByTestId('review-card');
    await screen.findByTestId('review-bulk');

    fireEvent.click(screen.getByTestId('review-counter-row'));
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    await waitFor(() => expect(screen.getByTestId('review-counter-row').textContent).toContain('Demo Savings'));
    const counterTxRow = await screen.findByTestId('review-countertx-row');
    expect(counterTxRow.textContent).toContain('created on confirm');
    fireEvent.click(counterTxRow);
    // #268: picking the pot's twin neither warns nor silences the bulk; the siblings queue for their own counters
    fireEvent.click((await screen.findByTestId('counter-dup-rvc')).querySelector('button')!);
    await waitFor(() => expect(screen.getByTestId('review-countertx-row').textContent).toContain('Pot side'));
    expect(screen.getByTestId('review-countertx-row').textContent).toContain('$');
    expect(screen.getByTestId('review-countertx-row').textContent).not.toContain('€5');
    expect(screen.queryByTestId('review-pick-warn')).toBeNull();
    expect(screen.getByTestId('review-bulk')).toBeTruthy();

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    const context = await screen.findByTestId('counter-queue-context', undefined, { timeout: 10_000 });
    expect(context.textContent).toContain('Weekgeld Sam');
    expect(context.textContent).toContain('1/1');
    // #268: the deck holds behind the queue: the confirmed card stays frozen (no advance, no exit flight)
    expect(screen.getByTestId('review-card').getAttribute('data-held')).toBe('1');
    const heldMeta = screen.getByTestId('review-card-meta').textContent;
    expect(heldMeta).toContain('2 January'); // rv1's own face, not rv2's
    fireEvent.click(screen.getByTestId('counter-queue-why-toggle'));
    expect((await screen.findByTestId('counter-queue-why')).textContent).toContain('needs its own');
    fireEvent.click(screen.getByTestId('counter-queue-why-toggle'));
    expect(screen.queryByTestId('counter-queue-why')).toBeNull();
    // the sibling picks ITS OWN twin (rv1's pick is spoken for)
    fireEvent.click((await screen.findByTestId('counter-dup-rvc2')).querySelector('button')!);
    await waitFor(() => expect(screen.queryByTestId('counter-queue-context')).toBeNull(), { timeout: 10_000 });
    await waitFor(() => {
      expect(screen.getByTestId('review-card').getAttribute('data-held')).toBeNull();
      expect(screen.getByTestId('review-card-meta').textContent).not.toBe(heldMeta);
    }, { timeout: 10_000 });

    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const source = await db.transactions.get('rv1');
      expect(source?.needsReview).toBe(0);
      expect(source?.linkedAccountId).toBe('demo_save');
      expect(source?.transferPeerId).toBe('rvc');
      expect((await db.transactions.get('rvc'))?.transferPeerId).toBe('rv1');
      const sibling = await db.transactions.get('rv2');
      expect(sibling?.needsReview).toBe(0);
      expect(sibling?.linkedAccountId).toBe('demo_save');
      expect(sibling?.transferPeerId).toBe('rvc2');
      expect((await db.transactions.get('rvc2'))?.transferPeerId).toBe('rv2');
    }, { timeout: 8000 });
    db.close();
  }, 25_000);

  it('#268 r2: the bulk list holds only LATER unreviewed siblings — reviewed, current and skipped rows drop out', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('revwalk'), { trackOutbox: false });
    // three same-merchant unreviewed rows, oldest first; categorized so Confirm is live
    const base = { accountId: 'demo_main', currency: 'EUR', merchant: 'Metro Market', catId: 'groceries', needsReview: 1 as const };
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'rw1', { ...base, date: '2026-01-02', amountCents: -500 });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'rw2', { ...base, date: '2026-01-03', amountCents: -600 });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'rw3', { ...base, date: '2026-01-04', amountCents: -700 });
    seed.close();
    cleanup();
    renderApp('/review');
    await screen.findByTestId('review-card', undefined, { timeout: 10_000 });

    await waitFor(() => expect(screen.getByTestId('review-bulk-toggle').getAttribute('aria-label')).toContain('2 similar'), { timeout: 10_000 });
    fireEvent.click(screen.getByTestId('review-bulk-expand'));
    await screen.findByTestId('review-bulk-list');
    expect(screen.queryByTestId('review-bulk-rw1')).toBeNull();
    expect(screen.getByTestId('review-bulk-rw2')).toBeTruthy();
    expect(screen.getByTestId('review-bulk-rw3')).toBeTruthy();

    fireEvent.click(screen.getByTestId('review-bulk-toggle'));
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(() => expect(screen.getByTestId('review-card-meta').textContent).toContain('3 January'), { timeout: 10_000 });
    await waitFor(() => expect(screen.getByTestId('review-bulk-toggle').getAttribute('aria-label')).toContain('1 similar'), { timeout: 10_000 });
    fireEvent.click(screen.getByTestId('review-bulk-expand'));
    await screen.findByTestId('review-bulk-list', undefined, { timeout: 10_000 });
    expect(screen.queryByTestId('review-bulk-rw1')).toBeNull(); // reviewed — must never ride again
    expect(screen.queryByTestId('review-bulk-rw2')).toBeNull();
    expect(screen.getByTestId('review-bulk-rw3')).toBeTruthy();

    // a skipped card left the deck on purpose: the last card has nobody left to offer, so the bulk row stands down
    fireEvent.click(screen.getByTestId('review-skip-btn'));
    await waitFor(() => expect(screen.getByTestId('review-card-meta').textContent).toContain('4 January'), { timeout: 10_000 });
    await waitFor(() => expect(screen.queryByTestId('review-bulk')).toBeNull(), { timeout: 10_000 });
  }, 30_000);

  it('a row that REMEMBERS its counterparty wears the movement category, and its stored pair is the person\'s to release from the card (user ss 2026-10-05)', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('revpair'), { trackOutbox: false });
    // the oldest card: counterparty and pair survived (the memory, another device) but its category did not
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'rp1', {
      accountId: 'demo_main', date: '2026-01-01', amountCents: -2500, currency: 'EUR',
      merchant: 'Pot top-up', catId: 'uncategorized', needsReview: 1, linkedAccountId: 'demo_save', transferPeerId: 'rp1peer',
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'rp1peer', {
      accountId: 'demo_save', date: '2026-01-01', amountCents: 2500, currency: 'EUR',
      merchant: 'Pot side', catId: 'savingDeposit', needsReview: 0, linkedAccountId: 'demo_main', transferPeerId: 'rp1',
    });
    seed.close();
    cleanup();
    renderApp('/review');
    await screen.findByTestId('review-card');
    await waitFor(() => expect(screen.getByTestId('review-counter-row').textContent).toContain('Demo Savings'));
    expect(screen.getByTestId('review-category-chip').textContent).toContain('Set aside');
    const counterTxRow = await screen.findByTestId('review-countertx-row');
    expect(counterTxRow.textContent).toContain('Pot side');
    expect((counterTxRow as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(counterTxRow);
    // the pot is manual: the create door releases the stored pair
    fireEvent.click(await screen.findByTestId('counter-fork-create'));
    await waitFor(() => expect(screen.getByTestId('review-countertx-row').textContent).toContain('created on confirm'));
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const row = await db.transactions.get('rp1');
      expect(row?.needsReview).toBe(0);
      expect(row?.catId).toBe('savingDeposit');
      expect(row?.transferPeerId ?? null).toBeNull();
      expect((await db.transactions.get('rp1peer'))?.transferPeerId ?? null).toBeNull();
    }, { timeout: 8000 });
    db.close();
  }, 20_000);

  it('dropping the counterparty on the card releases the stored pair on confirm (user ss 2026-10-05)', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('revdrop'), { trackOutbox: false });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'rp2', {
      accountId: 'demo_main', date: '2026-01-01', amountCents: -1800, currency: 'EUR',
      merchant: 'Mislabelled shop', catId: 'uncategorized', needsReview: 1, linkedAccountId: 'demo_save', transferPeerId: 'rp2peer',
    });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'rp2peer', {
      accountId: 'demo_save', date: '2026-01-01', amountCents: 1800, currency: 'EUR',
      merchant: 'Pot side', catId: 'savingDeposit', needsReview: 0, linkedAccountId: 'demo_main', transferPeerId: 'rp2',
    });
    seed.close();
    cleanup();
    renderApp('/review');
    await screen.findByTestId('review-card');
    await waitFor(() => expect(screen.getByTestId('review-counter-row').textContent).toContain('Demo Savings'));
    // not a transfer after all: the counter-transaction row stands empty (#565: disabled, never hidden)
    fireEvent.click(screen.getByTestId('review-counter-row'));
    fireEvent.click(await screen.findByTestId('counter-detach'));
    await waitFor(() => expect((screen.getByTestId('review-countertx-row') as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByTestId('review-countertx-row').textContent).toContain('None');
    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-groceries'));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('review-category-chip').textContent).toContain('Other · Groceries'));
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const row = await db.transactions.get('rp2');
      expect(row?.catId).toBe('groceries');
      expect(row?.linkedAccountId ?? null).toBeNull();
      expect(row?.transferPeerId ?? null).toBeNull();
      expect((await db.transactions.get('rp2peer'))?.transferPeerId ?? null).toBeNull();
    }, { timeout: 8000 });
    db.close();
  }, 20_000);

  it('a receipt that fits the card asks on the card — yes attaches it, and the Receipts screen has nothing left to check (user ss 2026-10-05)', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('revrcpt'), { trackOutbox: false });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'rr1', {
      accountId: 'demo_main', date: '2026-01-01', amountCents: -1316, currency: 'EUR', merchant: 'Albert Heijn 1842', needsReview: 1,
    });
    await seedRepo.upsert('receiptLink', DEMO_SPACE_ID, 'rlink-review', {
      receiptId: 'rcpt:ah:demo_conn_ah:rv', source: 'ah', instanceId: 'demo_conn_ah', date: '2026-01-01', totalCents: 1316, merchant: 'Albert Heijn', auto: 0, proposedTxId: 'rr1',
    });
    seed.close();
    cleanup();
    renderApp('/review');
    await screen.findByTestId('review-card');
    const row = await screen.findByTestId('review-receipt-row');
    expect(row.textContent).toContain('Receipt to check');
    fireEvent.click(row);
    await screen.findByTestId('review-receipt-proposal');
    fireEvent.click(screen.getByTestId('review-receipt-accept'));
    // both in one wait: between "to check" and attached the row reads nothing for a moment
    await waitFor(() => {
      const text = screen.getByTestId('review-receipt-row').textContent ?? '';
      expect(text).toContain('Albert Heijn');
      expect(text).not.toContain('Receipt to check');
    });
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const link = await db.receiptLinks.get('rlink-review');
      expect(link?.txId).toBe('rr1');
      expect(link?.proposedTxId ?? null).toBeNull();
    });
    db.close();
  }, 20_000);

  it('#228 feedback: counter-FIRST from the card row — the pick fills the special category by itself', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('revfirst'), { trackOutbox: false });
    // the oldest card wears no category: the counterparty may come first
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'cf1', {
      accountId: 'demo_main', date: '2026-01-01', amountCents: -2500, currency: 'EUR', merchant: 'Onbekende overboeking', catId: 'uncategorized', needsReview: 1,
    });
    seed.close();
    cleanup();
    renderApp('/review');
    await waitFor(() => expect(screen.getByTestId('review-card').textContent).toContain('Onbekende overboeking'));
    fireEvent.click(screen.getByTestId('review-counter-row'));
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    await waitFor(() => expect(screen.getByTestId('review-counter-row').textContent).toContain('Demo Savings'));
    expect(screen.getByTestId('review-category-chip').textContent).toContain('Set aside');
    expect(screen.getByTestId('review-countertx-row').textContent).toContain('created on confirm');
  }, 15_000);

  it('#133 C: a loan-family pick creates its loan through the ask and the debt row takes over', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    expect(screen.getByTestId('review-recurring-row')).toBeTruthy();

    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-loanRepayment'));
    await screen.findByTestId('counter-accounts');
    fireEvent.click(screen.getByTestId('counter-full-setup'));
    fireEvent.click(await screen.findByTestId('chooser-manual'));
    fireEvent.click(await screen.findByTestId('chooser-accttype-loan'));
    fireEvent.change(await screen.findByTestId('chooser-acctform-name'), { target: { value: 'Car loan' } });
    // v2: a loan account's current value is required (it IS the debt)
    fireEvent.change(screen.getByTestId('chooser-acctform-balance'), { target: { value: '5000' } });
    fireEvent.click(screen.getByTestId('chooser-acctform-save'));
    await waitFor(() => expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBeTruthy(), { timeout: 5000 });
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('review-counter-row').textContent).toContain('Car loan'), { timeout: 5000 });

    // #236: no separate debt row, the Counterparty row names the loan
    // a payoff is no recurring cost, so that row stands disabled
    await waitFor(() => expect((screen.getByTestId('review-recurring-row') as HTMLButtonElement).disabled).toBe(true), { timeout: 5000 });
    expect(screen.queryByTestId('review-debt-row')).toBeNull();
  }, 15_000);

  it('#133 E+r5: a ◆ Transfer pick stages nothing until the mandatory ask answers — REGULAR accounts only, no default', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    const chipBefore = screen.getByTestId('review-category-chip').textContent;

    // #546: no default bank account answers the mandatory ask; #133: the pot is off the real list
    // the demo has no other regular account
    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-transferOut'));
    await screen.findByTestId('counter-accounts');
    expect(screen.queryByTestId('counter-default')).toBeNull();
    expect(screen.queryByTestId('counter-pick-demo_save')).toBeNull(); // the pot is not a transfer counter (#133)
    await screen.findByTestId('counter-empty');
    fireEvent.keyDown(window, { key: 'Escape' });
    // dismissed: the entry rolls back, an unlinked transfer is unrepresentable
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('review-category-chip').textContent).toBe(chipBefore));

    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click((await screen.findAllByTestId('catpicker-transferOut')).at(-1)!);
    fireEvent.click(await screen.findByTestId('counter-full-setup'));
    fireEvent.click(await screen.findByTestId('chooser-manual'));
    fireEvent.click(await screen.findByTestId('chooser-accttype-checking'));
    fireEvent.change(await screen.findByTestId('chooser-acctform-name'), { target: { value: 'Second checking' } });
    fireEvent.change(screen.getByTestId('chooser-acctform-balance'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('chooser-acctform-save'));
    await waitFor(() => expect((screen.getAllByTestId('part-cat-save').at(-1)! as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(screen.getAllByTestId('part-cat-save').at(-1)!);
    await waitFor(() => expect(screen.getByTestId('review-category-chip').textContent).toContain('Transfer Out'));
    await waitFor(() => expect(screen.getByTestId('review-counter-row').textContent).toContain('Second checking'));
  }, 15_000);

  it('#133 C/#309: a bare ◆ Confirm REFUSES with the red counterparty field — naming the account answers it', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    // walking away keeps the bare story staged, but it can no longer confirm bare (#309)
    await screen.findByTestId('counter-accounts');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(await screen.findByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('review-category-chip').textContent).toContain('Set aside'));
    expect(screen.getByTestId('review-counter-row').textContent).toContain('No counter account');
    expect((screen.getByTestId('review-confirm-btn') as HTMLButtonElement).disabled).toBe(false);

    // #309: the click marks the field red instead of silently linking the default
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    expect((await screen.findByTestId('review-counter-required')).textContent).toContain('Counterparty required');
    expect(screen.getByTestId('review-counter-row').className).toContain('ring-negative');
    // #316: the ring draws inset: the row spans the card's full width and the card's overflow-hidden clips a box-edge ring
    expect(screen.getByTestId('review-counter-row').className).toContain('ring-inset');
    expect(screen.getByTestId('review-card')).toBeTruthy();

    fireEvent.click(screen.getByTestId('review-counter-row'));
    // the card's own ask stacks above the editor's (a closed sheet keeps its children)
    fireEvent.click((await screen.findAllByTestId('counter-pick-demo_save')).at(-1)!);
    await waitFor(() => expect(screen.queryByTestId('review-counter-required')).toBeNull());

    // the seed's own savings transfers already name the pot, so only the card's row can tell
    const cardId = screen.getByTestId('review-card').closest('[data-card-id]')!.getAttribute('data-card-id')!;
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const row = await db.transactions.get(cardId);
      expect(row).toMatchObject({ catId: 'savingDeposit', linkedAccountId: 'demo_save', needsReview: 0 });
      const leg = row?.transferPeerId ? await db.transactions.get(row.transferPeerId) : undefined;
      expect(leg?.accountId).toBe('demo_save');
    }, { timeout: 8000 });
    db.close();
  }, 20_000);

  const seedR3 = async (over: { id: string; merchant: string; description?: string; counterIban?: string; withPaypalAccount?: boolean }) => {
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('r3-seed'), { trackOutbox: false });
    if (over.withPaypalAccount) {
      await seedRepo.upsert('account', DEMO_SPACE_ID, 'demo_pp', {
        name: 'PayPal o.doker@live.nl', type: 'checking', source: 'camt053', currency: 'EUR', balanceCents: 0,
      });
    }
    // a server-style prediction: Transfer Out stamped, no counterparty; oldest date so the queue leads with it
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, over.id, {
      accountId: 'demo_main', date: '2026-01-05', amountCents: -799, currency: 'EUR',
      merchant: over.merchant, description: over.description, counterIban: over.counterIban,
      catId: 'transferOut', needsReview: 1,
    });
    seed.close();
  };

  it('#228 r3: a predicted transfer whose text names a tracked account opens LINKED to it — and confirms without the default', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    await seedR3({
      id: 'tx-r3a',
      merchant: 'PayPal Europe S.a.r.l. et Cie S.C.A',
      description: 'Incasso · Naam: PayPal Europe S.a.r.l. et Cie S.C.A Omschrijving: 1051635911097/PAYPAL',
      counterIban: 'LU89751000135104200E',
      withPaypalAccount: true,
    });
    cleanup();
    renderApp('/review');
    await screen.findByTestId('review-card');
    await waitFor(() => expect(screen.getByTestId('review-counter-row').textContent).toContain('PayPal'), { timeout: 5000 });
    expect(screen.getByTestId('review-category-chip').textContent).toContain('Transfer Out');
    expect((screen.getByTestId('review-confirm-btn') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const row = await db.transactions.get('tx-r3a');
      expect(row).toMatchObject({ catId: 'transferOut', linkedAccountId: 'demo_pp', needsReview: 0 });
    }, { timeout: 8000 });
    db.close();
  }, 15_000);

  it('#228 r3: a predicted transfer with NO nameable account stands down to Uncategorized — the default is not an answer', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    await seedR3({ id: 'tx-r3b', merchant: 'Verzamelbetaling batch 42' });
    cleanup();
    renderApp('/review');
    await screen.findByTestId('review-card');
    await waitFor(() => expect(screen.getByTestId('review-category-chip').textContent).toContain('Pick a category'), { timeout: 5000 });
    expect(screen.getByTestId('review-category-chip').textContent).not.toContain('Transfer');
    expect(screen.getByTestId('review-counter-row').textContent).toContain('No counter account');
    // Confirm waits for a human decision: no one-tap default link for bare transfers (#228)
    // the tap names the missing category (#410)
    expect((screen.getByTestId('review-confirm-btn') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await screen.findByTestId('review-cat-required');
  }, 15_000);

  it('a picked category is staged and written on confirm', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    const db = new MunniDB('munni_demo');
    const current = (await db.transactions.filter((t) => t.needsReview === 1).toArray())
      .sort((a, b) => a.date.localeCompare(b.date))[0];

    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-coffee'));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('review-category-chip').textContent).toContain('Coffee'));
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

    // bulk1 (2020) becomes the CURRENT card; bulk2 and the demo row are its similar companions
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-rev'), { trackOutbox: false });
    const first = (await db.transactions.filter((t) => t.needsReview === 1).toArray())
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    for (const [id, date] of [['bulk1', '2020-01-15'], ['bulk2', '2020-02-15']] as const) {
      await repo.upsert('transaction', DEMO_SPACE_ID, id, {
        accountId: first.accountId,
        date,
        amountCents: first.amountCents,
        currency: 'EUR',
        merchant: first.merchant,
        catId: first.catId, // bulk1 IS the card — it needs a ready draft
        needsReview: 1,
      });
    }

    await waitFor(
      () => expect(screen.getByTestId('review-bulk').textContent).toContain('2'),
      { timeout: 5000 },
    );
    fireEvent.click(screen.getByTestId('review-bulk-expand'));
    const bulkList = await screen.findByTestId('review-bulk-list');
    expect(bulkList.className).toContain('overflow-y-auto');
    expect(screen.getByTestId('review-bulk-bulk2')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tx-row-bulk2'));
    await screen.findByTestId('review-bulk-detail');
    expect(screen.getByTestId('review-bulk-select-all')).toBeTruthy();
    // the async prediction arms the confirm — wait before clicking
    await waitFor(() =>
      expect((screen.getByTestId('review-confirm-btn') as HTMLButtonElement).disabled).toBe(false),
    );
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

    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-link'), { trackOutbox: false });
    await repo.upsert('recurring', DEMO_SPACE_ID, 'rec-nfx', {
      name: 'Netflix',
      kind: 'subscription',
      amountCents: 1399,
      every: 'month',
      dueDay: 7,
      active: 1,
      merchantKey: 'netflix com',
    });
    const iso = '2020-03-01'; // oldest-first queue: an old date makes this the CURRENT card
    await repo.upsert('transaction', DEMO_SPACE_ID, 'tx-nfx', {
      accountId: 'demo_main',
      date: iso,
      amountCents: -1399,
      currency: 'EUR',
      merchant: 'NETFLIX.COM',
      catId: 'subs',
      needsReview: 1,
    });
    // last month's charge, reviewed long ago and never linked
    await repo.upsert('transaction', DEMO_SPACE_ID, 'tx-nfx-feb', {
      accountId: 'demo_main',
      date: '2020-02-01',
      amountCents: -1399,
      currency: 'EUR',
      merchant: 'NETFLIX.COM',
      catId: 'subs',
      needsReview: 0,
    });

    await waitFor(() => expect(screen.getByTestId('review-card').textContent).toContain('NETFLIX.COM'), { timeout: 5000 });
    await waitFor(() => expect(screen.getByTestId('review-recurring-row').textContent).toContain('Netflix'), { timeout: 5000 });

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(
      async () => expect((await db.transactions.get('tx-nfx'))?.recurringId).toBe('rec-nfx'),
      { timeout: 5000 },
    );
    // the link reaches the other billing cycles once the deck has moved on
    await waitFor(
      async () => expect((await db.transactions.get('tx-nfx-feb'))?.recurringId).toBe('rec-nfx'),
      { timeout: 5000 },
    );
    db.close();
  }, 15_000);

  it('the manual picker clears again via "no link", and ArrowRight skips by keyboard', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');

    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-manual-2'), { trackOutbox: false });
    await repo.upsert('recurring', DEMO_SPACE_ID, 'rec-spotify', {
      name: 'Spotify',
      kind: 'subscription',
      amountCents: 1099,
      every: 'month',
      dueDay: 5,
      active: 1,
      merchantKey: 'spotify',
    });
    db.close();

    fireEvent.click(await screen.findByTestId('review-recurring-row', {}, { timeout: 5000 }));
    await screen.findByTestId('recpick-list');
    fireEvent.click(await screen.findByTestId('recpick-rec-spotify', {}, { timeout: 5000 }));
    await waitFor(() => expect(screen.getByTestId('review-recurring-row').textContent).toContain('Spotify'), { timeout: 5000 });

    fireEvent.click(screen.getByTestId('review-recurring-row'));
    fireEvent.click(await screen.findByTestId('recpick-none'));
    await waitFor(() => expect(screen.getByTestId('review-recurring-row').textContent).not.toContain('Spotify'), { timeout: 5000 });
  }, 15_000);

  it('ArrowRight skips the current card from the keyboard', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    const before = screen.getByTestId('review-card').textContent;
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByTestId('review-card').textContent).not.toBe(before), { timeout: 5000 });
  }, 15_000);

  it('an event is staged on the card and confirm carries EVERYTHING to the bulk siblings', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');

    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-event'), { trackOutbox: false });
    await repo.upsert('event', DEMO_SPACE_ID, 'ev-trip', { name: 'Ski trip', icon: 'party-popper' });
    for (const [id, day] of [['evt-a', '01'], ['evt-b', '02']] as const) {
      await repo.upsert('transaction', DEMO_SPACE_ID, id, {
        accountId: 'demo_main', date: `2020-01-${day}`, amountCents: -2000, currency: 'EUR',
        merchant: 'APRES SKI BAR', catId: 'entertainment', needsReview: 1,
      });
    }
    await waitFor(() => expect(screen.getByTestId('review-card').textContent).toContain('APRES SKI BAR'), { timeout: 5000 });
    await screen.findByTestId('review-bulk');

    fireEvent.click(screen.getByTestId('review-event-row'));
    fireEvent.click(await screen.findByTestId('review-event-ev-trip'));
    await waitFor(() => expect(screen.getByTestId('review-event-row').textContent).toContain('Ski trip'));
    expect((await db.transactions.get('evt-a'))?.eventId).toBeUndefined();

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(async () => {
      expect((await db.transactions.get('evt-a'))?.eventId).toBe('ev-trip');
      expect((await db.transactions.get('evt-b'))?.eventId).toBe('ev-trip');
      expect((await db.transactions.get('evt-b'))?.needsReview).toBe(0);
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('no auto-match: the manual chip opens the picker and confirm links the choice', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');

    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-manual'), { trackOutbox: false });
    await repo.upsert('recurring', DEMO_SPACE_ID, 'rec-gym', {
      name: 'Gym',
      kind: 'fixed',
      amountCents: 2999,
      every: 'month',
      dueDay: 1,
      active: 1,
      merchantKey: 'basic fit',
    });
    const current = (await db.transactions.filter((t) => t.needsReview === 1).toArray())
      .sort((a, b) => a.date.localeCompare(b.date))[0];

    fireEvent.click(await screen.findByTestId('review-recurring-row'));
    fireEvent.click(await screen.findByTestId('recpick-rec-gym', {}, { timeout: 5000 }));
    await waitFor(() => expect(screen.getByTestId('review-recurring-row').textContent).toContain('Gym'), { timeout: 5000 });

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(
      async () => expect((await db.transactions.get(current.id))?.recurringId).toBe('rec-gym'),
      { timeout: 5000 },
    );
    db.close();
  }, 15_000);

  it('the split door opens the VALUES editor — pure money, no category rows (#126 v2)', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    await openSplitEditor();
    await screen.findByTestId('split-label-0');
    expect(screen.queryByTestId('split-cat-0')).toBeNull();
    expect(screen.getByTestId('split-mode-pct')).toBeTruthy();
  });

  it('the part deck: one card expanded, tap to toggle, per-part category staged in place (#126 v2)', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');

    await openSplitEditor();
    fireEvent.click(screen.getByTestId('split-add-row'));
    const amount0 = (await screen.findByTestId('split-amount-0')) as HTMLInputElement;
    fireEvent.focus(amount0);
    fireEvent.change(amount0, { target: { value: '6,00' } });
    fireEvent.blur(amount0);
    fireEvent.click(await screen.findByTestId('split-remainder'));
    await waitFor(() => expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('split-save'));

    await screen.findByTestId('review-part-deck');
    await screen.findByTestId('deck-cat-0');
    expect(screen.queryByTestId('deck-cat-1')).toBeNull();
    fireEvent.click(screen.getByTestId('deck-part-1'));
    await screen.findByTestId('deck-cat-1');
    expect(screen.queryByTestId('deck-cat-0')).toBeNull();

    fireEvent.click(screen.getByTestId('deck-cat-1'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-coffee'));
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('deck-cat-1').textContent).toContain('Coffee'));

    fireEvent.change(screen.getByTestId('deck-label-1'), { target: { value: 'Office snacks' } });
    await waitFor(() => expect((screen.getByTestId('deck-label-1') as HTMLInputElement).value).toBe('Office snacks'));

    expect(screen.queryByTestId('deck-kind-row-1')).toBeNull();
    expect(screen.getByTestId('deck-counter-1').textContent).toContain('No counter account');

    fireEvent.click(screen.getByTestId('deck-event-1'));
    await screen.findByTestId('deck-event-list');
    expect(screen.getByTestId('deck-event-create')).toBeTruthy();
    fireEvent.click(screen.getByTestId('deck-event-none'));

    // the deck carries no notes row (review never had one)
    fireEvent.click(screen.getByTestId('deck-rec-1'));
    await screen.findByTestId('deck-rec-list');
    expect(screen.getByTestId('deck-rec-create')).toBeTruthy();
    fireEvent.click(screen.getByTestId('deck-rec-none'));
    expect(screen.getByTestId('deck-rec-1').textContent).toContain('None');
    expect(screen.queryByTestId('deck-notes-1')).toBeNull();
  }, 15_000);

  it('#251: creating a recurring from a part links THAT part, prefilled from the part', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');

    // part 1 labeled: the label must seed the form's name
    await openSplitEditor();
    fireEvent.click(screen.getByTestId('split-add-row'));
    const amount0 = (await screen.findByTestId('split-amount-0')) as HTMLInputElement;
    fireEvent.focus(amount0);
    fireEvent.change(amount0, { target: { value: '6,00' } });
    fireEvent.blur(amount0);
    fireEvent.click(await screen.findByTestId('split-remainder'));
    await waitFor(() => expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('split-save'));
    await screen.findByTestId('review-part-deck');
    fireEvent.click(screen.getByTestId('deck-part-1'));
    fireEvent.change(await screen.findByTestId('deck-label-1'), { target: { value: 'Gym half' } });
    // #331: the part's category rides into the form
    fireEvent.click(screen.getByTestId('deck-cat-1'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-coffee'));
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('deck-cat-1').textContent).toContain('Coffee'));

    fireEvent.click(screen.getByTestId('deck-rec-1'));
    await screen.findByTestId('deck-rec-list');
    fireEvent.click(screen.getByTestId('deck-rec-create'));
    const name = (await screen.findByTestId('recform-name')) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe('Gym half'));
    expect(screen.getByTestId('recform-cat').textContent).toContain('Coffee');
    fireEvent.click(screen.getByTestId('recform-save'));

    await waitFor(() => expect(screen.getByTestId('deck-rec-1').textContent).toContain('Gym half'));
  }, 15_000);

  it('#331: a category picked upfront rides into the quick-created recurring form', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    fireEvent.click(screen.getByTestId('review-category-chip'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-coffee'));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('review-category-chip').textContent).toContain('Coffee'));

    fireEvent.click(screen.getByTestId('review-recurring-row'));
    await screen.findByTestId('recpick-list');
    fireEvent.click(screen.getByTestId('recpick-create'));
    await screen.findByTestId('recform-name');
    await waitFor(() => expect(screen.getByTestId('recform-cat').textContent).toContain('Coffee'));
  }, 15_000);

  it('#333: the picked recurring\'s own visual replaces the generic circle-arrow on the card row', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-recvis'), { trackOutbox: false });
    await repo.upsert('recurring', DEMO_SPACE_ID, 'rec-logo', {
      name: 'Spotify', kind: 'subscription', amountCents: 1099, every: 'month', dueDay: 5, active: 1,
      merchantKey: 'spotify', logo: 'data:image/png;base64,abc',
    });
    db.close();
    expect(screen.queryByTestId('review-recurring-visual')).toBeNull();
    fireEvent.click(await screen.findByTestId('review-recurring-row', {}, { timeout: 10_000 }));
    await screen.findByTestId('recpick-list');
    fireEvent.click(await screen.findByTestId('recpick-rec-logo', {}, { timeout: 10_000 }));
    await waitFor(() => expect(screen.getByTestId('review-recurring-row').textContent).toContain('Spotify'), { timeout: 10_000 });
    const visual = await screen.findByTestId('review-recurring-visual');
    expect(visual.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,abc');
    fireEvent.click(screen.getByTestId('review-recurring-row'));
    fireEvent.click(await screen.findByTestId('recpick-none'));
    await waitFor(() => expect(screen.queryByTestId('review-recurring-visual')).toBeNull(), { timeout: 10_000 });
  }, 15_000);

  it('#324: a typed note lands with the confirm — and the bulk update carries it to the siblings', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-notes'), { trackOutbox: false });
    // two same-merchant cards, dated oldest so they lead the queue
    for (const [id, day] of [['note-a', '01'], ['note-b', '02']] as const) {
      await repo.upsert('transaction', DEMO_SPACE_ID, id, {
        accountId: 'demo_main', date: `2020-02-${day}`, amountCents: -1500, currency: 'EUR',
        merchant: 'PADEL CLUB', catId: 'entertainment', needsReview: 1,
      });
    }
    await waitFor(() => expect(screen.getByTestId('review-card').textContent).toContain('PADEL CLUB'), { timeout: 10_000 });
    await screen.findByTestId('review-bulk');

    fireEvent.change(screen.getByTestId('review-notes'), { target: { value: 'Court 4, with Jan' } });
    expect((await db.transactions.get('note-a'))?.notes).toBeUndefined();

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(async () => {
      expect((await db.transactions.get('note-a'))?.notes).toBe('Court 4, with Jan');
      expect((await db.transactions.get('note-b'))?.notes).toBe('Court 4, with Jan');
      expect((await db.transactions.get('note-b'))?.needsReview).toBe(0);
    }, { timeout: 8000 });
    db.close();
  }, 15_000);

  it('#325: unticking every similar row swaps the zero count for the short none-selected line', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-none'), { trackOutbox: false });
    const first = (await db.transactions.filter((t) => t.needsReview === 1).toArray())
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    await repo.upsert('transaction', DEMO_SPACE_ID, 'none-1', {
      accountId: first.accountId, date: '2030-01-01', amountCents: first.amountCents, currency: 'EUR',
      merchant: first.merchant, catId: first.catId, needsReview: 1,
    });
    db.close();
    await waitFor(() => expect(screen.getByTestId('review-bulk').textContent).toContain('Also apply to 1 similar'), { timeout: 10_000 });

    fireEvent.click(screen.getByTestId('review-bulk-toggle'));
    await waitFor(() => expect(screen.getByTestId('review-bulk').textContent).toContain('Similar found — none selected'), { timeout: 10_000 });
    expect(screen.getByTestId('review-bulk').textContent).not.toContain('0 similar');
    fireEvent.click(screen.getByTestId('review-bulk-toggle'));
    await waitFor(() => expect(screen.getByTestId('review-bulk').textContent).toContain('Also apply to 1 similar'), { timeout: 10_000 });
  }, 15_000);

  it('NO restrictions on a split: even the same special kind twice lands (#126 r7)', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    await openSplitEditor();
    fireEvent.click(screen.getByTestId('split-add-row'));
    const amount0 = (await screen.findByTestId('split-amount-0')) as HTMLInputElement;
    fireEvent.focus(amount0);
    fireEvent.change(amount0, { target: { value: '6,00' } });
    fireEvent.blur(amount0);
    fireEvent.click(await screen.findByTestId('split-remainder'));
    await waitFor(() => expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('split-save'));

    await screen.findByTestId('review-part-deck');
    fireEvent.click(screen.getByTestId('deck-part-1'));
    fireEvent.click(await screen.findByTestId('deck-cat-1'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await screen.findByTestId('counter-accounts');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('deck-cat-1').textContent).toContain('Set aside'));

    // the same pick on part 0: a repeat is allowed, no warning
    fireEvent.click(screen.getByTestId('deck-part-0'));
    fireEvent.click(await screen.findByTestId('deck-cat-0'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-0'));
    fireEvent.click((await screen.findAllByTestId('catpicker-savingDeposit')).at(-1)!);
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('deck-cat-0').textContent).toContain('Set aside'));
    await waitFor(() => expect((screen.getByTestId('review-confirm-btn') as HTMLButtonElement).disabled).toBe(false));
  }, 15_000);

  it('a split holds MORE than two parts: pct rows seed the leftover, Done stays armed, the stepper walks the stack (#126 r6)', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    await openSplitEditor();
    fireEvent.click(screen.getByTestId('split-mode-pct'));
    const amount0 = (await screen.findByTestId('split-amount-0')) as HTMLInputElement;
    fireEvent.focus(amount0);
    fireEvent.change(amount0, { target: { value: '50' } });
    fireEvent.blur(amount0);
    // every added row seeds the remaining PERCENTAGE, not a '0,00' euro text
    fireEvent.click(screen.getByTestId('split-add-row'));
    await waitFor(() => expect((screen.getByTestId('split-amount-1') as HTMLInputElement).value).toBe('50'));
    const amount1 = screen.getByTestId('split-amount-1') as HTMLInputElement;
    fireEvent.focus(amount1);
    fireEvent.change(amount1, { target: { value: '30' } });
    fireEvent.blur(amount1);
    fireEvent.click(screen.getByTestId('split-add-row'));
    await waitFor(() => expect((screen.getByTestId('split-amount-2') as HTMLInputElement).value).toBe('20'));
    // three parts, two uncategorized: the shared placeholder must not jam Done
    await waitFor(() => expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('split-save'));

    await screen.findByTestId('review-part-deck');
    await screen.findByTestId('deck-label-0');
    fireEvent.click(screen.getByTestId('deck-part-2'));
    await screen.findByTestId('deck-label-2');
    fireEvent.click(screen.getByTestId('deck-part-1'));
    await screen.findByTestId('deck-label-1');

    // Confirm stays tappable while parts are uncategorized: the tap writes nothing and marks the offenders
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await screen.findByTestId('deck-attention');
    await screen.findByTestId('deck-attn-1');
    await screen.findByTestId('deck-attn-2');
    expect(screen.queryByTestId('deck-attn-0')).toBeNull();
    await screen.findByTestId('review-card');

    fireEvent.click(await screen.findByTestId('deck-cat-1'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-coffee'));
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.queryByTestId('deck-attn-1')).toBeNull());

    fireEvent.click(screen.getByTestId('deck-part-2'));
    await screen.findByTestId('deck-label-2');
    fireEvent.click(screen.getByTestId('deck-cat-2'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect((screen.getByTestId('review-confirm-btn') as HTMLButtonElement).disabled).toBe(false));
  }, 15_000);

  it('a part spreads its own money across several categories from the deck (#126 r6)', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    await openSplitEditor();
    const amount0 = (await screen.findByTestId('split-amount-0')) as HTMLInputElement;
    fireEvent.focus(amount0);
    fireEvent.change(amount0, { target: { value: '6,00' } });
    fireEvent.blur(amount0);
    fireEvent.click(screen.getByTestId('split-add-row'));
    await waitFor(() => expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('split-save'));

    await screen.findByTestId('review-part-deck');
    fireEvent.click(await screen.findByTestId('deck-cat-0'));
    await screen.findByTestId('part-cats-editor');

    // a full-owning row converts between euros and percentages round-trip without drift
    fireEvent.click(screen.getByTestId('part-cat-mode-pct'));
    await waitFor(() => expect((screen.getByTestId('part-cat-amount-0') as HTMLInputElement).value).toBe('100'));
    fireEvent.click(screen.getByTestId('part-cat-mode-amount'));
    await waitFor(() => expect((screen.getByTestId('part-cat-amount-0') as HTMLInputElement).value).toBe('6,00'));

    fireEvent.click(screen.getByTestId('part-cat-add'));
    fireEvent.click(await screen.findByTestId('part-cat-1'));
    fireEvent.click(await screen.findByTestId('catpicker-coffee'));
    const spread0 = screen.getByTestId('part-cat-amount-0') as HTMLInputElement;
    fireEvent.focus(spread0);
    fireEvent.change(spread0, { target: { value: '2,00' } });
    fireEvent.blur(spread0);
    fireEvent.click(await screen.findByTestId('part-cat-remainder'));
    await waitFor(() => expect((screen.getByTestId('part-cat-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    // #217: the deck shows each category as its own row, value included
    await waitFor(() => expect(screen.getByTestId('deck-cat-0-1').textContent).toContain('Coffee'));
    expect(screen.getByTestId('deck-cat-0-1').textContent).toMatch(/4[.,]00/);
    expect(screen.getByTestId('deck-cat-0').textContent).toMatch(/2[.,]00/);
  }, 15_000);

  it('#133 r3: a ◆ Transfer pick on a PART stages nothing until its mandatory ask answers; dismissal rolls back', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    await openSplitEditor();
    const amount0 = (await screen.findByTestId('split-amount-0')) as HTMLInputElement;
    fireEvent.focus(amount0);
    fireEvent.change(amount0, { target: { value: '6,00' } });
    fireEvent.blur(amount0);
    fireEvent.click(screen.getByTestId('split-add-row'));
    await waitFor(() => expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('split-save'));
    await screen.findByTestId('review-part-deck');
    const catBefore = screen.getByTestId('deck-cat-0').textContent;

    // the mandatory ask opens on the pick, nothing patched; #546: no default account answers; walking away rolls the entry back
    fireEvent.click(await screen.findByTestId('deck-cat-0'));
    fireEvent.click((await screen.findAllByTestId('part-cat-0')).at(-1)!);
    fireEvent.click((await screen.findAllByTestId('catpicker-transferOut')).at(-1)!);
    await screen.findByTestId('counter-accounts');
    expect(screen.queryByTestId('counter-default')).toBeNull();
    expect(screen.queryByTestId('counter-pick-demo_save')).toBeNull(); // the pot is not a transfer counter (#133)
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getAllByTestId('part-cat-save').at(-1)!);
    await waitFor(() => expect(screen.getByTestId('deck-cat-0').textContent).toBe(catBefore));

    fireEvent.click(screen.getByTestId('deck-cat-0'));
    fireEvent.click(screen.getAllByTestId('part-cat-0').at(-1)!);
    fireEvent.click((await screen.findAllByTestId('catpicker-transferOut')).at(-1)!);
    fireEvent.click(await screen.findByTestId('counter-full-setup'));
    fireEvent.click(await screen.findByTestId('chooser-manual'));
    fireEvent.click(await screen.findByTestId('chooser-accttype-checking'));
    fireEvent.change(await screen.findByTestId('chooser-acctform-name'), { target: { value: 'Second checking' } });
    fireEvent.change(screen.getByTestId('chooser-acctform-balance'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('chooser-acctform-save'));
    await waitFor(() => expect((screen.getAllByTestId('part-cat-save').at(-1)! as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(screen.getAllByTestId('part-cat-save').at(-1)!);
    await waitFor(() => expect(screen.getByTestId('deck-cat-0').textContent).toContain('Transfer Out'));
    await waitFor(() => expect(screen.getByTestId('deck-counter-0').textContent).toContain('Second checking'));
    expect(screen.queryByTestId('deck-cat-counter-0-0')).toBeNull();
    // #133: the row's door asks within the transfer's account types
    // sheets stay mounted in tests, so the door's list is the one the tap adds
    const asked = new Set(screen.getAllByTestId('counter-accounts'));
    fireEvent.click(screen.getByTestId('deck-counter-0'));
    await waitFor(() => expect(screen.getAllByTestId('counter-accounts')).toHaveLength(asked.size + 1));
    const door = screen.getAllByTestId('counter-accounts').find((list) => !asked.has(list))!;
    await waitFor(() => expect(door.textContent).toContain('Second checking'));
    expect(door.querySelector('[data-testid="counter-pick-demo_save"]')).toBeNull();
  }, 15_000);

  it('splitting warns first — the reset waits for the editor\'s Done; cancelling keeps the staged picks (#126 r7, #330)', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-splitreset'), { trackOutbox: false });
    await repo.upsert('recurring', DEMO_SPACE_ID, 'rec-yoga', {
      name: 'Yoga studio', kind: 'subscription', amountCents: 2500, every: 'month', dueDay: 3, active: 1, merchantKey: 'yoga',
    });
    db.close();
    fireEvent.click(await screen.findByTestId('review-category-chip'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(screen.getByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-coffee'));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('review-category-chip').textContent).toContain('Coffee'));
    fireEvent.click(screen.getByTestId('review-recurring-row'));
    fireEvent.click(await screen.findByTestId('recpick-rec-yoga', {}, { timeout: 10_000 }));
    await waitFor(() => expect(screen.getByTestId('review-recurring-row').textContent).toContain('Yoga studio'));

    fireEvent.click(screen.getByTestId('review-split-row'));
    await screen.findByTestId('split-reset-continue');
    fireEvent.click(screen.getByTestId('split-reset-cancel'));
    expect(screen.queryByTestId('split-label-0')).toBeNull();

    // #330: the reset waits for Done: Escape keeps category and recurring as staged
    // test sheets stay mounted, so the card's rows are the signal
    fireEvent.click(screen.getByTestId('review-split-row'));
    fireEvent.click(await screen.findByTestId('split-reset-continue'));
    await screen.findByTestId('split-label-0');
    expect(screen.getByTestId('review-category-chip').textContent).toContain('Coffee');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('review-category-chip').textContent).toContain('Coffee');
    expect(screen.getByTestId('review-recurring-row').textContent).toContain('Yoga studio');
    expect(screen.queryByTestId('review-part-deck')).toBeNull();

    fireEvent.click(screen.getByTestId('review-split-row'));
    fireEvent.click(await screen.findByTestId('split-reset-continue'));
    await screen.findByTestId('split-label-0');
    fireEvent.click(screen.getByTestId('split-save'));
    // the seeded category stays as the collapse's shape while the staged recurring link is reversed
    await waitFor(() => expect(screen.getByTestId('review-recurring-row').textContent).not.toContain('Yoga studio'));
    expect(screen.getByTestId('review-category-chip').textContent).toContain('Coffee');

    // the collapse left a staged category, so the warning asks once more; the arm rides through to this Done
    fireEvent.click(screen.getByTestId('review-split-row'));
    fireEvent.click(await screen.findByTestId('split-reset-continue'));
    fireEvent.click(await screen.findByTestId('split-add-row'));
    const amount0 = (await screen.findByTestId('split-amount-0')) as HTMLInputElement;
    fireEvent.focus(amount0);
    fireEvent.change(amount0, { target: { value: '6,00' } });
    fireEvent.blur(amount0);
    fireEvent.click(await screen.findByTestId('split-remainder'));
    await waitFor(() => expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('split-save'));
    await screen.findByTestId('review-part-deck');
  }, 20_000);

  it('#330 r2 (user): the FIRST split press warns when the card only wears its ROW category — and stays silent on a bare card', async () => {
    // #330: the category came with the ROW (imported/predicted fill), nothing user-staged: the first press must warn
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('splitwarn'), { trackOutbox: false });
    // a story-less card dated OLDEST: uncategorized, no counterparty, no note, the one shape that opens directly
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'bare-split', {
      accountId: 'demo_main', date: '2020-01-01', amountCents: -1000, currency: 'EUR',
      merchant: 'Storyless Stall', catId: 'uncategorized', needsReview: 1,
    });
    seed.close();
    cleanup();
    renderApp('/review');
    await screen.findByTestId('review-card');

    await waitFor(() => expect(screen.getByTestId('review-card').textContent).toContain('Storyless Stall'), { timeout: 10_000 });
    fireEvent.click(await screen.findByTestId('review-split-row'));
    await screen.findByTestId('split-editor');
    expect(screen.queryByTestId('split-reset-continue')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.click(screen.getByTestId('review-skip-btn'));
    await waitFor(() => expect(screen.getByTestId('review-card').textContent).not.toContain('Storyless Stall'), { timeout: 10_000 });

    // the earlier card's editor stays mounted in tests, so the warning sheet's own button is the signal
    fireEvent.click(screen.getByTestId('review-split-row'));
    await screen.findByTestId('split-reset-continue', {}, { timeout: 10_000 });

    fireEvent.click(screen.getByTestId('split-reset-cancel'));
    expect(screen.getByTestId('review-category-chip').textContent).toContain('Hobby');
  }, 25_000);

  it('the pill fills the FOCUSED field even though its blur restores the stash first (#130 r2)', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    await openSplitEditor();
    fireEvent.click(screen.getByTestId('split-add-row'));
    fireEvent.click(screen.getByTestId('split-mode-pct'));
    const amount1 = (await screen.findByTestId('split-amount-1')) as HTMLInputElement;
    fireEvent.focus(amount1);
    fireEvent.change(amount1, { target: { value: '50' } });
    fireEvent.blur(amount1);
    // focusing row 0 empties it (stash holds 100); pointerdown arms the pill, blur restores 100
    // the click must still fill THIS row (#130)
    const amount0 = screen.getByTestId('split-amount-0') as HTMLInputElement;
    fireEvent.focus(amount0);
    // the empty-for-typing lands one frame after focus (#134 iOS fix)
    await waitFor(() => expect(amount0.value).toBe(''));
    const pill = await screen.findByTestId('split-remainder');
    fireEvent.pointerDown(pill);
    fireEvent.blur(amount0);
    expect(amount0.value).toBe('100'); // the stash restore — the old trap
    fireEvent.click(pill);
    await waitFor(() => expect((screen.getByTestId('split-amount-0') as HTMLInputElement).value).toBe('50'));
    expect((screen.getByTestId('split-amount-1') as HTMLInputElement).value).toBe('50');
  });

  it('the left-to-assign pill fills the EMPTY row, not the last one (#130)', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    await openSplitEditor();
    fireEvent.click(screen.getByTestId('split-add-row'));
    fireEvent.click(screen.getByTestId('split-mode-pct'));
    const amount0 = (await screen.findByTestId('split-amount-0')) as HTMLInputElement;
    fireEvent.focus(amount0);
    fireEvent.change(amount0, { target: { value: '0' } });
    fireEvent.blur(amount0);
    const amount1 = (await screen.findByTestId('split-amount-1')) as HTMLInputElement;
    fireEvent.focus(amount1);
    fireEvent.change(amount1, { target: { value: '50' } });
    fireEvent.blur(amount1);
    fireEvent.click(await screen.findByTestId('split-remainder'));
    await waitFor(() => expect((screen.getByTestId('split-amount-0') as HTMLInputElement).value).toBe('50'));
    expect((screen.getByTestId('split-amount-1') as HTMLInputElement).value).toBe('50');
    expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a lone 50% row holds Done — the partition must always add up (#126 r3)', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    await openSplitEditor();
    fireEvent.click(screen.getByTestId('split-mode-pct'));
    const amount0 = (await screen.findByTestId('split-amount-0')) as HTMLInputElement;
    fireEvent.focus(amount0);
    fireEvent.change(amount0, { target: { value: '50' } });
    fireEvent.blur(amount0);
    // #195: Done stays tappable, the tap refuses in place
    fireEvent.click(screen.getByTestId('split-save'));
    expect(screen.getByTestId('split-editor')).toBeTruthy();
    expect(screen.getByTestId('split-save').getAttribute('aria-invalid')).toBe('true');
    fireEvent.focus(amount0);
    fireEvent.change(amount0, { target: { value: '100' } });
    fireEvent.blur(amount0);
    await waitFor(() => expect(screen.getByTestId('split-save').getAttribute('aria-invalid')).toBe('false'));
  });

  it('splitting stays on the card; amounts clear on focus and restore on blur', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');

    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-split'), { trackOutbox: false });
    const iso = '2020-03-01'; // oldest-first queue: an old date makes this the CURRENT card
    await repo.upsert('transaction', DEMO_SPACE_ID, 'tx-split', {
      accountId: 'demo_main',
      date: iso,
      amountCents: -1000,
      currency: 'EUR',
      merchant: 'SPLITCAFE',
      description: 'A very long remittance line that identifies this charge beyond two clamped lines of text',
      catId: 'groceries',
      needsReview: 1,
    });
    await waitFor(() => expect(screen.getByTestId('review-card').textContent).toContain('SPLITCAFE'), { timeout: 5000 });

    // the clamp lives on the inner span: display on the button itself killed -webkit-box
    const desc = screen.getByTestId('review-description');
    expect(screen.getByTestId('review-description-text').className).toContain('line-clamp-2');
    fireEvent.click(desc);
    // waitFor: under coverage instrumentation the expand re-render can lag the click
    await waitFor(() => expect(screen.getByTestId('review-description-text').className).not.toContain('line-clamp-2'));

    fireEvent.click(screen.getByTestId('review-category-chip'));
    await screen.findByTestId('part-cats-editor');
    fireEvent.click(await screen.findByTestId('part-cat-add'));
    // the fresh entry is uncategorized + 0: no third until it is done
    await screen.findByTestId('part-cat-amount-1');
    expect((screen.getByTestId('part-cat-add') as HTMLButtonElement).disabled).toBe(true);
    const amount0 = (await screen.findByTestId('part-cat-amount-0')) as HTMLInputElement;
    expect(amount0.value).toBe('10,00');

    // focus empties the field one frame later (#134 iOS fix); a blank blur restores
    fireEvent.focus(amount0);
    await waitFor(() => expect(amount0.value).toBe(''));
    fireEvent.blur(amount0);
    expect(amount0.value).toBe('10,00');

    fireEvent.focus(amount0);
    fireEvent.change(amount0, { target: { value: '6,00' } });
    fireEvent.blur(amount0);
    fireEvent.click(await screen.findByTestId('part-cat-remainder'));
    fireEvent.click(screen.getByTestId('part-cat-1'));
    fireEvent.click(await screen.findByTestId('catpicker-coffee'));
    fireEvent.click(screen.getByTestId('part-cat-save'));

    // the spread stages: one row per category, no part deck (not a split), recurring/event affordances stay
    await waitFor(() => expect(screen.getByTestId('review-cat-coffee')).toBeTruthy());
    expect(screen.getByTestId('review-cat-groceries')).toBeTruthy();
    expect(screen.queryByTestId('review-part-deck')).toBeNull();
    expect(screen.getByTestId('review-event-row')).toBeTruthy();
    expect(screen.getByTestId('review-card').textContent).toContain('SPLITCAFE');
    expect((await db.transactions.get('tx-split'))?.cats).toBeUndefined();

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(async () => {
      const row = await db.transactions.get('tx-split');
      expect(row?.cats).toEqual([
        { catId: 'groceries', amountCents: 600 },
        { catId: 'coffee', amountCents: 400 },
      ]);
      expect(row?.splits ?? undefined).toBeUndefined();
      expect(row?.catId).toBe('groceries');
      expect(row?.needsReview).toBe(0);
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('#133 r4: a ◆ pick answered with a REAL pot keeps its family category — the link tells the movement', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');

    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-coffee'));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('review-category-chip').textContent).toContain('Coffee'));
    expect((screen.getByTestId('review-confirm-btn') as HTMLButtonElement).disabled).toBe(false);

    // the person's category stays the story; the link makes it a movement
    // the view derives transfer from the real counterparty
    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    await screen.findByTestId('counter-accounts');
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    await waitFor(() => expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBe('demo_save'));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('review-category-chip').textContent).toContain('Set aside'));
    await waitFor(() => expect(screen.getByTestId('review-counter-row').textContent).toContain('Demo Savings'));
    expect((screen.getByTestId('review-confirm-btn') as HTMLButtonElement).disabled).toBe(false);
  }, 15_000);

  it('skip moves on and the skipped pile can be revisited', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');
    const firstMerchant = screen.getByTestId('review-card').textContent;

    fireEvent.click(screen.getByTestId('review-skip-btn'));
    await waitFor(() => expect(screen.getByTestId('review-card').textContent).not.toBe(firstMerchant));

    fireEvent.click(screen.getByTestId('review-skip-btn'));
    fireEvent.click(screen.getByTestId('review-skip-btn'));
    const note = await screen.findByTestId('review-skipped-note');
    expect(note.textContent).toContain('3');
    fireEvent.click(screen.getByTestId('review-reset-skipped'));
    expect(await screen.findByTestId('review-card')).toBeTruthy();

    // leaving review and coming back starts the deck from the top: skips are per-visit, not per-session
    fireEvent.click(screen.getByTestId('review-skip-btn'));
    cleanup();
    renderApp('/review');
    await waitFor(() => expect(screen.getByTestId('review-card').textContent).toBe(firstMerchant));
  }, 15_000);
});

// eslint-disable-next-line vitest/no-identical-title -- separate identity
describe('ReviewScreen (user identity, split settlements)', () => {
  it('an incoming amount matching an open settlement offers the transfer chip (SP5)', async () => {
    const { USER_TEST_DB, renderAppAsUser } = await import('@/test/harness');
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);

    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed'), { trackOutbox: false });
    await repo.upsert('transaction', 's-user', 'tx-in', {
      accountId: 'a1', date: '2026-07-16', amountCents: 1500, currency: 'EUR',
      merchant: 'A. FRIEND', needsReview: 1,
    });
    db.close();

    const ME = '11111111-1111-1111-1111-111111111111';
    const ANNA = '22222222-2222-2222-2222-222222222222';
    renderAppAsUser('/review', {
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: {}, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }),
        'GET /splits': () => [
          { id: 'split-1', name: 'Barcelona', currency: 'EUR', status: 'open', role: 'owner', state: 'active', memberCount: 2, entryCount: 1 },
        ],
        'GET /splits/split-1': () => ({
          split: { id: 'split-1', name: 'Barcelona', currency: 'EUR', status: 'open', role: 'owner', state: 'active' },
          members: [
            { userId: ME, role: 'owner', state: 'active', displayName: 'Me', isMe: true },
            { userId: ANNA, role: 'contributor', state: 'active', displayName: 'Anna', isMe: false },
          ],
          entries: [{
            id: 'e-settle', kind: 'settlement', paidByUserId: ANNA, description: 'settlement',
            amountCents: 1500, date: '2026-07-16', shareMode: 'exact',
            shares: [{ userId: ME, cents: 1500 }], createdBy: ANNA,
          }],
          payments: [],
          requests: null,
          friendInvites: null,
        }),
      },
    });

    const chip = await screen.findByTestId('review-settle-match');
    expect(chip.textContent).toContain('Anna');
    expect(chip.textContent).toContain('Barcelona');

    fireEvent.click(chip);
    // a settlement is money from a person and transfer is strictly account-to-account (R2)
    // so the chip stages received reimbursement
    await waitFor(() =>
      expect((screen.getByTestId('review-confirm-btn') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(async () => {
      const check = new MunniDB(USER_TEST_DB);
      const tx = await check.transactions.get('tx-in');
      check.close();
      expect(tx).toMatchObject({ catId: 'reimburse', needsReview: 0 });
    });
  }, 15_000);
});

describe('ReviewScreen (own-account transfers)', () => {
  it('a counterparty IBAN that is MY OWN account pre-marks the card as transfer', async () => {
    const { USER_TEST_DB, renderAppAsUser } = await import('@/test/harness');
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);

    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed'), { trackOutbox: false });
    await repo.upsert('account', 's-user', 'acct-cc', {
      name: 'Credit card', type: 'credit', source: 'manual', currency: 'EUR',
      iban: 'NL91 ABNA 0417 1643 00',
    });
    await repo.upsert('transaction', 's-user', 'tx-topup', {
      accountId: 'acct-main', date: '2026-07-16', amountCents: -50000, currency: 'EUR',
      merchant: 'CREDITCARD TOPUP', needsReview: 1,
      counterIban: 'NL91ABNA0417164300', // same IBAN, bank formatting differs
    });
    db.close();

    renderAppAsUser('/review', {
      api: { 'GET /health': () => ({ status: 'ok', capabilities: {}, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }) },
    });

    await waitFor(() => expect(screen.getByTestId('review-counter-row').textContent).toContain('Credit card'));
    expect(screen.queryByTestId('review-own-transfer')).toBeNull();
    expect(screen.queryByTestId('review-cat-counter-transferOut')).toBeNull();

    await waitFor(() =>
      expect((screen.getByTestId('review-confirm-btn') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(async () => {
      const check = new MunniDB(USER_TEST_DB);
      const tx = await check.transactions.get('tx-topup');
      check.close();
      // a credit counter-account makes a transfer between own accounts
      expect(tx).toMatchObject({ linkedAccountId: 'acct-cc', needsReview: 0 });
    });
  }, 15_000);

  it('#218: the DETACH door opts back out of the auto-transfer — and frees the category choice', async () => {
    const { USER_TEST_DB, renderAppAsUser } = await import('@/test/harness');
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);

    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed'), { trackOutbox: false });
    await repo.upsert('account', 's-user', 'acct-cc', {
      name: 'Credit card', type: 'credit', source: 'manual', currency: 'EUR', iban: 'NL91ABNA0417164300',
    });
    await repo.upsert('transaction', 's-user', 'tx-topup', {
      accountId: 'acct-main', date: '2026-07-16', amountCents: -50000, currency: 'EUR',
      merchant: 'CREDITCARD TOPUP', needsReview: 1, counterIban: 'NL91ABNA0417164300',
    });
    db.close();

    renderAppAsUser('/review', {
      api: { 'GET /health': () => ({ status: 'ok', capabilities: {}, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }) },
    });

    await waitFor(() => expect(screen.getByTestId('review-counter-row').textContent).toContain('Credit card'));
    fireEvent.click(screen.getByTestId('review-category-chip'));
    await screen.findByTestId('part-cats-editor');
    // #218: with a credit counter attached the picker narrows to transfer or debt payment
    fireEvent.click(screen.getByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-loanRepayment');
    expect(screen.queryByTestId('catpicker-groceries')).toBeNull();
    fireEvent.click(screen.getByTestId('catpicker-loanRepayment'));
    await waitFor(() => expect(screen.getByTestId('part-cat-0').textContent).toContain('Repaid'));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('review-counter-row').textContent).toContain('Credit card'));
    // removing the counterparty resets the category and frees the full picker (#228)
    fireEvent.click(screen.getByTestId('review-counter-row'));
    fireEvent.click(await screen.findByTestId('counter-detach'));
    await waitFor(() => expect(screen.getByTestId('review-counter-row').textContent).toContain('No counter account'));
    await waitFor(() => expect(screen.getByTestId('review-category-chip').textContent).not.toContain('Repaid'));
    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-groceries'));
    fireEvent.click(screen.getByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('review-category-chip').textContent).toContain('Other · Groceries'));
  }, 15_000);
});

describe('the receipt on the review card (user 2026-10-06)', () => {
  const AMAZON = 'rcpt:amazon-nl:demo_conn_amz:a1';
  const COOLBLUE = 'rcpt:coolblue:demo_conn_cb:c1';
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  async function seedShopsAndCard() {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('revauto'), { trackOutbox: false });
    const { DEMO_STORE_FEED_ID } = await import('@/application/storeFeed');
    const { storeConnLinkId } = await import('@/domain/feedIds');
    await seedRepo.upsert('storeConnLink', DEMO_SPACE_ID, storeConnLinkId(DEMO_SPACE_ID, 'demo_conn_amz'), { instanceId: 'demo_conn_amz', store: 'amazon-nl', displayName: 'Amazon' });
    await seedRepo.upsert('storeConnLink', DEMO_SPACE_ID, storeConnLinkId(DEMO_SPACE_ID, 'demo_conn_cb'), { instanceId: 'demo_conn_cb', store: 'coolblue', displayName: 'Coolblue' });
    await seedRepo.upsert('receipt', DEMO_STORE_FEED_ID, 'rcpt:amazon-nl:demo_conn_amz:a1', { source: 'amazon-nl', instanceId: 'demo_conn_amz', date: '2026-01-09', totalCents: 5956, merchant: 'Amazon.nl' });
    await seedRepo.upsert('receipt', DEMO_STORE_FEED_ID, 'rcpt:coolblue:demo_conn_cb:c1', { source: 'coolblue', instanceId: 'demo_conn_cb', date: '2026-01-06', totalCents: 5798, merchant: 'Coolblue' });
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'ra1', {
      accountId: 'demo_main', date: '2026-01-10', amountCents: -5956, currency: 'EUR', merchant: 'Amzn Mktp NL', catId: 'groceries', needsReview: 1,
    });
    seed.close();
    cleanup();
  }

  it('the best-matching receipt is suggested on the card and attached on confirm; the sheet searches every receipt and a pick replaces it', async () => {
    await seedShopsAndCard();
    renderApp('/review');
    await screen.findByTestId('review-card');
    // the oldest card first: the one the Amazon receipt fits to the cent, a day apart
    await waitFor(() => expect(screen.getByTestId('review-receipt-row').textContent).toContain('Amazon.nl'), { timeout: 5000 });
    expect(screen.getByTestId('review-receipt-row').textContent).toContain('suggested');

    fireEvent.click(screen.getByTestId('review-receipt-row'));
    await screen.findByTestId('review-receipt-sheet');
    expect(screen.getByTestId('review-receipt-pick-rcpt:amazon-nl:demo_conn_amz:a1').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('review-receipt-all-list').textContent).toContain('Coolblue');
    fireEvent.click(screen.getByTestId('review-receipt-party-coolblue'));
    expect(screen.queryByTestId('review-receipt-all-rcpt:amazon-nl:demo_conn_amz:a1')).toBeNull();
    fireEvent.change(screen.getByTestId('review-receipt-search'), { target: { value: '57,98' } });
    fireEvent.click(screen.getByTestId('review-receipt-all-rcpt:coolblue:demo_conn_cb:c1'));
    fireEvent.click(await screen.findByTestId('review-receipt-peek-attach'));
    await waitFor(() => expect(screen.getByTestId('review-receipt-row').textContent).toContain('Coolblue'));
    expect(screen.getByTestId('review-receipt-row').textContent).not.toContain('suggested');

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const links = await db.receiptLinks.toArray();
      expect(links.find((l) => l.txId === 'ra1')?.receiptId).toBe('rcpt:coolblue:demo_conn_cb:c1');
    }, { timeout: 8000 });
    db.close();
  }, 25_000);

  it('left alone, the suggestion is attached by the confirm; "No receipt" leaves the card without one', async () => {
    await seedShopsAndCard();
    renderApp('/review');
    await screen.findByTestId('review-card');
    await waitFor(() => expect(screen.getByTestId('review-receipt-row').textContent).toContain('suggested'), { timeout: 5000 });
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const links = await db.receiptLinks.toArray();
      expect(links.find((l) => l.txId === 'ra1')?.receiptId).toBe('rcpt:amazon-nl:demo_conn_amz:a1');
    }, { timeout: 8000 });
    db.close();
  }, 25_000);

  it('a receipt that says the card’s own amount files it by its lines (#567): the card shows the split before the confirm, the confirm writes it and keeps the lines with the receipt', async () => {
    await seedShopsAndCard();
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('revfile'), { trackOutbox: false });
    const { DEMO_STORE_FEED_ID } = await import('@/application/storeFeed');
    const { receiptLinkId } = await import('@/domain/feedIds');
    // the Amazon receipt's lines — and an older receipt whose coffee beans the person filed under Coffee
    await seedRepo.upsert('receipt', DEMO_STORE_FEED_ID, AMAZON, {
      items: [
        { name: 'Koffiebonen 1 kg', totalCents: 4000 },
        { name: 'USB-C kabel', totalCents: 1956 },
      ],
    });
    await seedRepo.upsert('receiptLink', DEMO_SPACE_ID, 'older_receipt', {
      source: 'photo', date: '2025-12-01', totalCents: 4000, txId: 'dm101', auto: 0,
      items: [{ name: 'koffiebonen 1 KG', totalCents: 4000 }],
      picks: { dm101: [{ line: 0, catId: 'coffee', amountCents: 4000 }] },
    });
    seed.close();

    renderApp('/review');
    await screen.findByTestId('review-card');
    await waitFor(() => expect(screen.getByTestId('review-receipt-row').textContent).toContain('suggested'), { timeout: 5000 });
    // the beans as the person filed beans before, the cable under what the card suggested anyway
    await waitFor(() => expect(screen.getByTestId('review-cats').textContent).toMatch(/Coffee/));
    expect(screen.getByTestId('review-cats').textContent).toMatch(/Other/);

    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const tx = await db.transactions.get('ra1');
      expect(tx?.needsReview).toBe(0);
      expect(tx?.cats?.map(({ catId, amountCents }) => ({ catId, amountCents }))).toEqual([
        { catId: 'coffee', amountCents: 4000 },
        { catId: 'groceries', amountCents: 1956 },
      ]);
      const link = await db.receiptLinks.get(receiptLinkId(DEMO_SPACE_ID, AMAZON));
      expect(link?.txId).toBe('ra1');
      expect(link?.picks).toEqual({ ra1: [{ line: 0, catId: 'coffee', amountCents: 4000 }] });
    }, { timeout: 8000 });
    db.close();
  }, 25_000);

  it('"No receipt" on such a card leaves the filing out with the receipt (#567): the card’s own category is confirmed', async () => {
    await seedShopsAndCard();
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('revfile2'), { trackOutbox: false });
    const { DEMO_STORE_FEED_ID } = await import('@/application/storeFeed');
    await seedRepo.upsert('receipt', DEMO_STORE_FEED_ID, AMAZON, { items: [{ name: 'Koffiebonen 1 kg', totalCents: 5956, catId: 'coffee' }] });
    seed.close();

    renderApp('/review');
    await screen.findByTestId('review-card');
    await waitFor(() => expect(screen.getByTestId('review-cats').textContent).toMatch(/Coffee/), { timeout: 5000 });
    fireEvent.click(screen.getByTestId('review-receipt-row'));
    fireEvent.click(await screen.findByTestId('review-receipt-none'));
    await waitFor(() => expect(screen.getByTestId('review-cats').textContent).not.toMatch(/Coffee/));
    expect(screen.getByTestId('review-cats').textContent).toMatch(/Groceries/);
  }, 25_000);

  async function attachAmazonToCard() {
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('revatt'), { trackOutbox: false });
    const { receiptLinkId } = await import('@/domain/feedIds');
    await seedRepo.upsert('receiptLink', DEMO_SPACE_ID, receiptLinkId(DEMO_SPACE_ID, AMAZON), {
      receiptId: AMAZON, source: 'amazon-nl', instanceId: 'demo_conn_amz', date: '2026-01-09', totalCents: 5956, merchant: 'Amazon.nl', txId: 'ra1', auto: 0,
    });
    seed.close();
  }

  it('an attached receipt on the card (#496): the eye shows it in a sheet at once; the row opens the list with it first and one more, and a pick there swaps it on confirm', async () => {
    await seedShopsAndCard();
    await attachAmazonToCard();
    renderApp('/review');
    await screen.findByTestId('review-card');
    await waitFor(() => expect(screen.getByTestId('review-receipt-row').textContent).toContain('Amazon.nl'), { timeout: 5000 });

    fireEvent.click(screen.getByTestId('review-receipt-look'));
    await waitFor(() => expect(screen.getByTestId('review-receipt-look-head').textContent).toContain('Amazon.nl'));
    expect(screen.getByTestId('review-receipt-look-view-total').textContent).toMatch(/€[1-9]/);
    expect(screen.queryByTestId('review-receipt-look-attach')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.click(screen.getByTestId('review-receipt-row'));
    await screen.findByTestId('review-receipt-sheet');
    const suggestions = screen.getByTestId('review-receipt-pick-list').querySelectorAll('[data-testid$="-row"]');
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].getAttribute('data-testid')).toBe(`review-receipt-pick-${AMAZON}-row`);
    expect(screen.getByTestId(`review-receipt-pick-${AMAZON}`).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId(`review-receipt-pick-${COOLBLUE}`));
    fireEvent.click(await screen.findByTestId('review-receipt-peek-attach'));
    await waitFor(() => expect(screen.getByTestId('review-receipt-row').textContent).toContain('Coolblue'));

    // staged until the confirm, which swaps: Amazon is free again but never offered back to this payment
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const links = await db.receiptLinks.toArray();
      expect(links.find((l) => l.receiptId === COOLBLUE)?.txId).toBe('ra1');
      const amazon = links.find((l) => l.receiptId === AMAZON);
      expect(amazon?.txId ?? null).toBeNull();
      expect(amazon?.rejectedTxIds).toEqual(['ra1']);
    }, { timeout: 8000 });
    db.close();
  }, 25_000);

  it('"No receipt" on a card with an attached receipt lets it go on confirm (#496)', async () => {
    await seedShopsAndCard();
    await attachAmazonToCard();
    renderApp('/review');
    await screen.findByTestId('review-card');
    await waitFor(() => expect(screen.getByTestId('review-receipt-row').textContent).toContain('Amazon.nl'), { timeout: 5000 });
    fireEvent.click(screen.getByTestId('review-receipt-row'));
    fireEvent.click(await screen.findByTestId('review-receipt-none'));
    await waitFor(() => expect(screen.getByTestId('review-receipt-row').textContent).toContain('None'));
    expect(screen.queryByTestId('review-receipt-look')).toBeNull();
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const amazon = (await db.receiptLinks.toArray()).find((l) => l.receiptId === AMAZON);
      expect(amazon?.txId ?? null).toBeNull();
      expect(amazon?.rejectedTxIds).toEqual(['ra1']);
    }, { timeout: 8000 });
    db.close();
  }, 25_000);

  it('a bulk confirm walks the siblings’ receipts in turn (#495), the deck held until the walk is done', async () => {
    await seedShopsAndCard();
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('revwalk'), { trackOutbox: false });
    const { DEMO_STORE_FEED_ID } = await import('@/application/storeFeed');
    // a newer payment of the same shop, with a receipt of that shop that fits it to the cent (#650: another shop's would not be asked about)
    const SECOND = 'rcpt:amazon-nl:demo_conn_amz:a2';
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'ra2', {
      accountId: 'demo_main', date: '2026-01-11', amountCents: -5798, currency: 'EUR', merchant: 'Amzn Mktp NL', catId: 'groceries', needsReview: 1,
    });
    await seedRepo.upsert('receipt', DEMO_STORE_FEED_ID, SECOND, { source: 'amazon-nl', instanceId: 'demo_conn_amz', date: '2026-01-11', totalCents: 5798, merchant: 'Amazon.nl' });
    seed.close();
    renderApp('/review');
    await screen.findByTestId('review-card');
    await waitFor(() => expect(screen.getByTestId('review-receipt-row').textContent).toContain('Amazon.nl'), { timeout: 5000 });
    await screen.findByTestId('review-bulk', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('review-confirm-btn'));

    const context = await screen.findByTestId('receipt-queue-context', {}, { timeout: 8000 });
    expect(context.textContent).toContain('1/1');
    expect(screen.getByTestId('review-card').getAttribute('data-held')).toBe('1');
    fireEvent.click(screen.getByTestId(`receipt-queue-pick-${SECOND}`));
    fireEvent.click(await screen.findByTestId('receipt-queue-peek-attach'));
    await waitFor(() => expect(screen.queryByTestId('receipt-queue-context')).toBeNull(), { timeout: 5000 });
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const links = await db.receiptLinks.toArray();
      expect(links.find((l) => l.receiptId === AMAZON)?.txId).toBe('ra1');
      expect(links.find((l) => l.receiptId === SECOND)?.txId).toBe('ra2');
    }, { timeout: 8000 });
    db.close();
  }, 30_000);

  it('a receipt attached to another payment stays on the list and says where it sits (user 2026-10-08: several payments, one receipt)', async () => {
    await seedShopsAndCard();
    const seed = new MunniDB('munni_demo');
    const seedRepo = new Repo(new DexieBackend(seed), new HlcClock('revmulti'), { trackOutbox: false });
    const { receiptLinkId } = await import('@/domain/feedIds');
    // a reviewed payment already holds the Coolblue receipt
    await seedRepo.upsert('transaction', DEMO_SPACE_ID, 'rx0', { accountId: 'demo_main', date: '2026-01-06', amountCents: -5798, currency: 'EUR', merchant: 'Coolblue', catId: 'groceries', needsReview: 0 });
    await seedRepo.upsert('receiptLink', DEMO_SPACE_ID, receiptLinkId(DEMO_SPACE_ID, COOLBLUE), {
      receiptId: COOLBLUE, source: 'coolblue', instanceId: 'demo_conn_cb', date: '2026-01-06', totalCents: 5798, merchant: 'Coolblue', txId: 'rx0', auto: 0,
    });
    seed.close();

    renderApp('/review');
    await screen.findByTestId('review-card');
    await waitFor(() => expect(screen.getByTestId('review-receipt-row').textContent).toContain('Amazon.nl'), { timeout: 5000 });
    fireEvent.click(screen.getByTestId('review-receipt-row'));
    await screen.findByTestId('review-receipt-sheet');
    // an attached receipt is no suggestion but stays in the whole list with a note, still pickable for this card
    expect(screen.queryByTestId(`review-receipt-pick-${COOLBLUE}`)).toBeNull();
    const note = await screen.findByTestId(`review-receipt-all-${COOLBLUE}-attached`);
    expect(note.textContent).toContain('Attached to');
    expect(note.textContent).toContain('Coolblue');
    fireEvent.click(screen.getByTestId(`review-receipt-all-${COOLBLUE}`));
    fireEvent.click(await screen.findByTestId('review-receipt-peek-attach'));
    await waitFor(() => expect(screen.getByTestId('review-receipt-row').textContent).toContain('Coolblue'));
  }, 25_000);

  it('the confirm’s receipt rules (#496): with one attached a pick swaps it, None lets it go, untouched it stays; with none attached a proposal is accepted (its own receipt picked too) or turned down', async () => {
    const { AUTO_STAGE, markedReceiptId, receiptSettlement } = await import('./reviewReceipt');
    const r = (id: string) => ({ id, spaceId: 's', source: 'ah', date: '2026-01-01', totalCents: 100, deleted: 0 }) as import('@/db/types').ReceiptRow;
    const proposal = { id: 'link-p', receiptId: 'p', proposedTxId: 't' } as import('@/db/types').ReceiptLinkRow;
    const picked = (id: string) => ({ kind: 'picked' as const, receipt: r(id) });
    expect(receiptSettlement(AUTO_STAGE, r('a'), undefined, null)).toEqual({ kind: 'keep' });
    expect(receiptSettlement(picked('b'), r('a'), undefined, null)).toEqual({ kind: 'pick', receipt: r('b') });
    expect(receiptSettlement(picked('a'), r('a'), undefined, null)).toEqual({ kind: 'keep' });
    expect(receiptSettlement({ kind: 'none' }, r('a'), undefined, null)).toEqual({ kind: 'pick', receipt: null });
    expect(receiptSettlement(AUTO_STAGE, null, proposal, null)).toEqual({ kind: 'accept', proposal });
    expect(receiptSettlement(picked('p'), null, proposal, null)).toEqual({ kind: 'accept', proposal });
    expect(receiptSettlement(picked('b'), null, proposal, null)).toEqual({ kind: 'pick', receipt: r('b'), reject: proposal });
    expect(receiptSettlement({ kind: 'none' }, null, proposal, null)).toEqual({ kind: 'reject', proposal });
    expect(receiptSettlement({ kind: 'none' }, null, undefined, r('c'))).toEqual({ kind: 'keep' });
    expect(receiptSettlement(AUTO_STAGE, null, undefined, r('c'))).toEqual({ kind: 'pick', receipt: r('c') });
    expect(receiptSettlement(AUTO_STAGE, null, undefined, null)).toEqual({ kind: 'keep' });
    expect(markedReceiptId(picked('b'), 'a', 'c')).toBe('b');
    expect(markedReceiptId({ kind: 'none' }, 'a', 'c')).toBeNull();
    expect(markedReceiptId(AUTO_STAGE, 'a', 'c')).toBe('a');
    expect(markedReceiptId(AUTO_STAGE, null, 'c')).toBe('c');
    expect(markedReceiptId(AUTO_STAGE, null, null)).toBeNull();
  });
});
