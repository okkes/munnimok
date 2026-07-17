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

export const encryptedStoreEnabled = (): boolean =>
  isNativeApp() && sqliteAvailable() && localStorage.getItem(FLAG_KEY) === '1';

export async function openStorageBackend(name: string): Promise<StorageBackend> {
  if (encryptedStoreEnabled()) {
    const [{ openEncryptedExecutor }, { SqlStorageBackend, initSqlSchema }] = await Promise.all([
      import('./capacitorSql'),
      import('./sqlBackend'),
    ]);
    const executor = await openEncryptedExecutor(name);
    await initSqlSchema(executor);
    return new SqlStorageBackend(executor);
  }
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
