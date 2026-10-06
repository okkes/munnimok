import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCall, getJson, reasonOf } from './api';

describe('the api door', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reasonOf reads the api string, the connector envelope (with its detail id) and falls back to the status', async () => {
    expect(await reasonOf(null)).toBe('network');
    expect(await reasonOf(new Response(JSON.stringify({ error: 'nope' }), { status: 400 }))).toBe('nope');
    expect(await reasonOf(new Response(JSON.stringify({ error: { code: 'rate_limited' } }), { status: 429 }))).toBe('rate_limited');
    expect(await reasonOf(new Response(JSON.stringify({ error: { code: 'internal', detailId: 'err_9' } }), { status: 500 }))).toBe('internal (err_9)');
    expect(await reasonOf(new Response('not json', { status: 503 }))).toBe('HTTP 503');
  });

  it('getJson answers null on 404 (no connectors), "unreachable" on a failure, the body otherwise', async () => {
    const answers: Record<string, Response> = {
      'http://api.test/a': new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
      'http://api.test/b': new Response('', { status: 404 }),
      'http://api.test/c': new Response('', { status: 500 }),
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => answers[String(input)] ?? Promise.reject(new Error('down'))));
    const call = createCall('http://api.test', { getToken: null, sub: 'x' });
    expect(await getJson(call, '/a')).toEqual({ ok: 1 });
    expect(await getJson(call, '/b')).toBeNull();
    expect(await getJson(call, '/c')).toBe('unreachable');
    expect(await getJson(call, '/d')).toBe('unreachable');
  });

  it('a bearer wins over the test subject; without either, no identity header goes out', async () => {
    const seen: Headers[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response('{}');
    }));
    await createCall('http://api.test', { getToken: async () => 'tok', sub: 'x' })('/p');
    await createCall('http://api.test', { getToken: async () => undefined, sub: 'x' })('/p');
    await createCall('http://api.test', { getToken: null, sub: '' })('/p');
    expect(seen[0].get('Authorization')).toBe('Bearer tok');
    expect(seen[0].get('X-User-Sub')).toBeNull();
    expect(seen[1].get('Authorization')).toBeNull();
    expect(seen[2].get('X-User-Sub')).toBeNull();
    expect(seen[2].get('Content-Type')).toBe('application/json');
  });
});
