// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

describe('Overview (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('home shows the four period tiles with money values', async () => {
    renderApp('/home');
    await screen.findByTestId('home-overview-expense');
    // demo data always has a purchase within the last 3 days -> spent > 0
    await waitFor(() => expect(screen.getByTestId('home-overview-expense').textContent).toMatch(/€\d/));
    expect(screen.getByTestId('home-overview-income')).toBeTruthy();
    expect(screen.getByTestId('home-overview-saving')).toBeTruthy();
    expect(screen.getByTestId('home-overview-investment')).toBeTruthy();
  });

  it('tapping a tile opens the drill-down with total, chart and category groups', async () => {
    renderApp('/home');
    await screen.findByTestId('home-overview-expense');
    fireEvent.click(screen.getByTestId('home-overview-expense'));

    await screen.findByTestId('screen-overview');
    await waitFor(() => expect(screen.getByTestId('overview-total').textContent).toMatch(/€\d/));
    expect(screen.getByTestId('overview-barchart')).toBeTruthy();
    expect(screen.getByTestId('overview-stackedbar')).toBeTruthy();

    // main categories render; expanding one reveals its sub categories
    const group = await waitFor(() => {
      const el = document.querySelector('[data-testid^="overview-group-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    const catId = group.getAttribute('data-testid')!.replace('overview-group-', '');
    fireEvent.click(group);
    expect(await screen.findByTestId(`overview-subs-${catId}`)).toBeTruthy();
    expect(document.querySelectorAll(`[data-testid="overview-subs-${catId}"] .m-num`).length).toBeGreaterThan(0);
  });

  it('selecting an older period updates the total', async () => {
    renderApp('/overview/expense');
    await screen.findByTestId('screen-overview');
    await waitFor(() => expect(screen.getByTestId('overview-total').textContent).toMatch(/€\d/));
    const current = screen.getByTestId('overview-total').textContent;

    fireEvent.click(screen.getByTestId('overview-bar-0')); // oldest period
    await waitFor(() => expect(screen.getByTestId('overview-total').textContent).not.toBe(current));
  });

  it('saving uses the checking-side sign mechanic (deposits count positive)', async () => {
    renderApp('/overview/saving');
    await screen.findByTestId('screen-overview');
    // demo savingDeposit rows are negative on the checking account ->
    // shown as a positive amount saved in some period bar
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid^="overview-bar-"]')).toHaveLength(6);
    });
    // find a period with saving activity by clicking through the bars
    // (inside waitFor: the transactions arrive via a live query)
    await waitFor(() => {
      let found = false;
      for (let i = 5; i >= 0 && !found; i--) {
        fireEvent.click(screen.getByTestId(`overview-bar-${i}`));
        const text = screen.getByTestId('overview-total').textContent ?? '';
        if (/€[1-9]/.test(text) && !text.includes('-')) found = true;
      }
      expect(found).toBe(true);
    });
  });
});
