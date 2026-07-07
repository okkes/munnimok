// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

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
});
