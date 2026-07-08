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

    // step 2: connect your bank (offered), do it later -> home
    expect(await screen.findByTestId('onboarding-bank-step')).toBeTruthy();
    fireEvent.click(screen.getByTestId('onboarding-bank-later'));
    expect(await screen.findByTestId('screen-home')).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('skip also passes the bank step; import goes to the accounts screen', async () => {
    renderApp('/onboarding');
    await screen.findByTestId('screen-onboarding');
    fireEvent.click(screen.getByTestId('onboarding-skip'));
    await screen.findByTestId('onboarding-bank-step');
    fireEvent.click(screen.getByTestId('onboarding-import'));
    expect(await screen.findByTestId('screen-accounts')).toBeTruthy();
  });
});
