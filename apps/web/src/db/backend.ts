import Dexie, { liveQuery } from 'dexie';
import type { MunniDB } from './schema';
import type {
  ConnectorConnRow,
  EntityName,
  EntityRowMap,
  MetaRow,
  OutboxRow,
  QuoteCacheRow,
} from './types';

/**
 * Encryption-at-rest E1 (approved design): the storage seam. Everything
 * the app knows about persistence goes through this interface — semantic
 * operations, not query-builder chains — so the native shells can swap
 * Dexie/IndexedDB for SQLCipher (E2) without touching callers.
 *
 * Reactivity contract: `subscribe` re-emits the query result whenever
 * underlying data changes, including writes from other contexts (the
 * service worker syncs in the background while the app is open).
 */

/** tables a `transact` scope may name (synced entities + local-only stores) */
export type TableScope = EntityName | 'outbox' | 'meta';

/** spaces are the partition key themselves — every other entity is space-scoped */
export type SpaceScopedEntity = Exclude<EntityName, 'space'>;

export interface StorageBackend {
  // --- synced entities ---
  get<E extends EntityName>(entity: E, id: string): Promise<EntityRowMap[E] | undefined>;
  bySpace<E extends SpaceScopedEntity>(entity: E, spaceId: string): Promise<EntityRowMap[E][]>;
  allRows<E extends EntityName>(entity: E): Promise<EntityRowMap[E][]>;
  countBySpace(entity: SpaceScopedEntity, spaceId: string): Promise<number>;
  /**
   * Raw row write — the LWW merge (Repo/applyOp) is the only caller.
   * Loosely typed on purpose: merged rows are built field-by-field.
   */
  put(entity: EntityName, row: Record<string, unknown> & { id: string }): Promise<void>;
  deleteBySpace(entity: SpaceScopedEntity, spaceId: string): Promise<void>;
  deleteRow(entity: EntityName, id: string): Promise<void>;

  // --- outbox (local-only op queue) ---
  outboxAdd(op: OutboxRow): Promise<void>;
  outboxAll(): Promise<OutboxRow[]>;
  /** ops of one space, ordered by HLC (push order) */
  outboxBySpace(spaceId: string): Promise<OutboxRow[]>;
  outboxDelete(opIds: string[]): Promise<void>;
  outboxDeleteBySpace(spaceId: string): Promise<void>;

  // --- meta (local-only key-value) ---
  metaGet(key: string): Promise<MetaRow | undefined>;
  metaPut(key: string, value: unknown): Promise<void>;
  metaDelete(key: string): Promise<void>;

  // --- device-only stores (never synced) ---
  connectorConnAll(): Promise<ConnectorConnRow[]>;
  /** by connection id (#367) */
  connectorConnGet(id: string): Promise<ConnectorConnRow | undefined>;
  connectorConnPut(row: ConnectorConnRow): Promise<void>;
  connectorConnDelete(id: string): Promise<void>;
  quoteCacheAll(): Promise<QuoteCacheRow[]>;
  quoteCachePutAll(rows: QuoteCacheRow[]): Promise<void>;

  // --- atomicity, reactivity, lifecycle ---
  /** run `fn` atomically over the named tables (read-modify-write safety) */
  transact(tables: TableScope[], fn: () => Promise<void>): Promise<void>;
  /**
   * 2026-10-09: declare `fn`'s writes one burst — the live queries hold
   * their re-run until it ends (a bulk confirm lands as ONE update, not
   * one per sibling). Optional: a backend without it just runs `fn`.
   */
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

/**
 * 2026-10-09 (user: Confirm stalled 3–4 s on the review, a quick run of
 * attaches "bottled"): a BURST of commits — the review's bulk writes, a
 * confirm's own several writes, a sync pull — used to re-run every
 * overlapping live query once PER commit. Dexie aborts the run in flight
 * and starts the next at once, but the reads it had already issued still
 * complete, so N writes cost N full joins per subscriber and the main
 * thread drowned in them (measured: 18 bulk writes → 196 query runs).
 * A commit that finds the subscription idle still re-runs at once (a lone
 * write reaches the screen as fast as before — the detail's sheets
 * snapshot the live row the moment they open). A commit landing while a
 * run is in flight, or within this quiet window of the last one, is a
 * burst: Dexie aborts the run and the replacement waits until no write
 * transaction is open and the window has passed since the last commit
 * (a slow device commits about as fast as the window, so the window
 * alone let every other write through); a run superseded meanwhile
 * skips its reads altogether (Dexie discards an aborted run's value
 * anyway). So a burst costs a leading run and a trailing one, never one
 * per write.
 */
export const LIVE_QUERY_QUIET_MS = 40;
const SUPERSEDED = Symbol('live query run superseded');

/** Today's storage: Dexie/IndexedDB, one database per identity. */
export class DexieBackend implements StorageBackend {
  constructor(readonly db: MunniDB) {}

  /** write transactions open right now, when the last one committed, and the declared bursts open — the signals the live queries wait on */
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
    // same union-table bridge as bySpace
    return this.db.tableFor(entity).toArray() as unknown as Promise<EntityRowMap[E][]>;
  }

  countBySpace(entity: SpaceScopedEntity, spaceId: string) {
    return this.db.tableFor(entity).where('spaceId').equals(spaceId).count();
  }

  async put(entity: EntityName, row: Record<string, unknown> & { id: string }) {
    // dexie's union table intersects all row types — the cast is required
    await this.db.tableFor(entity).put(row as never); // NOSONAR(S4325)
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
    // dexie's zone makes the backend's own reads/writes inside `fn`
    // participate in this transaction automatically
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
