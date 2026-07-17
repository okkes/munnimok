import type { SqlExecutor } from './sqlBackend';

/**
 * E2: the SQLCipher executor for the native shells, speaking to
 * @capacitor-community/sqlite through the injected Capacitor global —
 * the web bundle never imports native code (platform.ts rule).
 *
 * Key lifecycle (approved design): a random passphrase is minted on
 * first use and handed to the plugin, which keeps it in the iOS
 * Keychain / Android Keystore-backed storage. It never syncs and never
 * lands in a backup — a restored device gets a fresh key and re-syncs
 * (decision 2: key loss = forced re-sync).
 */

interface SqliteQueryResult {
  values?: Record<string, unknown>[];
}

interface CapacitorSqlitePlugin {
  isSecretStored(): Promise<{ result?: boolean }>;
  setEncryptionSecret(options: { passphrase: string }): Promise<void>;
  createConnection(options: {
    database: string;
    version: number;
    encrypted: boolean;
    mode: string;
    readonly: boolean;
  }): Promise<void>;
  open(options: { database: string }): Promise<void>;
  run(options: { database: string; statement: string; values: unknown[]; transaction: boolean }): Promise<unknown>;
  query(options: { database: string; statement: string; values: unknown[] }): Promise<SqliteQueryResult>;
  beginTransaction(options: { database: string }): Promise<void>;
  commitTransaction(options: { database: string }): Promise<void>;
  rollbackTransaction(options: { database: string }): Promise<void>;
  closeConnection(options: { database: string; readonly: boolean }): Promise<void>;
  deleteDatabase(options: { database: string }): Promise<void>;
}

const sqlitePlugin = (): CapacitorSqlitePlugin | undefined =>
  (globalThis as { Capacitor?: { Plugins?: { CapacitorSQLite?: CapacitorSqlitePlugin } } }).Capacitor?.Plugins
    ?.CapacitorSQLite;

export const sqliteAvailable = (): boolean => !!sqlitePlugin();

/** 32 random bytes as hex — the SQLCipher passphrase (minted exactly once) */
const mintPassphrase = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** open (creating if needed) the identity's encrypted database */
export async function openEncryptedExecutor(database: string): Promise<SqlExecutor> {
  const plugin = sqlitePlugin();
  if (!plugin) throw new Error('CapacitorSQLite plugin not available');

  const stored = await plugin.isSecretStored();
  if (!stored.result) await plugin.setEncryptionSecret({ passphrase: mintPassphrase() });

  await plugin.createConnection({ database, version: 1, encrypted: true, mode: 'secret', readonly: false });
  await plugin.open({ database });

  return {
    async run(statement, params = []) {
      // transaction:false — explicit BEGIN/COMMIT drives batches instead
      await plugin.run({ database, statement, values: params, transaction: false });
    },
    async query(statement, params = []) {
      const result = await plugin.query({ database, statement, values: params });
      return result.values ?? [];
    },
    async transaction(fn) {
      await plugin.beginTransaction({ database });
      try {
        await fn();
        await plugin.commitTransaction({ database });
      } catch (err) {
        await plugin.rollbackTransaction({ database }).catch(() => undefined);
        throw err;
      }
    },
    async close() {
      await plugin.closeConnection({ database, readonly: false }).catch(() => undefined);
    },
    async destroy() {
      await plugin.deleteDatabase({ database }).catch(() => undefined);
      await plugin.closeConnection({ database, readonly: false }).catch(() => undefined);
    },
  };
}
