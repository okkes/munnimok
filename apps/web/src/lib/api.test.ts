// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, getApiCapabilities } from './api';

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
    expect((await getApiCapabilities()).gocardless).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches the first result for the page lifetime', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ capabilities: { gocardless: true } }));
    const first = await getApiCapabilities();
    const second = await getApiCapabilities();
    expect(first.gocardless).toBe(true);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
