import { reportError } from '@/lib/report';
import type { SqlExecutor } from './sqlBackend';

// the web bundle never imports native code (platform.ts rule), so the plugin comes through the injected Capacitor global
// passphrase minted on first use, kept by the plugin in Keychain/Keystore-backed storage; never synced, never in a backup:
// a restored device gets a fresh key and re-syncs (key loss = forced re-sync)

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
  executeSet(options: { database: string; set: { statement: string; values: unknown[] }[]; transaction: boolean }): Promise<unknown>;
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

/** what `PRAGMA cipher_version` reported at open; plain SQLite answers empty, so null means the store is NOT SQLCipher */
let cipherVersion: string | null = null;
export const sqlCipherVersion = (): string | null => cipherVersion;

const mintPassphrase = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export async function openEncryptedExecutor(database: string): Promise<SqlExecutor> {
  const plugin = sqlitePlugin();
  if (!plugin) throw new Error('CapacitorSQLite plugin not available');

  const stored = await plugin.isSecretStored();
  if (!stored.result) await plugin.setEncryptionSecret({ passphrase: mintPassphrase() });

  // the native side outlives webview reloads: a stale connection made createConnection throw, and the never-brick guard read
  // that as a broken store and cleared the flag; closing first makes open idempotent
  await plugin.closeConnection({ database, readonly: false }).catch(() => undefined);
  await plugin.createConnection({ database, version: 1, encrypted: true, mode: 'secret', readonly: false });
  await plugin.open({ database });

  // a failure to answer records null (= no proof), never an open failure
  try {
    const result = await plugin.query({ database, statement: 'PRAGMA cipher_version;', values: [] });
    const rows = result.values ?? [];
    const clean = rows[0] && 'ios_columns' in rows[0] ? rows.slice(1) : rows;
    const value = Object.values(clean[0] ?? {})[0];
    cipherVersion = typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    cipherVersion = null;
  }

  let batchRefused = false;
  return {
    async run(statement, params = []) {
      // transaction:false — explicit BEGIN/COMMIT drives batches instead
      await plugin.run({ database, statement, values: params, transaction: false });
    },
    async batch(statements) {
      if (statements.length === 0) return;
      if (!batchRefused) {
        try {
          // one flat value list per statement: a list of lists makes the plugin paste the values into the SQL text itself
          await plugin.executeSet({ database, set: statements.map((s) => ({ statement: s.sql, values: s.params })), transaction: false });
          return;
        } catch (err) {
          // a plugin build that refuses the batch costs speed, never the sync: statements go one by one, reported once
          batchRefused = true;
          reportError('sqlite-batch', err);
        }
      }
      for (const s of statements) await plugin.run({ database, statement: s.sql, values: s.params, transaction: false });
    },
    async query(statement, params = []) {
      const result = await plugin.query({ database, statement, values: params });
      const rows = result.values ?? [];
      // raw-plugin quirk: on iOS the first row is {"ios_columns":[...]}, which the plugin's JS wrapper strips;
      // unstripped, JSON.parse(undefined) broke the whole first sync
      return rows[0] && 'ios_columns' in rows[0] ? rows.slice(1) : rows;
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
