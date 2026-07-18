import { reportError } from '@/lib/report';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { SyncBackend } from './backend';
import { SyncHttpError } from './backend';

const cursorKey = (spaceId: string) => `syncCursor_${spaceId}`;
export const LAST_SYNC_KEY = 'lastSyncAt';

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drives sync for one identity: flush the outbox, then pull and merge
 * remote ops, per space. Any interleaving is safe — pushes are idempotent
 * (op ids), pulls are cursor-based, and the merge is commutative. A 403 on
 * a space means we lost membership: local copy of that space is purged.
 *
 * Freshness comes from three layers: a server-sent-events stream (near
 * real-time while open), a 10s visible poll as fallback, and wake-ups on
 * focus/online. Web push covers the closed-app case.
 */
export class SyncEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly listeners = new Set<(status: SyncStatus) => void>();
  private status: SyncStatus = 'idle';
  private eventsAbort: AbortController | null = null;
  private eventDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: StorageBackend,
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

  /** the most recent sync failure, for diagnostics UI */
  lastError: string | null = null;

  getStatus(): SyncStatus {
    return this.status;
  }

  /** start background loop: SSE stream + wake on focus/online + 10s visible poll */
  start(): void {
    void this.syncAll();
    window.addEventListener('online', this.handleWake);
    document.addEventListener('visibilitychange', this.handleWake);
    this.timer = setInterval(() => {
      if (document.visibilityState === 'visible') void this.syncAll();
    }, 10_000);
    void this.listenEvents();
  }

  stop(): void {
    window.removeEventListener('online', this.handleWake);
    document.removeEventListener('visibilitychange', this.handleWake);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.eventsAbort?.abort();
    this.eventsAbort = null;
  }

  /** near-real-time: the server announces changed spaces over SSE */
  private async listenEvents(): Promise<void> {
    if (!this.backend.events) return;
    this.eventsAbort = new AbortController();
    const { signal } = this.eventsAbort;
    let retryMs = 1_000;
    while (!signal.aborted) {
      try {
        await this.backend.events(signal, () => {
          // coalesce event bursts into one sync pass
          if (this.eventDebounce) clearTimeout(this.eventDebounce);
          this.eventDebounce = setTimeout(() => void this.syncAll(), 300);
        });
        retryMs = 1_000; // stream ended cleanly — reconnect promptly
      } catch {
        // connection lost/refused — the poll keeps us fresh meanwhile
      }
      if (signal.aborted) return;
      await sleep(retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    }
  }

  private readonly handleWake = () => {
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
      const spaces = (await this.store.allRows('space')).filter((s) => s.deleted === 0);
      // also flush outbox ops for spaces we no longer have rows for
      const outboxSpaces = (await this.store.outboxAll()).map((o) => o.spaceId);
      // and pull spaces the server knows us to be in (fresh device / new invite)
      const serverSpaces = await this.backend.listSpaces();
      const spaceIds = [...new Set([...spaces.map((s) => s.id), ...outboxSpaces, ...serverSpaces])];
      for (const spaceId of spaceIds) await this.syncSpace(spaceId);
      await this.store.metaPut(LAST_SYNC_KEY, Date.now());
      this.setStatus('idle');
    } catch (err) {
      this.lastError = String(err); // surfaced on the connecting screen
      const offline = err instanceof TypeError; // fetch network errors are TypeError
      if (!offline) reportError('sync', err); // real faults, not connectivity
      this.setStatus(offline ? 'offline' : 'error');
    } finally {
      this.running = false;
    }
  }

  async syncSpace(spaceId: string): Promise<void> {
    try {
      // 1. push queued local ops (ordered by HLC)
      const outbox = await this.store.outboxBySpace(spaceId);
      if (outbox.length > 0) {
        await this.backend.push(spaceId, this.clientId, outbox);
        await this.store.outboxDelete(outbox.map((o) => o.opId));
      }

      // 2. pull everything after our cursor and merge (own ops no-op)
      const since = ((await this.store.metaGet(cursorKey(spaceId)))?.value as number | undefined) ?? 0;
      const { ops, latestSeq } = await this.backend.pull(spaceId, since);
      if (ops.length > 0) await this.repo.applyRemoteOps(ops);
      if (latestSeq !== since) await this.store.metaPut(cursorKey(spaceId), latestSeq);
    } catch (err) {
      if (err instanceof SyncHttpError && err.status === 403) {
        await this.purgeSpace(spaceId);
        return;
      }
      throw err;
    }
  }

  /** membership revoked (403) or explicitly left: remove all local data of the space */
  async purgeSpace(spaceId: string): Promise<void> {
    const scoped = ['account', 'category', 'transaction', 'txMeta', 'accountLink'] as const;
    await this.store.transact(['space', ...scoped, 'outbox', 'meta'], async () => {
      await this.store.deleteRow('space', spaceId);
      for (const entity of scoped) {
        await this.store.deleteBySpace(entity, spaceId);
      }
      await this.store.outboxDeleteBySpace(spaceId);
      await this.store.metaDelete(cursorKey(spaceId));
    });
  }
}
