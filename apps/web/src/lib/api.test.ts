// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, getApiCapabilities } from './api';
import { reportWarning } from './report';

vi.mock('./report', () => ({ reportError: vi.fn(), reportWarning: vi.fn() }));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('apiFetch', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends X-User-Sub for test-auth user identities', async () => {
    localStorage.setItem('munni_session', JSON.stringify({ kind: 'user', sub: 'alice', testAuth: true }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
    await apiFetch('/friends');
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init!.headers);
    expect(headers.get('X-User-Sub')).toBe('alice');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('refuses the network entirely for demo/offline identities', async () => {
    localStorage.setItem('munni_session', JSON.stringify({ kind: 'demo' }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
    await expect(apiFetch('/health')).rejects.toThrow(/local-only/);
    localStorage.setItem('munni_session', JSON.stringify({ kind: 'offline', profileId: 'p1' }));
    await expect(apiFetch('/health')).rejects.toThrow(/local-only/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still fetches while signed out (login provisioning)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
    await apiFetch('/health');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a 500 and a 409 as unexpected; a gateway answer (502/503/504) is a retry, never an event (user rule 2026-10-05)', async () => {
    localStorage.setItem('munni_session', JSON.stringify({ kind: 'user', sub: 'a', testAuth: true }));
    vi.mocked(reportWarning).mockClear();
    for (const status of [502, 503, 504]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, status));
      expect((await apiFetch('/connectors/bol/sync', { method: 'POST' })).status).toBe(status);
    }
    expect(reportWarning).not.toHaveBeenCalled();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 500));
    await apiFetch('/x');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 409));
    await apiFetch('/y');
    expect(reportWarning).toHaveBeenCalledTimes(2);
    await apiFetch('/feeds', {}, { expectStatuses: [409] });
    expect(reportWarning).toHaveBeenCalledTimes(2);
  });

  it('preserves caller-supplied headers and method', async () => {
    localStorage.setItem('munni_session', JSON.stringify({ kind: 'user', sub: 'a', testAuth: true }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
    await apiFetch('/x', { method: 'DELETE', headers: { 'X-Extra': '1' } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init!.method).toBe('DELETE');
    expect(new Headers(init!.headers).get('X-Extra')).toBe('1');
  });
});

describe('getApiCapabilities', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('answers "no server features" for offline identities without touching the network', async () => {
    localStorage.setItem('munni_session', JSON.stringify({ kind: 'offline', profileId: 'p1' }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
    expect(await getApiCapabilities()).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches the first result for the page lifetime', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ capabilities: { logos: true } }));
    const first = await getApiCapabilities();
    const second = await getApiCapabilities();
    expect(first.logos).toBe(true);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('dead-session handling (401 → retry → the sign-in banner)', () => {
  it('retries once with a fresh token, then marks the session expired — nobody is logged out (local-first, user 2026-10-06)', async () => {
    const { resetAuthExpiryGuard } = await import('./api');
    resetAuthExpiryGuard();
    const { isSessionExpired, resetSessionExpiryForTests } = await import('@/app/sessionExpiry');
    resetSessionExpiryForTests();
    const { setAccessTokenGetter, signalAuthReady } = await import('@/app/authToken');
    signalAuthReady();
    setAccessTokenGetter(async () => 'stale-but-real-token'); // a REAL bearer gets rejected
    const { useSession } = await import('@/app/session');
    // apiFetch reads the persisted identity, not the store snapshot
    localStorage.setItem('munni_session', JSON.stringify({ kind: 'user', sub: 'stale-user' }));
    localStorage.setItem('logto:app-id:idToken', 'stale');
    useSession.setState({ identity: { kind: 'user', sub: 'stale-user' } });
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls.push('call');
      return new Response('{}', { status: 401 });
    }));
    const assignSpy = vi.fn();
    const original = globalThis.location;
    vi.stubGlobal('location', { ...original, assign: assignSpy });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { apiFetch } = await import('./api');
    const res = await apiFetch('/me/spaces');
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(2);
    expect(useSession.getState().identity).not.toBeNull();
    expect(localStorage.getItem('logto:app-id:idToken')).toBe('stale');
    expect(assignSpy).not.toHaveBeenCalled();
    expect(isSessionExpired()).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('double 401'));

    // #654: from here the session is known to be gone — the next call asks the server nothing
    const again = await apiFetch('/me/spaces');
    expect(again.status).toBe(401);
    expect(calls).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    setAccessTokenGetter(null);
    resetSessionExpiryForTests();
  });

  it('a party\'s 401 through the relay (partyAuth) is neither retried nor marks the session expired (user 2026-10-07: "random expired issues" were a bank\'s lapsed session)', async () => {
    const { resetAuthExpiryGuard } = await import('./api');
    resetAuthExpiryGuard();
    const { isSessionExpired, resetSessionExpiryForTests } = await import('@/app/sessionExpiry');
    resetSessionExpiryForTests();
    const { setAccessTokenGetter, signalAuthReady } = await import('@/app/authToken');
    signalAuthReady();
    setAccessTokenGetter(async () => 'a-real-token');
    const { useSession } = await import('@/app/session');
    localStorage.setItem('munni_session', JSON.stringify({ kind: 'user', sub: 'party-user' }));
    useSession.setState({ identity: { kind: 'user', sub: 'party-user' } });
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls.push('call');
      return new Response('{"error":{"code":"session_expired"}}', { status: 401 });
    }));

    const { apiFetch } = await import('./api');
    const res = await apiFetch('/connectors/ing-nl/sync', {}, { partyAuth: true });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1); // a bank login is never retried behind the person's back
    expect(isSessionExpired()).toBe(false);
    setAccessTokenGetter(null);
    resetSessionExpiryForTests();
  });

  it('a 401 without a bearer never forces a logout (cold-start boot race)', async () => {
    // requests fired before the token getter exists carry no bearer: those 401s must not wipe the session
    const { resetAuthExpiryGuard, apiFetch } = await import('./api');
    resetAuthExpiryGuard();
    const { setAccessTokenGetter, signalAuthReady } = await import('@/app/authToken');
    signalAuthReady();
    setAccessTokenGetter(null);
    const { useSession } = await import('@/app/session');
    localStorage.setItem('munni_session', JSON.stringify({ kind: 'user', sub: 'booting-user' }));
    useSession.setState({ identity: { kind: 'user', sub: 'booting-user' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    const assignSpy = vi.fn();
    vi.stubGlobal('location', { ...globalThis.location, assign: assignSpy });

    const res = await apiFetch('/me/spaces');
    expect(res.status).toBe(401);
    expect(useSession.getState().identity).not.toBeNull();
    expect(assignSpy).not.toHaveBeenCalled();
  });
});
