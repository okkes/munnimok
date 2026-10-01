// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminApp } from './AdminApp';
import type { AdminConfig } from './config';

const CONFIG: AdminConfig = { apiUrl: 'http://api.test', logtoEndpoint: '', logtoAppId: '', logtoResource: '' };

const USERS = [
  { id: 'u1', sub: 'sub-alice', displayName: 'Alice', email: 'alice@x.nl', createdAt: '2026-01-01T00:00:00Z', spaceCount: 2 },
  { id: 'u2', sub: 'sub-bob', displayName: null, email: null, createdAt: '2026-02-01T00:00:00Z', spaceCount: 1 },
  { id: 'u3', sub: 'sub-carol', displayName: 'Carol', email: null, createdAt: '2026-03-01T00:00:00Z', spaceCount: 3 },
];
const HEALTH = { status: 'ok', build: '640', capabilities: { fcm: true, push: false } };

type Handler = (init?: RequestInit, url?: URL) => { status?: number; body?: unknown };

function scriptFetch(routes: Record<string, Handler>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const key = `${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`;
      calls.push(key);
      const out = routes[key]?.(init, url) ?? { status: 404 };
      return new Response(JSON.stringify(out.body ?? {}), {
        status: out.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

const CATALOG = {
  version: 2,
  categories: [
    { id: 'groceries', names: { en: 'Food shops', nl: 'Eten', tr: 'Gida' }, icon: 'cart' },
  ],
  keywords: [{ catId: 'hobby', keywords: ['padel'] }],
};

// the connector control plane as /admin/connectors/* relays it (#367 M6)
const CONNECTOR_STATUS = {
  service: { kinds: ['bank', 'registry', 'store'], version: '1.0.0', manifestDigest: 'sha256-abcdef1234567890' },
  providers: [
    { providerId: 'ah', state: 'paused', since: '2026-09-29T10:00:00Z', reasonKey: 'connect.paused.maintenance', acceptsWork: false },
    { providerId: 'mock-store-simple', state: 'healthy', since: '2026-09-29T09:00:00Z', reasonKey: null, acceptsWork: true },
  ],
  agents: { total: 2, online: 1, revoked: 0 },
  queue: { queued: 1, running: 0, awaitingInput: 2 },
  relay: { openStreams: 3 },
};
const CONNECTOR_AGENTS = {
  agents: [
    { id: 'agt_kitchen', name: 'the kitchen laptop', class: 'byo', revoked: false, lastHeartbeatAt: '2026-09-30T06:00:00Z', online: true, stale: false, profiles: [{ id: 'prof_1', provider: 'asn-persistent', healthy: true, lastOkAt: null }] },
  ],
};
const CONNECTOR_CANARIES = {
  canaries: [{ providerId: 'ah', resource: 'receipts', intervalMinutes: 60, lastRunAt: '2026-09-30T05:00:00Z', lastJobId: 'job_1', intact: false, verdict: 'login page changed' }],
};

const HAPPY_ROUTES = (): Record<string, Handler> => ({
  'GET /catalog': () => ({ body: CATALOG }),
  'GET /admin/ping': () => ({}),
  'GET /admin/users': () => ({ body: USERS }),
  'GET /health': () => ({ body: HEALTH }),
});

function renderAdmin() {
  localStorage.setItem('munni_admin_sub', 'sub-alice');
  render(<AdminApp config={CONFIG} getToken={null} />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AdminApp (test-auth mode)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear(); // the persisted screen must not leak between tests
  });

  it('a sign-in without the admin scope sees the denied note and no data', async () => {
    scriptFetch({ 'GET /admin/ping': () => ({ status: 403 }) });
    render(<AdminApp config={CONFIG} getToken={null} />);
    fireEvent.change(screen.getByTestId('admin-sub'), { target: { value: 'nobody' } });
    await waitFor(() => expect(screen.getByText(/no admin access/)).toBeTruthy());
    expect(screen.queryByTestId('overview-tiles')).toBeNull();
    expect(screen.queryByText(/did not answer/)).toBeNull();
  });

  it('a Logto session offers Sign out — a freshly granted admin role rides on the next token', async () => {
    scriptFetch({ 'GET /admin/ping': () => ({ status: 403 }) });
    const signOut = vi.fn();
    render(<AdminApp config={CONFIG} getToken={async () => 'tok'} signOut={signOut} />);
    await screen.findByText(/no admin access/);
    fireEvent.click(screen.getByTestId('admin-signout'));
    expect(signOut).toHaveBeenCalledTimes(1);
    // the denied note carries its own Sign out — the fix it names is one tap away
    fireEvent.click(screen.getByTestId('admin-denied-signout'));
    expect(signOut).toHaveBeenCalledTimes(2);
  });

  it('an unanswered ping (network/CORS/5xx) shows the reachability note, NOT the denied one', async () => {
    scriptFetch({ 'GET /admin/ping': () => ({ status: 500 }) });
    render(<AdminApp config={CONFIG} getToken={null} />);
    fireEvent.change(screen.getByTestId('admin-sub'), { target: { value: 'anybody' } });
    await screen.findByText(/did not answer/);
    expect(screen.queryByText(/no admin access/)).toBeNull();
    expect(screen.queryByTestId('overview-tiles')).toBeNull();
  });

  it('a disconnected device (410) says so and forgets its id so the next load registers anew', async () => {
    localStorage.setItem('munni_admin_device', 'dev-revoked');
    scriptFetch({ 'GET /admin/ping': () => ({ status: 410, body: { error: 'device-revoked' } }) });
    render(<AdminApp config={CONFIG} getToken={null} />);
    fireEvent.change(screen.getByTestId('admin-sub'), { target: { value: 'anybody' } });
    await screen.findByText(/disconnected from the account/);
    expect(screen.queryByText(/did not answer/)).toBeNull();
    expect(screen.queryByTestId('overview-tiles')).toBeNull();
    expect(localStorage.getItem('munni_admin_device')).toBeNull();
  });

  it('overview shows tiles and capability chips — the parties live under Connectors (#414)', async () => {
    scriptFetch(HAPPY_ROUTES());
    renderAdmin();
    const tiles = await screen.findByTestId('overview-tiles');
    expect(tiles.textContent).toContain('Users');
    expect(tiles.textContent).toContain('3'); // 3 users
    expect(tiles.textContent).toContain('6'); // 2+1+3 space memberships
    expect(tiles.textContent).toContain('Bank feeds');
    expect(tiles.textContent).not.toContain('Linked banks');
    expect(screen.queryByTestId('overview-quota')).toBeNull();
    expect(screen.queryByTestId('nav-connections')).toBeNull();

    const caps = screen.getByTestId('overview-capabilities');
    expect(caps.textContent).toContain('build 640');
    expect(caps.textContent).toContain('fcm');
  });

  it('users screen filters by search', async () => {
    scriptFetch(HAPPY_ROUTES());
    renderAdmin();
    fireEvent.click(await screen.findByTestId('nav-users'));

    const table = await screen.findByTestId('admin-users');
    expect(table.textContent).toContain('Alice');
    expect(table.textContent).toContain('sub-bob'); // nameless users fall back to sub

    fireEvent.change(screen.getByTestId('users-search'), { target: { value: 'carol' } });
    expect(screen.getByTestId('admin-users').textContent).not.toContain('Alice');
    expect(screen.getByTestId('admin-users').textContent).toContain('Carol');
  });

  it('diagnose shows the sync chain; failures show a message; the screen survives a reload', async () => {
    scriptFetch({
      ...HAPPY_ROUTES(),
      'GET /admin/users/sub-bob/diagnosis': () => ({
        body: {
          userId: 'u2',
          memberSpaces: ['space-main'],
          ownedFeeds: [{ feedSpaceId: 'feed12345678', maxSeq: 42 }],
          attachments: [],
        },
      }),
      'GET /admin/users/sub-carol/diagnosis': () => ({ status: 500 }),
    });
    renderAdmin();
    fireEvent.click(await screen.findByTestId('nav-users'));
    await screen.findByTestId('admin-users');

    fireEvent.click(screen.getByTestId('diagnose-sub-bob'));
    const panel = await screen.findByTestId('user-diagnosis');
    await waitFor(() => expect(panel.textContent).toContain('space-main'));
    expect(panel.textContent).toContain('ops 42');
    expect(panel.textContent).toContain('NONE — feeds never attached');

    // a dead call must not spin forever — it says what went wrong
    fireEvent.click(screen.getByTestId('diagnose-sub-carol'));
    await waitFor(() => expect(screen.getByTestId('user-diagnosis').textContent).toContain('HTTP 500'));

    // the active screen survives the page reload a Logto re-auth causes
    expect(sessionStorage.getItem('munni_admin_screen')).toBe('users');
    cleanup();
    renderAdmin();
    await screen.findByTestId('admin-users');
  });

  it('a failed action surfaces the server error', async () => {
    scriptFetch({
      ...HAPPY_ROUTES(),
      'PUT /admin/catalog': () => ({ status: 400, body: { error: 'categories, keywords and stores must be arrays' } }),
    });
    renderAdmin();
    fireEvent.click(await screen.findByTestId('nav-catalog'));
    await screen.findByTestId('catalog-cat-groceries');
    // the publish button arms only with unpublished changes
    fireEvent.change(screen.getByTestId('catalog-store-ah'), { target: { value: 'albert heijn' } });
    fireEvent.click(screen.getByTestId('catalog-publish'));
    await waitFor(() => expect(screen.getByTestId('admin-error').textContent).toContain('must be arrays'));
  });

  it('connectors: the parties with the kill switch, the fleet with revoke, the canaries (#367 M6)', async () => {
    const posted: unknown[] = [];
    let revoked = false;
    const calls = scriptFetch({
      ...HAPPY_ROUTES(),
      'GET /admin/connectors/status': () => ({ body: CONNECTOR_STATUS }),
      'GET /admin/connectors/agents': () => ({ body: revoked ? { agents: [] } : CONNECTOR_AGENTS }),
      'GET /admin/connectors/canaries': () => ({ body: CONNECTOR_CANARIES }),
      'POST /admin/connectors/providers/ah/status': (init) => {
        posted.push(JSON.parse(String(init?.body)));
        return { body: { providerId: 'ah', state: 'healthy', since: '2026-09-30T06:00:00Z', reasonKey: null, acceptsWork: true } };
      },
      'POST /admin/connectors/providers/mock-store-simple/status': (init) => {
        posted.push(JSON.parse(String(init?.body)));
        return { body: { providerId: 'mock-store-simple', state: 'paused', since: '2026-09-30T06:00:00Z', reasonKey: null, acceptsWork: false } };
      },
      'DELETE /admin/connectors/agents/agt_kitchen': () => {
        revoked = true;
        return { status: 204 };
      },
    });
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderAdmin();
    fireEvent.click(await screen.findByTestId('nav-connectors'));
    const tiles = await screen.findByTestId('connectors-tiles');
    expect(tiles.textContent).toContain('1 / 2'); // one of two parties accepts work; one of two agents is online
    expect(tiles.textContent).toContain('1 · 2'); // one job in flight, two awaiting input
    const providers = screen.getByTestId('connectors-providers');
    expect(screen.getByTestId('connector-state-ah').textContent).toBe('paused');
    expect(providers.textContent).toContain('connect.paused.maintenance');

    // resume the paused party; pause the healthy one with a reason key
    fireEvent.click(screen.getByTestId('connector-resume-ah'));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ state: 'healthy', reasonKey: null });
    fireEvent.change(screen.getByTestId('connector-reason-mock-store-simple'), { target: { value: 'connect.paused.maintenance' } });
    fireEvent.click(screen.getByTestId('connector-pause-mock-store-simple'));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({ state: 'paused', reasonKey: 'connect.paused.maintenance' });

    // retiring expires every live session, so it wants the id typed
    fireEvent.click(await screen.findByTestId('connector-retire-mock-store-simple'));
    const typed = await screen.findByTestId('connector-retire-typed');
    expect((screen.getByTestId('connector-retire-confirm') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(typed, { target: { value: 'mock-store-simple' } });
    fireEvent.click(screen.getByTestId('connector-retire-confirm'));
    await waitFor(() => expect(posted).toHaveLength(3));
    expect(posted[2]).toMatchObject({ state: 'retired' });

    // the fleet: health and the logins each keeps; revoking asks first
    const agents = screen.getByTestId('connectors-agents');
    expect(agents.textContent).toContain('the kitchen laptop');
    expect(agents.textContent).toContain('online');
    expect(agents.textContent).toContain('asn-persistent');
    fireEvent.click(screen.getByTestId('agent-revoke-agt_kitchen'));
    await waitFor(() => expect(revoked).toBe(true));
    expect(calls).toContain('DELETE /admin/connectors/agents/agt_kitchen');
    await waitFor(() => expect(screen.getByTestId('connectors-agents').textContent).toContain('No household agents'));

    // a broken canary wears its verdict
    expect(screen.getByTestId('connectors-canaries').textContent).toContain('login page changed');
  });

  it('connectors: an environment without connectors says so, and a relay refusal reaches the error strip as its code', async () => {
    scriptFetch({ ...HAPPY_ROUTES(), 'GET /admin/connectors/status': () => ({ status: 404 }) });
    renderAdmin();
    fireEvent.click(await screen.findByTestId('nav-connectors'));
    expect((await screen.findByTestId('connectors-absent')).textContent).toContain('runs no connectors');
    cleanup();

    scriptFetch({
      ...HAPPY_ROUTES(),
      'GET /admin/connectors/status': () => ({ body: { ...CONNECTOR_STATUS, providers: [CONNECTOR_STATUS.providers[1]] } }),
      'GET /admin/connectors/agents': () => ({ body: { agents: [] } }),
      'GET /admin/connectors/canaries': () => ({ body: { canaries: [] } }),
      'POST /admin/connectors/providers/mock-store-simple/status': () => ({
        status: 503,
        body: { error: { code: 'provider_unavailable', retriable: true, userAction: 'retry', messageKey: 'connect.error.provider_unavailable', detailId: null, retryAfterSeconds: null } },
      }),
    });
    renderAdmin();
    fireEvent.click(await screen.findByTestId('nav-connectors'));
    fireEvent.click(await screen.findByTestId('connector-pause-mock-store-simple'));
    expect((await screen.findByTestId('admin-error')).textContent).toContain('provider_unavailable');
  });

  it('a user diagnosis lists the connector sessions the relay binds (#367 M6)', async () => {
    scriptFetch({
      ...HAPPY_ROUTES(),
      'GET /admin/users/sub-alice/diagnosis': () => ({
        body: {
          userId: 'u1',
          memberSpaces: ['space-1'],
          ownedFeeds: [],
          attachments: [],
          connectorSessions: [{ sessionId: 'ses_1', provider: 'mock-store-simple', connectionId: 'conn-1234567890abcdef', state: 'awaiting_input', lastSeenAt: '2026-09-30T06:00:00Z' }],
        },
      }),
    });
    renderAdmin();
    fireEvent.click(await screen.findByTestId('nav-users'));
    fireEvent.click(await screen.findByTestId('diagnose-sub-alice'));
    const line = await screen.findByTestId('user-diagnosis-connectors');
    expect(line.textContent).toContain('mock-store-simple awaiting_input');
    expect(line.textContent).toContain('conn-1234567…');
  });

  it('connectors: a bank party shows its budget, and its inventory lists every environment’s consents with a revoke that asks first (#414)', async () => {
    const revoked: string[] = [];
    scriptFetch({
      ...HAPPY_ROUTES(),
      'GET /admin/connectors/status': () => ({
        body: {
          ...CONNECTOR_STATUS,
          providers: [
            { providerId: 'gocardless', state: 'healthy', since: '2026-09-30T03:00:00Z', reasonKey: null, acceptsWork: true, quota: { limit: 10, remaining: 2, resetAt: '2026-10-01T00:00:00Z', seenAt: '2026-09-30T03:05:00Z' } },
            CONNECTOR_STATUS.providers[1],
          ],
        },
      }),
      'GET /admin/connectors/agents': () => ({ body: { agents: [] } }),
      'GET /admin/connectors/canaries': () => ({ body: { canaries: [] } }),
      'GET /admin/connectors/providers/gocardless/remote-consents': () => ({
        body: {
          consents: [
            { id: 'req-here-0001', status: 'LN', createdAt: '2026-09-01T00:00:00Z', reference: 'ref-1', institutionId: 'ING_INGBNL2A', origin: 'https://app.munni.example', accountCount: 2 },
            { id: 'req-gone-0002', status: 'EX', createdAt: null, reference: null, institutionId: 'ASN_BANK_ASNBNL21', origin: null, accountCount: 0 },
          ].filter((c) => !revoked.includes(c.id)),
        },
      }),
      'DELETE /admin/connectors/providers/gocardless/remote-consents/req-gone-0002': () => {
        revoked.push('req-gone-0002');
        return { status: 204 };
      },
    });
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderAdmin();
    fireEvent.click(await screen.findByTestId('nav-connectors'));
    // the budget: two of ten calls left, nearly spent (a fifth or less)
    const quota = await screen.findByTestId('connector-quota-gocardless');
    expect(quota.textContent).toContain('2 / 10');
    expect(quota.className).toContain('warn');
    // a party that said nothing about its budget shows none
    expect(screen.getByTestId('connector-quota-mock-store-simple').textContent).toBe('—');

    fireEvent.click(screen.getByTestId('connector-inventory-gocardless'));
    const table = await screen.findByTestId('connector-inventory');
    expect(table.textContent).toContain('ING_INGBNL2A');
    expect(table.textContent).toContain('https://app.munni.example');
    expect(table.textContent).toContain('unattributed');
    fireEvent.click(screen.getByTestId('remote-consent-revoke-req-gone-0002'));
    await waitFor(() => expect(revoked).toEqual(['req-gone-0002']));
    await waitFor(() => expect(screen.getByTestId('connector-inventory').textContent).not.toContain('ASN_BANK_ASNBNL21'));

    // a party without an inventory says so
    fireEvent.click(screen.getByTestId('connector-inventory-mock-store-simple'));
    await screen.findByTestId('connector-inventory-none');
  });

  it('typing a sub persists it and sends it as X-User-Sub, with a stable device id', async () => {
    const seenHeaders: (string | null)[] = [];
    const seenDevices: (string | null)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/admin/')) {
          seenHeaders.push(new Headers(init?.headers).get('X-User-Sub'));
          seenDevices.push(new Headers(init?.headers).get('X-Munni-Device'));
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    render(<AdminApp config={CONFIG} getToken={null} />);
    fireEvent.change(screen.getByTestId('admin-sub'), { target: { value: 'sub-admin' } });
    await waitFor(() => expect(seenHeaders.length).toBeGreaterThan(1));
    expect(seenHeaders.every((h) => h === 'sub-admin')).toBe(true);
    expect(localStorage.getItem('munni_admin_sub')).toBe('sub-admin');
    // the API refuses requests that name no device: one id, minted once, on every call
    expect(seenDevices[0]).toBeTruthy();
    expect(seenDevices.every((d) => d === seenDevices[0])).toBe(true);
    expect(localStorage.getItem('munni_admin_device')).toBe(seenDevices[0]);
  });
});

describe('AdminApp (OIDC token mode)', () => {
  beforeEach(() => sessionStorage.clear()); // persisted screen must not leak in

  it('uses the bearer token and hides the sub box', async () => {
    const seenAuth: (string | null)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/admin/')) seenAuth.push(new Headers(init?.headers).get('Authorization'));
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    render(<AdminApp config={CONFIG} getToken={async () => 'tok-abc'} />);
    expect(screen.queryByTestId('admin-sub')).toBeNull();
    await waitFor(() => expect(seenAuth.length).toBeGreaterThan(0));
    expect(seenAuth.every((h) => h === 'Bearer tok-abc')).toBe(true);
  });

  it('catalog: shows the published document and retires with a typed-id gate', async () => {
    scriptFetch(HAPPY_ROUTES());
    renderAdmin();
    fireEvent.click(await screen.findByTestId('nav-catalog'));
    // the published overlay renders
    await screen.findByTestId('catalog-cat-groceries');
    expect(screen.getByTestId('catalog-categories').textContent).toContain('Food shops');

    // retiring demands the exact id before the button arms
    fireEvent.click(screen.getByTestId('catalog-delete-groceries'));
    const confirmBtn = screen.getByTestId('catalog-delete-confirm') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('catalog-delete-typed'), { target: { value: 'grocery' } });
    expect((screen.getByTestId('catalog-delete-confirm') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('catalog-delete-typed'), { target: { value: 'groceries' } });
    fireEvent.click(screen.getByTestId('catalog-delete-confirm'));
    // tombstoned: struck through with a restore action
    expect(screen.getByTestId('catalog-restore-groceries')).toBeTruthy();
  });

  it('catalog tree: search filters, bundled rows retire via synthetic tombstones, restore removes them again', async () => {
    scriptFetch(HAPPY_ROUTES());
    renderAdmin();
    fireEvent.click(await screen.findByTestId('nav-catalog'));
    await screen.findByTestId('catalog-cat-groceries');

    // the merged tree shows bundled mains; search narrows it
    expect(screen.getByTestId('catalog-row-transport')).toBeTruthy();
    fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'transport' } });
    expect(screen.queryByTestId('catalog-row-housing')).toBeNull();
    expect(screen.getByTestId('catalog-row-transport')).toBeTruthy();
    fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: '' } });

    // a bundled-only category retires through a synthesized tombstone…
    fireEvent.click(screen.getByTestId('catalog-delete-transport'));
    fireEvent.change(screen.getByTestId('catalog-delete-typed'), { target: { value: 'transport' } });
    fireEvent.click(screen.getByTestId('catalog-delete-confirm'));
    // the tombstone exists as a document entry and offers the restore action
    expect(screen.getByTestId('catalog-cat-transport')).toBeTruthy();
    expect(screen.getByTestId('catalog-restore-transport')).toBeTruthy();

    // …and restoring it removes the synthetic entry (back to bundled-only)
    fireEvent.click(screen.getByTestId('catalog-restore-transport'));
    expect(screen.queryByTestId('catalog-cat-transport')).toBeNull();
    expect(screen.getByTestId('catalog-row-transport')).toBeTruthy();

    // "+ sub" pre-fills the editor with the parent; rename pre-fills the id
    fireEvent.click(screen.getByTestId('catalog-addsub-transport'));
    expect((screen.getByTestId('catalog-new-parent') as HTMLInputElement).value).toBe('transport');
    fireEvent.click(screen.getByTestId('catalog-editor-cancel'));
    fireEvent.click(screen.getByTestId('catalog-prefill-transport'));
    expect((screen.getByTestId('catalog-new-id') as HTMLInputElement).value).toBe('transport');
  });

  it('catalog: adding entries and publishing PUTs the document', async () => {
    let published: unknown = null;
    scriptFetch({
      ...HAPPY_ROUTES(),
      'PUT /admin/catalog': (init) => {
        published = JSON.parse(String(init?.body));
        return { body: { version: 3 } };
      },
    });
    renderAdmin();
    fireEvent.click(await screen.findByTestId('nav-catalog'));
    await screen.findByTestId('catalog-cat-groceries');

    // a new category entry (all three languages required) — the editor
    // panel opens from the tree toolbar (catalog redesign)
    fireEvent.click(screen.getByTestId('catalog-add-main'));
    fireEvent.change(screen.getByTestId('catalog-new-id'), { target: { value: 'padelClub' } });
    fireEvent.change(screen.getByTestId('catalog-new-parent'), { target: { value: 'hobby' } });
    fireEvent.change(screen.getByTestId('catalog-new-en'), { target: { value: 'Padel' } });
    fireEvent.change(screen.getByTestId('catalog-new-nl'), { target: { value: 'Padel' } });
    fireEvent.change(screen.getByTestId('catalog-new-tr'), { target: { value: 'Padel' } });
    fireEvent.change(screen.getByTestId('catalog-new-icon'), { target: { value: 'tennis' } });
    fireEvent.click(screen.getByTestId('catalog-add-category'));
    await screen.findByTestId('catalog-cat-padelClub');

    // a keyword rule
    fireEvent.change(screen.getByTestId('catalog-kw-cat'), { target: { value: 'padelClub' } });
    fireEvent.change(screen.getByTestId('catalog-kw-words'), { target: { value: 'Padelbaan, PADEL CLUB' } });
    fireEvent.click(screen.getByTestId('catalog-add-keyword'));

    // store merchant patterns (receipts v3 R9) publish alongside
    fireEvent.change(screen.getByTestId('catalog-store-ah'), { target: { value: 'albert heijn, AH to go' } });

    fireEvent.click(screen.getByTestId('catalog-publish'));
    await waitFor(() => expect(published).not.toBeNull());
    const doc = published as {
      categories: { id: string }[];
      keywords: { catId: string; keywords: string[] }[];
      stores: { id: string; patterns: string[] }[];
    };
    expect(doc.categories.map((c) => c.id)).toEqual(['groceries', 'padelClub']);
    expect(doc.keywords.at(-1)).toEqual({ catId: 'padelClub', keywords: ['padelbaan', 'padel club'] });
    expect(doc.stores).toEqual([{ id: 'ah', patterns: ['albert heijn', 'AH to go'] }]);
  });
});
