// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiSyncBackend, SyncHttpError, retryAfterMs } from './backend';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('ApiSyncBackend', () => {
  afterEach(() => vi.restoreAllMocks());

  const backend = (auth: { bearer?: string; testSub?: string }) =>
    new ApiSyncBackend({ baseUrl: 'http://api', getAuth: async () => auth });

  it('push sends ops with bearer auth and returns the result', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ lastSeq: 7 }));
    const result = await backend({ bearer: 'tok-123' }).push('s1', 'dev1', []);
    expect(result).toEqual({ lastSeq: 7 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api/sync/s1/push');
    const headers = new Headers(init!.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok-123');
    // the device pair every API call carries — the server refuses
    // device-less requests
    expect(headers.get('X-Munni-Device')).toMatch(/^[0-9a-f]{12}$/);
    expect(headers.get('X-Munni-Platform')).toBe('web');
    expect(init!.method).toBe('POST');
  });

  it('a 410 device-revoked answer raises the remote-disconnect event before failing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'device-revoked' }, 410));
    const seen = vi.fn();
    globalThis.addEventListener('munni:device-revoked', seen);
    try {
      await expect(backend({ testSub: 'x' }).pull('s1', 0)).rejects.toMatchObject(new SyncHttpError(410));
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.removeEventListener('munni:device-revoked', seen);
    }
  });

  it('test-auth identities send the X-User-Sub header instead', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ops: [], latestSeq: 0 }));
    await backend({ testSub: 'alice' }).pull('s1', 5);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api/sync/s1/pull?since=5');
    const headers = new Headers(init!.headers);
    expect(headers.get('X-User-Sub')).toBe('alice');
    expect(headers.get('Authorization')).toBeNull();
  });

  it('non-2xx responses raise SyncHttpError with the status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 403));
    await expect(backend({ testSub: 'x' }).pull('s1', 0)).rejects.toMatchObject(
      new SyncHttpError(403),
    );
    await expect(backend({ testSub: 'x' }).listSpaces()).rejects.toBeInstanceOf(SyncHttpError);
  });

  it('listSpaces returns the id array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(['a', 'b']));
    expect(await backend({ testSub: 'x' }).listSpaces()).toEqual(['a', 'b']);
  });

  it('#569: heads read every space with its head in one call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([{ spaceId: 'a', latestSeq: 4 }]));
    expect(await backend({ testSub: 'x' }).heads()).toEqual([{ spaceId: 'a', latestSeq: 4 }]);
    expect(fetchMock.mock.calls[0][0]).toBe('http://api/sync/heads');
  });

  it('#569: a 429 carries the pause the server named', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '10' } }));
    await expect(backend({ testSub: 'x' }).heads()).rejects.toMatchObject({ status: 429, retryAfterMs: 10_000 });
  });
});

describe('retryAfterMs', () => {
  it('reads seconds or an HTTP date, and nothing it cannot read', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    expect(retryAfterMs('30', now)).toBe(30_000);
    expect(retryAfterMs('Sun, 08 Nov 2026 12:00:20 GMT', now)).toBe(20_000);
    expect(retryAfterMs('soon', now)).toBeUndefined();
    expect(retryAfterMs(null, now)).toBeUndefined();
  });
});
