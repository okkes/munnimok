// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/harness';

// demo identity is fully local: profile edits must not touch the network
const fetchSpy = vi.fn(() => Promise.reject(new Error('network disabled in test')));

describe('ProfileScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockClear();
  });

  it('opens from the settings header row', async () => {
    renderApp('/settings');
    fireEvent.click(await screen.findByTestId('settings-profile-row'));
    expect(await screen.findByTestId('screen-profile')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('saves name + avatar locally and shows them back in settings', async () => {
    const first = renderApp('/profile');
    const name = await screen.findByTestId('profile-name');
    await waitFor(() => expect((name as HTMLInputElement).value).toBe('Demo'));

    fireEvent.change(name, { target: { value: 'Okkes' } });
    fireEvent.click(screen.getByTestId('profile-avatar-cat'));
    fireEvent.click(screen.getByTestId('profile-save'));
    await screen.findByText('Saved');
    first.unmount(); // release the db before mounting a fresh app

    renderApp('/settings');
    await waitFor(() => expect(screen.getByTestId('settings-profile-row').textContent).toContain('Okkes'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('demo identity shows no user id / email block', async () => {
    renderApp('/profile');
    await screen.findByTestId('screen-profile');
    expect(screen.queryByTestId('profile-copy-id')).toBeNull();
    expect(screen.queryByTestId('profile-email')).toBeNull();
  });
});
