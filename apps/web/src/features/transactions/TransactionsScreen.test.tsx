// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

const rows = () => screen.getByTestId('tx-list').querySelectorAll('[data-testid^="tx-row-"]');

describe('TransactionsScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('search narrows the list to matching merchants', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));
    const before = rows().length;

    fireEvent.change(screen.getByTestId('tx-search'), { target: { value: 'Albert Heijn' } });
    await waitFor(() => {
      const after = rows().length;
      expect(after).toBeGreaterThan(0);
      expect(after).toBeLessThan(before);
    });
    for (const row of rows()) {
      expect(row.textContent).toContain('Albert Heijn');
      // the match itself is marked in the row
      expect(row.querySelector('mark')?.textContent).toBe('Albert Heijn');
    }

    fireEvent.change(screen.getByTestId('tx-search'), { target: { value: 'zzz-no-such-merchant' } });
    await waitFor(() => expect(rows().length).toBe(0));
  });

  it('review chip filters to flagged transactions only', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));

    fireEvent.click(screen.getByTestId('tx-filter-review'));
    // demo seed flags exactly 3 transactions for review
    await waitFor(() => expect(rows().length).toBe(3));
    fireEvent.click(screen.getByTestId('tx-filter-review'));
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));
  });

  it('the filter sheet narrows by account and type; clear restores everything', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    await waitFor(() => expect(rows().length).toBeGreaterThan(3));
    const all = rows().length;

    // the demo savings account has no transactions — filter yields none
    fireEvent.click(screen.getByTestId('tx-filter-open'));
    fireEvent.click(await screen.findByTestId('filter-account-demo_save'));
    fireEvent.click(screen.getByTestId('filter-done'));
    await waitFor(() => expect(rows().length).toBe(0));
    expect(screen.getByTestId('tx-filter-count').textContent).toBe('1');

    // the clear chip resets the sheet filters
    fireEvent.click(screen.getByTestId('tx-filter-clear'));
    await waitFor(() => expect(rows().length).toBe(all));

    // type filter: saving transactions only
    fireEvent.click(screen.getByTestId('tx-filter-open'));
    fireEvent.click(await screen.findByTestId('filter-type-saving'));
    fireEvent.click(screen.getByTestId('filter-done'));
    await waitFor(() => {
      expect(rows().length).toBeGreaterThan(0);
      expect(rows().length).toBeLessThan(all);
    });
  });
});
