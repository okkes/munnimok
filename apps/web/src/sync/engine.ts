import type { MunniDB } from '@/db/schema';
import type { Repo } from '@/db/repo';
import type { SyncBackend } from './backend';
import { SyncHttpError } from './backend';

const cursorKey = (spaceId: string) => `syncCursor_${spaceId}`;

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

/**
 * Drives sync for one identity: flush the outbox, then pull and merge
 * remote ops, per space. Any interleaving is safe — pushes are idempotent
 * (op ids), pulls are cursor-based, and the merge is commutative. A 403 on
 * a space means we lost membership: local copy of that space is purged.
 */
export class SyncEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private listeners = new Set<(status: SyncStatus) => void>();
  private status: SyncStatus = 'idle';

  constructor(
    private readonly db: MunniDB,
    private readonly repo: Repo,
    private readonly backend: SyncBackend,
    private readonly clientId: string,
  ) {}

  onStatus(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: SyncStatus) {
    this.status = status;
    for (const l of this.listeners) l(status);
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  /** start background loop: on start, on regaining connectivity/visibility, every 60s while visible */
  start(): void {
    void this.syncAll();
    window.addEventListener('online', this.handleWake);
    document.addEventListener('visibilitychange', this.handleWake);
    this.timer = setInterval(() => {
      if (document.visibilityState === 'visible') void this.syncAll();
    }, 60_000);
  }

  stop(): void {
    window.removeEventListener('online', this.handleWake);
    document.removeEventListener('visibilitychange', this.handleWake);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private handleWake = () => {
    if (document.visibilityState === 'visible') void this.syncAll();
  };

  /** debounce hook for repositories: call after local writes */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  nudge(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.syncAll(), 2_000);
  }

  async syncAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.setStatus('syncing');
    try {
      const spaces = await this.db.spaces.filter((s) => s.deleted === 0).toArray();
      // also flush outbox ops for spaces we no longer have rows for
      const outboxSpaces = new Set((await this.db.outbox.toArray()).map((o) => o.spaceId));
      const spaceIds = [...new Set([...spaces.map((s) => s.id), ...outboxSpaces])];
      for (const spaceId of spaceIds) await this.syncSpace(spaceId);
      this.setStatus('idle');
    } catch (err) {
      this.setStatus(err instanceof TypeError ? 'offline' : 'error'); // fetch network errors are TypeError
    } finally {
      this.running = false;
    }
  }

  async syncSpace(spaceId: string): Promise<void> {
    try {
      // 1. push queued local ops (ordered by HLC)
      const outbox = await this.db.outbox.where('spaceId').equals(spaceId).sortBy('hlc');
      if (outbox.length > 0) {
        await this.backend.push(spaceId, this.clientId, outbox);
        await this.db.outbox.bulkDelete(outbox.map((o) => o.opId));
      }

      // 2. pull everything after our cursor and merge (own ops no-op)
      const since = ((await this.db.meta.get(cursorKey(spaceId)))?.value as number | undefined) ?? 0;
      const { ops, latestSeq } = await this.backend.pull(spaceId, since);
      if (ops.length > 0) await this.repo.applyRemoteOps(ops);
      if (latestSeq !== since) await this.db.meta.put({ key: cursorKey(spaceId), value: latestSeq });
    } catch (err) {
      if (err instanceof SyncHttpError && err.status === 403) {
        await this.purgeSpace(spaceId);
        return;
      }
      throw err;
    }
  }

  /** membership revoked: remove all local data belonging to the space */
  private async purgeSpace(spaceId: string): Promise<void> {
    const scoped = [this.db.accounts, this.db.categories, this.db.transactions];
    await this.db.transaction('rw', [this.db.spaces, ...scoped, this.db.outbox, this.db.meta], async () => {
      await this.db.spaces.delete(spaceId);
      for (const table of scoped) {
        await table.where('spaceId').equals(spaceId).delete();
      }
      await this.db.outbox.where('spaceId').equals(spaceId).delete();
      await this.db.meta.delete(cursorKey(spaceId));
    });
  }
}
