// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
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

  it('hides user-only rows for the demo identity', async () => {
    renderApp('/settings/global');
    await screen.findByTestId('screen-settings-global');
    expect(screen.queryByTestId('settings-friends-row')).toBeNull();
    expect(screen.queryByTestId('settings-connections-row')).toBeNull();
    expect(screen.queryByTestId('settings-admin-row')).toBeNull();
  });

  it('theme toggle flips the document theme', async () => {
    renderApp('/settings/global');
    await screen.findByTestId('screen-settings-global');
    expect(document.documentElement.dataset.theme).toBe('light');
    fireEvent.click(screen.getByTestId('settings-theme-toggle'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('munni_theme')).toBe('dark');
  });

  it('language sheet switches the UI language and persists it', async () => {
    renderApp('/settings/global');
    await screen.findByTestId('screen-settings-global');
    fireEvent.click(screen.getByTestId('settings-language-row'));
    fireEvent.click(await screen.findByTestId('lang-option-nl'));
    expect(localStorage.getItem('munni_lang')).toBe('nl');
    // the screen title re-renders in Dutch
    await waitFor(() => expect(screen.getByTestId('screen-settings-global').textContent).toContain('Algemene instellingen'));
  });

  it('navigates to accounts from its row', async () => {
    renderApp('/settings/global');
    await screen.findByTestId('screen-settings-global');
    fireEvent.click(screen.getByTestId('settings-accounts-row'));
    expect(await screen.findByTestId('screen-accounts')).toBeTruthy();
  });

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

    // the user proved themself at unlock time — disabling is direct
    fireEvent.click(screen.getByTestId('settings-lock-toggle'));
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
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false } }),
      },
    });
    await screen.findByTestId('settings-sync-row');
    expect(screen.getByTestId('settings-global-row')).toBeTruthy();
  }, 15_000);

  it('shows user rows; the connections sheet lists bank links', async () => {
    renderAppAsUser('/settings/global', {
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: true, push: false } }),
        'GET /gocardless/connections': () => [{ gcAccountId: 'g1', iban: 'NL69INGB0123456789', lastFetchAt: null }],
      },
    });

    await screen.findByTestId('screen-settings-global');
    expect(await screen.findByTestId('settings-friends-row')).toBeTruthy();
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
      api: { 'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false } }) },
    });
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-signout'));
    expect(await screen.findByTestId('screen-login')).toBeTruthy();
    expect(useSession.getState().identity).toBeNull();
    const dbs = await indexedDB.databases();
    expect(dbs.some((d) => d.name === USER_TEST_DB)).toBe(true); // data survives
  }, 15_000);
});
