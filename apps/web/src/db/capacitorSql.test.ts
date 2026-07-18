// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openEncryptedExecutor, sqliteAvailable } from './capacitorSql';

/** a fake raw plugin, close enough for the executor's contract */
const makePlugin = (queryValues: Record<string, unknown>[]) => ({
  isSecretStored: vi.fn().mockResolvedValue({ result: true }),
  setEncryptionSecret: vi.fn().mockResolvedValue(undefined),
  createConnection: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue(undefined),
  run: vi.fn().mockResolvedValue(undefined),
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

afterEach(() => setPlugin(undefined));

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
});
