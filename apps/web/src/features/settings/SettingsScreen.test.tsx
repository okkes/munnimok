// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { CLIENT_PROTOCOL } from '@/lib/protocol';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_TEST_DB, renderApp, renderAppAsUser } from '@/test/harness';
import { readLockConfig } from '@/features/lock/lock';
import { resetApiCapabilitiesCache } from '@/lib/api';
import { useSession } from '@/app/session';

describe('SettingsScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('the global door opens the global settings screen', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-global-row'));
    expect(await screen.findByTestId('screen-settings-global')).toBeTruthy();
  });

  it('the space header card opens space settings', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-space-row'));
    expect(await screen.findByTestId('screen-space-settings')).toBeTruthy();
  });

  it('currency is its own setting: the sheet applies the pick immediately and shows it on the row', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    await waitFor(() => expect(screen.getByTestId('settings-currency-value').textContent).toBe('EUR'));
    fireEvent.click(screen.getByTestId('settings-currency-row'));
    fireEvent.click(await screen.findByTestId('space-currency-TRY'));
    // no save button: the pick persists and the row badge follows
    await waitFor(() => expect(screen.getByTestId('settings-currency-value').textContent).toBe('TRY'), {
      timeout: 5000,
    });
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const space = (await db.spaces.toArray()).find((s) => s.deleted === 0);
      expect(space?.currency).toBe('TRY');
    });
    db.close();
  });

  it('history start stages as a draft with counted impact; Apply commits (arc 5)', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(await screen.findByTestId('settings-history-row'));
    fireEvent.change(await screen.findByTestId('space-history-start'), { target: { value: '2026-01-01' } });
    // nothing writes yet — the consequences show first, then Apply
    const impact = await screen.findByTestId('space-history-impact');
    expect(impact).toBeTruthy();
    fireEvent.click(screen.getByTestId('space-history-apply'));
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await waitFor(
      async () => {
        const space = (await db.spaces.toArray()).find((s) => s.deleted === 0);
        expect(space?.historyStartDate).toBe('2026-01-01');
      },
      { timeout: 5000 },
    );
    db.close();
  });

  it('#302: with an app lock armed, ENABLING invitations asks for the PIN first', async () => {
    // arm the app lock for the demo identity (hash of '1234' with salt 's')
    const { hashPin } = await import('@/features/lock/lock');
    const pinHash = await hashPin('1234', 'salty');
    localStorage.setItem('munni_lock_demo', JSON.stringify({ enabled: true, pinSalt: 'salty', pinHash, timeoutSec: 0 }));

    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    const toggle = (await screen.findByTestId('settings-space-private-toggle')) as HTMLInputElement;
    // arm the space lock first (checking is free)
    if (!toggle.checked) {
      fireEvent.click(toggle);
      await waitFor(() => expect((screen.getByTestId('settings-space-private-toggle') as HTMLInputElement).checked).toBe(true), { timeout: 5000 });
    }
    // unchecking = opening the space for invitations → the challenge
    fireEvent.click(screen.getByTestId('settings-space-private-toggle'));
    await screen.findByTestId('pin-challenge-sheet');
    // still locked — nothing wrote yet
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    expect((await db.spaces.toArray()).some((sp) => sp.deleted === 0 && sp.inviteLock === 1)).toBe(true);
    // a wrong 8-digit pin errors; the right one passes and writes
    fireEvent.change(screen.getByTestId('pin-challenge-pin'), { target: { value: '99999999' } });
    await screen.findByTestId('pin-challenge-error');
    fireEvent.change(screen.getByTestId('pin-challenge-pin'), { target: { value: '1234' } });
    await waitFor(async () => {
      expect((await db.spaces.toArray()).some((sp) => sp.deleted === 0 && sp.inviteLock === 1)).toBe(false);
    }, { timeout: 5000 });
    db.close();
    localStorage.removeItem('munni_lock_demo');
  }, 15_000);

  it('the private lock is an owner toggle in the Setup group now (#162)', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    expect(await screen.findByTestId('settings-space-private-row')).toBeTruthy();
    // demo space predates the lock: unlocked until the owner arms it
    const toggle = screen.getByTestId('settings-space-private-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);

    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await waitFor(
      async () => {
        const spaces = await db.spaces.toArray();
        expect(spaces.some((s) => s.deleted === 0 && s.inviteLock === 1)).toBe(true);
      },
      { timeout: 5000 },
    );
    // the controlled checkbox must SHOW the write before the next tap —
    // clicking mid-liveQuery-emission would re-toggle from stale state
    await waitFor(
      () => expect((screen.getByTestId('settings-space-private-toggle') as HTMLInputElement).checked).toBe(true),
      { timeout: 5000 },
    );
    fireEvent.click(screen.getByTestId('settings-space-private-toggle'));
    await waitFor(
      async () => {
        const spaces = await db.spaces.toArray();
        expect(spaces.some((s) => s.deleted === 0 && s.inviteLock === 1)).toBe(false);
      },
      { timeout: 5000 },
    );
    db.close();
  }, 15_000);

  it('demo sign-out returns to the login screen and wipes the demo db', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-signout'));
    expect(await screen.findByTestId('screen-login')).toBeTruthy();
    expect(localStorage.getItem('munni_session')).toBeNull();
    // demo resets to pristine data: the identity db is destroyed
    await waitFor(async () => {
      const dbs = await indexedDB.databases();
      expect(dbs.some((d) => d.name === 'munni_demo')).toBe(false);
    });
  });
});

describe('GlobalSettingsScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('the demo identity gets the device-level rows: appearance, language, accounts, tips and the app lock', async () => {
    renderApp('/settings/global');
    await screen.findByTestId('screen-settings-global');
    for (const id of ['settings-theme-toggle', 'settings-language-row', 'settings-accounts-row', 'settings-tips-toggle', 'settings-lock-toggle']) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });

  it('appearance: the segments pin light or dark, the row cycles light → dark → follow-device', async () => {
    // persistence + the data attribute belong to app/theme.test.tsx —
    // here the two controls and what they show
    renderApp('/settings/global');
    await screen.findByTestId('screen-settings-global');
    const pressed = (id: string) => screen.getByTestId(id).getAttribute('aria-pressed');
    // fresh storage = follow-device
    expect(pressed('settings-theme-auto')).toBe('true');
    fireEvent.click(screen.getByTestId('settings-theme-dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(pressed('settings-theme-dark')).toBe('true');
    fireEvent.click(screen.getByTestId('settings-theme-light'));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(pressed('settings-theme-light')).toBe('true');
    fireEvent.click(screen.getByTestId('settings-theme-auto'));
    expect(pressed('settings-theme-auto')).toBe('true');

    // the row walks the cycle from follow-device: light, dark, device again
    fireEvent.click(screen.getByTestId('settings-theme-toggle'));
    expect(pressed('settings-theme-light')).toBe('true');
    fireEvent.click(screen.getByTestId('settings-theme-toggle'));
    expect(pressed('settings-theme-dark')).toBe('true');
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.click(screen.getByTestId('settings-theme-toggle'));
    expect(pressed('settings-theme-auto')).toBe('true');
    // the segments stay the precise control: a direct pick lands exactly
    // where it points, never one step further along the row's cycle
    fireEvent.click(screen.getByTestId('settings-theme-dark'));
    expect(pressed('settings-theme-dark')).toBe('true');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('language sheet switches the UI language and persists it', async () => {
    renderApp('/settings/global');
    await screen.findByTestId('screen-settings-global');
    fireEvent.click(screen.getByTestId('settings-language-row'));
    fireEvent.click(await screen.findByTestId('lang-option-nl'));
    // the screen title re-renders in Dutch (persistence: LoginScreen's pill spec)
    await waitFor(() => expect(screen.getByTestId('screen-settings-global').textContent).toContain('Algemene instellingen'));
  });

  it('navigates to accounts from its row', async () => {
    renderApp('/settings/global');
    await screen.findByTestId('screen-settings-global');
    fireEvent.click(screen.getByTestId('settings-accounts-row'));
    expect(await screen.findByTestId('screen-accounts')).toBeTruthy();
  });

  it('hide-tips removes the question marks and nudges everywhere (user request)', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    expect(await screen.findByTestId('help-btn-home')).toBeTruthy();

    cleanup();
    renderApp('/settings/global');
    await screen.findByTestId('screen-settings-global');
    fireEvent.click(screen.getByTestId('settings-tips-toggle'));
    await waitFor(() => expect(screen.getByTestId('settings-tips-state').textContent).toBe('ON'));

    cleanup();
    renderApp('/home');
    await screen.findByTestId('screen-home');
    // the help button and the install hint read the SAME meta flag via
    // separate live queries — under load one emission can trail the
    // other, so both disappearances wait together
    await waitFor(() => {
      expect(screen.queryByTestId('help-btn-home')).toBeNull();
      expect(screen.queryByTestId('install-hint')).toBeNull();
    });
  }, 15_000);

  it('app lock setup: mismatch is rejected, matching PINs arm the lock, toggle disarms', async () => {
    renderApp('/settings/global');
    await screen.findByTestId('screen-settings-global');

    fireEvent.click(screen.getByTestId('settings-lock-toggle'));
    fireEvent.change(await screen.findByTestId('lock-setup-pin'), { target: { value: '1234' } });
    fireEvent.change(screen.getByTestId('lock-setup-pin2'), { target: { value: '9999' } });
    fireEvent.click(screen.getByTestId('lock-setup-save'));
    expect(await screen.findByTestId('lock-setup-error')).toBeTruthy(); // mismatch

    fireEvent.change(screen.getByTestId('lock-setup-pin2'), { target: { value: '1234' } });
    fireEvent.click(screen.getByTestId('lock-timeout-300'));
    fireEvent.click(screen.getByTestId('lock-setup-save'));
    await waitFor(() => {
      const config = readLockConfig();
      expect(config?.timeoutSec).toBe(300);
      expect(config?.pinHash).toMatch(/^[0-9a-f]{64}$/); // hashed, never the raw pin
    });

    // #282: disabling is a GUARDED act now — the current PIN answers
    fireEvent.click(screen.getByTestId('settings-lock-toggle'));
    await screen.findByTestId('lock-disarm-sheet');
    expect(readLockConfig()).not.toBeNull(); // nothing until the challenge
    // a wrong 8-digit try errors and keeps the lock armed
    fireEvent.change(screen.getByTestId('lock-disarm-pin'), { target: { value: '99999999' } });
    expect(await screen.findByTestId('lock-disarm-error')).toBeTruthy();
    expect(readLockConfig()).not.toBeNull();
    // the real PIN disarms
    fireEvent.change(screen.getByTestId('lock-disarm-pin'), { target: { value: '1234' } });
    await waitFor(() => expect(readLockConfig()).toBeNull());
  }, 15_000);
});

describe('Settings screens (user identity, scripted server)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
    resetApiCapabilitiesCache(); // each test scripts its own /health
  });

  /** the push-capable browser surface happy-dom lacks */
  const installPushEnv = () => {
    const subscription = {
      endpoint: 'https://push.example/settings',
      toJSON: () => ({ keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const pushManager = {
      getSubscription: vi.fn().mockResolvedValue(null),
      subscribe: vi.fn().mockResolvedValue(subscription),
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ pushManager }) },
    });
    Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { requestPermission: vi.fn().mockResolvedValue('granted') },
    });
    return pushManager;
  };

  it('shows the sync card on the settings tab', async () => {
    renderAppAsUser('/settings', {
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false }, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }),
      },
    });
    await screen.findByTestId('settings-sync-row');
    expect(screen.getByTestId('settings-global-row')).toBeTruthy();
  }, 15_000);

  it('shows user rows; the connections sheet lists bank links', async () => {
    renderAppAsUser('/settings/global', {
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: true, push: false }, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }),
        'GET /gocardless/connections': () => [{ gcAccountId: 'g1', iban: 'NL69INGB0123456789', lastFetchAt: null }],
      },
    });

    await screen.findByTestId('screen-settings-global');
    expect(await screen.findByTestId('settings-friends-row')).toBeTruthy();
    // #159: the devices door moved here from the profile
    expect(screen.getByTestId('settings-devices-row')).toBeTruthy();
    fireEvent.click(await screen.findByTestId('settings-connections-row'));
    await waitFor(() => expect(screen.getByText('NL69INGB0123456789')).toBeTruthy());
  }, 15_000);

  it('push toggle subscribes with the server VAPID key and registers the endpoint', async () => {
    const pushManager = installPushEnv();
    const registrations: unknown[] = [];
    renderAppAsUser('/settings/global', {
      api: {
        'GET /health': () => ({
          status: 'ok',
          capabilities: { gocardless: false, push: true, vapidPublicKey: 'BPtest-key_123' },
          protocol: CLIENT_PROTOCOL,
          minClientProtocol: 1,
        }),
        'POST /me/push-subscriptions': (body) => {
          registrations.push(body);
          return {};
        },
      },
    });

    fireEvent.click(await screen.findByTestId('settings-push-toggle'));
    await waitFor(() => expect(registrations).toHaveLength(1));
    expect(pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(registrations[0]).toMatchObject({ endpoint: 'https://push.example/settings' });
    await waitFor(() => expect(screen.getByTestId('settings-push-state').textContent?.length).toBeGreaterThan(0));
  }, 15_000);

  it('user sign-out keeps the local database (sync is the source of truth)', async () => {
    renderAppAsUser('/settings', {
      api: { 'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false }, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }) },
    });
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-signout'));
    expect(await screen.findByTestId('screen-login')).toBeTruthy();
    expect(useSession.getState().identity).toBeNull();
    const dbs = await indexedDB.databases();
    expect(dbs.some((d) => d.name === USER_TEST_DB)).toBe(true); // data survives
  }, 15_000);

  it('account deletion requires the typed word, calls the api and wipes the device', async () => {
    let deleted = false;
    // lives on the PROFILE screen now (user request: identity-level danger)
    renderAppAsUser('/profile', {
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false }, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }),
        'DELETE /me': () => {
          deleted = true;
          return { deleted: true };
        },
      },
    });
    await screen.findByTestId('screen-profile');
    fireEvent.click(await screen.findByTestId('settings-delete-account'));

    // the confirm stays disarmed until the exact word is typed
    const confirm = (await screen.findByTestId('delete-account-confirm')) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('delete-account-input'), { target: { value: 'nope' } });
    expect((screen.getByTestId('delete-account-confirm') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('delete-account-input'), { target: { value: 'delete' } });
    expect((screen.getByTestId('delete-account-confirm') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('delete-account-confirm'));
    expect(await screen.findByTestId('screen-login')).toBeTruthy();
    expect(deleted).toBe(true);
    expect(useSession.getState().identity).toBeNull();
    // unlike sign-out, deletion FORGETS the device copy
    await waitFor(async () => {
      const dbs = await indexedDB.databases();
      expect(dbs.some((d) => d.name === USER_TEST_DB)).toBe(false);
    });
  }, 15_000);

  it('#307: deletion in flight narrates the stage and refuses dismissal', async () => {
    let release: (() => void) | undefined;
    renderAppAsUser('/profile', {
      api: {
        // a slow server erase — resolved by hand below
        'DELETE /me': () =>
          new Promise((resolve) => {
            release = () => resolve({ deleted: true });
          }),
      },
    });
    await screen.findByTestId('screen-profile');
    fireEvent.click(await screen.findByTestId('settings-delete-account'));
    fireEvent.change(await screen.findByTestId('delete-account-input'), { target: { value: 'delete' } });
    fireEvent.click(screen.getByTestId('delete-account-confirm'));

    // the running stage names itself (server erase first — the slow one)
    const progress = await screen.findByTestId('delete-account-progress');
    expect(progress.textContent).toContain('Deleting your account on the server');
    // a dismissal attempt mid-run is refused with the busy note
    fireEvent.keyDown(window, { key: 'Escape' });
    const note = await screen.findByTestId('sheet-busy-note');
    expect(note.textContent).toContain('still running');
    expect(screen.getByTestId('delete-account-progress')).toBeTruthy(); // sheet stayed

    // the server answers — wipe + sign-out land as before
    release?.();
    expect(await screen.findByTestId('screen-login')).toBeTruthy();
    expect(useSession.getState().identity).toBeNull();
  }, 15_000);
});
