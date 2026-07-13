// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/harness';

// Local-first law: demo mode must never touch the network. Any fetch is
// both recorded (asserted below) and rejected (offline behavior).
const fetchSpy = vi.fn(() => Promise.reject(new Error('network disabled in test')));

describe('app screens (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirects a signed-out visitor to the login screen', async () => {
    renderApp('/home', { signedIn: false });
    expect(await screen.findByTestId('screen-login')).toBeTruthy();
  });

  it('redirects /login to /home when already signed in', async () => {
    renderApp('/login');
    expect(await screen.findByTestId('screen-home')).toBeTruthy();
  });

  it.each([
    ['/home', 'screen-home'],
    ['/transactions', 'screen-transactions'],
    ['/spaces', 'screen-spaces'],
    ['/settings', 'screen-settings'],
    ['/review', 'screen-review'],
    ['/accounts', 'screen-accounts'],
    ['/categories', 'screen-manage-cats'],
    ['/friends', 'screen-friends'],
  ])('renders %s without any network call', async (path, testId) => {
    renderApp(path);
    expect(await screen.findByTestId(testId)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows seeded demo transactions in the list', async () => {
    renderApp('/transactions');
    const list = await screen.findByTestId('tx-list');
    await waitFor(() => expect(list.querySelectorAll('[data-testid^="tx-row-"]').length).toBeGreaterThan(0));
  });

  it('tab bar navigates between screens', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    fireEvent.click(screen.getAllByTestId('tab-settings')[0]);
    expect(await screen.findByTestId('screen-settings')).toBeTruthy();
    fireEvent.click(screen.getAllByTestId('tab-transactions')[0]);
    expect(await screen.findByTestId('screen-transactions')).toBeTruthy();
  });

  it('spaces left the tab bar: no tab, a settings row opens the screen', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    expect(screen.queryByTestId('tab-spaces')).toBeNull();
    // app-wide rows live behind the single Global settings door now
    fireEvent.click(screen.getByTestId('settings-global-row'));
    fireEvent.click(await screen.findByTestId('settings-spaces-row'));
    expect(await screen.findByTestId('screen-spaces')).toBeTruthy();
  });

  it('customize home hides and reorders landing-zone blocks (per space)', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await screen.findByTestId('home-overview-expense');

    fireEvent.click(screen.getByTestId('home-customize'));
    await screen.findByTestId('home-customize-list');

    // hide the transactions block: its card leaves Home
    fireEvent.click(screen.getByTestId('home-block-toggle-transactions'));
    await waitFor(() => expect(screen.queryByText('Transactions', { selector: '.m-cap' })).toBeNull());
    fireEvent.click(screen.getByTestId('home-block-toggle-transactions'));

    // move review above overview: the saved order round-trips
    fireEvent.click(screen.getByTestId('home-block-up-review'));
    await waitFor(async () => {
      const db = await import('@/db/schema').then((m) => new m.MunniDB('munni_demo'));
      const space = await db.spaces.get('demo_space');
      db.close();
      expect(space?.homeBlocks?.[0]?.id).toBe('review');
    });
  });

  it('home space switcher lists spaces, marks the active one, links to manage', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    fireEvent.click(screen.getByTestId('home-space-switcher'));
    const active = await screen.findByTestId('space-pick-demo_space');
    expect(active.textContent).toContain('Active space');
    fireEvent.click(screen.getByTestId('space-pick-manage'));
    expect(await screen.findByTestId('screen-spaces')).toBeTruthy();
  });
});
