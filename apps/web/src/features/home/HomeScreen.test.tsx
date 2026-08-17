// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

/**
 * The balance band's configurable meaning (user design 2026-08-01):
 * per-space mode + per-account say in the sum. Lean demo: checking
 * €3,420.55 + savings €8,150.00.
 */
describe('Home balance band (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('#180: the FAB opens the quick-add sheet; the tx door hosts the form in place', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    fireEvent.click(screen.getByTestId('home-fab'));
    await screen.findByTestId('home-quick-sheet');
    // the six doors, in the user's stated order
    for (const id of ['tx', 'import', 'category', 'account', 'friend', 'space']) {
      expect(screen.getByTestId(`home-quick-${id}`)).toBeTruthy();
    }
    // the manual-transaction door opens the form right here
    fireEvent.click(screen.getByTestId('home-quick-tx'));
    await screen.findByTestId('txform-save');
    expect(screen.getByTestId('txform-merchant')).toBeTruthy();
  }, 15_000);

  it('modes switch the meaning; account toggles bend the sum; all persisted per space', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    // default = net worth, the pre-config behavior
    await waitFor(() => expect(screen.getByTestId('home-total-balance').textContent).toContain('11,570.55'));
    expect(screen.getByTestId('band-mode-label').textContent).toContain('Net worth');

    fireEvent.click(screen.getByTestId('home-balance-band'));
    await screen.findByTestId('band-mode-row');

    // #142 (user): net worth is PREMADE — no per-account checkboxes
    expect(screen.queryByTestId('band-acct-demo_save')).toBeNull();

    // custom mode starts empty and counts only picked accounts
    fireEvent.click(screen.getByTestId('band-mode-custom'));
    await waitFor(() => expect(screen.getByTestId('band-mode-label').textContent).toContain('Picked accounts'));
    await waitFor(() => expect(screen.getByTestId('home-total-balance').textContent).toContain('0.00'));
    fireEvent.click(await screen.findByTestId('band-acct-demo_main'));
    await waitFor(() => expect(screen.getByTestId('home-total-balance').textContent).toContain('3,420.55'));

    // #142: total cash is premade too — the full liquid formula, no
    // checkboxes, unaffected by any stored exclusions
    fireEvent.click(screen.getByTestId('band-mode-cash'));
    await waitFor(() => expect(screen.getByTestId('band-mode-label').textContent).toContain('Total cash'));
    await waitFor(() => expect(screen.getByTestId('home-total-balance').textContent).toContain('11,570.55'));
    expect(screen.queryByTestId('band-acct-demo_main')).toBeNull();
  }, 15_000);

  it('unused features collapse into ONE Explore block instead of a pile of teaser cards (#121)', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    // the lean demo has no budgets, goals or debts — three teasers'
    // worth of unused features, one compact door
    const explore = await screen.findByTestId('home-explore');
    expect(explore.textContent).toContain('Explore');
    expect(screen.queryByTestId('home-budgets-teaser')).toBeNull();
    expect(screen.queryByTestId('home-goals-teaser')).toBeNull();
    expect(screen.queryByTestId('home-debts-teaser')).toBeNull();
    // rows lead straight to the feature
    fireEvent.click(await screen.findByTestId('home-explore-goals'));
    expect(await screen.findByTestId('screen-goals')).toBeTruthy();
  }, 15_000);

  it('Explore is a first-class block: it appears in Customize Home like any other (#121 v2)', async () => {
    renderApp('/home/customize');
    const rows = await screen.findAllByText('Explore');
    expect(rows.length).toBeGreaterThanOrEqual(1);
  }, 15_000);
});
