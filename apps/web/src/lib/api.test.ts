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

  it('sends no auth headers for demo identities', async () => {
    localStorage.setItem('munni_session', JSON.stringify({ kind: 'demo' }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
    await apiFetch('/health');
    const headers = new Headers(fetchMock.mock.calls[0][1]!.headers);
    expect(headers.get('X-User-Sub')).toBeNull();
    expect(headers.get('Authorization')).toBeNull();
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
  afterEach(() => vi.restoreAllMocks());

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
