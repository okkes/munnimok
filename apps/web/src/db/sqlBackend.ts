import { compareHlc } from '@/sync/hlc';
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

// StorageBackend over a SQL engine (SQLCipher on native shells, sql.js in the parity suite). One document table per entity
// (id, spaceId, json) mirrors Dexie's row model, which makes parity testable; other filters run in JS

export type SqlParam = string | number | null;

export interface SqlStatement {
  sql: string;
  params: SqlParam[];
}

/** ids per SELECT … IN (the oldest SQLite builds bind at most 999 values) and rows per batched write (one message to native code) */
const READ_CHUNK = 500;
const WRITE_CHUNK = 200;
// rows per read (#594): native code returns a read as ONE object, held in an Android heap
export const READ_PAGE = 2000;
// characters one message to or from native code may carry (#594): rows are no measure, a receipt holds its invoice.
// Android builds a read as one string, several times its size while it grows: 75 million characters ended the app
export const NATIVE_CHARS = 4_000_000;
/** a row up to this size travels with its page, so a full page of them is one message's worth */
const INLINE_CHARS = NATIVE_CHARS / READ_PAGE;

/** rows as they stand last: one rewritten while it was read came by twice */
const lastOf = <T>(rows: T[], key: (row: T) => string): T[] => [...new Map(rows.map((row) => [key(row), row])).values()];

export interface SqlExecutor {
  run(sql: string, params?: SqlParam[]): Promise<void>;
  // many `run`s in ONE call: each call crosses into native code on a phone. Only statements that may run twice
  // (INSERT OR REPLACE): an engine that refuses the batch replays them one by one
  batch(statements: SqlStatement[]): Promise<void>;
  query(sql: string, params?: SqlParam[]): Promise<Record<string, unknown>[]>;
  transaction(fn: () => Promise<void>): Promise<void>;
  close(): Promise<void>;
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
  // #296: forgotten here while Dexie had it: on native, user login crashed (`unknown entity: txSeen`)
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
  await sql.run('CREATE TABLE IF NOT EXISTS connector_conn (id TEXT PRIMARY KEY, json TEXT NOT NULL)');
  await sql.run('DROP TABLE IF EXISTS store_inst');
  await sql.run('CREATE TABLE IF NOT EXISTS quote_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL)');
}

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
  queued: boolean;
  touched(written: ReadonlySet<string>): void;
  run(): Promise<void>;
}

// #554: a write wakes only the live queries that read what it touched (like Dexie's liveQuery); reads carry no
// async context, so re-runs go one at a time to record their reads (a read by anyone meanwhile counts: spare, never missed)
export class SqlStorageBackend implements StorageBackend {
  private readonly subs = new Set<LiveSub>();
  private inTransaction = false;
  /** what the open transaction wrote (and anyone meanwhile — BEGIN is connection-wide): announced after the commit */
  private txDeps = new Set<string>();
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

  /** inside `transact` the announcement waits for the commit: a live query must never see a half-applied batch */
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

  // what a table holds, parsed, in write order: a page carries its small rows, the large ones follow by size.
  // A row rewritten mid-read moves to the end (REPLACE gives it a new place) and may come by twice
  private async documents<T>(table: string, condition = '', params: SqlParam[] = []): Promise<T[]> {
    const out: T[] = [];
    let after = 0;
    for (;;) {
      const page = await this.sql.query(
        `SELECT rowid AS place, length(json) AS size, CASE WHEN length(json) <= ${INLINE_CHARS} THEN json END AS json FROM ${table} WHERE rowid > ?${condition} ORDER BY rowid LIMIT ${READ_PAGE}`,
        [after, ...params],
      );
      const large = page.filter((r) => r.json == null).map((r) => ({ place: Number(r.place), size: Number(r.size) }));
      const fetched = await this.largeJson(table, large, condition, params);
      for (const r of page) {
        const json = (r.json as string | null) ?? fetched.get(Number(r.place));
        if (json !== undefined) out.push(JSON.parse(json) as T);
      }
      // a large row that left its place meanwhile stands behind this page now, also behind a last one
      const moved = fetched.size < large.length;
      if (page.length < READ_PAGE && !moved) return out;
      after = Number(page.at(-1)?.place);
    }
  }

  private async largeJson(table: string, rows: { place: number; size: number }[], condition: string, params: SqlParam[]) {
    const found = new Map<number, string>();
    let places: number[] = [];
    let chars = 0;
    const fetch = async () => {
      if (places.length === 0) return;
      const got = await this.sql.query(
        `SELECT rowid AS place, json FROM ${table} WHERE rowid IN (${places.map(() => '?').join(',')})${condition}`,
        [...places, ...params],
      );
      for (const r of got) found.set(Number(r.place), r.json as string);
      places = [];
      chars = 0;
    };
    for (const { place, size } of rows) {
      if (size > NATIVE_CHARS) {
        const json = await this.slicedJson(table, place, condition, params);
        if (json !== undefined) found.set(place, json);
      } else {
        if (chars + size > NATIVE_CHARS || places.length === READ_CHUNK) await fetch();
        places.push(place);
        chars += size;
      }
    }
    await fetch();
    return found;
  }

  /** a row larger than one message: SQLite cuts it, the pieces are joined here */
  private async slicedJson(table: string, place: number, condition: string, params: SqlParam[]): Promise<string | undefined> {
    let json = '';
    let size = Number.POSITIVE_INFINITY;
    for (let from = 1; from <= size; from += NATIVE_CHARS) {
      const rows = await this.sql.query(
        `SELECT length(json) AS size, substr(json, ?, ${NATIVE_CHARS}) AS part FROM ${table} WHERE rowid = ?${condition}`,
        [from, place, ...params],
      );
      if (rows.length === 0) return undefined;
      const now = Number(rows[0].size);
      // another row took this place between two slices: the pieces are of two rows
      if (from > 1 && now !== size) return this.slicedJson(table, place, condition, params);
      size = now;
      json += rows[0].part as string;
    }
    return json;
  }

  private async rowsOf<E extends EntityName>(entity: E, condition = '', params: SqlParam[] = []) {
    this.read(entityDep(entity));
    return lastOf(await this.documents<EntityRowMap[E]>(entityTable(entity), condition, params), (row) => row.id);
  }

  async get<E extends EntityName>(entity: E, id: string) {
    const rows = await this.rowsOf(entity, ' AND id = ?', [id]);
    return rows[0];
  }

  bySpace<E extends Exclude<EntityName, 'space'>>(entity: E, spaceId: string) {
    return this.rowsOf(entity, ' AND spaceId = ?', [spaceId]);
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

  async getMany<E extends EntityName>(entity: E, ids: string[]) {
    const rows: EntityRowMap[E][] = [];
    for (let i = 0; i < ids.length; i += READ_CHUNK) {
      const chunk = ids.slice(i, i + READ_CHUNK);
      rows.push(...(await this.rowsOf(entity, ` AND id IN (${chunk.map(() => '?').join(',')})`, chunk)));
    }
    return rows;
  }

  async putMany(entity: EntityName, rows: (Record<string, unknown> & { id: string })[]) {
    if (rows.length === 0) return;
    const sql = `INSERT OR REPLACE INTO ${entityTable(entity)} (id, spaceId, json) VALUES (?, ?, ?)`;
    let batch: SqlStatement[] = [];
    let chars = 0;
    for (const row of rows) {
      const json = JSON.stringify(row);
      // a row larger than a message cannot be cut on the way in: it goes alone
      if (batch.length === WRITE_CHUNK || (batch.length > 0 && chars + json.length > NATIVE_CHARS)) {
        await this.sql.batch(batch);
        batch = [];
        chars = 0;
      }
      batch.push({ sql, params: [row.id, (row.spaceId as string) ?? null, json] });
      chars += json.length;
    }
    await this.sql.batch(batch);
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

  outboxAll() {
    this.read(OUTBOX_DEP);
    return this.documents<OutboxRow>('outbox');
  }

  async outboxBySpace(spaceId: string) {
    this.read(OUTBOX_DEP);
    const rows = await this.documents<OutboxRow>('outbox', ' AND spaceId = ?', [spaceId]);
    return rows.sort((a, b) => compareHlc(a.hlc, b.hlc));
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
    const values = await this.documents<unknown>('meta', ' AND key = ?', [key]);
    return values.length > 0 ? { key, value: values.at(-1) } : undefined;
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
    return lastOf(await this.documents<ConnectorConnRow>('connector_conn'), (row) => row.id);
  }

  async connectorConnGet(id: string) {
    this.read(CONN_DEP);
    return (await this.documents<ConnectorConnRow>('connector_conn', ' AND id = ?', [id])).at(-1);
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
    return lastOf(await this.documents<QuoteCacheRow>('quote_cache'), (row) => row.key);
  }

  async quoteCachePutAll(rows: QuoteCacheRow[]) {
    for (const row of rows) {
      await this.sql.run('INSERT OR REPLACE INTO quote_cache (key, json) VALUES (?, ?)', [row.key, JSON.stringify(row)]);
    }
    this.emit(QUOTE_DEP);
  }

  // SQL BEGIN is connection-wide: concurrent un-awaited Repo writes raced into a nested BEGIN on SQLCipher,
  // so transactions queue (Dexie schedules its own)
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
