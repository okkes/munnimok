// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER_TEST_DB, renderAppAsUser } from '@/test/harness';
import { NO_INGEST, catalogueOf, manifestOf } from '@/test/connectorFixtures';
import { usePendingLogins } from './pendingLogins';
import { useSyncActivity } from './syncActivity';
import type { ProviderManifest } from './types';

/** ING as the relay lists it: a sign-in with app approval on every sync, a fifteen-minute session, the login kept sealed on the device (#543) */
const ING = manifestOf({
  id: 'ing-nl',
  name: 'ING',
  kind: 'bank',
  unattendedFetch: false,
  offersCredentialStore: true,
  auth: { ...manifestOf().auth, flow: 'mobile_approval', session: { ttlSeconds: 900, refreshable: false, rotatesOnUse: false } },
});
/** Albert Heijn: its refresh token syncs it by itself */
const AH = manifestOf({ id: 'ah', name: 'Albert Heijn', kind: 'store', unattendedFetch: true });

const catalogue = (...providers: ProviderManifest[]) => ({ 'GET /connectors/providers': () => catalogueOf(...providers) });

/** a connection made on this device, as adopt() leaves it, with the catalogue the hub cached */
async function seed(rows: { id: string; manifest: ProviderManifest; device: Record<string, unknown> }[]) {
  const { MunniDB } = await import('@/db/schema');
  const { Repo } = await import('@/db/repo');
  const { DexieBackend } = await import('@/db/backend');
  const { HlcClock } = await import('@/sync/hlc');
  const { storeFeedId } = await import('@/domain/feedIds');
  const { USER_TEST_SUB } = await import('@/test/harness');
  const db = new MunniDB(USER_TEST_DB);
  const backend = new DexieBackend(db);
  const repo = new Repo(backend, new HlcClock('qs'), { trackOutbox: false });
  for (const { id, manifest, device } of rows) {
    await repo.upsert('storeConn', storeFeedId(USER_TEST_SUB), id, { store: manifest.id, kind: manifest.kind, displayName: `${manifest.name} thuis`, connectedAt: '2026-09-01', status: 'ok' });
    // synced minutes ago: neither the app-open keep-alive nor the after-sync pass touches it, so every sync below is the sheet's own
    const minutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    await backend.connectorConnPut({ id, provider: manifest.id, bundle: 'sb_v1.seeded', sessionId: `ses-${id}`, state: 'active', refreshedAt: new Date().toISOString(), lastSyncAt: minutesAgo, ...device });
  }
  await backend.metaPut('connectorCatalogue', { etag: null, catalogue: catalogueOf(...rows.map((r) => r.manifest)), at: new Date().toISOString() });
  db.close();
}

describe('the quick sync on Home (#548)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
    usePendingLogins.setState({ logins: {} });
    useSyncActivity.setState({ activity: {} });
  });

  it('lists the connections synced by hand with their last sync — never the ones that sync by themselves', async () => {
    await seed([
      { id: 'c-ing', manifest: ING, device: {} },
      { id: 'c-ah', manifest: AH, device: {} },
    ]);
    renderAppAsUser('/', { api: catalogue(ING, AH) });
    fireEvent.click(await screen.findByTestId('home-quick-sync', {}, { timeout: 5000 }));
    const row = await screen.findByTestId('quick-sync-c-ing', {}, { timeout: 5000 });
    expect(row.textContent).toContain('ING thuis');
    expect(screen.getByTestId('quick-sync-state-c-ing').textContent).toContain('Synced');
    expect(screen.queryByTestId('quick-sync-c-ah')).toBeNull();
  }, 15_000);

  it('Home offers no quick sync to someone whose connections all sync by themselves — the cache that knows every party answers without a call', async () => {
    await seed([
      { id: 'c-ing', manifest: ING, device: {} },
      { id: 'c-ah', manifest: AH, device: {} },
    ]);
    let asked = 0;
    renderAppAsUser('/', {
      api: {
        'GET /connectors/providers': () => {
          asked += 1;
          return catalogueOf(ING, AH);
        },
      },
    });
    await screen.findByTestId('home-quick-sync', {}, { timeout: 5000 });
    // the button's query is live now: it must leave with the last connection synced by hand
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const { storeFeedId } = await import('@/domain/feedIds');
    const { USER_TEST_SUB } = await import('@/test/harness');
    const db = new MunniDB(USER_TEST_DB);
    await new Repo(new DexieBackend(db), new HlcClock('qs2'), { trackOutbox: false }).remove('storeConn', storeFeedId(USER_TEST_SUB), 'c-ing');
    await waitFor(() => expect(screen.queryByTestId('home-quick-sync')).toBeNull(), { timeout: 5000 });
    db.close();
    expect(asked).toBe(0);
  }, 15_000);

  it('a device whose cached catalogue does not hold the party asks the relay once, and the button follows', async () => {
    await seed([{ id: 'c-ing', manifest: ING, device: {} }]);
    // as on a second device: the connection synced over, the catalogue was cached before ING existed
    const { MunniDB } = await import('@/db/schema');
    const { DexieBackend } = await import('@/db/backend');
    const db = new MunniDB(USER_TEST_DB);
    await new DexieBackend(db).metaPut('connectorCatalogue', { etag: 'old', catalogue: catalogueOf(AH), at: '2026-09-01T00:00:00Z' });
    db.close();
    let asked = 0;
    renderAppAsUser('/', {
      api: {
        'GET /connectors/providers': () => {
          asked += 1;
          return catalogueOf(ING, AH);
        },
      },
    });
    expect(await screen.findByTestId('home-quick-sync', {}, { timeout: 5000 })).toBeTruthy();
    expect(asked).toBe(1);
  }, 15_000);

  it('Sync on a session still alive runs the sync right there', async () => {
    await seed([{ id: 'c-ing', manifest: ING, device: {} }]);
    let synced = 0;
    renderAppAsUser('/', {
      api: {
        ...catalogue(ING),
        'POST /connectors/ing-nl/sync': () => {
          synced += 1;
          return { sessionId: 'ses-c-ing', state: 'active', ingested: { ...NO_INGEST, records: 3, transactions: 3 } };
        },
      },
    });
    fireEvent.click(await screen.findByTestId('home-quick-sync', {}, { timeout: 5000 }));
    fireEvent.click(await screen.findByTestId('quick-sync-go-c-ing', {}, { timeout: 5000 }));
    await waitFor(() => expect(synced).toBe(1), { timeout: 5000 });
    expect(screen.queryByTestId('connect-form')).toBeNull();
  }, 15_000);

  it('#543: a session past the party’s own clock signs in again first — with the login this device keeps, nothing to type', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await seed([{ id: 'c-ing', manifest: ING, device: { refreshedAt: twoHoursAgo, credentialBundle: 'cb_v1.kept' } }]);
    let login: { connectionId?: string; inputs?: unknown; credentialBundle?: string } = {};
    renderAppAsUser('/', {
      api: {
        ...catalogue(ING),
        'POST /connectors/ing-nl/login': (body) => {
          login = body as typeof login;
          return { sessionId: 'ses-new', state: 'active', bundle: 'sb_v1.fresh', credentialBundle: 'cb_v1.rotated', notes: [] };
        },
        'POST /connectors/ing-nl/sync': () => ({ sessionId: 'ses-new', state: 'active', ingested: NO_INGEST }),
      },
    });
    fireEvent.click(await screen.findByTestId('home-quick-sync', {}, { timeout: 5000 }));
    fireEvent.click(await screen.findByTestId('quick-sync-go-c-ing', {}, { timeout: 5000 }));
    // the kept login is offered in place of the fields
    expect((await screen.findByTestId('connect-saved-login', {}, { timeout: 5000 })).textContent).toContain('saved login');
    expect(screen.queryByTestId('connect-field-username')).toBeNull();
    fireEvent.click(screen.getByTestId('connect-next'));
    await waitFor(() => expect(login.connectionId).toBe('c-ing'), { timeout: 5000 });
    expect(login.inputs).toBeUndefined();
    expect(login.credentialBundle).toBe('cb_v1.kept');
    // the fresh sealed copy replaces the old one on the device
    await waitFor(async () => {
      const { MunniDB } = await import('@/db/schema');
      const db = new MunniDB(USER_TEST_DB);
      const row = await db.connectorConns.get('c-ing');
      db.close();
      expect(row?.credentialBundle).toBe('cb_v1.rotated');
    });
  }, 20_000);

  it('#460: older history still to fetch survives the sign-in a sync needs first — the sync after it goes on with it', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await seed([{ id: 'c-ing', manifest: ING, device: { refreshedAt: twoHoursAgo, credentialBundle: 'cb_v1.kept', backfill: { until: '2026-03-10' } } }]);
    const windows: { since?: string; until?: string }[] = [];
    renderAppAsUser('/', {
      api: {
        ...catalogue(ING),
        'POST /connectors/ing-nl/login': () => ({ sessionId: 'ses-new', state: 'active', bundle: 'sb_v1.fresh', notes: [] }),
        'POST /connectors/ing-nl/sync': (body) => {
          windows.push(body as { since?: string; until?: string });
          return { sessionId: 'ses-new', state: 'active', ingested: NO_INGEST, complete: true };
        },
      },
    });
    fireEvent.click(await screen.findByTestId('home-quick-sync', {}, { timeout: 5000 }));
    fireEvent.click(await screen.findByTestId('quick-sync-go-c-ing', {}, { timeout: 5000 }));
    await screen.findByTestId('connect-saved-login', {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId('connect-next'));
    await waitFor(() => expect(windows.map((w) => w.until)).toEqual([undefined, '2026-03-10']), { timeout: 5000 });
  }, 20_000);

  it('#543: "Use another login" brings the fields back', async () => {
    await seed([{ id: 'c-ing', manifest: ING, device: { state: 'needs_reauth', credentialBundle: 'cb_v1.kept' } }]);
    renderAppAsUser('/', { api: catalogue(ING) });
    fireEvent.click(await screen.findByTestId('home-quick-sync', {}, { timeout: 5000 }));
    fireEvent.click(await screen.findByTestId('quick-sync-go-c-ing', {}, { timeout: 5000 }));
    fireEvent.click(await screen.findByTestId('connect-saved-login-other', {}, { timeout: 5000 }));
    expect(await screen.findByTestId('connect-field-username')).toBeTruthy();
    expect(screen.queryByTestId('connect-saved-login')).toBeNull();
  }, 15_000);
});
