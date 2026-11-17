import Dexie, { liveQuery } from 'dexie';
import type { Table } from 'dexie';
import type { MunniDB } from './schema';
import type {
  ConnectorConnRow,
  EntityName,
  EntityRowMap,
  MetaRow,
  OutboxRow,
  QuoteCacheRow,
} from './types';

// the storage seam: all persistence goes through this interface so native shells can swap Dexie for SQLCipher (E2);
// `subscribe` re-emits on any change, including writes from other contexts (the service worker syncs in the background)

export type TableScope = EntityName | 'outbox' | 'meta';

/** spaces are the partition key themselves — every other entity is space-scoped */
export type SpaceScopedEntity = Exclude<EntityName, 'space'>;

export interface StorageBackend {
  get<E extends EntityName>(entity: E, id: string): Promise<EntityRowMap[E] | undefined>;
  bySpace<E extends SpaceScopedEntity>(entity: E, spaceId: string): Promise<EntityRowMap[E][]>;
  allRows<E extends EntityName>(entity: E): Promise<EntityRowMap[E][]>;
  countBySpace(entity: SpaceScopedEntity, spaceId: string): Promise<number>;
  /** raw row write: only Repo/applyOp's LWW merge calls it; loosely typed because merged rows are built field-by-field */
  put(entity: EntityName, row: Record<string, unknown> & { id: string }): Promise<void>;
  /** many-row get/put: a pulled page goes through these, since on a phone every call is a trip into native code (#594) */
  getMany<E extends EntityName>(entity: E, ids: string[]): Promise<EntityRowMap[E][]>;
  putMany(entity: EntityName, rows: (Record<string, unknown> & { id: string })[]): Promise<void>;
  deleteBySpace(entity: SpaceScopedEntity, spaceId: string): Promise<void>;
  deleteRow(entity: EntityName, id: string): Promise<void>;

  outboxAdd(op: OutboxRow): Promise<void>;
  outboxAll(): Promise<OutboxRow[]>;
  /** the space of each waiting op, one entry per op — for a count or the spaces with something to send, without
   *  reading what the ops carry (#630: a receipt's photo is one op) */
  outboxSpaceIds(): Promise<string[]>;
  /** ops of one space, ordered by HLC (push order) */
  outboxBySpace(spaceId: string): Promise<OutboxRow[]>;
  outboxDelete(opIds: string[]): Promise<void>;
  outboxDeleteBySpace(spaceId: string): Promise<void>;

  metaGet(key: string): Promise<MetaRow | undefined>;
  metaPut(key: string, value: unknown): Promise<void>;
  metaDelete(key: string): Promise<void>;

  connectorConnAll(): Promise<ConnectorConnRow[]>;
  /** by connection id (#367) */
  connectorConnGet(id: string): Promise<ConnectorConnRow | undefined>;
  connectorConnPut(row: ConnectorConnRow): Promise<void>;
  connectorConnDelete(id: string): Promise<void>;
  quoteCacheAll(): Promise<QuoteCacheRow[]>;
  quoteCachePutAll(rows: QuoteCacheRow[]): Promise<void>;

  transact(tables: TableScope[], fn: () => Promise<void>): Promise<void>;
  /** declare fn's writes one burst: live queries hold their re-run until it ends; optional (else just runs fn) */
  burst?<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * live query: emits now and on every relevant change; returns unsubscribe.
   * `query` must read only through this backend.
   */
  subscribe<T>(query: () => Promise<T>, onNext: (value: T) => void, onError?: (err: unknown) => void): () => void;
  close(): void;
  /** wipe the identity's entire database (demo logout, account deletion) */
  destroy(): Promise<void>;
}

// a commit burst re-ran every overlapping live query per commit (measured: 18 bulk writes -> 196 runs), drowning the thread
// idle: re-run at once (a lone write must reach the screen fast); inside a run or this quiet window it is a burst: wait
// for no open write AND a quiet window since the last commit (the window alone let every other write through)
export const LIVE_QUERY_QUIET_MS = 40;
const SUPERSEDED = Symbol('live query run superseded');

export class DexieBackend implements StorageBackend {
  constructor(readonly db: MunniDB) {}

  /** write transactions open now, when the last committed, declared bursts open: what live queries wait on */
  private writesInFlight = 0;
  private lastCommitAt = 0;
  private burstDepth = 0;

  async burst<T>(fn: () => Promise<T>): Promise<T> {
    this.burstDepth += 1;
    try {
      return await fn();
    } finally {
      this.burstDepth -= 1;
      // the burst's end counts as a commit: the quiet window starts here
      this.lastCommitAt = performance.now();
    }
  }

  get<E extends EntityName>(entity: E, id: string) {
    return this.db.tableFor(entity).get(id) as Promise<EntityRowMap[E] | undefined>;
  }

  bySpace<E extends SpaceScopedEntity>(entity: E, spaceId: string) {
    // dexie's union table narrows to an impossible intersection — bridge it
    return this.db.tableFor(entity).where('spaceId').equals(spaceId).toArray() as unknown as Promise<
      EntityRowMap[E][]
    >;
  }

  allRows<E extends EntityName>(entity: E) {
    return this.db.tableFor(entity).toArray() as unknown as Promise<EntityRowMap[E][]>;
  }

  countBySpace(entity: SpaceScopedEntity, spaceId: string) {
    return this.db.tableFor(entity).where('spaceId').equals(spaceId).count();
  }

  async put(entity: EntityName, row: Record<string, unknown> & { id: string }) {
    // dexie's union table intersects all row types — the cast is required
    await this.db.tableFor(entity).put(row as never); // NOSONAR(S4325)
  }

  async getMany<E extends EntityName>(entity: E, ids: string[]) {
    const rows = (await this.db.tableFor(entity).bulkGet(ids)) as unknown as (EntityRowMap[E] | undefined)[];
    return rows.filter((row): row is EntityRowMap[E] => row !== undefined);
  }

  async putMany(entity: EntityName, rows: (Record<string, unknown> & { id: string })[]) {
    // dexie's union table has no common bulkPut signature at all — one table's shape stands in for it
    await (this.db.tableFor(entity) as unknown as Table<Record<string, unknown>, string>).bulkPut(rows);
  }

  async deleteBySpace(entity: SpaceScopedEntity, spaceId: string) {
    await this.db.tableFor(entity).where('spaceId').equals(spaceId).delete();
  }

  async deleteRow(entity: EntityName, id: string) {
    await this.db.tableFor(entity).delete(id);
  }

  async outboxAdd(op: OutboxRow) {
    await this.db.outbox.add(op);
  }

  outboxAll() {
    return this.db.outbox.toArray();
  }

  async outboxSpaceIds() {
    // the index's own keys: no row is read
    return (await this.db.outbox.orderBy('spaceId').keys()) as string[];
  }

  outboxBySpace(spaceId: string) {
    return this.db.outbox.where('spaceId').equals(spaceId).sortBy('hlc');
  }

  async outboxDelete(opIds: string[]) {
    await this.db.outbox.bulkDelete(opIds);
  }

  async outboxDeleteBySpace(spaceId: string) {
    await this.db.outbox.where('spaceId').equals(spaceId).delete();
  }

  metaGet(key: string) {
    return this.db.meta.get(key);
  }

  async metaPut(key: string, value: unknown) {
    await this.db.meta.put({ key, value });
  }

  async metaDelete(key: string) {
    await this.db.meta.delete(key);
  }

  connectorConnAll() {
    return this.db.connectorConns.toArray();
  }

  connectorConnGet(id: string) {
    return this.db.connectorConns.get(id);
  }

  async connectorConnPut(row: ConnectorConnRow) {
    await this.db.connectorConns.put(row);
  }

  async connectorConnDelete(id: string) {
    await this.db.connectorConns.delete(id);
  }

  quoteCacheAll() {
    return this.db.quoteCache.toArray();
  }

  async quoteCachePutAll(rows: QuoteCacheRow[]) {
    await this.db.quoteCache.bulkPut(rows);
  }

  async transact(tables: TableScope[], fn: () => Promise<void>) {
    const dexieTables = tables.map((t) => {
      if (t === 'outbox') return this.db.outbox;
      if (t === 'meta') return this.db.meta;
      return this.db.tableFor(t);
    });
    this.writesInFlight += 1;
    try {
      await this.db.transaction('rw', dexieTables, fn);
    } finally {
      this.writesInFlight -= 1;
      this.lastCommitAt = performance.now();
    }
  }

  subscribe<T>(query: () => Promise<T>, onNext: (value: T) => void, onError?: (err: unknown) => void) {
    let generation = 0;
    let closed = false;
    // runs still reading (Dexie aborts a run but its reads complete) and when the last one ended
    let running = 0;
    let lastRunEndedAt = Number.NEGATIVE_INFINITY;
    const coalesced = async (): Promise<T | typeof SUPERSEDED> => {
      const mine = ++generation;
      // idle: run at once; a declared burst, a run in flight or one that just ended means a burst — wait it out
      if (mine > 1 && (this.burstDepth > 0 || running > 0 || performance.now() - lastRunEndedAt < LIVE_QUERY_QUIET_MS)) {
        for (;;) {
          // a Dexie promise keeps the observation zone across the timer, so
          // the reads after it still register what this run depends on
          await new Dexie.Promise<void>((resolve) => setTimeout(resolve, LIVE_QUERY_QUIET_MS));
          if (closed || mine !== generation) return SUPERSEDED;
          if (this.burstDepth === 0 && this.writesInFlight === 0 && performance.now() - this.lastCommitAt >= LIVE_QUERY_QUIET_MS) break;
        }
      }
      running += 1;
      try {
        return await query();
      } finally {
        running -= 1;
        lastRunEndedAt = performance.now();
      }
    };
    const sub = liveQuery(coalesced).subscribe({
      next: (value) => {
        if (value !== SUPERSEDED) onNext(value);
      },
      error: onError ?? ((err) => console.error('live query failed', err)),
    });
    return () => {
      closed = true;
      sub.unsubscribe();
    };
  }

  close() {
    this.db.close();
  }

  async destroy() {
    await this.db.delete();
  }
}
