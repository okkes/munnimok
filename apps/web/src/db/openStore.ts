import { isNativeApp } from '@/lib/platform';
import { reportError } from '@/lib/report';
import { DexieBackend } from './backend';
import type { StorageBackend } from './backend';
import Dexie from 'dexie';
import { MunniDB } from './schema';
import { sqliteAvailable } from './capacitorSql';

// native shells always run the encrypted SQLCipher store, no toggle; Dexie there is only the never-brick fallback
export const FLAG_KEY = 'munni_encrypted_store';

/** what actually opened — the truth signal: encrypted is intent, this is fact */
export type ActiveStoreBackend = 'sqlcipher' | 'dexie';
let activeBackend: ActiveStoreBackend = 'dexie';
export const activeStoreBackend = (): ActiveStoreBackend => activeBackend;

// '0' is written only by the never-brick fallback after a failed encrypted open
export const encryptedStoreEnabled = (): boolean =>
  isNativeApp() && sqliteAvailable() && localStorage.getItem(FLAG_KEY) !== '0';

export async function openStorageBackend(name: string): Promise<StorageBackend> {
  if (encryptedStoreEnabled()) {
    // never brick the app on the encrypted path: a plugin config error once left the shell stuck on connecting until reinstall
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
      // #554: static — a dynamic import of the SDK kept every export (Replay, Feedback) in the first load
      reportError('store', err);
      // '0': remember the failure so the fallback is stable across launches
      localStorage.setItem(FLAG_KEY, '0');
    }
  }
  activeBackend = 'dexie';
  return new DexieBackend(new MunniDB(name));
}

export async function destroyStorage(name: string): Promise<void> {
  if (encryptedStoreEnabled()) {
    const { openEncryptedExecutor } = await import('./capacitorSql');
    const executor = await openEncryptedExecutor(name);
    await executor.destroy();
  }
  await new DexieBackend(new MunniDB(name)).destroy();
  // #363: a wipe that silently left the database behind is worse than a loud one: the caller shows the failure
  if (await Dexie.exists(name)) throw new Error(`local database ${name} survived the wipe`);
}
