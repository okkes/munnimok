// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readSessionIdentity } from '@/app/session';
import { renderApp } from '@/test/harness';

// Local-first law also applies to demo/offline sign-in: zero network.
const fetchSpy = vi.fn(() => Promise.reject(new Error('network disabled in test')));

describe('LoginScreen', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockClear();
  });

  it('demo button signs in and lands on home without network calls', async () => {
    renderApp('/login', { signedIn: false });
    fireEvent.click(await screen.findByTestId('login-demo-btn'));
    expect(await screen.findByTestId('screen-home')).toBeTruthy();
    expect(readSessionIdentity()).toEqual({ kind: 'demo' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('creates an offline profile and enters a personal space named after it', async () => {
    renderApp('/login', { signedIn: false });
    fireEvent.click(await screen.findByTestId('login-offline-btn'));
    const name = await screen.findByTestId('offline-name');
    expect((screen.getByTestId('offline-create') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'Okkes' } });
    fireEvent.click(screen.getByTestId('offline-create'));

    expect(await screen.findByTestId('screen-home')).toBeTruthy();
    const identity = readSessionIdentity();
    expect(identity?.kind).toBe('offline');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an existing offline profile is offered on the next visit and keeps its data', async () => {
    // first visit: create the profile
    const first = renderApp('/login', { signedIn: false });
    fireEvent.click(await screen.findByTestId('login-offline-btn'));
    fireEvent.change(await screen.findByTestId('offline-name'), { target: { value: 'Okkes' } });
    fireEvent.click(screen.getByTestId('offline-create'));
    await screen.findByTestId('screen-home');
    const identity = readSessionIdentity();
    first.unmount();

    // sign out (session cleared) but local data must survive for offline profiles
    localStorage.removeItem('munni_session');
    renderApp('/login', { signedIn: false });
    fireEvent.click(await screen.findByTestId('login-offline-btn'));
    const profileBtn = await screen.findByText('Okkes');
    fireEvent.click(profileBtn.closest('button')!);
    expect(await screen.findByTestId('screen-home')).toBeTruthy();
    await waitFor(() => expect(readSessionIdentity()).toEqual(identity));
  });
});
