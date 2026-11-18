// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER_TEST_DB, renderAppAsUser } from '@/test/harness';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { appendNotification, readInbox } from '@/application/notifications';
import { latestWhatsNewVersion } from '@/features/help/releaseNotes';

describe('NotificationsBell (user identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('counts pending requests + invites + the fresh what’s-new; rows lead to their screens', async () => {
    renderAppAsUser('/home', {
      api: {
        'GET /friends': () => ({
          friends: [],
          sentPending: [],
          receivedPending: [{ id: 'r1', fromUserId: 'u-carol', fromName: 'Carol' }],
        }),
        'GET /me/invites': () => [
          { id: 'i1', spaceId: 's-shared', spaceName: 'Household', fromName: 'Bob' },
        ],
        'GET /me': () => ({ userId: 'test-user' }),
      },
    });
    await screen.findByTestId('screen-home');

    // 2 server alerts + 1 unread inbox entry (this release's what's-new)
    await waitFor(() => expect(screen.getByTestId('home-notifications-badge').textContent).toBe('3'), { timeout: 5000 });

    fireEvent.click(screen.getByTestId('home-notifications'));
    expect((await screen.findByTestId('notif-request-r1')).textContent).toContain('Carol');
    expect(screen.getByTestId('notif-invite-i1').textContent).toContain('Household');
    // #614: what is about no space sits under its own name
    expect(screen.getByTestId('notif-group-general').textContent).toBe('General');

    fireEvent.click(screen.getByTestId('notif-invite-i1'));
    expect(await screen.findByTestId('screen-spaces')).toBeTruthy();
  }, 15_000);

  it('opening the Notifications tab clears the inbox share of the badge (arc 6)', async () => {
    renderAppAsUser('/home', {
      api: {
        'GET /friends': () => ({ friends: [], sentPending: [], receivedPending: [] }),
        'GET /me/invites': () => [],
      },
    });
    await screen.findByTestId('screen-home');
    // fresh identity: the release's what's-new is the one unread entry
    await waitFor(() => expect(screen.getByTestId('home-notifications-badge').textContent).toBe('1'), { timeout: 5000 });

    // opening the tab stamps notifSeenAt — the badge clears, the row stays
    fireEvent.click(screen.getByTestId('home-notifications'));
    await waitFor(() => {
      expect(document.querySelector('[data-testid^="notif-inbox-"]')).toBeTruthy();
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('home-notifications-badge')).toBeNull(), { timeout: 5000 });
  }, 15_000);

  it('the Activity tab keeps the audit trail behind the same bell', async () => {
    renderAppAsUser('/home', {
      api: {
        'GET /friends': () => ({ friends: [], sentPending: [], receivedPending: [] }),
        'GET /me/invites': () => [],
      },
    });
    await screen.findByTestId('screen-home');
    fireEvent.click(await screen.findByTestId('home-notifications'));
    fireEvent.click(await screen.findByTestId('notif-tab-activity'));
    expect(await screen.findByTestId('history-empty')).toBeTruthy();
  }, 15_000);

  it('once per session the app files this device with the server again — no visit to Settings needed', async () => {
    const subscription = { endpoint: 'https://push.example/bell', toJSON: () => ({ keys: { p256dh: 'p', auth: 'a' } }) };
    const pushManager = { getSubscription: () => Promise.resolve(subscription) };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve({ pushManager }) } });
    Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
    Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'default' } });
    const registrations: unknown[] = [];
    let listAsked = 0;
    try {
      renderAppAsUser('/home', {
        api: {
          'GET /friends': () => ({ friends: [], sentPending: [], receivedPending: [] }),
          'GET /me/invites': () => {
            listAsked += 1;
            return [];
          },
          'POST /me/push-subscriptions': (body) => {
            registrations.push(body);
            return {};
          },
        },
      });
      await screen.findByTestId('screen-home');
      // the server may have lost the device, or still know it under the account that used it before
      await waitFor(() => expect(registrations).toEqual([expect.objectContaining({ endpoint: 'https://push.example/bell' })]), { timeout: 5000 });

      // a push reaching the open app reloads the list — the registration is not sent a second time
      const before = listAsked;
      window.dispatchEvent(new Event('munni-push'));
      await waitFor(() => expect(listAsked).toBeGreaterThan(before));
      expect(registrations).toHaveLength(1);
    } finally {
      Reflect.deleteProperty(navigator, 'serviceWorker');
      Reflect.deleteProperty(window, 'PushManager');
      Reflect.deleteProperty(window, 'Notification');
    }
  }, 15_000);

  /** the device's list before the app opens: one digest row per space named, this release already seen; answers the first */
  async function seedInbox(...spaceIds: string[]) {
    const store = new DexieBackend(new MunniDB(USER_TEST_DB));
    for (const spaceId of spaceIds) await appendNotification(store, 'digest', { n: '3', spaceId }, `digest_${spaceId}`);
    await store.metaPut('whatsNewSeenVersion', latestWhatsNewVersion());
    await store.metaPut('activeSpaceId', 's-user');
    const entries = await readInbox(store);
    store.close();
    return entries.find((entry) => entry.payload?.spaceId === spaceIds[0])!;
  }

  const spaces = [
    { id: 's-user', name: 'Personal' },
    { id: 's-trip', name: 'Trip', kind: 'shared' as const },
  ];

  it('#614: the bell shows the open space’s rows under its name; another space’s row waits in that space', async () => {
    const entry = await seedInbox('s-user', 's-trip');
    renderAppAsUser('/home', {
      spaces,
      api: {
        'GET /friends': () => ({ friends: [], sentPending: [], receivedPending: [] }),
        'GET /me/invites': () => [],
      },
    });
    await screen.findByTestId('screen-home');
    // the badge counts what the bell will show: the row about Trip is not in it
    await waitFor(() => expect(screen.getByTestId('home-notifications-badge').textContent).toBe('1'), { timeout: 5000 });

    fireEvent.click(screen.getByTestId('home-notifications'));
    await screen.findByTestId(`notif-inbox-${entry.id}`, {}, { timeout: 5000 });
    expect(screen.getByTestId('notif-group-space').textContent).toBe('Personal');
    expect(document.querySelectorAll('[data-testid^="notif-inbox-meta-"]')).toHaveLength(1);
    expect(screen.queryByTestId('notif-group-general')).toBeNull();

    // #551: the row opens its screen in the space it is about
    fireEvent.click(screen.getByTestId(`notif-inbox-${entry.id}`));
    await screen.findByTestId('screen-insights', {}, { timeout: 5000 });
  }, 15_000);

  it('#640: a failed sync is in the bell with the party and the reason, and opens the screen its connection is on', async () => {
    const store = new DexieBackend(new MunniDB(USER_TEST_DB));
    const failed = { code: 'provider_changed', messageKey: 'connect.error.provider_changed', userAction: 'none' };
    await store.connectorConnPut({ id: 'c-bol', provider: 'bol', sessionId: 'ses_1', state: 'active', refreshedAt: '2026-09-01T00:00:00Z', lastError: failed });
    await appendNotification(store, 'syncFailed', { name: 'bol.com', code: 'provider_changed', hub: 'connections', connectionId: 'c-bol' }, 'syncFailed_c-bol_provider_changed_2026-11-18');
    await store.metaPut('whatsNewSeenVersion', latestWhatsNewVersion());
    const [entry] = await readInbox(store);
    store.close();

    renderAppAsUser('/home', {
      api: {
        'GET /friends': () => ({ friends: [], sentPending: [], receivedPending: [] }),
        'GET /me/invites': () => [],
      },
    });
    await screen.findByTestId('screen-home');
    fireEvent.click(await screen.findByTestId('home-notifications'));
    const row = await screen.findByTestId(`notif-inbox-${entry.id}`, {}, { timeout: 5000 });
    expect(row.textContent).toContain('bol.com could not sync: The party changed its site');

    fireEvent.click(row);
    await screen.findByTestId('screen-connections', {}, { timeout: 5000 });
  }, 15_000);

  it('#580, #614: Clear all empties what the bell shows, tells the person’s other devices, and leaves another space’s rows', async () => {
    const entry = await seedInbox('s-user', 's-trip');
    const puts: { clearedAt: string; scopes: string[] }[] = [];
    renderAppAsUser('/home', {
      spaces,
      api: {
        'GET /friends': () => ({ friends: [], sentPending: [], receivedPending: [] }),
        'GET /me/invites': () => [],
        'GET /me/notifications/cleared': () => ({ clearedAt: null }),
        'PUT /me/notifications/cleared': (body) => {
          const sent = body as { clearedAt: string; scopes: string[] };
          puts.push(sent);
          return { clearedAt: null, scopes: Object.fromEntries(sent.scopes.map((scope) => [scope, sent.clearedAt])) };
        },
      },
    });
    await screen.findByTestId('screen-home');
    fireEvent.click(screen.getByTestId('home-notifications'));
    await screen.findByTestId(`notif-inbox-${entry.id}`, {}, { timeout: 5000 });

    fireEvent.click(screen.getByTestId('notif-clear'));
    expect(await screen.findByTestId('notif-empty', {}, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].scopes).toEqual(['general', 's-user']);
    expect(screen.queryByTestId('notif-clear')).toBeNull();
    const store = new DexieBackend(new MunniDB(USER_TEST_DB));
    try {
      expect((await readInbox(store)).map((row) => row.payload?.spaceId)).toEqual(['s-trip']);
    } finally {
      store.close();
    }
  }, 15_000);

  it('#580: a clear made on another device empties the list here too', async () => {
    const entry = await seedInbox('s-user');
    renderAppAsUser('/home', {
      spaces,
      api: {
        'GET /friends': () => ({ friends: [], sentPending: [], receivedPending: [] }),
        'GET /me/invites': () => [],
        'GET /me/notifications/cleared': () => ({ clearedAt: new Date(Date.now() + 1000).toISOString() }),
      },
    });
    await screen.findByTestId('screen-home');
    const store = new DexieBackend(new MunniDB(USER_TEST_DB));
    try {
      await waitFor(async () => expect(await readInbox(store)).toEqual([]), { timeout: 5000 });
    } finally {
      store.close();
    }
    fireEvent.click(screen.getByTestId('home-notifications'));
    expect(await screen.findByTestId('notif-empty')).toBeTruthy();
    expect(screen.queryByTestId(`notif-inbox-${entry.id}`)).toBeNull();
  }, 15_000);
});
