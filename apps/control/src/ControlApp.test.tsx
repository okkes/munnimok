// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlApp } from './ControlApp';
import type { ControlConfig } from './config';

const CONFIG: ControlConfig = { apiUrl: 'http://api.test', logtoEndpoint: '', logtoAppId: '', logtoResource: '', labUrl: '' };

const HEALTH = { status: 'ok', build: '640', capabilities: { connectors: true, fcm: true, push: false } };

type Handler = (init?: RequestInit) => { status?: number; body?: unknown };

function scriptFetch(routes: Record<string, Handler>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const key = `${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`;
      calls.push(key);
      const out = routes[key]?.(init) ?? { status: 404 };
      return new Response(JSON.stringify(out.body ?? {}), {
        status: out.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

const HAPPY_ROUTES = (): Record<string, Handler> => ({
  'GET /control/ping': () => ({}),
  'GET /control/connectors/status': () => ({
    body: {
      service: { kinds: ['bank'], version: '1.0.0', manifestDigest: 'sha256-abcdef1234567890' },
      providers: [{ providerId: 'gocardless', state: 'healthy', since: '2026-09-30T03:00:00Z', reasonKey: null, acceptsWork: true, quota: null }],
      agents: { total: 1, online: 1, revoked: 0 },
      queue: { queued: 0, running: 0, awaitingInput: 0 },
      relay: { openStreams: 0 },
    },
  }),
  'GET /health': () => ({ body: HEALTH }),
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/** an aggregator that keeps an inventory beside a party that does not, and the consents of three origins on its account */
const CONSENT_ROUTES = (): Record<string, Handler> => ({
  ...HAPPY_ROUTES(),
  'GET /control/connectors/status': () => ({
    body: {
      service: { kinds: ['bank', 'store'], version: '1.0.0', manifestDigest: 'sha256-abcdef1234567890' },
      providers: [
        { providerId: 'gocardless', state: 'healthy', since: '2026-09-30T03:00:00Z', reasonKey: null, acceptsWork: true, inventory: true, quota: { limit: 10, remaining: 2, resetAt: '2026-10-01T00:00:00Z', seenAt: '2026-09-30T03:05:00Z' } },
        { providerId: 'ah', state: 'paused', since: '2026-09-29T10:00:00Z', reasonKey: 'connect.paused.maintenance', acceptsWork: false },
      ],
      agents: { total: 2, online: 1, revoked: 0 },
      queue: { queued: 0, running: 1, awaitingInput: 0 },
      relay: { openStreams: 0 },
    },
  }),
  'GET /control/connectors/providers/gocardless/remote-consents': () => ({
    body: {
      consents: [
        { id: 'req-prod-00001', status: 'LN', createdAt: daysAgo(40), institutionId: 'ING_NL', origin: 'https://munni-prod-nas.example.com', accountCount: 2 },
        { id: 'req-old-00004', status: 'EX', createdAt: daysAgo(200), institutionId: 'ING_NL', origin: 'https://munni-prod-nas.example.com', accountCount: 0 },
        { id: 'req-here-00002', status: 'LN', createdAt: daysAgo(10), institutionId: 'RABO_NL', origin: 'http://localhost:8480', accountCount: 1 },
        { id: 'req-lost-00003', status: 'CR', createdAt: daysAgo(3), institutionId: 'ASN_NL', origin: null, accountCount: 0 },
      ],
    },
  }),
});

function renderControl(overrides: Partial<ControlConfig> = {}) {
  localStorage.setItem('munni_control_sub', 'sub-alice');
  render(<ControlApp config={{ ...CONFIG, ...overrides }} getToken={null} />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ControlApp (test-auth mode)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear(); // the persisted screen must not leak between tests
  });

  it('a sign-in without the admin scope sees the denied note and no data', async () => {
    scriptFetch({ 'GET /control/ping': () => ({ status: 403 }) });
    render(<ControlApp config={CONFIG} getToken={null} />);
    fireEvent.change(screen.getByTestId('control-sub'), { target: { value: 'nobody' } });
    await screen.findByText(/no admin access/);
    expect(screen.queryByTestId('control-tiles')).toBeNull();
    expect(screen.queryByText(/did not answer/)).toBeNull();
  });

  it('a Logto session offers Sign out — a freshly granted admin role rides on the next token', async () => {
    scriptFetch({ 'GET /control/ping': () => ({ status: 403 }) });
    const signOut = vi.fn();
    render(<ControlApp config={CONFIG} getToken={async () => 'tok'} signOut={signOut} />);
    await screen.findByText(/no admin access/);
    fireEvent.click(screen.getByTestId('control-signout'));
    expect(signOut).toHaveBeenCalledTimes(1);
    // the denied note carries its own Sign out — the fix it names is one tap away
    fireEvent.click(screen.getByTestId('control-denied-signout'));
    expect(signOut).toHaveBeenCalledTimes(2);
  });

  it('an unanswered ping (network/CORS/5xx) shows the reachability note, NOT the denied one', async () => {
    scriptFetch({ 'GET /control/ping': () => ({ status: 500 }) });
    render(<ControlApp config={CONFIG} getToken={null} />);
    fireEvent.change(screen.getByTestId('control-sub'), { target: { value: 'anybody' } });
    await screen.findByText(/did not answer/);
    expect(screen.queryByText(/no admin access/)).toBeNull();
    expect(screen.queryByTestId('control-tiles')).toBeNull();
  });

  it('a disconnected device (410) says so and forgets its id so the next load registers anew', async () => {
    localStorage.setItem('munni_control_device', 'dev-revoked');
    scriptFetch({ 'GET /control/ping': () => ({ status: 410, body: { error: 'device-revoked' } }) });
    render(<ControlApp config={CONFIG} getToken={null} />);
    fireEvent.change(screen.getByTestId('control-sub'), { target: { value: 'anybody' } });
    await screen.findByText(/disconnected from the account/);
    expect(screen.queryByText(/did not answer/)).toBeNull();
    expect(screen.queryByTestId('control-tiles')).toBeNull();
    expect(localStorage.getItem('munni_control_device')).toBeNull();
  });

  it('shows the cockpit nav and overview: the designated environment’s parties at a glance plus its health', async () => {
    const calls = scriptFetch(HAPPY_ROUTES());
    renderControl();
    await screen.findByTestId('nav-connectors');
    expect(screen.getByTestId('nav-overview')).toBeTruthy();
    // the per-environment portal's screens do not exist here, nor the retired consents and quota screens
    expect(screen.queryByTestId('nav-users')).toBeNull();
    expect(screen.queryByTestId('nav-catalog')).toBeNull();
    expect(screen.queryByTestId('nav-connections')).toBeNull();
    expect(screen.queryByTestId('nav-quota')).toBeNull();

    const tiles = await screen.findByTestId('control-tiles');
    await waitFor(() => expect(tiles.textContent).toContain('1 / 1Parties accepting work'));
    expect(tiles.textContent).toContain('1 / 1Agents online');
    expect(screen.getByTestId('control-health').textContent).toContain('build 640');

    // the cockpit talks to /control/* only — never the per-env admin surface
    expect(calls.some((c) => c.includes('/admin/'))).toBe(false);
  });

  it('the overview says what the cockpit is for — which environment it reads, that it never writes — and opens its two screens (#571)', async () => {
    scriptFetch(CONSENT_ROUTES());
    renderControl();
    const about = await screen.findByTestId('control-about');
    expect(about.textContent).toContain('api.test');
    expect(about.textContent).toContain('only reads');
    expect(about.textContent).toContain('admin portal');
    fireEvent.click(screen.getByTestId('control-about-consents'));
    expect(await screen.findByTestId('consents-party-gocardless')).toBeTruthy();
    fireEvent.click(screen.getByTestId('nav-overview'));
    fireEvent.click(await screen.findByTestId('control-about-connectors'));
    expect(await screen.findByTestId('control-connectors')).toBeTruthy();
  });
  it('an environment without connectors shows empty tiles and no inventory, never a blank screen', async () => {
    scriptFetch({ ...HAPPY_ROUTES(), 'GET /control/connectors/status': () => ({ status: 404 }) });
    renderControl();
    const tiles = await screen.findByTestId('control-tiles');
    expect(tiles.textContent).toContain('—');
    expect(screen.getByTestId('control-health').textContent).toContain('build 640');
  });

  it('connectors: the designated environment’s parties with their budget and the fleet, read-only; only an aggregator’s row opens its consents (#367 M6, #414, #561)', async () => {
    const calls = scriptFetch(CONSENT_ROUTES());
    renderControl();
    fireEvent.click(await screen.findByTestId('nav-connectors'));
    const tiles = await screen.findByTestId('control-connectors-tiles');
    expect(tiles.textContent).toContain('1 / 2');
    const table = screen.getByTestId('control-connectors');
    expect(table.textContent).toContain('ah');
    expect(table.textContent).toContain('paused');
    expect(table.textContent).toContain('connect.paused.maintenance');
    // the budget: two of ten calls left, nearly spent (a fifth or less)
    const quota = screen.getByTestId('control-quota-gocardless');
    expect(quota.textContent).toContain('2 / 10');
    expect(quota.className).toContain('warn');
    // read-only: no kill switch here, and a party that keeps no inventory offers none (asking it was the 400 of #561)
    expect([...table.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['consents']);
    expect(screen.queryByTestId('control-consents-ah')).toBeNull();

    fireEvent.click(screen.getByTestId('control-consents-gocardless'));
    expect(await screen.findByTestId('consents-group-https://munni-prod-nas.example.com')).toBeTruthy();
    expect(calls.filter((c) => c.endsWith('/remote-consents'))).toEqual(['GET /control/connectors/providers/gocardless/remote-consents']);
    expect(calls.some((c) => c.includes('/admin/'))).toBe(false);

    // the active screen survives the page reload a Logto re-auth causes
    expect(sessionStorage.getItem('munni_control_screen')).toBe('consents');
    cleanup();
    renderControl();
    await screen.findByTestId('consents-party-gocardless');
  });

  it('bank consents: every environment’s consents at the aggregator in one list, by environment, leftovers marked — and where to remove one (#571)', async () => {
    scriptFetch(CONSENT_ROUTES());
    renderControl({ labUrl: 'https://munni-prod-nas-lab.example.com' });
    fireEvent.click(await screen.findByTestId('nav-consents'));
    const prod = await screen.findByTestId('consents-group-https://munni-prod-nas.example.com');
    // munni's own hosts name their environment
    expect(prod.textContent).toContain('prod · nas');
    expect(prod.textContent).toContain('ING_NL');
    expect(prod.textContent).toContain('2 consents · 2 accounts · 1 leftover');
    expect(screen.getByTestId('consent-req-prod-00001').textContent).toContain('linked — in force');
    expect(screen.getByTestId('consent-req-prod-00001').textContent).not.toContain('leftover');
    expect(screen.getByTestId('consent-req-old-00004').textContent).toContain('expired');
    expect(screen.getByTestId('consent-req-old-00004').textContent).toContain('leftover');
    expect(screen.getByTestId('consents-group-http://localhost:8480').textContent).toContain('this computer');
    // a sign-in at the bank nobody finished is a leftover; no return address goes last, said as such
    const lost = screen.getByTestId('consents-group-unattributed');
    expect(lost.textContent).toContain('never finished');
    expect(lost.textContent).toContain('No return address');
    const tiles = screen.getByTestId('consents-tiles');
    expect(tiles.textContent).toContain('4Consents');
    expect(tiles.textContent).toContain('2In force');
    expect(tiles.textContent).toContain('2Leftovers');
    expect(tiles.textContent).toContain('2Environments');
    // read-only: the revoke is the lab's, one link away; Enable Banking is said to list nothing at its side
    expect(screen.queryAllByRole('button', { name: /revoke/i })).toHaveLength(0);
    expect(screen.getByTestId('consents-lab-gocardless').getAttribute('href')).toBe('https://munni-prod-nas-lab.example.com/#/providers/gocardless');
    expect(screen.getByTestId('consents-enablebanking').textContent).toContain('admin portal');
  });

  it('bank consents: an inventory that does not answer, one without consents, and an environment without an aggregator each say so', async () => {
    scriptFetch({
      ...CONSENT_ROUTES(),
      'GET /control/connectors/providers/gocardless/remote-consents': () => ({ status: 502 }),
    });
    renderControl();
    fireEvent.click(await screen.findByTestId('nav-consents'));
    expect(await screen.findByTestId('consents-unreachable')).toBeTruthy();
    expect(screen.queryByTestId('consents-lab-gocardless')).toBeNull(); // no lab address known: nothing to link
    cleanup();

    scriptFetch({ ...CONSENT_ROUTES(), 'GET /control/connectors/providers/gocardless/remote-consents': () => ({ body: { consents: [] } }) });
    renderControl();
    expect(await screen.findByTestId('consents-empty')).toBeTruthy();
    cleanup();

    scriptFetch(HAPPY_ROUTES()); // gocardless here keeps no inventory
    renderControl();
    expect(await screen.findByTestId('consents-none')).toBeTruthy();
    cleanup();

    scriptFetch({ ...HAPPY_ROUTES(), 'GET /control/connectors/status': () => ({ status: 503 }) });
    renderControl();
    expect((await screen.findByTestId('control-connectors-note')).textContent).toContain('did not answer');
  });
  it('connectors: an environment without connectors says so', async () => {
    scriptFetch({ ...HAPPY_ROUTES(), 'GET /control/connectors/status': () => ({ status: 404 }) });
    renderControl();
    fireEvent.click(await screen.findByTestId('nav-connectors'));
    expect((await screen.findByTestId('control-connectors-note')).textContent).toContain('runs no connectors');
  });

  it('typing a sub persists it and sends it as X-User-Sub, with a stable device id', async () => {
    const seenHeaders: (string | null)[] = [];
    const seenDevices: (string | null)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/control/')) {
          seenHeaders.push(new Headers(init?.headers).get('X-User-Sub'));
          seenDevices.push(new Headers(init?.headers).get('X-Munni-Device'));
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    render(<ControlApp config={CONFIG} getToken={null} />);
    fireEvent.change(screen.getByTestId('control-sub'), { target: { value: 'sub-admin' } });
    await waitFor(() => expect(seenHeaders.length).toBeGreaterThan(1));
    expect(seenHeaders.every((h) => h === 'sub-admin')).toBe(true);
    expect(localStorage.getItem('munni_control_sub')).toBe('sub-admin');
    // the API refuses requests that name no device: one id, minted once, on every call
    expect(seenDevices[0]).toBeTruthy();
    expect(seenDevices.every((d) => d === seenDevices[0])).toBe(true);
    expect(localStorage.getItem('munni_control_device')).toBe(seenDevices[0]);
  });
});

describe('ControlApp (OIDC token mode)', () => {
  beforeEach(() => sessionStorage.clear()); // persisted screen must not leak in

  it('uses the bearer token and hides the sub box', async () => {
    const seenAuth: (string | null)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/control/')) seenAuth.push(new Headers(init?.headers).get('Authorization'));
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    render(<ControlApp config={CONFIG} getToken={async () => 'tok-abc'} />);
    expect(screen.queryByTestId('control-sub')).toBeNull();
    await waitFor(() => expect(seenAuth.length).toBeGreaterThan(0));
    expect(seenAuth.every((h) => h === 'Bearer tok-abc')).toBe(true);
  });
});
