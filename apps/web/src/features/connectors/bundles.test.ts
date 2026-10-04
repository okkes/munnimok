// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { ConnectorError } from './api';
import { keepBundle, readBundle } from './bundles';

let db: MunniDB;
let backend: DexieBackend;
let counter = 0;

beforeEach(async () => {
  db = new MunniDB(`bundles_${++counter}`);
  backend = new DexieBackend(db);
  await backend.connectorConnPut({ id: 'conn-1', provider: 'mock-store-simple', state: 'active', refreshedAt: '2026-10-05T00:00:00Z' });
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  db.close();
});

describe('web custody of a connection bundle (prod 2026-10-05: a shop sign-in that "did nothing")', () => {
  it('keeps the bundle in the tab and reads it back', async () => {
    await keepBundle(backend, 'conn-1', 'sb_v1.kept');
    expect(await readBundle(backend, 'conn-1')).toBe('sb_v1.kept');
    // the row itself carries no bundle on the web - it dies with the tab
    expect((await backend.connectorConnGet('conn-1'))?.bundle).toBeUndefined();
  });

  it('a browser that keeps no site data says so instead of signing in into thin air', async () => {
    // happy-dom's storage is not a Storage instance a prototype spy reaches: the global itself is replaced
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      removeItem: () => undefined,
      clear: () => undefined,
    });
    const failure = await keepBundle(backend, 'conn-1', 'sb_v1.lost').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ConnectorError);
    expect((failure as ConnectorError).envelope.code).toBe('custody_unavailable');
    expect(await readBundle(backend, 'conn-1')).toBeUndefined();
  });
});
