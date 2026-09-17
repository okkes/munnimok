import { isNativeApp } from '@/lib/platform';
import { DexieBackend } from './backend';
import type { StorageBackend } from './backend';
import { MunniDB } from './schema';
import { sqliteAvailable } from './capacitorSql';

/**
 * E4 (user ruling 2026-07-24): the native shells run on the encrypted
 * SQLCipher store, ALWAYS — no toggle, no verify UI. The only path to
 * Dexie on native is the never-brick fallback below.
 */
export const FLAG_KEY = 'munni_encrypted_store';

/** what actually opened — the truth signal: encrypted is intent, this is fact */
export type ActiveStoreBackend = 'sqlcipher' | 'dexie';
let activeBackend: ActiveStoreBackend = 'dexie';
export const activeStoreBackend = (): ActiveStoreBackend => activeBackend;

// '0' is written ONLY by the never-brick fallback after a failed
// encrypted open — everything else on native is always-on
export const encryptedStoreEnabled = (): boolean =>
  isNativeApp() && sqliteAvailable() && localStorage.getItem(FLAG_KEY) !== '0';

export async function openStorageBackend(name: string): Promise<StorageBackend> {
  if (encryptedStoreEnabled()) {
    // NEVER brick the app on the encrypted path (user report: a plugin
    // config error left the shell stuck on the connecting screen until
    // reinstall): any failure reports itself, marks the flag and falls
    // back to Dexie.
    try {
      const [{ openEncryptedExecutor }, { SqlStorageBackend, initSqlSchema }] = await Promise.all([
        import('./capacitorSql'),
        import('./sqlBackend'),
      ]);
      const executor = await openEncryptedExecutor(name);
      await initSqlSchema(executor);
      const backend = new SqlStorageBackend(executor);
      activeBackend = 'sqlcipher';
      return backend;
    } catch (err) {
      console.error('encrypted store failed to open — falling back to Dexie', err);
      const { captureException } = await import('@sentry/react').catch(() => ({ captureException: () => undefined }));
      captureException(err);
      // '0': remember the failure so the fallback is stable across launches
      localStorage.setItem(FLAG_KEY, '0');
    }
  }
  activeBackend = 'dexie';
  return new DexieBackend(new MunniDB(name));
}

/** wipe an identity's data wherever it lives (demo logout, account deletion) */
export async function destroyStorage(name: string): Promise<void> {
  if (encryptedStoreEnabled()) {
    const { openEncryptedExecutor } = await import('./capacitorSql');
    const executor = await openEncryptedExecutor(name);
    await executor.destroy();
  }
  await new DexieBackend(new MunniDB(name)).destroy();
}
