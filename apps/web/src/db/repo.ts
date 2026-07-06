import { v7 as uuidv7 } from 'uuid';
import type { HlcClock } from '@/sync/hlc';
import { applyOp } from '@/sync/merge';
import type { Op, SyncEnvelope } from '@/sync/merge';
import type { MunniDB } from './schema';
import type { EntityName, EntityRowMap, OutboxRow } from './types';

export interface RepoOptions {
  /**
   * Demo and offline identities never sync, so they skip the outbox
   * (otherwise it would grow forever with nowhere to drain).
   */
  trackOutbox: boolean;
  /** called after every local write — used to nudge the sync engine */
  onWrite?: () => void;
}

/**
 * The only write path to synced tables. Every write goes through the
 * LWW merge (stamping fieldVersions) and queues an op in the outbox,
 * so local edits and remote edits are literally the same operation.
 */
export class Repo {
  constructor(
    readonly db: MunniDB,
    private readonly clock: HlcClock,
    private readonly options: RepoOptions,
  ) {}

  newId(): string {
    return uuidv7();
  }

  /** Create or partially update a row. `fields` contains only what changed. */
  async upsert<E extends EntityName>(
    entity: E,
    spaceId: string,
    entityId: string,
    fields: Partial<Omit<EntityRowMap[E], keyof SyncEnvelope | 'id' | 'spaceId'>>,
  ): Promise<void> {
    await this.write(entity, spaceId, entityId, fields as Record<string, unknown>, false);
  }

  /** Tombstone a row. It stays in the table and is filtered from queries. */
  async remove(entity: EntityName, spaceId: string, entityId: string): Promise<void> {
    await this.write(entity, spaceId, entityId, {}, true);
  }

  private async write(
    entity: EntityName,
    spaceId: string,
    entityId: string,
    fields: Record<string, unknown>,
    deleted: boolean,
  ): Promise<void> {
    const table = this.db.tableFor(entity);
    const op = {
      opId: uuidv7(),
      spaceId,
      entity,
      entityId,
      fields,
      hlc: this.clock.now(),
      ...(deleted ? { deleted: true } : {}),
    } satisfies OutboxRow;
    await this.db.transaction('rw', table, this.db.outbox, async () => {
      const local = ((await table.get(entityId)) ?? null) as (Record<string, unknown> & SyncEnvelope) | null;
      const { row, changed } = applyOp(local, op);
      if (!changed) return;
      await table.put({ ...row, id: entityId, spaceId } as never);
      if (this.options.trackOutbox) await this.db.outbox.add(op);
    });
    this.options.onWrite?.();
  }

  /**
   * Apply ops that arrived from the server (pull). Stale ops are dropped by
   * the merge; the clock observes every stamp so local edits sort after.
   */
  async applyRemoteOps(ops: Op[]): Promise<void> {
    if (ops.length === 0) return;
    const tables = [...new Set(ops.map((op) => this.db.tableFor(op.entity as EntityName)))];
    await this.db.transaction('rw', tables, async () => {
      for (const op of ops) {
        const table = this.db.tableFor(op.entity as EntityName);
        const local = ((await table.get(op.entityId)) ?? null) as (Record<string, unknown> & SyncEnvelope) | null;
        const { row, changed } = applyOp(local, op);
        if (changed) {
          await table.put({ ...row, id: op.entityId, spaceId: op.spaceId } as never);
        }
      }
    });
    for (const op of ops) this.clock.observe(op.hlc);
  }
}
