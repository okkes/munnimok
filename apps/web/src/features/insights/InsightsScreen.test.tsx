// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

/** a long-running debt makes the acceleration detector fire deterministically */
async function createBigDebt() {
  renderApp('/debts');
  await screen.findByTestId('screen-debts');
  fireEvent.click(await screen.findByTestId('debts-add'));
  await screen.findByTestId('debtform-name');
  fireEvent.change(screen.getByTestId('debtform-name'), { target: { value: 'Student loan' } });
  fireEvent.change(screen.getByTestId('debtform-original'), { target: { value: '25000' } });
  fireEvent.change(screen.getByTestId('debtform-apr'), { target: { value: '8' } });
  fireEvent.change(screen.getByTestId('debtform-payment'), { target: { value: '300' } });
  fireEvent.click(screen.getByTestId('debtform-save'));
  await waitFor(() => expect(document.querySelector('[data-testid^="debt-card-"]')).toBeTruthy());
}

describe('Insights (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('a detector finding renders, expands with detail, and dismisses for good', async () => {
    await createBigDebt();

    cleanup();
    renderApp('/insights');
    await screen.findByTestId('screen-insights');
    const head = await waitFor(
      () => {
        const el = document.querySelector('[data-testid^="insight-head-debtacc"]');
        expect(el).toBeTruthy();
        return el!;
      },
      { timeout: 5000 },
    );
    expect(head.textContent).toContain('Student loan');

    fireEvent.click(head);
    const body = await waitFor(() => {
      const el = document.querySelector('[data-testid^="insight-body-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(body.textContent).toMatch(/months earlier/);

    fireEvent.click(screen.getByTestId('insight-dismiss'));
    // synced dismissal: gone now, still gone on a fresh mount
    await waitFor(() => expect(document.querySelector('[data-testid^="insight-head-debtacc"]')).toBeNull());
    cleanup();
    renderApp('/insights');
    await screen.findByTestId('screen-insights');
    await screen.findByTestId('insights-empty', {}, { timeout: 5000 });
  }, 20_000);

  it('the home block surfaces the top insight; the settings row reaches the screen', async () => {
    await createBigDebt();

    cleanup();
    renderApp('/home');
    const block = await screen.findByTestId('home-insight', {}, { timeout: 5000 });
    expect(block.textContent).toContain('Student loan');
    fireEvent.click(block);
    await screen.findByTestId('screen-insights');

    cleanup();
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-insights-row'));
    expect(await screen.findByTestId('screen-insights')).toBeTruthy();
  }, 20_000);
});
