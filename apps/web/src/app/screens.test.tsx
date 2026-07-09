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
});
