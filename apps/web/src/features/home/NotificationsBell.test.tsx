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

    // a row leads to where the decision is made
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

  /** the device's list before the app opens: one plan row about `spaceId`, this release already seen */
  async function seedInbox(spaceId: string) {
    const store = new DexieBackend(new MunniDB(USER_TEST_DB));
    await appendNotification(store, 'planOverspent', { n: '1', names: 'Groceries', spaceId }, `plan_${spaceId}`);
    await store.metaPut('whatsNewSeenVersion', latestWhatsNewVersion());
    await store.metaPut('activeSpaceId', 's-user');
    const [entry] = await readInbox(store);
    store.close();
    return entry;
  }

  const spaces = [
    { id: 's-user', name: 'Personal' },
    { id: 's-trip', name: 'Trip', kind: 'shared' as const },
  ];

  it('#551: a row says which space it is about and opens its screen in that space', async () => {
    const entry = await seedInbox('s-trip');
    renderAppAsUser('/home', {
      spaces,
      api: {
        'GET /friends': () => ({ friends: [], sentPending: [], receivedPending: [] }),
        'GET /me/invites': () => [],
      },
    });
    await screen.findByTestId('screen-home');
    fireEvent.click(screen.getByTestId('home-notifications'));
    await waitFor(() => expect(screen.getByTestId(`notif-inbox-meta-${entry.id}`).textContent).toContain('Trip'), { timeout: 5000 });

    fireEvent.click(screen.getByTestId(`notif-inbox-${entry.id}`));
    await screen.findByTestId('screen-planning', {}, { timeout: 5000 });
    const db = new MunniDB(USER_TEST_DB);
    await waitFor(async () => expect((await db.meta.get('activeSpaceId'))?.value).toBe('s-trip'), { timeout: 5000 });
    db.close();
  }, 15_000);

  it('#580: Clear all empties the list and tells the person’s other devices', async () => {
    const entry = await seedInbox('s-user');
    const puts: unknown[] = [];
    renderAppAsUser('/home', {
      spaces,
      api: {
        'GET /friends': () => ({ friends: [], sentPending: [], receivedPending: [] }),
        'GET /me/invites': () => [],
        'GET /me/notifications/cleared': () => ({ clearedAt: null }),
        'PUT /me/notifications/cleared': (body) => {
          puts.push(body);
          return body;
        },
      },
    });
    await screen.findByTestId('screen-home');
    fireEvent.click(screen.getByTestId('home-notifications'));
    await screen.findByTestId(`notif-inbox-${entry.id}`, {}, { timeout: 5000 });

    fireEvent.click(screen.getByTestId('notif-clear'));
    expect(await screen.findByTestId('notif-empty', {}, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(screen.queryByTestId('notif-clear')).toBeNull();
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
