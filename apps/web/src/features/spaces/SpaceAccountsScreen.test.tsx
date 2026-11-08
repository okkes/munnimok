// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { CLIENT_PROTOCOL } from '@/lib/protocol';
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
    source: 'connector',
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

/** one UNATTACHED feed account — the attach candidate (#310) */
const seedCandidate = async () => {
  const { MunniDB } = await import('@/db/schema');
  const { Repo } = await import('@/db/repo');
  const { DexieBackend } = await import('@/db/backend');
  const { HlcClock } = await import('@/sync/hlc');
  const db = new MunniDB(USER_TEST_DB);
  const repo = new Repo(new DexieBackend(db), new HlcClock('t2'), { trackOutbox: false });
  await repo.upsert('account', 'feed-2', 'feedacct-2', {
    name: 'Bunq Main',
    type: 'checking',
    source: 'connector',
    currency: 'EUR',
    balanceCents: 100,
    iban: 'NL13BUNQ2025000001',
  });
  db.close();
};

/** the REST surface the attach-intent specs need (#308/#310) — the
 *  member list must agree with the kind: healSharedKind flips a space
 *  to shared the moment a fetch reports 2+ members */
const apiWithCandidate = (kind: 'personal' | 'shared') => ({
  'GET /health': () => ({ status: 'ok', capabilities: {}, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }),
  'GET /me': () => ({ userId: ME, displayName: 'Me' }),
  'GET /me/spaces': () => ['s-user', 'feed-1', 'feed-2'],
  'GET /me/feeds': () => [{ feedSpaceId: 'feed-1' }, { feedSpaceId: 'feed-2' }],
  'GET /spaces/s-user/members': () =>
    kind === 'shared' ? [member(ME, 'Me', 'owner'), member(BOB, 'Bob', 'contributor')] : [member(ME, 'Me', 'owner')],
  'GET /spaces/s-user/accounts': () => [{ id: 'srv-1', feedSpaceId: 'feed-1', accountId: 'feedacct-1' }],
});

describe('SpaceAccountsScreen (#284 reader gating · #308/#310 attach flow)', () => {
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
        'GET /health': () => ({ status: 'ok', capabilities: {}, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }),
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
        'GET /health': () => ({ status: 'ok', capabilities: {}, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }),
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
    // #305: my OWN feed's attachment never wears the shared badge
    expect(screen.queryByTestId('space-account-shared-link-1')).toBeNull();
  }, 15_000);

  it('#310: an attach intent naming a candidate opens the FINAL step — pick list skipped; #308: the shared-space warning rides along', async () => {
    await seedRows();
    await seedCandidate();
    const { setSpaceAttachIntent } = await import('@/features/accounts/openHandoff');
    setSpaceAttachIntent('feedacct-2');
    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Familie', kind: 'shared' }],
      api: apiWithCandidate('shared'),
    });

    // the sheet opened by itself on the final step: the named account
    // stands pre-picked, the pick list never mounts
    const focus = await screen.findByTestId('space-attach-focus', {}, { timeout: 10_000 });
    expect(focus.textContent).toContain('Bunq Main');
    expect(screen.queryByTestId('space-attach-candidates')).toBeNull();
    expect(await screen.findByTestId('space-attach-types', {}, { timeout: 10_000 })).toBeTruthy();
    expect(screen.getByTestId('space-attach-save')).toBeTruthy();

    // #308: attaching into a SHARED space says so, right above the button
    const warn = await screen.findByTestId('space-attach-share-warn', {}, { timeout: 10_000 });
    expect(warn.textContent).toContain('Familie');
  }, 20_000);

  it('#310: an already-attached target falls back to the plain pick list — where a manual pick still warns (#308)', async () => {
    await seedRows();
    await seedCandidate();
    const { setSpaceAttachIntent } = await import('@/features/accounts/openHandoff');
    setSpaceAttachIntent('feedacct-1'); // link-1 already attaches it here
    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Familie', kind: 'shared' }],
      api: apiWithCandidate('shared'),
    });

    // fallback: the sheet still opens, but on the pick list (no focus row)
    await screen.findByTestId('space-attach-candidates', {}, { timeout: 10_000 });
    expect(screen.queryByTestId('space-attach-focus')).toBeNull();

    // picking by hand reaches the same confirm step — warning included
    fireEvent.click(screen.getByTestId('space-attach-pick-feedacct-2'));
    expect(await screen.findByTestId('space-attach-share-warn', {}, { timeout: 10_000 })).toBeTruthy();
  }, 20_000);

  it('an account whose source this build no longer lists still renders, named after that party (prod ss 2026-10-04)', async () => {
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('t3'), { trackOutbox: false });
    // the retired integration's rows (#414 O4) carry its name as their source, and no provider
    await repo.upsert('account', 'feed-1', 'feedacct-old', {
      name: 'Oude rekening',
      type: 'checking',
      source: 'gocardless' as never,
      currency: 'EUR',
      balanceCents: 1200,
      iban: 'NL02ABNA0123456789',
    });
    await repo.upsert('accountLink', 's-user', 'link-old', { feedSpaceId: 'feed-1', accountId: 'feedacct-old', type: 'checking' });
    db.close();
    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Personal' }],
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: {}, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }),
        'GET /me': () => ({ userId: ME, displayName: 'Me' }),
        'GET /me/spaces': () => ['s-user', 'feed-1'],
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-1' }],
        'GET /spaces/s-user/members': () => [member(ME, 'Me', 'owner')],
        'GET /spaces/s-user/accounts': () => [{ id: 'srv-old', feedSpaceId: 'feed-1', accountId: 'feedacct-old' }],
      },
    });
    const row = await screen.findByTestId('space-account-link-old', {}, { timeout: 5000 });
    expect(row.textContent).toContain('Oude rekening');
    expect(row.textContent).toContain('GoCardless');
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
  }, 15_000);

  it('#445: an account a friend shared into the space never reads "not fetched any more" here — their connection lives on their phone (user ss 2026-10-08)', async () => {
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const { USER_TEST_SUB } = await import('@/test/harness');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('t3'), { trackOutbox: false });
    // Elo's ING account, fetched by Elo's connection — an id this device has no row for
    await repo.upsert('account', 'feed-elo', 'feedacct-elo', {
      name: 'ING Elo',
      type: 'checking',
      source: 'connector',
      provider: 'gocardless',
      connectionId: 'conn-elo',
      lastSyncedAt: '2026-09-30T08:00:00Z',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
    });
    await repo.upsert('accountLink', 's-user', 'link-elo', { feedSpaceId: 'feed-elo', accountId: 'feedacct-elo', type: 'checking', attachedBy: 'elo-sub', attachedByName: 'Elo' });
    // my own account, fetched by a connection that is gone from this device: that one says so
    await repo.upsert('account', 'feed-mine', 'feedacct-mine', {
      name: 'ING mine',
      type: 'checking',
      source: 'connector',
      provider: 'gocardless',
      connectionId: 'conn-gone',
      lastSyncedAt: '2026-09-30T08:00:00Z',
      currency: 'EUR',
      balanceCents: 100,
      iban: 'NL13BUNQ2025000001',
    });
    await repo.upsert('accountLink', 's-user', 'link-mine', { feedSpaceId: 'feed-mine', accountId: 'feedacct-mine', type: 'checking', attachedBy: USER_TEST_SUB, attachedByName: 'Me' });
    db.close();

    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Personal', kind: 'shared' }],
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: {}, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }),
        'GET /me': () => ({ userId: ME, displayName: 'Me' }),
        'GET /me/spaces': () => ['s-user', 'feed-elo', 'feed-mine'],
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-mine' }],
        'GET /spaces/s-user/members': () => [member(ME, 'Me', 'owner'), member(BOB, 'Elo', 'contributor')],
        'GET /spaces/s-user/accounts': () => [
          { id: 'srv-elo', feedSpaceId: 'feed-elo', accountId: 'feedacct-elo' },
          { id: 'srv-mine', feedSpaceId: 'feed-mine', accountId: 'feedacct-mine' },
        ],
      },
    });

    fireEvent.click(await screen.findByTestId('space-account-link-elo', {}, { timeout: 5000 }));
    const sheet = await screen.findByTestId('space-account-info');
    expect(sheet.textContent).toContain('Elo');
    expect(screen.queryByTestId('space-account-uncovered')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('space-account-info')).toBeNull());

    fireEvent.click(await screen.findByTestId('space-account-link-mine'));
    await screen.findByTestId('space-account-info');
    expect((await screen.findByTestId('space-account-uncovered')).textContent).toContain('Not fetched any more');
  }, 20_000);

  it('#445 r2: a friend\'s account whose link carries no name stays quiet — the feed set decides, not a default; my own nameless link still speaks (user ss 2026-10-09)', async () => {
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('t4'), { trackOutbox: false });
    // a friend's ING account, attached before links carried attachedBy — fetched by a connection this device has no row for
    await repo.upsert('account', 'feed-elo', 'feedacct-elo', {
      name: 'ING Elo',
      type: 'checking',
      source: 'connector',
      provider: 'gocardless',
      connectionId: 'conn-elo',
      lastSyncedAt: '2026-10-08T08:00:00Z',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
    });
    await repo.upsert('accountLink', 's-user', 'link-elo', { feedSpaceId: 'feed-elo', accountId: 'feedacct-elo', type: 'checking' });
    // my own account on an equally nameless link: the feed is mine, so the gone connection is mine to tell
    await repo.upsert('account', 'feed-mine', 'feedacct-mine', {
      name: 'ING mine',
      type: 'checking',
      source: 'connector',
      provider: 'gocardless',
      connectionId: 'conn-gone',
      lastSyncedAt: '2026-09-30T08:00:00Z',
      currency: 'EUR',
      balanceCents: 100,
      iban: 'NL13BUNQ2025000001',
    });
    await repo.upsert('accountLink', 's-user', 'link-mine', { feedSpaceId: 'feed-mine', accountId: 'feedacct-mine', type: 'checking' });
    db.close();

    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Personal', kind: 'shared' }],
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: {}, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }),
        'GET /me': () => ({ userId: ME, displayName: 'Me' }),
        'GET /me/spaces': () => ['s-user', 'feed-elo', 'feed-mine'],
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-mine' }],
        'GET /spaces/s-user/members': () => [member(ME, 'Me', 'owner'), member(BOB, 'Elo', 'contributor')],
        'GET /spaces/s-user/accounts': () => [
          { id: 'srv-elo', feedSpaceId: 'feed-elo', accountId: 'feedacct-elo' },
          { id: 'srv-mine', feedSpaceId: 'feed-mine', accountId: 'feedacct-mine' },
        ],
      },
    });

    // the shared badge and the quiet sheet rest on the same answer: feed-elo is not among my feeds
    await screen.findByTestId('space-account-shared-link-elo', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('space-account-link-elo'));
    const sheet = await screen.findByTestId('space-account-info');
    expect(sheet.textContent).toContain('ING Elo');
    expect(screen.queryByTestId('space-account-uncovered')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('space-account-info')).toBeNull());

    fireEvent.click(await screen.findByTestId('space-account-link-mine'));
    await screen.findByTestId('space-account-info');
    expect((await screen.findByTestId('space-account-uncovered')).textContent).toContain('Not fetched any more');
  }, 20_000);

  it('#305: an attachment on someone ELSE\'s feed wears the shared badge; space-owned rows do not', async () => {
    await seedRows();
    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Personal', kind: 'shared' }],
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: {}, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }),
        'GET /me': () => ({ userId: ME, displayName: 'Me' }),
        'GET /me/spaces': () => ['s-user', 'feed-1'],
        // feed-1 is NOT mine — I reach it through Bob's attachment
        'GET /me/feeds': () => [],
        'GET /spaces/s-user/members': () => [member(BOB, 'Bob', 'owner'), member(ME, 'Me', 'contributor')],
        'GET /spaces/s-user/accounts': () => [{ id: 'srv-1', feedSpaceId: 'feed-1', accountId: 'feedacct-1' }],
      },
    });

    expect(await screen.findByTestId('space-account-shared-link-1', {}, { timeout: 5000 })).toBeTruthy();
    // the space's own manual account stays badge-free
    expect(screen.queryByTestId('space-account-shared-manual-1')).toBeNull();
  }, 15_000);

  it('#550: the accounts stand in one segment per type — the space\'s own reading of an attached account decides', async () => {
    await seedRows();
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('t3'), { trackOutbox: false });
    await repo.upsert('account', 's-user', 'manual-loan', { name: 'DUO Studieschuld', type: 'loan', source: 'manual', currency: 'EUR', balanceCents: -100_000 });
    // the global row says checking — this space attached it as a loan
    await repo.upsert('account', 'feed-3', 'feedacct-3', { name: 'R13792519', type: 'checking', source: 'connector', currency: 'EUR', balanceCents: -43_792 });
    await repo.upsert('accountLink', 's-user', 'link-3', { feedSpaceId: 'feed-3', accountId: 'feedacct-3', type: 'loan' });
    db.close();
    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Personal', kind: 'personal' }],
      api: apiWithCandidate('personal'),
    });

    const list = await screen.findByTestId('space-accounts-list', {}, { timeout: 5000 });
    await waitFor(() => expect(list.querySelectorAll('section')).toHaveLength(3));
    const groups = [...list.querySelectorAll('section')].map((s) => s.getAttribute('data-testid'));
    expect(groups).toEqual(['space-accounts-group-checking', 'space-accounts-group-cash', 'space-accounts-group-loan']);
    const loans = screen.getByTestId('space-accounts-group-loan');
    expect(loans.textContent).toContain('Loans');
    expect(loans.querySelector('[data-testid="space-account-link-3"]')).toBeTruthy();
    expect(loans.querySelector('[data-testid="space-account-manual-loan"]')).toBeTruthy();
    expect(screen.getByTestId('space-accounts-group-cash').querySelector('[data-testid="space-account-manual-1"]')).toBeTruthy();
  }, 15_000);

  it('#536: the attach step starts on the type the bank reported — the space still picks', async () => {
    await seedRows();
    await seedCandidate();
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('t4'), { trackOutbox: false });
    // ING listed this agreement as a LOAN
    await repo.upsert('account', 'feed-2', 'feedloan', { name: 'R13792519', type: 'loan', source: 'connector', currency: 'EUR', balanceCents: -43_792 });
    db.close();
    const { setSpaceAttachIntent } = await import('@/features/accounts/openHandoff');
    setSpaceAttachIntent('feedloan');
    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Personal', kind: 'personal' }],
      api: apiWithCandidate('personal'),
    });

    await screen.findByTestId('space-attach-types', {}, { timeout: 10_000 });
    expect(screen.getByTestId('space-attach-type-loan').className).toContain('border-accent');
    expect(screen.getByTestId('space-attach-type-checking').className).not.toContain('border-accent');
    // a suggestion only: the space's own pick replaces it
    fireEvent.click(screen.getByTestId('space-attach-type-mortgage'));
    expect(screen.getByTestId('space-attach-type-mortgage').className).toContain('border-accent');
    expect(screen.getByTestId('space-attach-type-loan').className).not.toContain('border-accent');
  }, 20_000);
});

/** an Enable Banking connection of mine and the account it fetched, attached to the space; its last sync nine days ago */
const seedOpenBanking = async () => {
  const { MunniDB } = await import('@/db/schema');
  const { Repo } = await import('@/db/repo');
  const { DexieBackend } = await import('@/db/backend');
  const { HlcClock } = await import('@/sync/hlc');
  const { storeFeedId } = await import('@/domain/feedIds');
  const { USER_TEST_SUB } = await import('@/test/harness');
  const { catalogueOf, manifestOf } = await import('@/test/connectorFixtures');
  const db = new MunniDB(USER_TEST_DB);
  const backend = new DexieBackend(db);
  const repo = new Repo(backend, new HlcClock('ob'), { trackOutbox: false });
  await repo.upsert('storeConn', storeFeedId(USER_TEST_SUB), 'c-eb', { store: 'enablebanking', kind: 'bank', displayName: 'PayPal Okkes', connectedAt: '2026-07-01', status: 'ok' });
  await repo.upsert('account', 'feed-eb', 'eb-acc', {
    name: 'Okkes Doker',
    type: 'checking',
    source: 'connector',
    provider: 'enablebanking',
    connectionId: 'c-eb',
    currency: 'EUR',
    balanceCents: 0,
    lastSyncedAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
  });
  await repo.upsert('accountLink', 's-user', 'link-eb', { feedSpaceId: 'feed-eb', accountId: 'eb-acc', type: 'checking', displayName: 'PayPal EB' });
  // the catalogue as the hub last cached it: Enable Banking syncs by itself, its consent in the relay's keeping
  const enableBanking = manifestOf({ id: 'enablebanking', name: 'Enable Banking', kind: 'bank', unattendedFetch: true, secretCustody: 'server' });
  await backend.metaPut('connectorCatalogue', { etag: null, catalogue: catalogueOf(enableBanking), at: new Date().toISOString() });
  db.close();
  return enableBanking;
};

const binding = (state: string) => [
  { sessionId: 'ses-eb', provider: 'enablebanking', connectionId: 'c-eb', state, createdAt: '2026-07-01T00:00:00Z', lastSeenAt: '2026-10-05T00:00:00Z', scheduled: true },
];

describe('SpaceAccountsScreen — connecting and reconnecting from the space (#527, #528)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('#527: the archived accounts fold away below the list — a quiet toggle shows them', async () => {
    await seedRows();
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('arch'), { trackOutbox: false });
    await repo.upsert('account', 's-user', 'old-loan', { name: 'Lening canan', type: 'loan', source: 'manual', currency: 'EUR', balanceCents: 0, archived: 1 });
    db.close();
    renderAppAsUser('/spaces/s-user/accounts', { spaces: [{ id: 's-user', name: 'Personal', kind: 'personal' }], api: apiWithCandidate('personal') });

    await screen.findByTestId('space-account-manual-1', {}, { timeout: 5000 });
    const toggle = await screen.findByTestId('space-accounts-archived-toggle');
    expect(screen.queryByTestId('space-account-old-loan')).toBeNull();
    expect(toggle.textContent).toContain('Show archived accounts (1)');
    fireEvent.click(toggle);
    expect((await screen.findByTestId('space-account-old-loan')).textContent).toContain('Archived');
    expect(screen.getByTestId('space-accounts-list').querySelector('[data-testid="space-account-old-loan"]')).toBeNull();
    fireEvent.click(screen.getByTestId('space-accounts-archived-toggle'));
    await waitFor(() => expect(screen.queryByTestId('space-account-old-loan')).toBeNull());
  }, 15_000);

  it('#527: the space’s Add door connects a bank, imports a statement or adds a manual account — Connect opens the bank picker right here', async () => {
    const { catalogueOf, manifestOf } = await import('@/test/connectorFixtures');
    const consent = { ...manifestOf().auth, flow: 'oauth_redirect' as const, steps: [] };
    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Personal', kind: 'personal' }],
      api: { ...apiWithCandidate('personal'), 'GET /connectors/providers': () => catalogueOf(manifestOf({ id: 'enablebanking', name: 'Enable Banking', kind: 'bank', auth: consent }), manifestOf()) },
    });
    fireEvent.click(await screen.findByTestId('space-accounts-add', {}, { timeout: 5000 }));
    expect(await screen.findByTestId('chooser-import')).toBeTruthy();
    expect(screen.getByTestId('chooser-manual')).toBeTruthy();
    fireEvent.click(screen.getByTestId('chooser-connect'));
    const picker = await screen.findByTestId('bank-picker', {}, { timeout: 5000 });
    expect((await screen.findByTestId('conn-party-enablebanking', {}, { timeout: 5000 })).textContent).toContain('Enable Banking');
    expect(picker.querySelector('[data-testid="conn-party-mock-store-simple"]')).toBeNull();
    // no detour: still the space's own accounts
    expect(screen.getByTestId('screen-space-accounts')).toBeTruthy();
    fireEvent.click(screen.getByTestId('conn-party-enablebanking'));
    expect(await screen.findByTestId('connect-form', {}, { timeout: 5000 })).toBeTruthy();
  }, 20_000);

  it('#528: a living open-banking consent asks for no reconnect, however long ago its last sync', async () => {
    await seedOpenBanking();
    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Personal', kind: 'personal' }],
      api: { ...apiWithCandidate('personal'), 'GET /me/feeds': () => [{ feedSpaceId: 'feed-eb' }], 'GET /connectors/sessions': () => binding('active') },
    });
    await screen.findByTestId('space-account-link-eb', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('space-account-link-eb'));
    await screen.findByTestId('space-account-info');
    expect(screen.queryByTestId('space-account-stale-link-eb')).toBeNull();
    expect(screen.queryByTestId('space-account-uncovered')).toBeNull();
  }, 15_000);

  it('#528: a consent that ended says so, and its Reconnect leads to that connection on All accounts, brought into view', async () => {
    await seedOpenBanking();
    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Personal', kind: 'personal' }],
      api: {
        ...apiWithCandidate('personal'),
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-eb' }],
        'GET /connectors/sessions': () => binding('needs_reauth'),
        'GET /connectors/providers': () => ({ providers: [], service: { kinds: [], version: 'test', manifestDigest: 'd' } }),
      },
    });
    expect((await screen.findByTestId('space-account-stale-link-eb', {}, { timeout: 5000 })).textContent).toContain('Reconnect');
    fireEvent.click(screen.getByTestId('space-account-link-eb'));
    const note = await screen.findByTestId('space-account-uncovered');
    expect(note.textContent).toContain('PayPal Okkes');
    expect(note.textContent).toContain('lost its consent');
    fireEvent.click(screen.getByTestId('space-account-reconnect'));
    const card = await screen.findByTestId('conn-card-c-eb', {}, { timeout: 5000 });
    expect(screen.getByTestId('screen-accounts')).toBeTruthy();
    await waitFor(() => expect(card.dataset.flash).toBe('1'), { timeout: 3000 });
  }, 20_000);
});
