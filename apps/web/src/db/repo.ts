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
  /**
   * Demo and offline identities never sync, so they skip the outbox
   * (otherwise it would grow forever with nowhere to drain).
   */
  trackOutbox: boolean;
  /** called after every local write — used to nudge the sync engine */
  onWrite?: () => void;
  /** #505: the spaces this identity may only read — every write into one is refused */
  readOnly?: (spaceId: string) => boolean;
  /** #505: the upkeep view — a write into a read-only space is skipped instead of refused */
  skipReadOnly?: boolean;
}

/**
 * The only write path to synced tables. Every write goes through the
 * LWW merge (stamping fieldVersions) and queues an op in the outbox,
 * so local edits and remote edits are literally the same operation.
 */
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

  /** #505: whether a write into the space lands — a space this identity only reads takes none */
  canWrite(spaceId: string): boolean {
    return !this.options.readOnly?.(spaceId);
  }

  /**
   * #505: this repo for the app's own upkeep (boot heals, pairings,
   * matchers): in a space this identity only reads, their writes are
   * skipped — the members who may write do that work — where a person's
   * write is refused.
   */
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

  /**
   * 2026-10-09 (user: Confirm stalled, quick attaches "bottled"): the
   * writes inside `fn` are one burst — the live queries hold their re-run
   * until it ends, so a confirm's several writes (the card, its siblings,
   * the pair, the receipt) reach the screens as ONE update instead of one
   * per write. Every write still commits on its own (read-your-writes
   * holds inside); only the screens' refresh is held. A backend without
   * the notion just runs `fn`.
   */
  batch<T>(fn: () => Promise<T>): Promise<T> {
    return this.store.burst ? this.store.burst(fn) : fn();
  }

  /** Create or partially update a row. `fields` contains only what changed. */
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

  /**
   * #554: many rows of one entity in ONE storage transaction — the
   * matcher's pass wrote a proposal per receipt, each committed on its own
   * (hundreds on a first pass). Every row merges and queues its op exactly
   * as `upsert` does; an invariant violation refuses the whole set.
   */
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

  private opFor(entity: EntityName, spaceId: string, entityId: string, fields: Record<string, unknown>, deleted: boolean): OutboxRow {
    return {
      opId: uuidv7(),
      spaceId,
      entity,
      entityId,
      fields,
      hlc: this.clock.now(),
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
    await this.store.transact([entity, 'outbox'], () => this.mergeLocal(op, deleted));
    this.options.onWrite?.();
  }

  /** one local op onto its row, inside the caller's transaction */
  private async mergeLocal(op: OutboxRow, deleted: boolean): Promise<void> {
    const local = ((await this.store.get(op.entity, op.entityId)) ?? null) as
      | (Record<string, unknown> & SyncEnvelope)
      | null;
    const { row, changed } = applyOp(local, op);
    if (!changed) return;
    // model-level invariants on the MERGED row (user request: the
    // FluentValidation idea) — a violation blocks the write and lands
    // in GlitchTip, because it means a screen's own validation leaked.
    // applyRemoteOps stays unchecked on purpose: convergence with data
    // other devices already own must never be refused.
    const merged = { ...row, id: op.entityId, spaceId: op.spaceId };
    const problems = deleted ? [] : rowProblems(op.entity, merged);
    if (problems.length > 0) {
      const violation = new InvariantViolation(op.entity, op.entityId, problems);
      reportError('invariant', violation);
      throw violation;
    }
    await this.store.put(op.entity, merged);
    if (this.options.trackOutbox) await this.store.outboxAdd(op);
  }

  /**
   * Apply ops that arrived from the server (pull). Stale ops are dropped by
   * the merge; the clock observes every stamp so local edits sort after.
   */
  async applyRemoteOps(allOps: Op[]): Promise<void> {
    // an entity this build does not know (retired here, still pushed by
    // an older device or replayed from the server log) is skipped, not
    // fatal — one unknown row must never stall the space's whole pull
    const ops = allOps.filter((op) => KNOWN_ENTITIES.has(op.entity));
    for (const entity of new Set(allOps.filter((op) => !KNOWN_ENTITIES.has(op.entity)).map((op) => op.entity))) {
      reportError('sync', new Error(`skipped ops of unknown entity: ${entity}`));
    }
    if (ops.length === 0) return;
    const entities = [...new Set(ops.map((op) => op.entity as EntityName))];
    await this.store.transact(entities, async () => {
      for (const op of ops) {
        const local = ((await this.store.get(op.entity as EntityName, op.entityId)) ?? null) as
          | (Record<string, unknown> & SyncEnvelope)
          | null;
        const { row, changed } = applyOp(local, op);
        if (changed) {
          await this.store.put(op.entity as EntityName, { ...row, id: op.entityId, spaceId: op.spaceId });
        }
      }
    });
    for (const op of ops) this.clock.observe(op.hlc);
  }
}
