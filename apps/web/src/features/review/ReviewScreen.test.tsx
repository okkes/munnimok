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
      .sort((a, b) => a.date.localeCompare(b.date))[0]; // oldest first (user rule)

    // the row opens the unified editor (user redesign); a single row
    // saves as a plain category
    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('split-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-coffee'));
    fireEvent.click(screen.getByTestId('split-save'));
    // staged, not yet written — the chip shows the choice
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

    // two more flagged charges from the same merchant as the first card;
    // oldest-first queue: bulk1 (2020) becomes the CURRENT card, bulk2 and
    // the demo row are its "similar" companions
    const db = new MunniDB('munni_demo');
    const repo = new Repo(db, new HlcClock('seed-rev'), { trackOutbox: false });
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
        txType: 'expense',
        needsReview: 1,
      });
    }

    // both extra rows must be visible AND selected before confirming
    await waitFor(
      () => expect(screen.getByTestId('review-bulk').textContent).toContain('2'),
      { timeout: 5000 },
    );
    // "View all" opens the sheet with the internally-scrollable list;
    // each row can expand into a read-only detail with the description
    fireEvent.click(screen.getByTestId('review-bulk-expand'));
    const bulkList = await screen.findByTestId('review-bulk-list');
    expect(bulkList.className).toContain('overflow-y-auto');
    // bulk1 IS the card now; bulk2 sits in the similar list
    expect(screen.getByTestId('review-bulk-bulk2')).toBeTruthy();
    // row tap (TxRow style now) opens the stacked read-only detail sheet
    fireEvent.click(screen.getByTestId('tx-row-bulk2'));
    await screen.findByTestId('review-bulk-detail');
    // select/unselect all lives inside the sheet
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
    const iso = '2020-03-01'; // oldest-first queue: an old date makes this the CURRENT card
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

  it('splitting stays on the card; amounts clear on focus and restore on blur', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');

    // a controlled newest card with a long description
    const db = new MunniDB('munni_demo');
    const repo = new Repo(db, new HlcClock('seed-split'), { trackOutbox: false });
    const iso = '2020-03-01'; // oldest-first queue: an old date makes this the CURRENT card
    await repo.upsert('transaction', DEMO_SPACE_ID, 'tx-split', {
      accountId: 'demo_main',
      date: iso,
      amountCents: -1000,
      currency: 'EUR',
      merchant: 'SPLITCAFE',
      description: 'A very long remittance line that identifies this charge beyond two clamped lines of text',
      catId: 'groceries',
      txType: 'expense',
      needsReview: 1,
    });
    await waitFor(() => expect(screen.getByTestId('review-card').textContent).toContain('SPLITCAFE'), { timeout: 5000 });

    // the full description shows on tap (clamped by default). The clamp
    // lives on the INNER span: display on the button itself killed
    // -webkit-box and the toggle never visually worked
    const desc = screen.getByTestId('review-description');
    expect(screen.getByTestId('review-description-text').className).toContain('line-clamp-2');
    fireEvent.click(desc);
    // waitFor: under coverage instrumentation the expand re-render can lag the click
    await waitFor(() => expect(screen.getByTestId('review-description-text').className).not.toContain('line-clamp-2'));

    // the category row opens the unified editor with ONE row (user
    // redesign) — a second row is added explicitly
    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('split-add-row'));
    const amount0 = (await screen.findByTestId('split-amount-0')) as HTMLInputElement;
    expect(amount0.value).toBe('10,00');

    // focus empties the field so typing replaces; blank blur restores
    fireEvent.focus(amount0);
    expect(amount0.value).toBe('');
    fireEvent.blur(amount0);
    expect(amount0.value).toBe('10,00');

    // 6,00 + auto-balanced 4,00 = a valid split
    fireEvent.focus(amount0);
    fireEvent.change(amount0, { target: { value: '6,00' } });
    fireEvent.blur(amount0);
    fireEvent.click(await screen.findByTestId('split-remainder'));
    fireEvent.click(screen.getByTestId('split-save'));

    // draft model (review redesign): saving the split STAGES it — the card
    // previews it in the unified category list, nothing is written yet
    await waitFor(() => expect(screen.getAllByTestId(/^review-cat-/).length).toBeGreaterThanOrEqual(2));
    expect(screen.getByTestId('review-card').textContent).toContain('SPLITCAFE');
    expect((await db.transactions.get('tx-split'))?.splits).toBeUndefined();

    // Confirm lands the whole draft in one write
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(async () => {
      const row = await db.transactions.get('tx-split');
      expect(row?.splits).toHaveLength(2);
      expect(row?.needsReview).toBe(0);
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('a type change that invalidates the staged category asks again (ruling)', async () => {
    renderApp('/review');
    await screen.findByTestId('review-card');

    // stage a deliberate category — the row opens the unified editor now
    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('split-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-coffee'));
    fireEvent.click(screen.getByTestId('split-save'));
    await waitFor(() => expect(screen.getByTestId('review-category-chip').textContent).toContain('Coffee'));
    expect((screen.getByTestId('review-confirm-btn') as HTMLButtonElement).disabled).toBe(false);

    // flip the type to one Coffee does not speak: the chip must ask again
    fireEvent.click(screen.getByTestId('review-type-row'));
    await screen.findByTestId('txtype-options');
    fireEvent.click(screen.getByTestId('txtype-saving'));
    await waitFor(() => expect(screen.getByTestId('review-category-chip').textContent).not.toContain('Coffee'));
    expect(screen.getByTestId('review-type-row').textContent).toContain('Saving');
    expect((screen.getByTestId('review-confirm-btn') as HTMLButtonElement).disabled).toBe(true);

    // nothing was written mid-flight: the tx still holds its own type
    const db = new MunniDB('munni_demo');
    const current = (await db.transactions.filter((t) => t.needsReview === 1).toArray())
      .sort((a, b) => a.date.localeCompare(b.date))[0]; // oldest first (user rule)
    expect(current.txType).not.toBe('saving');
    db.close();

    // a saving-compatible category re-arms Confirm
    fireEvent.click(screen.getByTestId('review-category-chip'));
    fireEvent.click(await screen.findByTestId('split-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    fireEvent.click(screen.getByTestId('split-save'));
    await waitFor(() => expect((screen.getByTestId('review-confirm-btn') as HTMLButtonElement).disabled).toBe(false));
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

// eslint-disable-next-line vitest/no-identical-title -- separate identity
describe('ReviewScreen (user identity, split settlements)', () => {
  it('an incoming amount matching an open settlement offers the transfer chip (SP5)', async () => {
    const { USER_TEST_DB, renderAppAsUser } = await import('@/test/harness');
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);

    // my local queue holds an incoming €15.00 needing review
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(db, new HlcClock('seed'), { trackOutbox: false });
    await repo.upsert('transaction', 's-user', 'tx-in', {
      accountId: 'a1', date: '2026-07-16', amountCents: 1500, currency: 'EUR',
      merchant: 'A. FRIEND', txType: 'income', needsReview: 1,
    });
    db.close();

    const ME = '11111111-1111-1111-1111-111111111111';
    const ANNA = '22222222-2222-2222-2222-222222222222';
    renderAppAsUser('/review', {
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: {} }),
        'GET /splits': () => [
          { id: 'split-1', name: 'Barcelona', currency: 'EUR', status: 'open', role: 'owner', memberCount: 2, entryCount: 1 },
        ],
        'GET /splits/split-1': () => ({
          id: 'split-1', name: 'Barcelona', currency: 'EUR', status: 'open', role: 'owner',
          members: [
            { userId: ME, role: 'owner', displayName: 'Me', isMe: true },
            { userId: ANNA, role: 'member', displayName: 'Anna', isMe: false },
          ],
          entries: [{
            id: 'e-settle', kind: 'settlement', paidByUserId: ANNA, description: 'Settlement',
            amountCents: 1500, date: '2026-07-16',
            shares: [{ userId: ME, cents: 1500 }], createdBy: ANNA,
          }],
        }),
      },
    });

    const chip = await screen.findByTestId('review-settle-match');
    expect(chip.textContent).toContain('Anna');
    expect(chip.textContent).toContain('Barcelona');

    fireEvent.click(chip);
    // the staged draft flips to transfer; confirming persists it
    await waitFor(() =>
      expect((screen.getByTestId('review-confirm-btn') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(async () => {
      const check = new MunniDB(USER_TEST_DB);
      const tx = await check.transactions.get('tx-in');
      check.close();
      expect(tx).toMatchObject({ txType: 'transfer', needsReview: 0 });
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
    const repo = new Repo(db, new HlcClock('seed'), { trackOutbox: false });
    await repo.upsert('account', 's-user', 'acct-cc', {
      name: 'Credit card', type: 'credit', source: 'manual', currency: 'EUR',
      iban: 'NL91 ABNA 0417 1643 00',
    });
    await repo.upsert('transaction', 's-user', 'tx-topup', {
      accountId: 'acct-main', date: '2026-07-16', amountCents: -50000, currency: 'EUR',
      merchant: 'CREDITCARD TOPUP', txType: 'expense', needsReview: 1,
      counterIban: 'NL91ABNA0417164300', // same IBAN, bank formatting differs
    });
    db.close();

    renderAppAsUser('/review', {
      api: { 'GET /health': () => ({ status: 'ok', capabilities: {} }) },
    });

    // the chip names my account and the draft is already a transfer
    const chip = await screen.findByTestId('review-own-transfer');
    expect(chip.textContent).toContain('Credit card');

    await waitFor(() =>
      expect((screen.getByTestId('review-confirm-btn') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(async () => {
      const check = new MunniDB(USER_TEST_DB);
      const tx = await check.transactions.get('tx-topup');
      check.close();
      // credit counter-account: a transfer between own accounts (user ruling)
      expect(tx).toMatchObject({ txType: 'transfer', linkedAccountId: 'acct-cc', needsReview: 0 });
    });
  }, 15_000);

  it('one tap opts back out of the auto-transfer', async () => {
    const { USER_TEST_DB, renderAppAsUser } = await import('@/test/harness');
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);

    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(db, new HlcClock('seed'), { trackOutbox: false });
    await repo.upsert('account', 's-user', 'acct-cc', {
      name: 'Credit card', type: 'credit', source: 'manual', currency: 'EUR', iban: 'NL91ABNA0417164300',
    });
    await repo.upsert('transaction', 's-user', 'tx-topup', {
      accountId: 'acct-main', date: '2026-07-16', amountCents: -50000, currency: 'EUR',
      merchant: 'CREDITCARD TOPUP', txType: 'expense', needsReview: 1, counterIban: 'NL91ABNA0417164300',
    });
    db.close();

    renderAppAsUser('/review', {
      api: { 'GET /health': () => ({ status: 'ok', capabilities: {} }) },
    });

    fireEvent.click(await screen.findByTestId('review-own-transfer'));
    await waitFor(() => expect(screen.queryByTestId('review-own-transfer')).toBeNull());
  }, 15_000);
});
