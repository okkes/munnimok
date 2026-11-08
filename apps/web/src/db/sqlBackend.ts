import { LIVE_QUERY_QUIET_MS } from './backend';
import type { StorageBackend, TableScope } from './backend';
import type {
  EntityName,
  EntityRowMap,
  MetaRow,
  OutboxRow,
  QuoteCacheRow,
  ConnectorConnRow,
} from './types';

/**
 * Encryption-at-rest E2: the StorageBackend over a SQL engine. On the
 * native shells the executor is @capacitor-community/sqlite with a
 * SQLCipher key; the parity suite drives the same class with an
 * in-memory sql.js database — the backend itself never knows which.
 *
 * Storage shape: one document table per entity — (id PRIMARY KEY,
 * spaceId indexed, json payload). That mirrors Dexie's row model
 * exactly, which is what makes backend parity a testable property
 * instead of a hope. Queries beyond id/spaceId filter in JS, the same
 * contract the interface already promises.
 */

/** the SQL the backend needs — tiny on purpose, so any engine fits */
export interface SqlExecutor {
  /** DML/DDL, no result rows */
  run(sql: string, params?: (string | number | null)[]): Promise<void>;
  /** SELECT returning rows as plain objects */
  query(sql: string, params?: (string | number | null)[]): Promise<Record<string, unknown>[]>;
  /** BEGIN/COMMIT/ROLLBACK wrapper around `fn` */
  transaction(fn: () => Promise<void>): Promise<void>;
  close(): Promise<void>;
  /** wipe the whole database file (identity destroy) */
  destroy(): Promise<void>;
}

export const ENTITIES: readonly EntityName[] = [
  'space',
  'account',
  'category',
  'transaction',
  'txMeta',
  'accountLink',
  'recurring',
  'recurringDismiss',
  'budget',
  'event',
  'goal',
  'goalContribution',
  'receipt',
  'receiptLink',
  'storeConn',
  'storeConnLink',
  'holding',
  'lot',
  'insightDismiss',
  'plan',
  'planSubject',
  'activity',
  // #296: forgotten here while Dexie got it — on native, user login
  // crashed the home mount (`unknown entity: txSeen`) the moment the
  // synced first-seen clock (#148 r3) asked for its rows
  'txSeen',
];

const ENTITY_SET: ReadonlySet<EntityName> = new Set(ENTITIES);

/** entity/table name allowlist keeps interpolated identifiers safe */
const entityTable = (entity: EntityName): string => {
  if (!ENTITY_SET.has(entity)) throw new Error(`unknown entity: ${entity}`);
  return `e_${entity}`;
};

export async function initSqlSchema(sql: SqlExecutor): Promise<void> {
  for (const entity of ENTITIES) {
    const table = entityTable(entity);
    await sql.run(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, spaceId TEXT, json TEXT NOT NULL)`);
    await sql.run(`CREATE INDEX IF NOT EXISTS idx_${table}_space ON ${table} (spaceId)`);
  }
  await sql.run('CREATE TABLE IF NOT EXISTS outbox (opId TEXT PRIMARY KEY, spaceId TEXT, hlc TEXT, json TEXT NOT NULL)');
  await sql.run('CREATE INDEX IF NOT EXISTS idx_outbox_space ON outbox (spaceId)');
  await sql.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, json TEXT NOT NULL)');
  // #367: device-only connector connections (the bundle lives here), keyed by connection id
  await sql.run('CREATE TABLE IF NOT EXISTS connector_conn (id TEXT PRIMARY KEY, json TEXT NOT NULL)');
  await sql.run('DROP TABLE IF EXISTS store_inst');
  await sql.run('CREATE TABLE IF NOT EXISTS quote_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL)');
}

/** the deps — what a live query read and what a write touched: an entity's table, the outbox, one meta key, a device store */
const entityDep = (entity: EntityName): string => `e:${entity}`;
const metaDep = (key: string): string => `m:${key}`;
const OUTBOX_DEP = 'outbox';
const CONN_DEP = 'connectorConn';
const QUOTE_DEP = 'quoteCache';

/** a re-run still going after this lets the next one start — a hung query must never stall the rest */
const RERUN_WATCHDOG_MS = 5_000;

const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const dep of small) if (large.has(dep)) return true;
  return false;
};

interface LiveSub {
  /** waiting in the re-run queue */
  queued: boolean;
  /** a write landed: what it touched */
  touched(written: ReadonlySet<string>): void;
  /** one run; settles with it */
  run(): Promise<void>;
}

/**
 * #554 (GlitchTip: receipts.match averaged 70 s on the iOS app): every
 * write used to re-run every live query — a sync round's stamp, each of
 * the matcher's proposals. Now, like Dexie's liveQuery, a run records what
 * it read and a write wakes only the queries that read what it touched.
 * Reads carry no async context, so write-triggered re-runs go one at a
 * time to record their own reads (a read by anyone meanwhile counts too:
 * a spare re-run, never a missed one). Bursts coalesce by Dexie's rule
 * (LIVE_QUERY_QUIET_MS).
 */
export class SqlStorageBackend implements StorageBackend {
  private readonly subs = new Set<LiveSub>();
  private inTransaction = false;
  /** what the open transaction wrote (and anyone meanwhile — BEGIN is connection-wide): announced after the commit */
  private txDeps = new Set<string>();
  /** the reads of every run in flight */
  private readonly recorders = new Set<Set<string>>();
  private burstDepth = 0;
  private lastWriteAt = Number.NEGATIVE_INFINITY;
  private readonly rerunQueue: LiveSub[] = [];
  private pumping = false;
  private closed = false;

  constructor(private readonly sql: SqlExecutor) {}

  async burst<T>(fn: () => Promise<T>): Promise<T> {
    this.burstDepth += 1;
    try {
      return await fn();
    } finally {
      this.burstDepth -= 1;
      // the burst's end counts as a write: the quiet window starts here
      this.lastWriteAt = performance.now();
    }
  }

  private read(dep: string): void {
    for (const recorder of this.recorders) recorder.add(dep);
  }

  /** every write announces what it touched; inside `transact` the
   *  announcement waits for the commit — a live query must never observe
   *  a half-applied write batch */
  private emit(dep: string): void {
    if (this.inTransaction) {
      this.txDeps.add(dep);
      return;
    }
    this.announce(new Set([dep]));
  }

  private announce(written: ReadonlySet<string>): void {
    this.lastWriteAt = performance.now();
    for (const sub of this.subs) sub.touched(written);
  }

  private quiet(): boolean {
    return this.burstDepth === 0 && !this.inTransaction && performance.now() - this.lastWriteAt >= LIVE_QUERY_QUIET_MS;
  }

  private enqueue(sub: LiveSub): void {
    // a re-run a timer held must not reach a closed database (sign-out mid-burst)
    if (this.closed) return;
    if (!sub.queued) {
      sub.queued = true;
      this.rerunQueue.push(sub);
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let sub = this.rerunQueue.shift(); sub; sub = this.rerunQueue.shift()) {
        sub.queued = false;
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const released = new Promise<void>((resolve) => {
          watchdog = setTimeout(resolve, RERUN_WATCHDOG_MS);
        });
        await Promise.race([sub.run(), released]);
        clearTimeout(watchdog);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async rowsOf<E extends EntityName>(entity: E, where = '', params: (string | number)[] = []) {
    this.read(entityDep(entity));
    const rows = await this.sql.query(`SELECT json FROM ${entityTable(entity)} ${where}`, params);
    return rows.map((r) => JSON.parse(r.json as string) as EntityRowMap[E]);
  }

  async get<E extends EntityName>(entity: E, id: string) {
    const rows = await this.rowsOf(entity, 'WHERE id = ?', [id]);
    return rows[0];
  }

  bySpace<E extends Exclude<EntityName, 'space'>>(entity: E, spaceId: string) {
    return this.rowsOf(entity, 'WHERE spaceId = ?', [spaceId]);
  }

  allRows<E extends EntityName>(entity: E) {
    return this.rowsOf(entity);
  }

  async countBySpace(entity: Exclude<EntityName, 'space'>, spaceId: string) {
    this.read(entityDep(entity));
    const rows = await this.sql.query(`SELECT COUNT(*) AS n FROM ${entityTable(entity)} WHERE spaceId = ?`, [spaceId]);
    return Number(rows[0]?.n ?? 0);
  }

  async put(entity: EntityName, row: Record<string, unknown> & { id: string }) {
    await this.sql.run(`INSERT OR REPLACE INTO ${entityTable(entity)} (id, spaceId, json) VALUES (?, ?, ?)`, [
      row.id,
      (row.spaceId as string) ?? null,
      JSON.stringify(row),
    ]);
    this.emit(entityDep(entity));
  }

  async deleteBySpace(entity: Exclude<EntityName, 'space'>, spaceId: string) {
    await this.sql.run(`DELETE FROM ${entityTable(entity)} WHERE spaceId = ?`, [spaceId]);
    this.emit(entityDep(entity));
  }

  async deleteRow(entity: EntityName, id: string) {
    await this.sql.run(`DELETE FROM ${entityTable(entity)} WHERE id = ?`, [id]);
    this.emit(entityDep(entity));
  }

  async outboxAdd(op: OutboxRow) {
    // INSERT (not REPLACE): op ids are unique, a duplicate is a bug
    await this.sql.run('INSERT INTO outbox (opId, spaceId, hlc, json) VALUES (?, ?, ?, ?)', [
      op.opId,
      op.spaceId,
      op.hlc,
      JSON.stringify(op),
    ]);
    this.emit(OUTBOX_DEP);
  }

  private async outboxRows(where = '', params: string[] = []) {
    this.read(OUTBOX_DEP);
    const rows = await this.sql.query(`SELECT json FROM outbox ${where}`, params);
    return rows.map((r) => JSON.parse(r.json as string) as OutboxRow);
  }

  outboxAll() {
    return this.outboxRows();
  }

  outboxBySpace(spaceId: string) {
    return this.outboxRows('WHERE spaceId = ? ORDER BY hlc', [spaceId]);
  }

  async outboxDelete(opIds: string[]) {
    if (opIds.length === 0) return;
    await this.sql.run(`DELETE FROM outbox WHERE opId IN (${opIds.map(() => '?').join(',')})`, opIds);
    this.emit(OUTBOX_DEP);
  }

  async outboxDeleteBySpace(spaceId: string) {
    await this.sql.run('DELETE FROM outbox WHERE spaceId = ?', [spaceId]);
    this.emit(OUTBOX_DEP);
  }

  async metaGet(key: string): Promise<MetaRow | undefined> {
    this.read(metaDep(key));
    const rows = await this.sql.query('SELECT json FROM meta WHERE key = ?', [key]);
    return rows[0] ? { key, value: JSON.parse(rows[0].json as string) } : undefined;
  }

  async metaPut(key: string, value: unknown) {
    await this.sql.run('INSERT OR REPLACE INTO meta (key, json) VALUES (?, ?)', [key, JSON.stringify(value ?? null)]);
    this.emit(metaDep(key));
  }

  async metaDelete(key: string) {
    await this.sql.run('DELETE FROM meta WHERE key = ?', [key]);
    this.emit(metaDep(key));
  }

  async connectorConnAll() {
    this.read(CONN_DEP);
    const rows = await this.sql.query('SELECT json FROM connector_conn');
    return rows.map((r) => JSON.parse(r.json as string) as ConnectorConnRow);
  }

  async connectorConnGet(id: string) {
    this.read(CONN_DEP);
    const rows = await this.sql.query('SELECT json FROM connector_conn WHERE id = ?', [id]);
    return rows[0] ? (JSON.parse(rows[0].json as string) as ConnectorConnRow) : undefined;
  }

  async connectorConnPut(row: ConnectorConnRow) {
    await this.sql.run('INSERT OR REPLACE INTO connector_conn (id, json) VALUES (?, ?)', [row.id, JSON.stringify(row)]);
    this.emit(CONN_DEP);
  }

  async connectorConnDelete(id: string) {
    await this.sql.run('DELETE FROM connector_conn WHERE id = ?', [id]);
    this.emit(CONN_DEP);
  }

  async quoteCacheAll() {
    this.read(QUOTE_DEP);
    const rows = await this.sql.query('SELECT json FROM quote_cache');
    return rows.map((r) => JSON.parse(r.json as string) as QuoteCacheRow);
  }

  async quoteCachePutAll(rows: QuoteCacheRow[]) {
    for (const row of rows) {
      await this.sql.run('INSERT OR REPLACE INTO quote_cache (key, json) VALUES (?, ?)', [row.key, JSON.stringify(row)]);
    }
    this.emit(QUOTE_DEP);
  }

  /** transactions are serialized: SQL BEGIN is connection-wide, and two
   *  concurrent Repo writes (e.g. a manual tx + its balance delta, both
   *  fired without awaiting) raced into "cannot start a transaction
   *  within a transaction" on SQLCipher (user GlitchTip report). Dexie
   *  schedules overlapping transactions itself; here the queue does. */
  private txQueue: Promise<void> = Promise.resolve();

  async transact(_tables: TableScope[], fn: () => Promise<void>) {
    // the table list is a Dexie requirement the SQL engine doesn't share
    const run = async () => {
      this.inTransaction = true;
      let committed = false;
      try {
        await this.sql.transaction(fn);
        committed = true;
      } finally {
        this.inTransaction = false;
        const written = this.txDeps;
        this.txDeps = new Set();
        // a rollback took every write of the window with it
        if (committed && written.size > 0) this.announce(written);
      }
    };
    const next = this.txQueue.then(run, run);
    // keep the chain alive when a transaction rejects
    this.txQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  subscribe<T>(query: () => Promise<T>, onNext: (value: T) => void, onError?: (err: unknown) => void) {
    let cancelled = false;
    /** the run in flight's reads so far */
    let reading: Set<string> | null = null;
    /** what the last run read — null until one settled: then anything wakes it */
    let deps: Set<string> | null = null;
    let dirty = false;
    let waiting = false;
    let lastRunEndedAt = Number.NEGATIVE_INFINITY;
    const fail = onError ?? ((err: unknown) => console.error('live query failed', err));

    const run = (): Promise<void> => {
      if (cancelled) return Promise.resolve();
      const reads = new Set<string>();
      reading = reads;
      this.recorders.add(reads);
      let failed = false;
      return query()
        .then(
          (value) => {
            if (!cancelled) onNext(value);
          },
          (err: unknown) => {
            failed = true;
            if (!cancelled) fail(err);
          },
        )
        .finally(() => {
          this.recorders.delete(reads);
          reading = null;
          // a failed run may not have reached its reads: anything wakes it again
          deps = failed ? null : reads;
          lastRunEndedAt = performance.now();
          if (dirty) {
            dirty = false;
            hold();
          }
        });
    };
    /** wait until the writes have been quiet for the window, then queue the re-run */
    const hold = () => {
      if (cancelled || waiting) return;
      waiting = true;
      const check = () => {
        if (cancelled) return;
        if (!this.quiet()) {
          setTimeout(check, LIVE_QUERY_QUIET_MS);
          return;
        }
        waiting = false;
        this.enqueue(sub);
      };
      setTimeout(check, LIVE_QUERY_QUIET_MS);
    };
    const sub: LiveSub = {
      queued: false,
      run,
      touched: (written) => {
        if (cancelled || waiting || sub.queued) return;
        if (reading) {
          // a write under a run that already read it: once more afterwards
          if (intersects(reading, written)) dirty = true;
          return;
        }
        if (deps && !intersects(deps, written)) return;
        if (this.burstDepth === 0 && performance.now() - lastRunEndedAt >= LIVE_QUERY_QUIET_MS) this.enqueue(sub);
        else hold();
      },
    };
    this.subs.add(sub);
    void run();
    return () => {
      cancelled = true;
      this.subs.delete(sub);
    };
  }

  close() {
    this.closed = true;
    void this.sql.close();
  }

  destroy() {
    return this.sql.destroy();
  }
}
