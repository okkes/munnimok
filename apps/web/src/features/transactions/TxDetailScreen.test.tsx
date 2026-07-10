// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID } from '@/db/seed';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
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
    const repo = new Repo(db, new HlcClock('seed-att'), { trackOutbox: false });
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

  it('linking a savings counter-account derives the type and locks it', async () => {
    renderApp('/transactions/dm6');
    fireEvent.click(await screen.findByTestId('tx-detail-type-row'));
    fireEvent.click(await screen.findByTestId('txtype-linked-demo_save'));
    await waitFor(() => expect(screen.getByTestId('tx-detail-type-row').textContent).toContain('Saving'));

    // reopen: manual type choice is now locked
    fireEvent.click(screen.getByTestId('tx-detail-type-row'));
    expect(await screen.findByTestId('txtype-locked-note')).toBeTruthy();
    expect((screen.getByTestId('txtype-expense') as HTMLButtonElement).disabled).toBe(true);

    // unlink restores manual choice
    fireEvent.click(screen.getByTestId('txtype-linked-none'));
    await waitFor(() => expect(screen.queryByTestId('txtype-locked-note')).toBeNull());
  });
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

    // unlink restores the original state
    await waitFor(() =>
      expect(screen.getByTestId('reimb-list').querySelector('[data-testid^="reimb-unlink-"]')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('reimb-list').querySelector('[data-testid^="reimb-unlink-"]')!);
    await waitFor(() => {
      expect(screen.queryByTestId('reimb-summary')).toBeNull();
      expect(screen.getByTestId('tx-detail-amount').textContent).toContain('-€52.40');
    });
  });
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
