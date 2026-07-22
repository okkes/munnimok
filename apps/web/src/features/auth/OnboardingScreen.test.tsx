// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/harness';

describe('OnboardingScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('country choice drives the currency hint, search narrows the list', async () => {
    renderApp('/onboarding');
    await screen.findByTestId('screen-onboarding');
    expect(screen.getByTestId('onboarding-currency-hint').textContent).toContain('EUR');

    fireEvent.click(screen.getByTestId('onboarding-country'));
    fireEvent.change(await screen.findByTestId('onboarding-country-search'), { target: { value: 'Turk' } });
    fireEvent.click(await screen.findByTestId('onboarding-country-TR'));
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-country').textContent).toContain('TR');
      expect(screen.getByTestId('onboarding-currency-hint').textContent).toContain('TRY');
    });
  });

  it('continue applies the profile, then the bank step leads home', async () => {
    // the /me displayName call is best-effort — offline must not block
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    renderApp('/onboarding');
    await screen.findByTestId('screen-onboarding');
    fireEvent.change(screen.getByTestId('onboarding-name'), { target: { value: 'Okkes' } });
    fireEvent.click(screen.getByTestId('onboarding-save'));

    // step 2: the app-lock offer (user request) — skippable, and the
    // copy names Global settings as the later door
    expect(await screen.findByTestId('onboarding-lock-step')).toBeTruthy();
    fireEvent.click(screen.getByTestId('onboarding-lock-later'));

    // step 3: connect your bank (offered), do it later -> home
    expect(await screen.findByTestId('onboarding-bank-step')).toBeTruthy();
    fireEvent.click(screen.getByTestId('onboarding-bank-later'));
    expect(await screen.findByTestId('screen-home')).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('skip also passes the bank step; import goes to the accounts screen', async () => {
    renderApp('/onboarding');
    await screen.findByTestId('screen-onboarding');
    fireEvent.click(screen.getByTestId('onboarding-skip'));
    await screen.findByTestId('onboarding-lock-step');
    fireEvent.click(screen.getByTestId('onboarding-lock-later'));
    await screen.findByTestId('onboarding-bank-step');
    fireEvent.click(screen.getByTestId('onboarding-import'));
    expect(await screen.findByTestId('screen-accounts')).toBeTruthy();
  });

  it('setting the lock during onboarding writes a PIN-backed config', async () => {
    renderApp('/onboarding');
    await screen.findByTestId('screen-onboarding');
    fireEvent.click(screen.getByTestId('onboarding-skip'));
    await screen.findByTestId('onboarding-lock-step');
    fireEvent.change(screen.getByTestId('onboarding-lock-pin'), { target: { value: '1234' } });
    fireEvent.change(screen.getByTestId('onboarding-lock-pin2'), { target: { value: '4321' } });
    fireEvent.click(screen.getByTestId('onboarding-lock-enable'));
    // mismatch stays on the step with the error
    expect(await screen.findByTestId('onboarding-lock-error')).toBeTruthy();
    fireEvent.change(screen.getByTestId('onboarding-lock-pin2'), { target: { value: '1234' } });
    fireEvent.click(screen.getByTestId('onboarding-lock-enable'));
    await screen.findByTestId('onboarding-bank-step');
    // the config is stored per identity (munni_lock_<key>)
    const lockKey = Object.keys(localStorage).find((k) => k.startsWith('munni_lock'));
    const config = JSON.parse(localStorage.getItem(lockKey ?? '') ?? 'null');
    expect(config?.enabled).toBe(true);
    expect(config?.pinHash).toBeTruthy();
  });
});
