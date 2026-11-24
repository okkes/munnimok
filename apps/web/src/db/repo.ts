import { v7 as uuidv7 } from 'uuid';
import type { HlcClock } from '@/sync/hlc';
import { applyOp } from '@/sync/merge';
import type { Op, SyncEnvelope } from '@/sync/merge';
import { reportError } from '@/lib/report';
import { SpaceReadOnlyError } from '@/sync/spaceAccess';
import type { StorageBackend } from './backend';
import { InvariantViolation, rowProblems } from './invariants';
import { ENTITY_NAMES } from './types';
import type { EntityName, EntityRowMap, OutboxRow } from './types';

const KNOWN_ENTITIES: ReadonlySet<string> = new Set(ENTITY_NAMES);

export interface RepoOptions {
  /** demo and offline identities never sync: no outbox, it would grow with nowhere to drain */
  trackOutbox: boolean;
  onWrite?: () => void;
  /** #505: the spaces this identity may only read — every write into one is refused */
  readOnly?: (spaceId: string) => boolean;
  /** #505: the upkeep view — a write into a read-only space is skipped instead of refused */
  skipReadOnly?: boolean;
}

// the only write path to synced tables: every write merges via LWW and queues an outbox op,
// so local and remote edits are one operation
export class Repo {
  private upkeepView: Repo | null = null;

  constructor(
    readonly store: StorageBackend,
    private readonly clock: HlcClock,
    private readonly options: RepoOptions,
  ) {}

  newId(): string {
    return uuidv7();
  }

  canWrite(spaceId: string): boolean {
    return !this.options.readOnly?.(spaceId);
  }

  // upkeep (boot heals, pairings, matchers) skips writes into a read-only space instead of refusing:
  // the members who may write do that work (#505)
  upkeep(): Repo {
    if (this.options.skipReadOnly) return this;
    this.upkeepView ??= new Repo(this.store, this.clock, { ...this.options, skipReadOnly: true });
    return this.upkeepView;
  }

  /** false: the write is skipped (upkeep); a refused one throws before anything changed */
  private admits(spaceId: string): boolean {
    if (this.canWrite(spaceId)) return true;
    if (this.options.skipReadOnly) return false;
    throw new SpaceReadOnlyError(spaceId);
  }

  // writes inside fn are one burst: live queries hold their re-run until it ends, so a confirm's several writes
  // reach screens as ONE update; each write still commits on its own
  batch<T>(fn: () => Promise<T>): Promise<T> {
    return this.store.burst ? this.store.burst(fn) : fn();
  }

  async upsert<E extends EntityName>(
    entity: E,
    spaceId: string,
    entityId: string,
    fields: Partial<Omit<EntityRowMap[E], keyof SyncEnvelope | 'id' | 'spaceId'>>,
  ): Promise<void> {
    await this.write(entity, spaceId, entityId, fields, false);
  }

  /** Tombstone a row. It stays in the table and is filtered from queries. */
  async remove(entity: EntityName, spaceId: string, entityId: string): Promise<void> {
    await this.write(entity, spaceId, entityId, {}, true);
  }

  // #554: many rows of one entity in ONE storage transaction (a per-row commit cost hundreds on the matcher's first pass);
  // an invariant violation refuses the whole set
  async upsertMany<E extends EntityName>(
    entity: E,
    writes: readonly { spaceId: string; entityId: string; fields: Partial<Omit<EntityRowMap[E], keyof SyncEnvelope | 'id' | 'spaceId'>> }[],
  ): Promise<void> {
    // a refused write refuses the whole set before any of it lands
    const admitted = writes.filter((w) => this.admits(w.spaceId));
    if (admitted.length === 0) return;
    const ops = admitted.map((w) => this.opFor(entity, w.spaceId, w.entityId, w.fields, false));
    await this.store.transact([entity, 'outbox'], async () => {
      for (const op of ops) await this.mergeLocal(op, false);
    });
    this.options.onWrite?.();
  }

  /** stamps the caller derives from the content, not the clock: every device writes the same op, and one that
   *  changes nothing queues nothing — all in one storage transaction, so a run cut short leaves no half.
   *  `opId`: derived as well where the server writes the same op itself, so it keeps one of them;
   *  `deleted`: the row is removed at that stamp (#648: the row a move left behind) */
  async upsertStamped(
    spaceId: string,
    writes: readonly { entity: EntityName; entityId: string; fields: Record<string, unknown>; hlc: string; opId?: string; deleted?: boolean }[],
  ): Promise<number> {
    if (writes.length === 0 || !this.admits(spaceId)) return 0;
    const ops = writes.map((w) => ({ ...this.opFor(w.entity, spaceId, w.entityId, w.fields, w.deleted === true, w.hlc), ...(w.opId ? { opId: w.opId } : {}) }));
    let changed = 0;
    await this.store.transact([...new Set(writes.map((w) => w.entity)), 'outbox'], async () => {
      for (const op of ops) if (await this.mergeLocal(op, op.deleted === true)) changed += 1;
    });
    if (changed > 0) this.options.onWrite?.();
    return changed;
  }

  private opFor(entity: EntityName, spaceId: string, entityId: string, fields: Record<string, unknown>, deleted: boolean, hlc = this.clock.now()): OutboxRow {
    return {
      opId: uuidv7(),
      spaceId,
      entity,
      entityId,
      fields,
      hlc,
      ...(deleted ? { deleted: true } : {}),
    } satisfies OutboxRow;
  }

  private async write(
    entity: EntityName,
    spaceId: string,
    entityId: string,
    fields: Record<string, unknown>,
    deleted: boolean,
  ): Promise<void> {
    if (!this.admits(spaceId)) return;
    const op = this.opFor(entity, spaceId, entityId, fields, deleted);
    await this.store.transact([entity, 'outbox'], async () => {
      await this.mergeLocal(op, deleted);
    });
    this.options.onWrite?.();
  }

  private async mergeLocal(op: OutboxRow, deleted: boolean): Promise<boolean> {
    const local = ((await this.store.get(op.entity, op.entityId)) ?? null) as
      | (Record<string, unknown> & SyncEnvelope)
      | null;
    const { row, changed } = applyOp(local, op);
    if (!changed) return false;
    // invariants on the MERGED row: a violation blocks the write and lands in GlitchTip (a screen's validation leaked);
    // applyRemoteOps stays unchecked on purpose: convergence with data other devices own must never be refused
    const merged = { ...row, id: op.entityId, spaceId: op.spaceId };
    const problems = deleted ? [] : rowProblems(op.entity, merged);
    if (problems.length > 0) {
      const violation = new InvariantViolation(op.entity, op.entityId, problems);
      reportError('invariant', violation);
      throw violation;
    }
    await this.store.put(op.entity, merged);
    if (this.options.trackOutbox) await this.store.outboxAdd(op);
    return true;
  }

  /** stale ops are dropped by the merge; the clock observes every stamp so local edits sort after */
  async applyRemoteOps(allOps: Op[]): Promise<void> {
    // an unknown entity (retired here, still pushed by an older device or replayed from the log) is skipped:
    // one row must never stall a space's pull
    const ops = allOps.filter((op) => KNOWN_ENTITIES.has(op.entity));
    for (const entity of new Set(allOps.filter((op) => !KNOWN_ENTITIES.has(op.entity)).map((op) => op.entity))) {
      reportError('sync', new Error(`skipped ops of unknown entity: ${entity}`));
    }
    if (ops.length === 0) return;
    const entities = [...new Set(ops.map((op) => op.entity as EntityName))];
    await this.store.transact(entities, async () => {
      // one read and one write per KIND of row: every store call is a trip into native code on a phone (#594)
      for (const entity of entities) await this.mergeInto(entity, ops.filter((op) => op.entity === entity));
    });
    for (const op of ops) this.clock.observe(op.hlc);
  }

  private async mergeInto(entity: EntityName, ops: Op[]): Promise<void> {
    type Row = Record<string, unknown> & SyncEnvelope & { id: string };
    const ids = [...new Set(ops.map((op) => op.entityId))];
    const rows = new Map(((await this.store.getMany(entity, ids)) as unknown as Row[]).map((row) => [row.id, row]));
    const written = new Set<string>();
    for (const op of ops) {
      const { row, changed } = applyOp(rows.get(op.entityId) ?? null, op);
      if (!changed) continue;
      rows.set(op.entityId, { ...row, id: op.entityId, spaceId: op.spaceId });
      written.add(op.entityId);
    }
    await this.store.putMany(entity, [...written].map((id) => rows.get(id) as Row));
  }
}
