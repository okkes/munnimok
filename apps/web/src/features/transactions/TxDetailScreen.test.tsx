// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID } from '@/db/seed';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';

describe('TxDetailScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('opens a transaction from the list and shows its detail', async () => {
    renderApp('/transactions');
    const list = await screen.findByTestId('tx-list');
    await waitFor(() => expect(list.querySelector('[data-testid^="tx-row-"]')).toBeTruthy());
    fireEvent.click(list.querySelector('[data-testid^="tx-row-"]')!);

    expect(await screen.findByTestId('screen-tx-detail')).toBeTruthy();
    expect((await screen.findByTestId('tx-detail-amount')).textContent).toMatch(/€/);
    expect(screen.getByTestId('tx-detail-category-row')).toBeTruthy();
    expect(screen.getByTestId('tx-detail-type-row')).toBeTruthy();
  });

  it('a bogus tx id does not crash the screen', async () => {
    renderApp('/transactions/does-not-exist');
    // resolves to either the detail shell or a redirect back — must render something
    await waitFor(() => expect(document.body.textContent).not.toBe(''));
  });

  it('an expense attaches to a recurring cost and detaches again', async () => {
    renderApp('/transactions/dm6'); // dm6 is a demo expense
    await screen.findByTestId('screen-tx-detail');

    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-att'), { trackOutbox: false });
    await repo.upsert('recurring', DEMO_SPACE_ID, 'rec-gym', {
      name: 'Gym',
      kind: 'subscription',
      amountCents: 2499,
      every: 'month',
      dueDay: 10,
      active: 1,
    });

    fireEvent.click(await screen.findByTestId('tx-detail-recurring-row'));
    fireEvent.click(await screen.findByTestId('tx-recurring-rec-gym'));
    await waitFor(async () => expect((await db.transactions.get('dm6'))?.recurringId).toBe('rec-gym'), {
      timeout: 5000,
    });
    // the row now names the linked cost
    await waitFor(() => expect(screen.getByTestId('tx-detail-recurring-row').textContent).toContain('Gym'));

    fireEvent.click(screen.getByTestId('tx-detail-recurring-row'));
    fireEvent.click(await screen.findByTestId('tx-recurring-none'));
    await waitFor(async () => expect((await db.transactions.get('dm6'))?.recurringId).toBeFalsy(), { timeout: 5000 });
    db.close();
  }, 15_000);
});

describe('counterparty account number on the detail screen', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  const seedTx = async (counterIban: string, id: string) => {
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-cp'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, id, {
      accountId: 'demo_main',
      date: '2026-07-01',
      amountCents: -2500,
      currency: 'EUR',
      merchant: 'Counterparty Test',
      catId: 'groceries',
      txType: 'expense',
      needsReview: 0,
      counterIban,
    });
    db.close();
  };

  it('an unknown counterparty IBAN renders inside the editable row (user rule: pickable)', async () => {
    renderApp('/home'); // seed first, then navigate via a fresh render
    await screen.findByTestId('screen-home');
    await seedTx('NL99ELDR0000000042', 'tx-cp1');
    cleanup();
    renderApp('/transactions/tx-cp1');
    const row = await screen.findByTestId('tx-detail-counterparty-edit');
    expect(row.textContent).toContain('NL99ELDR0000000042');
    // tapping opens the Type sheet; the account picker stacks behind
    // its counterparty row (user redesign)
    fireEvent.click(row);
    fireEvent.click(await screen.findByTestId('txtype-counter-row'));
    expect(await screen.findByTestId('txtype-accounts')).toBeTruthy();
  }, 15_000);

  it('a counterparty matching an own account becomes a door with account info', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    // demo_save's IBAN, spaced differently — the join normalizes
    await seedTx('NL00DEMO0000000200', 'tx-cp2');
    cleanup();
    renderApp('/transactions/tx-cp2');
    const row = await screen.findByTestId('tx-detail-counterparty-row');
    expect(row.textContent).toContain('Demo Savings');

    fireEvent.click(row);
    const sheet = await screen.findByTestId('counterparty-sheet');
    expect(sheet.textContent).toContain('NL00 DEMO 0000 0002 00'); // the account's own IBAN
  }, 15_000);
});

describe('TxTypeSheet via detail (demo tx dm6, groceries expense)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('changing to a conflicting type clears the category and flags review', async () => {
    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('tx-detail-type-row'));
    await screen.findByTestId('txtype-options');
    fireEvent.click(screen.getByTestId('txtype-income'));
    // groceries only allows expense -> category falls back to uncategorized
    await waitFor(() => {
      expect(screen.getByTestId('tx-detail-type-row').textContent).toContain('Income');
      expect(screen.getByTestId('tx-detail-category-row').textContent).toContain('Uncategorized');
    });
  });

  it('linking a savings counter-account sets the type as an editable default', async () => {
    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('tx-detail-type-row'));
    // the account list stacks behind the counterparty row now
    fireEvent.click(await screen.findByTestId('txtype-counter-row'));
    fireEvent.click(await screen.findByTestId('txtype-linked-demo_save'));
    await waitFor(() => expect(screen.getByTestId('tx-detail-type-row').textContent).toContain('Saving'));

    // reopen: the account only SUGGESTS the type (user revision) — the
    // manual list stays usable and overriding keeps the link
    fireEvent.click(screen.getByTestId('tx-detail-type-row'));
    expect(await screen.findByTestId('txtype-default-note')).toBeTruthy();
    expect((screen.getByTestId('txtype-expense') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('txtype-transfer'));
    await waitFor(() => expect(screen.getByTestId('tx-detail-type-row').textContent).toContain('Transfer'));
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const tx = await db.transactions.get('dm6');
      expect(tx?.txType).toBe('transfer');
      expect(tx?.linkedAccountId).toBe('demo_save'); // link survived
    });
    db.close();

    // unlinking clears the suggestion note
    fireEvent.click(screen.getByTestId('tx-detail-type-row'));
    fireEvent.click(await screen.findByTestId('txtype-counter-row'));
    fireEvent.click(await screen.findByTestId('txtype-linked-none'));
    fireEvent.click(screen.getByTestId('tx-detail-type-row'));
    await waitFor(() => expect(screen.queryByTestId('txtype-default-note')).toBeNull());
  }, 15_000);
});

describe('ReimburseSection via detail (demo tx dm6, -€52.40)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('links a credit with a clamped partial amount, then unlinks it', async () => {
    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('reimb-add'));

    // pick the salary credit; the prefill is clamped to the expense (52,40)
    const picker = await screen.findByTestId('reimb-picker');
    await waitFor(() => expect(picker.querySelector('[data-testid^="reimb-pick-"]')).toBeTruthy());
    fireEvent.click(picker.querySelector('[data-testid^="reimb-pick-"]')!);
    const amountInput = (await screen.findByTestId('reimb-amount')) as HTMLInputElement;
    expect(amountInput.value).toBe('52,40');

    // link a partial 20,00 instead
    fireEvent.change(amountInput, { target: { value: '20,00' } });
    fireEvent.click(screen.getByTestId('reimb-save'));

    const summary = await screen.findByTestId('reimb-summary');
    expect(summary.textContent).toContain('€20.00');
    expect(summary.textContent).toContain('€52.40');
    // hero shows the net amount, gross struck through
    expect(screen.getByTestId('tx-detail-amount').textContent).toContain('-€32.40');
    expect(screen.getByTestId('tx-detail-gross').textContent).toContain('-€52.40');

    // physical rewrite (user rule): both sides' splits carry the NET truth
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const expense = await db.transactions.get('dm6');
      const creditId = expense?.reimbursements?.[0]?.txId;
      const credit = creditId ? await db.transactions.get(creditId) : undefined;
      expect(expense?.splits?.reduce((s, x) => s + x.amountCents, 0)).toBe(3240);
      expect(credit?.splits?.reduce((s, x) => s + x.amountCents, 0)).toBe((credit?.amountCents ?? 0) - 2000);
    });

    // unlink restores the original state
    await waitFor(() =>
      expect(screen.getByTestId('reimb-list').querySelector('[data-testid^="reimb-unlink-"]')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('reimb-list').querySelector('[data-testid^="reimb-unlink-"]')!);
    await waitFor(() => {
      expect(screen.queryByTestId('reimb-summary')).toBeNull();
      expect(screen.getByTestId('tx-detail-amount').textContent).toContain('-€52.40');
    });
    // the freed value lands on Uncategorized, not the original category (user rule)
    await waitFor(async () => {
      const expense = await db.transactions.get('dm6');
      expect(expense?.splits?.find((s) => s.catId === 'uncategorized')?.amountCents).toBe(2000);
      expect(expense?.splits?.reduce((s, x) => s + x.amountCents, 0)).toBe(5240);
    });
    db.close();
  });

  it('links an expense from the income side: the credit nets out and self-files as Reimbursement', async () => {
    // strip the salary's category so the self-filing rule may act
    const first = renderApp('/transactions/dm1');
    await screen.findByTestId('tx-detail-amount');
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await db.transactions.update('dm1', { catId: 'uncategorized', needsReview: 1 });
    db.close();
    first.unmount();

    renderApp('/transactions/dm1');
    fireEvent.click(await screen.findByTestId('reimb-add-out'));
    const picker = await screen.findByTestId('reimb-picker');
    await waitFor(() => expect(picker.querySelector('[data-testid^="reimb-pick-"]')).toBeTruthy());
    fireEvent.click(picker.querySelector('[data-testid^="reimb-pick-"]')!);
    // the prefill is already clamped to the expense's open remainder —
    // save it as-is (which expense is "most recent" is demo-data detail)
    await screen.findByTestId('reimb-amount');
    fireEvent.click(screen.getByTestId('reimb-save'));

    // hero shows what the salary is still worth, gross struck through
    await waitFor(() => expect(screen.getByTestId('tx-detail-gross').textContent).toContain('+€2,200.00'), { timeout: 5000 });
    expect(screen.getByTestId('tx-detail-amount').textContent).not.toContain('+€2,200.00');
    // …and the uncategorized credit filed itself as Reimbursement
    await waitFor(() => expect(screen.getByTestId('tx-detail-category-row').textContent).toContain('Reimbursement'));

    // unlinking from this side restores the full amount
    await waitFor(() =>
      expect(screen.getByTestId('reimb-reverse').querySelector('[data-testid^="reimb-unlink-out-"]')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('reimb-reverse').querySelector('[data-testid^="reimb-unlink-out-"]')!);
    await waitFor(() => expect(screen.getByTestId('tx-detail-amount').textContent).toContain('+€2,200.00'));
  }, 15_000);
});

describe('SplitEditorSheet via detail (demo tx dm6, -€52.40)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('splits across two categories with auto-balance, then clears the split', async () => {
    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('tx-detail-split'));
    await screen.findByTestId('split-editor');

    // shrink the first row: a remainder appears and blocks saving
    fireEvent.change(screen.getByTestId('split-amount-0'), { target: { value: '30,00' } });
    const remainder = await screen.findByTestId('split-remainder');
    expect(remainder.textContent).toContain('€22.40');
    expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(true);

    // give the second row a category, auto-balance the remainder, save
    fireEvent.click(screen.getByTestId('split-cat-1'));
    fireEvent.click(await screen.findByTestId('catpicker-restaurants'));
    fireEvent.click(screen.getByTestId('split-remainder'));
    await waitFor(() => expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('split-save'));

    // detail shows the split breakdown
    const splitsList = await screen.findByTestId('tx-detail-splits');
    expect(splitsList.textContent).toContain('€30.00');
    expect(splitsList.textContent).toContain('€22.40');

    // clear the split again
    fireEvent.click(screen.getByTestId('tx-detail-split'));
    fireEvent.click(await screen.findByTestId('split-clear'));
    await waitFor(() => expect(screen.queryByTestId('tx-detail-splits')).toBeNull());
  });

  it('percentage mode balances to 100 and stores materialized euro amounts', async () => {
    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('tx-detail-split'));
    await screen.findByTestId('split-editor');

    // a third row can be added and removed again
    fireEvent.click(screen.getByTestId('split-add-row'));
    fireEvent.click(await screen.findByTestId('split-remove-2'));

    // switch to % — the euro shape carries over (100 / 0)
    fireEvent.click(screen.getByTestId('split-mode-pct'));
    expect((screen.getByTestId('split-amount-0') as HTMLInputElement).value).toBe('100');

    // 60% leaves 40% open; auto-balance hands it to the last row
    fireEvent.change(screen.getByTestId('split-amount-0'), { target: { value: '60' } });
    const remainder = await screen.findByTestId('split-remainder');
    expect(remainder.textContent).toContain('40%');
    expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('split-cat-1'));
    fireEvent.click(await screen.findByTestId('catpicker-restaurants'));
    fireEvent.click(screen.getByTestId('split-remainder'));
    await waitFor(() => expect((screen.getByTestId('split-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('split-save'));

    // the detail shows euros: 60/40 of €52.40, exactly partitioned
    const splitsList = await screen.findByTestId('tx-detail-splits');
    expect(splitsList.textContent).toContain('€31.44');
    expect(splitsList.textContent).toContain('€20.96');

    // reopening restores percentage mode with the stored shares
    fireEvent.click(screen.getByTestId('tx-detail-split'));
    await screen.findByTestId('split-editor');
    await waitFor(() => expect((screen.getByTestId('split-amount-0') as HTMLInputElement).value).toBe('60'));
    expect((screen.getByTestId('split-amount-1') as HTMLInputElement).value).toBe('40');
  });
});

describe('bulk apply from the detail (user request)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('recategorizing offers to reach every same-merchant transaction, reviewed included', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-bulk'), { trackOutbox: false });
    for (const [id, needsReview] of [['blk-a', 0], ['blk-b', 1]] as const) {
      await repo.upsert('transaction', DEMO_SPACE_ID, id, {
        accountId: 'demo_main', date: '2026-06-01', amountCents: -900, currency: 'EUR',
        merchant: 'BULKSHOP BV', catId: 'groceries', txType: 'expense', needsReview,
      });
    }
    cleanup();

    renderApp('/transactions/blk-a');
    fireEvent.click(await screen.findByTestId('tx-detail-category-row'));
    fireEvent.click(await screen.findByTestId('catpicker-hobby'));

    // the offer names the ONE other BULKSHOP row (reviewed or not)
    const offer = await screen.findByTestId('tx-detail-bulk-offer');
    expect(offer.textContent).toContain('1');
    fireEvent.click(screen.getByTestId('tx-detail-bulk-apply'));

    await waitFor(async () => {
      expect(await db.transactions.get('blk-b')).toMatchObject({ catId: 'hobby', needsReview: 0 });
    });
    expect(screen.queryByTestId('tx-detail-bulk-offer')).toBeNull(); // offer consumed
    db.close();
  }, 15_000);
});
