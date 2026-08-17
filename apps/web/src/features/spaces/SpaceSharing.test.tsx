// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER_TEST_DB, renderAppAsUser } from '@/test/harness';

const ME = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
const CARA = '33333333-3333-3333-3333-333333333333';

const member = (userId: string, name: string, role: string) => ({ userId, displayName: name, role, picture: null });

describe('SpaceSharing (user identity, scripted server)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('a locked space disables inviting with an explainer (arc 4)', async () => {
    renderAppAsUser('/spaces/s-user/members', {
      spaces: [{ id: 's-user', name: 'Personal', inviteLock: 1 }],
      api: {
        'GET /me': () => ({ userId: ME, displayName: 'Me' }),
        'GET /me/invites': () => [],
        'GET /spaces/s-user/members': () => [member(ME, 'Me', 'owner')],
        'GET /friends': () => ({ friends: [{ userId: BOB, displayName: 'Bob' }], sentPending: [], receivedPending: [] }),
        'GET /spaces/s-user/invites': () => [],
      },
    });

    // the explainer replaces every invite tool — no invite door, no
    // add-friend form; the lock lifts in the Settings tab now
    expect(await screen.findByTestId('space-invite-locked')).toBeTruthy();
    expect(screen.queryByTestId('space-invite-open')).toBeNull();
    expect(screen.queryByTestId('space-addfriend-input')).toBeNull();
  }, 15_000);

  it('owner invites via the sheet: search narrows, role travels, revoke works (#170/#171)', async () => {
    let outgoing: { id: string; toUserId: string; toName: string; role: string }[] = [];
    const sentBodies: unknown[] = [];
    renderAppAsUser('/spaces/s-user/members', {
      api: {
        'GET /me': () => ({ userId: ME, displayName: 'Me' }),
        'GET /me/invites': () => [],
        'GET /spaces/s-user/members': () => [member(ME, 'Me', 'owner')],
        'GET /friends': () => ({
          friends: [
            { userId: BOB, displayName: 'Bob' },
            { userId: CARA, displayName: 'Cara' },
          ],
          sentPending: [],
          receivedPending: [],
        }),
        'GET /spaces/s-user/invites': () => outgoing,
        'POST /spaces/s-user/invites': (body) => {
          sentBodies.push(body);
          outgoing = [{ id: 'inv1', toUserId: BOB, toName: 'Bob', role: 'reader' }];
          return {};
        },
        'DELETE /spaces/invites/inv1': () => {
          outgoing = [];
          return {};
        },
      },
    });

    // the badge strip is gone — ONE door opens the invite sheet
    fireEvent.click(await screen.findByTestId('space-invite-open'));
    await screen.findByTestId(`space-invite-row-${CARA}`);
    fireEvent.change(screen.getByTestId('space-invite-search'), { target: { value: 'bo' } });
    await waitFor(() => expect(screen.queryByTestId(`space-invite-row-${CARA}`)).toBeNull());

    // expanding shows the FULL id + the role picker (contributor default)
    fireEvent.click(screen.getByTestId(`space-invite-row-${BOB}`));
    expect((await screen.findByTestId('space-invite-full-id')).textContent).toBe(BOB);
    fireEvent.click(screen.getByTestId('space-invite-role-reader'));
    fireEvent.click(screen.getByTestId('space-invite-send'));

    // real feedback: sent note + a pending row with a revoke control
    expect(await screen.findByTestId('space-invite-sent')).toBeTruthy();
    await screen.findByTestId('space-invite-revoke-inv1');
    expect(sentBodies[0]).toMatchObject({ toUserId: BOB, role: 'reader', spaceName: 'Personal' });

    fireEvent.click(screen.getByTestId('space-invite-revoke-inv1'));
    await waitFor(() => expect(screen.queryByTestId('space-invite-revoke-inv1')).toBeNull());
  }, 15_000);

  it('member rows open the sheet: member-since, role change and kick live there (#172)', async () => {
    let members = [
      member(ME, 'Me', 'owner'),
      { ...member(BOB, 'Bob', 'contributor'), joinedAt: '2026-03-05T12:00:00Z' },
    ];
    const roleChanges: unknown[] = [];
    let kickUrl: URL | null = null;
    renderAppAsUser('/spaces/s-user/members', {
      api: {
        'GET /me': () => ({ userId: ME, displayName: 'Me' }),
        'GET /me/invites': () => [],
        'GET /spaces/s-user/members': () => members,
        'GET /friends': () => ({ friends: [], sentPending: [], receivedPending: [] }),
        'GET /spaces/s-user/invites': () => [],
        [`PUT /spaces/s-user/members/${BOB}/role`]: (body) => {
          roleChanges.push(body);
          members = [members[0], { ...members[1], role: 'reader' }];
          return {};
        },
        [`DELETE /spaces/s-user/members/${BOB}`]: (_body, url) => {
          kickUrl = url;
          members = [members[0]];
          return {};
        },
      },
    });

    // the inline select and X are gone — the row opens the member sheet
    expect(screen.queryByTestId(`space-role-${BOB}`)).toBeNull();
    expect(screen.queryByTestId(`space-kick-${BOB}`)).toBeNull();
    fireEvent.click(await screen.findByTestId(`member-row-${BOB}`));
    expect((await screen.findByTestId('member-sheet-id')).textContent).toBe(BOB);
    expect(screen.getByTestId('member-sheet-since').textContent).toContain('2026');

    // owner changes the role from the sheet — the space name rides along
    fireEvent.click(screen.getByTestId('member-sheet-role-reader'));
    await waitFor(() => expect(roleChanges).toEqual([{ role: 'reader', spaceName: 'Personal' }]));

    // kicking still asks first; the DELETE carries the name for the push
    fireEvent.click(screen.getByTestId('member-sheet-remove'));
    expect((await screen.findByTestId('space-kick-body')).textContent).toContain('Bob');
    fireEvent.click(screen.getByTestId('space-kick-confirm'));
    await waitFor(() => expect(screen.queryByTestId(`member-row-${BOB}`)).toBeNull());
    expect(kickUrl!.searchParams.get('spaceName')).toBe('Personal');
  }, 15_000);

  it('adding a NEW person carries the space and the picked role (#169)', async () => {
    const friendRequests: unknown[] = [];
    renderAppAsUser('/spaces/s-user/members', {
      api: {
        'GET /me': () => ({ userId: ME, displayName: 'Me' }),
        'GET /me/invites': () => [],
        'GET /spaces/s-user/members': () => [member(ME, 'Me', 'owner')],
        'GET /friends': () => ({ friends: [], sentPending: [], receivedPending: [] }),
        'GET /spaces/s-user/invites': () => [],
        'POST /friends/requests': (body) => {
          friendRequests.push(body);
          return {};
        },
      },
    });

    // #195: an empty send is refused with the blocker, nothing posted
    fireEvent.click(await screen.findByTestId('space-addfriend-send'));
    expect(await screen.findByTestId('space-addfriend-blocker')).toBeTruthy();
    expect(friendRequests).toEqual([]);

    // the note says what accepting will do; the role picker rides along
    expect(screen.getByTestId('space-addfriend-autonote').textContent).toContain('Personal');
    fireEvent.change(screen.getByTestId('space-addfriend-input'), { target: { value: 'some-user-id' } });
    fireEvent.click(screen.getByTestId('space-addfriend-role-reader'));
    fireEvent.click(screen.getByTestId('space-addfriend-send'));
    expect(await screen.findByTestId('space-addfriend-sent')).toBeTruthy();
    expect(friendRequests).toEqual([
      { toUserId: 'some-user-id', spaceId: 's-user', role: 'reader', spaceName: 'Personal' },
    ]);
  }, 15_000);

  it('a reader sees the read-only note on space settings', async () => {
    renderAppAsUser('/spaces/s-user', {
      api: {
        'GET /me': () => ({ userId: ME, displayName: 'Me' }),
        'GET /me/invites': () => [],
        'GET /spaces/s-user/members': () => [member(BOB, 'Bob', 'owner'), member(ME, 'Me', 'reader')],
        'GET /friends': () => ({ friends: [], sentPending: [], receivedPending: [] }),
        'GET /spaces/s-user/invites': () => new Response('', { status: 403 }), // not an owner
      },
    });

    // the settings screen learns the role through useMyRole now
    expect(await screen.findByTestId('space-reader-note')).toBeTruthy();
  }, 15_000);

  it('a member leaves the space from space settings: server removal, then local purge', async () => {
    const removals: string[] = [];
    renderAppAsUser('/spaces/s-user', {
      api: {
        'GET /me': () => ({ userId: ME, displayName: 'Me' }),
        'GET /me/invites': () => [],
        'GET /spaces/s-user/members': () => [member(BOB, 'Bob', 'owner'), member(ME, 'Me', 'contributor')],
        'GET /friends': () => ({ friends: [], sentPending: [], receivedPending: [] }),
        'GET /spaces/s-user/invites': () => new Response('', { status: 403 }),
        [`DELETE /spaces/s-user/members/${ME}`]: () => {
          removals.push(ME);
          return {};
        },
      },
    });

    // two-tap confirm, mirroring delete
    fireEvent.click(await screen.findByTestId('space-edit-leave'));
    await screen.findByTestId('space-leave-confirm-note');
    fireEvent.click(screen.getByTestId('space-edit-leave'));

    await screen.findByTestId('screen-spaces', {}, { timeout: 5000 });
    expect(removals).toEqual([ME]);
    // the local copy of the space is gone (feed access ends server-side)
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB(USER_TEST_DB);
    await waitFor(async () => expect(await db.spaces.get('s-user')).toBeUndefined());
    db.close();
  }, 15_000);

  it('a reader sees no invite tools on the members screen', async () => {
    // reached from Settings now — the space-settings doors are gone
    renderAppAsUser('/spaces/s-user/members', {
      api: {
        'GET /me': () => ({ userId: ME, displayName: 'Me' }),
        'GET /me/invites': () => [],
        'GET /spaces/s-user/members': () => [member(BOB, 'Bob', 'owner'), member(ME, 'Me', 'reader')],
        'GET /friends': () => ({ friends: [], sentPending: [], receivedPending: [] }),
        'GET /spaces/s-user/invites': () => new Response('', { status: 403 }), // not an owner
      },
    });

    await screen.findByTestId('screen-space-members');
    await waitFor(() => expect(screen.queryByTestId('space-addfriend-input')).toBeNull());
    expect(screen.queryByTestId('space-invite-open')).toBeNull();
    // #172: rows still open the sheet, but it is read-only info — no
    // role control, no remove door
    fireEvent.click(await screen.findByTestId(`member-row-${BOB}`));
    await screen.findByTestId('member-sheet');
    expect(await screen.findByTestId('member-sheet-rolelabel')).toBeTruthy();
    expect(screen.queryByTestId('member-sheet-role-reader')).toBeNull();
    expect(screen.queryByTestId('member-sheet-remove')).toBeNull();
  }, 15_000);

  it('pending space invites show on the Spaces tab; accepting clears the banner', async () => {
    let invites = [
      { id: 'i1', spaceId: 's-new', spaceName: 'Big Family', fromUserId: BOB, fromName: 'Bob', role: 'contributor' },
    ];
    const responses: string[] = [];
    renderAppAsUser('/spaces', {
      api: {
        'GET /me/invites': () => invites,
        'POST /spaces/invites/i1/accept': () => {
          responses.push('accept');
          invites = [];
          return {};
        },
      },
    });

    const banner = await screen.findByTestId('space-invites');
    expect(banner.textContent).toContain('Big Family');
    expect(banner.textContent).toContain('Bob');

    fireEvent.click(screen.getByTestId('space-invite-accept-i1'));
    await waitFor(() => expect(screen.queryByTestId('space-invites')).toBeNull());
    expect(responses).toEqual(['accept']);
  }, 15_000);
});
