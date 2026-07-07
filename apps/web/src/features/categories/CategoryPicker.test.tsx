// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

describe('CategoryPicker direction filtering (via add-transaction form)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('an expense hides credit-only categories; income shows them', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    await screen.findByTestId('txform-account-demo_main');

    // expense (debit): the custom Padel main's Other sub (direction both)
    // is offered once the catalog's live query delivers the custom rows…
    fireEvent.click(screen.getByTestId('txform-category'));
    await screen.findByTestId('catpicker-groceries');
    await screen.findByTestId('catpicker-demo_cat_padel_other');
    // …while the demo credit-only sub "Side gig" is hidden
    expect(screen.queryByTestId('catpicker-demo_cat_sidegig')).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });

    // switch to income (credit): Side gig appears, debit-only cats disappear
    fireEvent.click(screen.getByTestId('txform-income'));
    fireEvent.click(screen.getByTestId('txform-category'));
    await waitFor(() => expect(screen.getByTestId('catpicker-demo_cat_sidegig')).toBeTruthy());
    expect(screen.queryByTestId('catpicker-savingDeposit')).toBeNull(); // builtin debit-only
  });
});
