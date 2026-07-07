// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CAMT_FIXTURE } from '@/test/camt-fixture';
import { renderApp } from '@/test/harness';

describe('AccountsScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('lists the seeded demo accounts', async () => {
    renderApp('/accounts');
    expect(await screen.findByTestId('account-row-demo_main')).toBeTruthy();
    expect(screen.getByTestId('account-row-demo_save')).toBeTruthy();
  });

  it('adds a manual cash account through the type grid', async () => {
    renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    fireEvent.click(screen.getByTestId('accounts-add'));
    fireEvent.click(await screen.findByTestId('accttype-cash'));
    fireEvent.change(screen.getByTestId('acctform-name'), { target: { value: 'Wallet' } });
    fireEvent.change(screen.getByTestId('acctform-balance'), { target: { value: '25,50' } });
    fireEvent.click(screen.getByTestId('acctform-save'));
    await waitFor(() => expect(screen.getByText('Wallet')).toBeTruthy());
  });

  it('a credit card account stores its balance as a liability', async () => {
    renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    fireEvent.click(screen.getByTestId('accounts-add'));
    fireEvent.click(await screen.findByTestId('accttype-credit'));
    fireEvent.change(screen.getByTestId('acctform-name'), { target: { value: 'Visa' } });
    fireEvent.change(screen.getByTestId('acctform-balance'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('acctform-save'));
    // renders under Liabilities with a negative amount
    const row = await screen.findByText('Visa');
    expect(row.closest('button')!.textContent).toContain('-€100.00');
  });

  it('renames and deletes an account from the edit sheet', async () => {
    renderApp('/accounts');
    fireEvent.click(await screen.findByTestId('account-row-demo_save'));
    const nameInput = await screen.findByTestId('acctedit-name');
    fireEvent.change(nameInput, { target: { value: 'Rainy day' } });
    fireEvent.click(screen.getByTestId('acctedit-save'));
    await waitFor(() => expect(screen.getByTestId('account-row-demo_save').textContent).toContain('Rainy day'));

    fireEvent.click(screen.getByTestId('account-row-demo_save'));
    fireEvent.click(await screen.findByTestId('acctedit-delete'));
    await waitFor(() => expect(screen.queryByTestId('account-row-demo_save')).toBeNull());
  });

  it('imports a CAMT.053 file: preview, run, result, new account appears', async () => {
    renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    const input = screen.getByTestId('accounts-import-input') as HTMLInputElement;
    const file = new File([CAMT_FIXTURE], 'statement.xml', { type: 'text/xml' });
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);

    const preview = await screen.findByTestId('import-preview');
    expect(preview.textContent).toContain('NL69INGB0123456789');
    expect(preview.textContent).toContain('2 transactions');

    fireEvent.click(screen.getByTestId('import-run'));
    const result = await screen.findByTestId('import-result');
    expect(result.textContent).toContain('Imported 2 transactions, skipped 0 duplicates');
    fireEvent.click(screen.getByTestId('import-close'));
    // the imported IBAN now exists as an account
    await waitFor(() => expect(screen.getByText('NL69INGB0123456789')).toBeTruthy());
  });

  it('rejects a non-CAMT file with the error banner', async () => {
    renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    const input = screen.getByTestId('accounts-import-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['<html>nope</html>'], 'x.xml')] });
    fireEvent.change(input);
    expect(await screen.findByTestId('import-error')).toBeTruthy();
  });
});
