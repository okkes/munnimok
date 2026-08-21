// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER_TEST_DB, renderAppAsUser } from '@/test/harness';

const ME = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
const member = (userId: string, name: string, role: string) => ({ userId, displayName: name, role, picture: null });

/** one linked feed account + one space-owned manual account */
const seedRows = async () => {
  const { MunniDB } = await import('@/db/schema');
  const { Repo } = await import('@/db/repo');
  const { DexieBackend } = await import('@/db/backend');
  const { HlcClock } = await import('@/sync/hlc');
  const db = new MunniDB(USER_TEST_DB);
  const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
  await repo.upsert('account', 'feed-1', 'feedacct-1', {
    name: 'ING Betaal',
    type: 'checking',
    source: 'gocardless',
    currency: 'EUR',
    balanceCents: 5000,
    iban: 'NL69INGB0123456789',
  });
  await repo.upsert('accountLink', 's-user', 'link-1', { feedSpaceId: 'feed-1', accountId: 'feedacct-1', type: 'checking' });
  await repo.upsert('account', 's-user', 'manual-1', {
    name: 'Cash jar',
    type: 'cash',
    source: 'manual',
    currency: 'EUR',
    balanceCents: 1000,
  });
  db.close();
};

describe('SpaceAccountsScreen (#284 reader gating)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('a reader sees the view-only note; every mutating affordance stands down', async () => {
    await seedRows();
    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Personal', kind: 'shared' }],
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false } }),
        'GET /me': () => ({ userId: ME, displayName: 'Me' }),
        'GET /me/spaces': () => ['s-user', 'feed-1'],
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-1' }],
        'GET /spaces/s-user/members': () => [member(BOB, 'Bob', 'owner'), member(ME, 'Me', 'reader')],
        'GET /spaces/s-user/accounts': () => [{ id: 'srv-1', feedSpaceId: 'feed-1', accountId: 'feedacct-1' }],
      },
    });

    // the quiet note lands once the role resolves…
    await screen.findByTestId('space-accounts-reader-note', {}, { timeout: 5000 });
    // …and the add/attach doors are gone with it
    expect(screen.queryByTestId('space-accounts-add')).toBeNull();
    expect(screen.queryByTestId('space-accounts-attach')).toBeNull();

    // the info sheet stays READABLE; detach, type change and rename don't
    fireEvent.click(await screen.findByTestId('space-account-link-1'));
    const sheet = await screen.findByTestId('space-account-info');
    expect(sheet.textContent).toContain('ING Betaal');
    expect(screen.queryByTestId('space-account-sheet-detach')).toBeNull();
    expect(screen.queryByTestId('account-type-row')).toBeNull();
    expect((screen.getByTestId('space-account-rename') as HTMLInputElement).readOnly).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('space-account-info')).toBeNull());

    // a manual row opens the read-only info sheet, NOT the editor
    fireEvent.click(await screen.findByTestId('space-account-manual-1'));
    expect(await screen.findByTestId('space-account-info')).toBeTruthy();
    expect(screen.queryByTestId('acctedit-name')).toBeNull();
  }, 15_000);

  it('a contributor keeps the mutating affordances (no reader note)', async () => {
    await seedRows();
    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Personal', kind: 'shared' }],
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false } }),
        'GET /me': () => ({ userId: ME, displayName: 'Me' }),
        'GET /me/spaces': () => ['s-user', 'feed-1'],
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-1' }],
        'GET /spaces/s-user/members': () => [member(BOB, 'Bob', 'owner'), member(ME, 'Me', 'contributor')],
        'GET /spaces/s-user/accounts': () => [{ id: 'srv-1', feedSpaceId: 'feed-1', accountId: 'feedacct-1' }],
      },
    });

    await screen.findByTestId('space-account-link-1');
    expect(await screen.findByTestId('space-accounts-add')).toBeTruthy();
    expect(screen.getByTestId('space-accounts-attach')).toBeTruthy();
    expect(screen.queryByTestId('space-accounts-reader-note')).toBeNull();
  }, 15_000);
});
