import { isNativeApp } from '@/lib/platform';
import { DexieBackend } from './backend';
import type { StorageBackend } from './backend';
import { MunniDB } from './schema';
import { sqliteAvailable } from './capacitorSql';

/**
 * E2 backend selection. The `munni_encrypted_store` device flag (set it
 * via devtools: localStorage.munni_encrypted_store = '1') switches the
 * native shells onto the SQLCipher store — dev/testing only until E3/E4
 * make it the default. The encrypted database starts empty; a syncing
 * identity simply re-syncs, which is also the approved migration path.
 */
export const FLAG_KEY = 'munni_encrypted_store';

/** what actually opened — the UI's truth signal (user: "how do I verify
 *  SQLCipher really took over?"): the flag is intent, this is fact */
export type ActiveStoreBackend = 'sqlcipher' | 'dexie';
let activeBackend: ActiveStoreBackend = 'dexie';
export const activeStoreBackend = (): ActiveStoreBackend => activeBackend;

export const encryptedStoreEnabled = (): boolean =>
  isNativeApp() && sqliteAvailable() && localStorage.getItem(FLAG_KEY) === '1';

export async function openStorageBackend(name: string): Promise<StorageBackend> {
  if (encryptedStoreEnabled()) {
    // NEVER brick the app on the encrypted path (user report: a plugin
    // config error left the shell stuck on the connecting screen until
    // reinstall): any failure reports itself, clears the flag and falls
    // back to Dexie — the next launch starts clean.
    try {
      const [{ openEncryptedExecutor }, { SqlStorageBackend, initSqlSchema }] = await Promise.all([
        import('./capacitorSql'),
        import('./sqlBackend'),
      ]);
      const executor = await openEncryptedExecutor(name);
      await initSqlSchema(executor);
      activeBackend = 'sqlcipher';
      return new SqlStorageBackend(executor);
    } catch (err) {
      console.error('encrypted store failed to open — falling back to Dexie', err);
      const { captureException } = await import('@sentry/react').catch(() => ({ captureException: () => undefined }));
      captureException(err);
      localStorage.removeItem(FLAG_KEY);
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
