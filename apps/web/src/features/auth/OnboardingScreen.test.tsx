// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MunniDB } from '@/db/schema';
import { USER_TEST_DB, renderApp, renderAppAsUser } from '@/test/harness';

describe('OnboardingScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('is NOT skippable: a nameless continue is refused with the blocker (#195)', async () => {
    renderApp('/onboarding');
    await screen.findByTestId('screen-onboarding');
    // the skip button is gone (user ruling) and so is the currency field
    expect(screen.queryByTestId('onboarding-skip')).toBeNull();
    expect(screen.queryByTestId('onboarding-currency')).toBeNull();
    // the button stays tappable — the invalid tap names the blocker instead
    expect((screen.getByTestId('onboarding-save') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('onboarding-save'));
    expect(await screen.findByTestId('onboarding-save-blocker')).toBeTruthy();
    expect(screen.getByTestId('onboarding-name').getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByTestId('onboarding-lock-step')).toBeNull(); // did not advance
    fireEvent.change(screen.getByTestId('onboarding-name'), { target: { value: 'Okkes' } });
    await waitFor(() => expect(screen.queryByTestId('onboarding-save-blocker')).toBeNull());
  });

  it('country picker searches; language chips switch the UI in place', async () => {
    renderApp('/onboarding');
    await screen.findByTestId('screen-onboarding');
    expect(screen.getByTestId('onboarding-country-info')).toBeTruthy();

    fireEvent.click(screen.getByTestId('onboarding-country'));
    fireEvent.change(await screen.findByTestId('onboarding-country-search'), { target: { value: 'Turk' } });
    fireEvent.click(await screen.findByTestId('onboarding-country-TR'));
    // the code badge became a flag icon (user request) — assert the flag
    await waitFor(() => expect(screen.getByTestId('onboarding-country').querySelector('[data-testid="flag-tr"]')).toBeTruthy());

    // language stays changeable during onboarding (kept from login pick)
    fireEvent.click(screen.getByTestId('onboarding-lang-nl'));
    await waitFor(() => expect(localStorage.getItem('munni_lang')).toBe('nl'));
  });

  it('profile (avatar + name + country) persists, lock offer leads home', async () => {
    // the /me call is best-effort — offline must not block
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    renderApp('/onboarding');
    await screen.findByTestId('screen-onboarding');
    fireEvent.click(screen.getByTestId('onboarding-avatar-2'));
    fireEvent.change(screen.getByTestId('onboarding-name'), { target: { value: 'Okkes' } });
    fireEvent.click(screen.getByTestId('onboarding-save'));

    // step 2: the app-lock offer — the bank step is GONE (tutorial owns it)
    expect(await screen.findByTestId('onboarding-lock-step')).toBeTruthy();
    fireEvent.click(screen.getByTestId('onboarding-lock-later'));
    expect(await screen.findByTestId('screen-home')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-bank-step')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('setting the lock during onboarding writes a PIN-backed config', async () => {
    renderApp('/onboarding');
    await screen.findByTestId('screen-onboarding');
    fireEvent.change(screen.getByTestId('onboarding-name'), { target: { value: 'Okkes' } });
    fireEvent.click(screen.getByTestId('onboarding-save'));
    await screen.findByTestId('onboarding-lock-step');
    fireEvent.change(screen.getByTestId('onboarding-lock-pin'), { target: { value: '1234' } });
    fireEvent.change(screen.getByTestId('onboarding-lock-pin2'), { target: { value: '4321' } });
    fireEvent.click(screen.getByTestId('onboarding-lock-enable'));
    // mismatch stays on the step with the error
    expect(await screen.findByTestId('onboarding-lock-error')).toBeTruthy();
    fireEvent.change(screen.getByTestId('onboarding-lock-pin2'), { target: { value: '1234' } });
    fireEvent.click(screen.getByTestId('onboarding-lock-enable'));
    await screen.findByTestId('screen-home');
    // the config is stored per identity (munni_lock_<key>)
    const lockKey = Object.keys(localStorage).find((k) => k.startsWith('munni_lock'));
    const config = JSON.parse(localStorage.getItem(lockKey ?? '') ?? 'null');
    expect(config?.enabled).toBe(true);
    expect(config?.pinHash).toBeTruthy();
  });

  it('hides the navigation chrome while onboarding', async () => {
    renderApp('/onboarding');
    await screen.findByTestId('screen-onboarding');
    // both tab bars carry the hidden class during the flow
    expect(screen.queryAllByTestId('tab-home').every((el) => el.closest('nav')?.className.includes('hidden'))).toBe(true);
  });
});

describe('OnboardingScreen (user identity, scripted server)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('a profile the server refuses keeps the person on the form, told so — nothing moves on', async () => {
    renderAppAsUser('/onboarding', { api: { 'PUT /me': () => new Response(JSON.stringify({ errors: { Picture: ['too long'] } }), { status: 400 }) } });
    await screen.findByTestId('screen-onboarding');
    fireEvent.change(screen.getByTestId('onboarding-name'), { target: { value: 'Okkes' } });
    fireEvent.click(screen.getByTestId('onboarding-save'));

    expect(await screen.findByTestId('onboarding-save-refused')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-lock-step')).toBeNull();
    const db = new MunniDB(USER_TEST_DB);
    expect(await db.meta.get('profile')).toBeUndefined();
    db.close();
  }, 15_000);

  it('a profile the server takes leads on to the lock offer', async () => {
    const puts: unknown[] = [];
    renderAppAsUser('/onboarding', {
      api: {
        'PUT /me': (body) => {
          puts.push(body);
          return { userId: 'uid-123', displayName: 'Okkes', picture: null };
        },
      },
    });
    await screen.findByTestId('screen-onboarding');
    fireEvent.change(screen.getByTestId('onboarding-name'), { target: { value: 'Okkes' } });
    fireEvent.click(screen.getByTestId('onboarding-save'));

    expect(await screen.findByTestId('onboarding-lock-step')).toBeTruthy();
    expect(puts[0]).toMatchObject({ displayName: 'Okkes' });
  }, 15_000);

  it('a server that cannot be reached does not hold the flow up', async () => {
    renderAppAsUser('/onboarding', {
      api: {
        'PUT /me': () => {
          throw new TypeError('Failed to fetch');
        },
      },
    });
    await screen.findByTestId('screen-onboarding');
    fireEvent.change(screen.getByTestId('onboarding-name'), { target: { value: 'Okkes' } });
    fireEvent.click(screen.getByTestId('onboarding-save'));

    expect(await screen.findByTestId('onboarding-lock-step')).toBeTruthy();
    expect(screen.queryByTestId('onboarding-save-refused')).toBeNull();
  }, 15_000);
});
