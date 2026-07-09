// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER_TEST_DB, renderAppAsUser } from '@/test/harness';

describe('NotificationsBell (user identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('counts pending requests + invites; rows lead to their screens', async () => {
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

    expect((await screen.findByTestId('home-notifications-badge')).textContent).toBe('2');

    fireEvent.click(screen.getByTestId('home-notifications'));
    expect((await screen.findByTestId('notif-request-r1')).textContent).toContain('Carol');
    expect(screen.getByTestId('notif-invite-i1').textContent).toContain('Household');

    // a row leads to where the decision is made
    fireEvent.click(screen.getByTestId('notif-invite-i1'));
    expect(await screen.findByTestId('screen-spaces')).toBeTruthy();
  }, 15_000);

  it('stays quiet with nothing pending', async () => {
    renderAppAsUser('/home', {
      api: {
        'GET /friends': () => ({ friends: [], sentPending: [], receivedPending: [] }),
        'GET /me/invites': () => [],
      },
    });
    await screen.findByTestId('screen-home');
    await screen.findByTestId('home-notifications');
    expect(screen.queryByTestId('home-notifications-badge')).toBeNull();

    fireEvent.click(screen.getByTestId('home-notifications'));
    expect(await screen.findByTestId('notif-empty')).toBeTruthy();
  }, 15_000);
});
