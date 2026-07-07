// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

const openForm = async () => {
  renderApp('/transactions');
  await screen.findByTestId('tx-list');
  fireEvent.click(screen.getByTestId('tx-add'));
  await screen.findByTestId('txform-save');
  // the account chips load via liveQuery; without an account save can never enable
  await screen.findByTestId('txform-account-demo_main');
};

describe('TxFormSheet (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('save stays disabled until amount and merchant are valid', async () => {
    await openForm();
    const save = screen.getByTestId('txform-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Bakker' } });
    expect(save.disabled).toBe(true); // still no amount

    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '0' } });
    expect(save.disabled).toBe(true); // zero is not a transaction

    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '4,50' } });
    await waitFor(() => expect(save.disabled).toBe(false));
  });

  it('adds an expense with a picked category and shows it in the list', async () => {
    await openForm();
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '12,34' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Bakker Bart' } });

    // pick a category through the nested picker
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('catpicker-groceries'));
    await waitFor(() => expect(screen.getByTestId('txform-category').textContent).toContain('Grocery'));

    fireEvent.click(screen.getByTestId('txform-save'));
    // generous timeout: coverage instrumentation slows the liveQuery round-trip
    await waitFor(
      () => {
        const row = [...screen.getByTestId('tx-list').querySelectorAll('[data-testid^="tx-row-"]')].find((r) =>
          r.textContent?.includes('Bakker Bart'),
        );
        expect(row).toBeTruthy();
        expect(row!.textContent).toContain('-€12.34');
        expect(row!.textContent).toContain('Grocery');
      },
      { timeout: 5000 },
    );
  });

  it('the income toggle stores a positive amount', async () => {
    await openForm();
    fireEvent.click(screen.getByTestId('txform-income'));
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '50' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Refund BV' } });
    fireEvent.click(screen.getByTestId('txform-save'));
    await waitFor(
      () => {
        const row = [...screen.getByTestId('tx-list').querySelectorAll('[data-testid^="tx-row-"]')].find((r) =>
          r.textContent?.includes('Refund BV'),
        );
        expect(row!.textContent).toContain('+€50.00');
      },
      { timeout: 5000 },
    );
  });
});
