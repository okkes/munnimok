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

  it('Home offers no quick sync to someone whose connections all sync by themselves', async () => {
    await seed([{ id: 'c-ah', manifest: AH, device: {} }]);
    renderAppAsUser('/', { api: catalogue(AH) });
    await screen.findByTestId('screen-home', {}, { timeout: 5000 });
    // the cached catalogue is read before the button would show
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByTestId('home-quick-sync')).toBeNull();
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
