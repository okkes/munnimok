// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportError } from '@/lib/report';
import { openEncryptedExecutor, sqlCipherVersion, sqliteAvailable } from './capacitorSql';

vi.mock('@/lib/report', () => ({ reportError: vi.fn() }));

/** a fake raw plugin, close enough for the executor's contract */
const makePlugin = (queryValues: Record<string, unknown>[]) => ({
  isSecretStored: vi.fn().mockResolvedValue({ result: true }),
  setEncryptionSecret: vi.fn().mockResolvedValue(undefined),
  createConnection: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue(undefined),
  run: vi.fn().mockResolvedValue(undefined),
  executeSet: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue({ values: queryValues }),
  beginTransaction: vi.fn().mockResolvedValue(undefined),
  commitTransaction: vi.fn().mockResolvedValue(undefined),
  rollbackTransaction: vi.fn().mockResolvedValue(undefined),
  closeConnection: vi.fn().mockResolvedValue(undefined),
  deleteDatabase: vi.fn().mockResolvedValue(undefined),
});

const setPlugin = (plugin: unknown) => {
  (globalThis as { Capacitor?: unknown }).Capacitor = plugin ? { Plugins: { CapacitorSQLite: plugin } } : undefined;
};

afterEach(() => {
  setPlugin(undefined);
  vi.mocked(reportError).mockClear();
});

describe('capacitorSql executor', () => {
  it('is unavailable without the injected plugin', () => {
    expect(sqliteAvailable()).toBe(false);
  });

  it('strips the iOS ios_columns marker row from query results', async () => {
    // the raw plugin (no JS wrapper) prefixes iOS results with a column
    // descriptor — leaking it upstream made JSON.parse read undefined
    // and broke the entire first sync (the E2 connect loop)
    const plugin = makePlugin([{ ios_columns: ['json'] }, { json: '{"a":1}' }]);
    setPlugin(plugin);
    const executor = await openEncryptedExecutor('munni-test');
    expect(await executor.query('SELECT json FROM meta')).toEqual([{ json: '{"a":1}' }]);
  });

  it('passes Android/web results through untouched and mints the secret once', async () => {
    const plugin = makePlugin([{ json: '{"b":2}' }]);
    plugin.isSecretStored.mockResolvedValue({ result: false });
    setPlugin(plugin);
    const executor = await openEncryptedExecutor('munni-test');
    expect(await executor.query('SELECT json FROM meta')).toEqual([{ json: '{"b":2}' }]);
    expect(plugin.setEncryptionSecret).toHaveBeenCalledTimes(1);

    // transactions commit on success and roll back on failure
    await executor.transaction(async () => undefined);
    expect(plugin.commitTransaction).toHaveBeenCalledTimes(1);
    await expect(executor.transaction(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(plugin.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it('#594: a batch of writes is ONE call into native code, inside the transaction that is already open', async () => {
    const plugin = makePlugin([]);
    setPlugin(plugin);
    const executor = await openEncryptedExecutor('munni-test');
    const sql = 'INSERT OR REPLACE INTO e_transaction (id, spaceId, json) VALUES (?, ?, ?)';

    await executor.batch([
      { sql, params: ['t1', 's1', '{"id":"t1"}'] },
      { sql, params: ['t2', null, '{"id":"t2"}'] },
    ]);

    expect(plugin.run).not.toHaveBeenCalled();
    expect(plugin.executeSet).toHaveBeenCalledTimes(1);
    expect(plugin.executeSet).toHaveBeenCalledWith({
      database: 'munni-test',
      // a flat value list per statement; the plugin's own transaction stays off — BEGIN/COMMIT are the caller's
      set: [
        { statement: sql, values: ['t1', 's1', '{"id":"t1"}'] },
        { statement: sql, values: ['t2', null, '{"id":"t2"}'] },
      ],
      transaction: false,
    });

    // nothing to write is no call at all: the plugin refuses an empty set
    await executor.batch([]);
    expect(plugin.executeSet).toHaveBeenCalledTimes(1);
  });

  it('a plugin that refuses the batch costs the speed, never the write: the statements go one by one, and it is said once', async () => {
    const plugin = makePlugin([]);
    plugin.executeSet.mockRejectedValue(new Error('ExecuteSet: lastId equals -1'));
    setPlugin(plugin);
    const executor = await openEncryptedExecutor('munni-test');
    const sql = 'INSERT OR REPLACE INTO e_transaction (id, spaceId, json) VALUES (?, ?, ?)';

    await executor.batch([
      { sql, params: ['t1', 's1', '{}'] },
      { sql, params: ['t2', 's1', '{}'] },
    ]);
    expect(plugin.run).toHaveBeenCalledTimes(2);
    expect(plugin.run).toHaveBeenLastCalledWith({ database: 'munni-test', statement: sql, values: ['t2', 's1', '{}'], transaction: false });
    expect(reportError).toHaveBeenCalledTimes(1);

    // it does not ask a second time
    await executor.batch([{ sql, params: ['t3', 's1', '{}'] }]);
    expect(plugin.executeSet).toHaveBeenCalledTimes(1);
    expect(plugin.run).toHaveBeenCalledTimes(3);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('captures the cipher_version proof at open — an empty answer records null (E3a)', async () => {
    // SQLCipher answers the PRAGMA with a version row; PLAIN SQLite
    // answers empty — so the recorded value is engine-reported proof
    const plugin = makePlugin([]);
    plugin.query.mockImplementation(async ({ statement }: { statement: string }) =>
      statement.includes('cipher_version') ? { values: [{ cipher_version: '4.6.1 community' }] } : { values: [] },
    );
    setPlugin(plugin);
    await openEncryptedExecutor('munni-test');
    expect(sqlCipherVersion()).toBe('4.6.1 community');

    // an unencrypted engine (empty PRAGMA answer) must NOT claim proof
    const bare = makePlugin([]);
    setPlugin(bare);
    await openEncryptedExecutor('munni-test');
    expect(sqlCipherVersion()).toBeNull();
  });
});
