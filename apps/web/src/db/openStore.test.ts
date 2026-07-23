// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLAG_KEY, activeStoreBackend, openStorageBackend } from './openStore';

vi.mock('@/lib/platform', () => ({ isNativeApp: () => true }));

/** the same fake raw plugin the executor tests use */
const makePlugin = () => ({
  isSecretStored: vi.fn().mockResolvedValue({ result: true }),
  setEncryptionSecret: vi.fn().mockResolvedValue(undefined),
  createConnection: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue(undefined),
  run: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue({ values: [] }),
  beginTransaction: vi.fn().mockResolvedValue(undefined),
  commitTransaction: vi.fn().mockResolvedValue(undefined),
  rollbackTransaction: vi.fn().mockResolvedValue(undefined),
  closeConnection: vi.fn().mockResolvedValue(undefined),
  deleteDatabase: vi.fn().mockResolvedValue(undefined),
});

const setPlugin = (plugin: unknown) => {
  (globalThis as { Capacitor?: unknown }).Capacitor = plugin ? { Plugins: { CapacitorSQLite: plugin } } : undefined;
};

const wipeIndexedDb = async () => {
  for (const db of await indexedDB.databases()) if (db.name) indexedDB.deleteDatabase(db.name);
};

describe('E3b: fresh native installs default onto the encrypted store', () => {
  beforeEach(async () => {
    localStorage.clear();
    await wipeIndexedDb();
  });
  afterEach(() => setPlugin(undefined));

  it('a fresh install (no munni databases, no flag) decides "1" and opens SQLCipher', async () => {
    setPlugin(makePlugin());
    const backend = await openStorageBackend('munni_fresh');
    expect(localStorage.getItem(FLAG_KEY)).toBe('1');
    expect(activeStoreBackend()).toBe('sqlcipher');
    backend.close();
  });

  it('an existing install (a munni database already on the device) stays on Dexie', async () => {
    // simulate the pre-E3b device: an identity database already exists
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('munni_veteran');
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error as Error);
    });
    setPlugin(makePlugin());
    const backend = await openStorageBackend('munni_veteran');
    expect(localStorage.getItem(FLAG_KEY)).toBe('0');
    expect(activeStoreBackend()).toBe('dexie');
    backend.close();
  });

  it('an explicit OFF ("0") is remembered — the default never re-triggers', async () => {
    localStorage.setItem(FLAG_KEY, '0');
    setPlugin(makePlugin());
    const backend = await openStorageBackend('munni_optout');
    expect(localStorage.getItem(FLAG_KEY)).toBe('0');
    expect(activeStoreBackend()).toBe('dexie');
    backend.close();
  });

  it('an encrypted-open failure falls back to Dexie and records "0", not a removal', async () => {
    const plugin = makePlugin();
    plugin.open.mockRejectedValue(new Error('plugin config broken'));
    setPlugin(plugin);
    localStorage.setItem(FLAG_KEY, '1');
    const backend = await openStorageBackend('munni_broken');
    expect(activeStoreBackend()).toBe('dexie'); // never brick the app
    // '0' (not removed): an absent flag would re-run the fresh-install
    // default next launch and loop the failure
    expect(localStorage.getItem(FLAG_KEY)).toBe('0');
    backend.close();
  });
});
