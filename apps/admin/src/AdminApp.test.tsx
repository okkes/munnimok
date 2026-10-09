// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminApp } from './AdminApp';
import type { AdminConfig } from './config';

const CONFIG: AdminConfig = { apiUrl: 'http://api.test', logtoEndpoint: '', logtoAppId: '', logtoResource: '', labUrl: 'https://lab.test' };

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

/** the invitations out on this environment — the magic links sign their people up */
const INVITATIONS = {
  inviteOnly: true,
  invitations: [
    { id: 'inv-1', email: 'dana@x.nl', status: 'pending', createdAt: '2026-10-01T10:00:00Z', expiresAt: '2026-10-08T10:00:00Z', link: 'https://app.test/invite/one' },
    { id: 'inv-2', email: 'erik@x.nl', status: 'pending', createdAt: '2026-10-02T10:00:00Z', expiresAt: '2026-10-09T10:00:00Z', link: 'https://app.test/invite/two' },
  ],
};

/** one connector session as the API details it (2026-10-09): a GoCardless consent the bank ended */
const SESSION = {
  sessionId: 'ses_1',
  provider: 'gocardless',
  connectionId: 'conn-1234567890abcdef',
  state: 'needs_reauth',
  label: 'ING',
  createdAt: '2026-09-01T06:00:00Z',
  lastSeenAt: '2026-09-30T06:00:00Z',
  keptBundle: false,
  lastScheduledSyncAt: '2026-09-29T03:00:00Z',
  lastScheduleError: 'session_expired',
  scheduleNotBefore: null,
  accounts: 2,
  stale: true,
};
const outcomeOf = (sessionId: string, party: string, provider = 'gocardless') => ({
  sessionId,
  provider,
  connectionId: 'conn-1234567890abcdef',
  party,
  partyError: null,
  accountsForgotten: 2,
});

const HAPPY_ROUTES = (): Record<string, Handler> => ({
  'GET /catalog': () => ({ body: CATALOG }),
  'GET /admin/ping': () => ({}),
  'GET /admin/users': () => ({ body: USERS }),
  'GET /health': () => ({ body: HEALTH }),
  'GET /admin/invitations': () => ({ body: INVITATIONS }),
});

/** the clipboard as a test wants it: granted, or refused (an insecure origin, a denied permission) */
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

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

  it('a dead refresh grant (prod Logto logs 2026-10-08): the note offers Sign in, and no call goes out without a bearer', async () => {
    const calls = scriptFetch(HAPPY_ROUTES());
    const signIn = vi.fn();
    render(<AdminApp config={CONFIG} getToken={async () => undefined} signOut={vi.fn()} session={{ expired: true, signIn }} />);
    fireEvent.click(screen.getByTestId('admin-session-signin'));
    expect(signIn).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual([]);
    expect(screen.queryByText(/did not answer/)).toBeNull();
    expect(screen.queryByTestId('overview-tiles')).toBeNull();
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
    // an older API without names: the ids stand in, grouped the same way (2026-10-09)
    await waitFor(() => expect(panel.textContent).toContain('space-main'));
    expect(screen.getByTestId('user-diagnosis-feeds').textContent).toContain('42');
    expect(screen.getByTestId('user-diagnosis-feeds').textContent).toContain('not attached to a space');
    expect(screen.getByTestId('user-diagnosis-attachments').textContent).toContain('No attachments');

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

  it('#441: the Connectors tab hands over to the lab with its link', async () => {
    scriptFetch(HAPPY_ROUTES());
    renderAdmin();
    fireEvent.click(await screen.findByTestId('nav-connectors'));
    expect((await screen.findByTestId('connectors-handover')).textContent).toContain('moved to the lab');
    expect(screen.getByTestId('connectors-open-lab').getAttribute('href')).toBe('https://lab.test');
  });

  it('a user diagnosis names the spaces, feeds and attachments and lists the connector sessions as a table; a row disconnects from there (#367 M6 · user 2026-10-09)', async () => {
    let deleted = 0;
    let diagnosed = 0;
    scriptFetch({
      ...HAPPY_ROUTES(),
      'GET /admin/users/sub-alice/diagnosis': () => {
        diagnosed += 1;
        return {
          body: {
            userId: 'u1',
            memberSpaces: ['space-1', 'feed-1'],
            spaces: [
              { id: 'space-1', name: 'Household', role: 'owner', feed: false },
              { id: 'feed-1', name: null, role: 'owner', feed: true },
            ],
            ownedFeeds: [{ feedSpaceId: 'feed-1', maxSeq: 7, lastOpAt: '2026-10-08T06:00:00Z', attachedTo: [{ id: 'space-1', name: 'Household' }] }],
            attachments: [{ spaceId: 'space-1', feedSpaceId: 'feed-1', accountId: 'acct-1', spaceName: 'Household', accountName: 'ING Betaal', ibanTail: '…1234', attachedByName: 'Alice' }],
            connectorSessions: deleted === 0 ? [SESSION] : [],
          },
        };
      },
      'DELETE /admin/bank-connections/ses_1': () => {
        deleted += 1;
        return { body: outcomeOf('ses_1', 'ended') };
      },
    });
    renderAdmin();
    fireEvent.click(await screen.findByTestId('nav-users'));
    fireEvent.click(await screen.findByTestId('diagnose-sub-alice'));
    const spaces = await screen.findByTestId('user-diagnosis-spaces');
    expect(spaces.textContent).toContain('Household');
    expect(spaces.textContent).toContain('owner');
    // a feed membership is not a space: it sits under Feeds, attached to its space
    expect(spaces.textContent).not.toContain('feed-1');
    expect(screen.getByTestId('user-diagnosis-feeds').textContent).toContain('Household');
    const attachments = screen.getByTestId('user-diagnosis-attachments');
    expect(attachments.textContent).toContain('ING Betaal');
    expect(attachments.textContent).toContain('…1234');
    expect(attachments.textContent).toContain('Alice');

    const sessions = screen.getByTestId('user-diagnosis-connectors');
    expect(sessions.textContent).toContain('GoCardless');
    expect(sessions.textContent).toContain('needs_reauth');
    expect(sessions.textContent).toContain('session_expired');
    expect(screen.getByTestId('session-stale-ses_1')).toBeTruthy();
    // the id stays reachable: short in the cell, whole on the title
    expect(sessions.textContent).toContain('conn-12345…');
    expect(screen.getByTestId('session-connection-ses_1').getAttribute('title')).toContain('conn-1234567890abcdef');

    // Disconnect asks once, DELETEs, says what the party did and reads the diagnosis again
    fireEvent.click(screen.getByTestId('session-disconnect-ses_1'));
    fireEvent.click(await screen.findByTestId('session-disconnect-ses_1-yes'));
    await waitFor(() => expect(deleted).toBe(1));
    expect((await screen.findByTestId('admin-notice')).textContent).toContain('ended at the party');
    await waitFor(() => expect(screen.queryByTestId('session-ses_1')).toBeNull());
    expect(diagnosed).toBeGreaterThanOrEqual(2);
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

describe('AdminApp (invitations)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  /** the screen open — its list (and with it the mode line) lands on the first reload */
  const openInvitations = async () => {
    renderAdmin();
    fireEvent.click(await screen.findByTestId('nav-invitations'));
    return screen.findByTestId('invitations-screen');
  };

  it('lists the active invitations and says whether sign-up is by invitation', async () => {
    scriptFetch(HAPPY_ROUTES());
    await openInvitations();
    const row = await screen.findByTestId('invite-row-inv-1');
    expect(row.textContent).toContain('dana@x.nl');
    expect(screen.getByTestId('invite-row-inv-2').textContent).toContain('erik@x.nl');
    expect((screen.getByTestId('invite-link-inv-1') as HTMLInputElement).value).toBe('https://app.test/invite/one');
    expect(screen.getByTestId('invite-mode').textContent).toContain('by invitation');

    // an environment with open registration says so — the links still work there
    cleanup();
    scriptFetch({ ...HAPPY_ROUTES(), 'GET /admin/invitations': () => ({ body: { ...INVITATIONS, inviteOnly: false } }) });
    await openInvitations();
    await screen.findByTestId('invite-row-inv-1');
    expect(screen.getByTestId('invite-mode').textContent).toContain('Registration is open');
  });

  it('inviting posts the lower-cased e-mail, shows the link to hand over and copies it', async () => {
    let posted: unknown = null;
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    const calls = scriptFetch({
      ...HAPPY_ROUTES(),
      'POST /admin/invitations': (init) => {
        posted = JSON.parse(String(init?.body));
        return { status: 201, body: { id: 'inv-3', email: 'fay@x.nl', expiresAt: '2026-10-14T10:00:00Z', link: 'https://app.test/invite/three' } };
      },
    });
    await openInvitations();
    await screen.findByTestId('invite-row-inv-1');

    // the button arms only for something that reads as an address
    fireEvent.change(screen.getByTestId('invite-email'), { target: { value: 'fay' } });
    expect((screen.getByTestId('invite-send') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('invite-email'), { target: { value: 'Fay@X.nl' } });
    fireEvent.click(screen.getByTestId('invite-send'));

    const link = (await screen.findByTestId('invite-link')) as HTMLInputElement;
    expect(posted).toEqual({ email: 'fay@x.nl' });
    expect(link.value).toBe('https://app.test/invite/three');
    expect(screen.getByText(/Send this link to the person yourself/)).toBeTruthy();
    expect((screen.getByTestId('invite-email') as HTMLInputElement).value).toBe('');
    // the list reloads after the mint
    const post = calls.indexOf('POST /admin/invitations');
    expect(calls.indexOf('GET /admin/invitations', post)).toBeGreaterThan(post);

    fireEvent.click(screen.getByTestId('invite-copy'));
    await waitFor(() => expect(screen.getByTestId('invite-copy').textContent).toBe('Copied'));
    expect(writeText).toHaveBeenCalledWith('https://app.test/invite/three');
  });

  it('copy link falls back to selecting the text when the clipboard is unavailable', async () => {
    stubClipboard(async () => {
      throw new Error('clipboard denied');
    });
    scriptFetch(HAPPY_ROUTES());
    await openInvitations();
    await screen.findByTestId('invite-row-inv-2');
    fireEvent.click(screen.getByTestId('invite-copy-inv-2'));
    await waitFor(() => expect(screen.getByTestId('invite-copy-inv-2').textContent).toContain('Ctrl+C'));
    expect((screen.getByTestId('invite-link-inv-2') as HTMLInputElement).selectionEnd).toBe('https://app.test/invite/two'.length);
  });

  it('revoke calls DELETE and reloads the list', async () => {
    let revoked = false;
    const calls = scriptFetch({
      ...HAPPY_ROUTES(),
      'GET /admin/invitations': () => ({
        body: { ...INVITATIONS, invitations: INVITATIONS.invitations.filter((i) => !revoked || i.id !== 'inv-1') },
      }),
      'DELETE /admin/invitations/inv-1': () => {
        revoked = true;
        return {};
      },
    });
    await openInvitations();
    await screen.findByTestId('invite-row-inv-1');
    fireEvent.click(screen.getByTestId('invite-revoke-inv-1'));
    await waitFor(() => expect(screen.queryByTestId('invite-row-inv-1')).toBeNull());
    expect(screen.getByTestId('invite-row-inv-2')).toBeTruthy();
    const del = calls.indexOf('DELETE /admin/invitations/inv-1');
    expect(del).toBeGreaterThan(-1);
    expect(calls.indexOf('GET /admin/invitations', del)).toBeGreaterThan(del);
  });

  it('a refused invite (503 logto-refused) surfaces the error text and keeps the address for a retry', async () => {
    scriptFetch({ ...HAPPY_ROUTES(), 'POST /admin/invitations': () => ({ status: 503, body: { error: 'logto-refused' } }) });
    await openInvitations();
    await screen.findByTestId('invite-row-inv-1');
    fireEvent.change(screen.getByTestId('invite-email'), { target: { value: 'gus@x.nl' } });
    fireEvent.click(screen.getByTestId('invite-send'));
    await waitFor(() => expect(screen.getByTestId('admin-error').textContent).toContain('logto-refused'));
    expect(screen.queryByTestId('invite-link')).toBeNull();
    expect((screen.getByTestId('invite-email') as HTMLInputElement).value).toBe('gus@x.nl');
  });

  it('a list the API cannot give says why instead of posing as empty; the mode line falls back to /health', async () => {
    scriptFetch({
      ...HAPPY_ROUTES(),
      'GET /health': () => ({ body: { ...HEALTH, capabilities: { ...HEALTH.capabilities, inviteOnly: true } } }),
      'GET /admin/invitations': () => ({ status: 503, body: { error: 'logto-unavailable' } }),
    });
    await openInvitations();
    const note = await screen.findByTestId('invitations-unavailable');
    expect(note.textContent).toContain('logto-unavailable');
    expect(screen.queryByTestId('invitations-table')).toBeNull();
    expect(screen.getByTestId('invite-mode').textContent).toContain('by invitation');
  });
});

/** the Bank connections dashboard (user 2026-10-09): every open-banking consent across users, with a disconnect */
describe('AdminApp (bank connections)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  const ROWS = [
    { ...SESSION, sessionId: 'ses_a1', userSub: 'sub-alice', userName: 'Alice', connectionId: 'conn-alive-1', state: 'active', keptBundle: true, stale: false, lastScheduleError: null },
    { ...SESSION, sessionId: 'ses_a2', userSub: 'sub-alice', userName: 'Alice', connectionId: 'conn-dead-1' },
    { ...SESSION, sessionId: 'ses_a3', userSub: 'sub-alice', userName: 'Alice', connectionId: 'conn-dead-2', state: 'failed' },
    { ...SESSION, sessionId: 'ses_b1', userSub: 'sub-bob', userName: 'sub-bob', provider: 'enablebanking', state: 'active', keptBundle: true, stale: false, lastScheduleError: null },
  ];

  it('lists every open-banking session per user with the stale ones marked; the toggle asks for every party; the filter narrows', async () => {
    const asked: (string | null)[] = [];
    scriptFetch({
      ...HAPPY_ROUTES(),
      'GET /admin/bank-connections': (_init, url) => {
        const all = url?.searchParams.get('all') ?? null;
        asked.push(all);
        return { body: { all: all === 'true', total: ROWS.length, capped: false, connections: ROWS } };
      },
    });
    renderAdmin();
    fireEvent.click(await screen.findByTestId('nav-bank-connections'));
    const alice = await screen.findByTestId('bank-connections-user-sub-alice');
    expect(alice.textContent).toContain('Alice');
    expect(alice.textContent).toContain('3 connections');
    expect(alice.textContent).toContain('2 stale');
    expect(screen.getByTestId('session-stale-ses_a2')).toBeTruthy();
    expect(screen.getByTestId('session-stale-ses_a3')).toBeTruthy();
    expect(screen.queryByTestId('session-stale-ses_a1')).toBeNull();
    expect(screen.getByTestId('bank-connections-user-sub-bob').textContent).toContain('Enable Banking');
    expect(screen.getByTestId('bank-connections-tiles').textContent).toContain('Stale');

    // every party: the list is asked again with ?all=true
    fireEvent.click(screen.getByTestId('bank-connections-all'));
    await waitFor(() => expect(asked).toContain('true'));

    // the filter narrows by user or party
    fireEvent.change(await screen.findByTestId('bank-connections-search'), { target: { value: 'enable' } });
    await waitFor(() => expect(screen.queryByTestId('bank-connections-user-sub-alice')).toBeNull());
    expect(screen.getByTestId('bank-connections-user-sub-bob')).toBeTruthy();
  });

  it('Disconnect asks once and DELETEs; Clean up stale ends every stale row of that person after one confirm', async () => {
    const deleted: string[] = [];
    let rows = ROWS;
    const gone = (id: string, party: string, provider = 'gocardless') => () => {
      deleted.push(id);
      rows = rows.filter((row) => row.sessionId !== id);
      return { body: outcomeOf(id, party, provider) };
    };
    scriptFetch({
      ...HAPPY_ROUTES(),
      'GET /admin/bank-connections': () => ({ body: { all: false, total: rows.length, capped: false, connections: rows } }),
      'DELETE /admin/bank-connections/ses_a2': gone('ses_a2', 'gone'),
      'DELETE /admin/bank-connections/ses_a3': gone('ses_a3', 'ended'),
      'DELETE /admin/bank-connections/ses_b1': gone('ses_b1', 'ended', 'enablebanking'),
    });
    renderAdmin();
    fireEvent.click(await screen.findByTestId('nav-bank-connections'));
    await screen.findByTestId('bank-connections-user-sub-bob');

    // one row: the question, a way back, then the call and the outcome in the strip
    fireEvent.click(screen.getByTestId('session-disconnect-ses_b1'));
    expect(screen.getByTestId('session-disconnect-ses_b1-confirm').textContent).toContain('End it at the party');
    fireEvent.click(screen.getByTestId('session-disconnect-ses_b1-no'));
    expect(screen.queryByTestId('session-disconnect-ses_b1-confirm')).toBeNull();
    expect(deleted).toEqual([]);
    fireEvent.click(screen.getByTestId('session-disconnect-ses_b1'));
    fireEvent.click(screen.getByTestId('session-disconnect-ses_b1-yes'));
    await waitFor(() => expect(deleted).toEqual(['ses_b1']));
    expect((await screen.findByTestId('admin-notice')).textContent).toContain('Enable Banking');
    await waitFor(() => expect(screen.queryByTestId('bank-connections-user-sub-bob')).toBeNull());

    // the stale rows of Alice in one go — the live one stays
    fireEvent.click(screen.getByTestId('bank-connections-cleanup-sub-alice'));
    fireEvent.click(await screen.findByTestId('bank-connections-cleanup-sub-alice-yes'));
    await waitFor(() => expect(deleted).toEqual(['ses_b1', 'ses_a2', 'ses_a3']));
    await waitFor(() => expect(screen.getByTestId('admin-notice').textContent).toContain('2 stale connections disconnected'));
    await waitFor(() => expect(screen.queryByTestId('session-ses_a2')).toBeNull());
    expect(screen.getByTestId('session-ses_a1')).toBeTruthy();
    expect(screen.queryByTestId('bank-connections-cleanup-sub-alice')).toBeNull();
  });

  it('a list the API cannot give says why instead of posing as empty; the Connectors page points here', async () => {
    scriptFetch({ ...HAPPY_ROUTES(), 'GET /admin/bank-connections': () => ({ status: 404 }) });
    renderAdmin();
    fireEvent.click(await screen.findByTestId('nav-connectors'));
    fireEvent.click(await screen.findByTestId('connectors-open-bank-connections'));
    expect((await screen.findByTestId('bank-connections-unavailable')).textContent).toContain('HTTP 404');
    expect(sessionStorage.getItem('munni_admin_screen')).toBe('bank-connections');
  });
});
