import type { Span } from '@sentry/react';
import { getApiCapabilities, getProtocolIssue, resetApiCapabilitiesCache } from '@/lib/api';
import { measure } from '@/lib/perf';
import { reportError } from '@/lib/report';
import { reportEviction } from '@/app/evicted';
import type { StorageBackend } from '@/db/backend';
import { ENTITY_NAMES } from '@/db/types';
import type { EntityName, OutboxRow } from '@/db/types';
import type { Repo } from '@/db/repo';
import type { SyncBackend } from './backend';
import { SPACE_DELETED, SyncHttpError, isLostConnection } from './backend';
import { cursorKey, drainPull, snapshotKey } from './drain';
import { dropUnstamped, unstampWrites } from './merge';
import type { SyncEnvelope } from './merge';
import { noteUnsavedUndone } from './spaceAccess';
import type { SpaceAccess } from './spaceAccess';

/** answers that mean "not now", never "broken": the server's pause and the gateway's own errors */
export const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
import { publishConnectorFrame } from '@/features/connectors/events';

const parkedKey = (spaceId: string) => `parkedOps_${spaceId}`;
/** #306: durable per-identity eviction tombstone — mirrored in swSync.ts */
const evictedKey = (spaceId: string) => `evictedSpace_${spaceId}`;
/** #505: rows whose own writes were undone, waiting for the pull that lays the server's values back */
const undoKey = (spaceId: string) => `undoPending_${spaceId}`;
const KNOWN_ENTITIES: ReadonlySet<string> = new Set(ENTITY_NAMES);
/** "entity:id" — entity names carry no colon, ids may */
const splitRowKey = (key: string): [EntityName, string] => {
  const at = key.indexOf(':');
  return [key.slice(0, at) as EntityName, key.slice(at + 1)];
};
const entitiesOf = (keys: readonly string[]): EntityName[] => [...new Set(keys.map((key) => splitRowKey(key)[0]))];

/** ops per push request — the server caps at 1000, proxies cap body size */
const PUSH_CHUNK = 300;
/** …and characters of what they carry (#630): a receipt's photo is one op, and a request that never finishes is retried whole */
export const PUSH_CHARS = 2_000_000;

/** an op larger than a push goes alone */
export function pushChunks(ops: readonly OutboxRow[]): OutboxRow[][] {
  const chunks: OutboxRow[][] = [];
  let chunk: OutboxRow[] = [];
  let chars = 0;
  for (const op of ops) {
    const size = JSON.stringify(op.fields).length;
    if (chunk.length === PUSH_CHUNK || (chunk.length > 0 && chars + size > PUSH_CHARS)) {
      chunks.push(chunk);
      chunk = [];
      chars = 0;
    }
    chunk.push(op);
    chars += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}
export const LAST_SYNC_KEY = 'lastSyncAt';
/** #569: how long a pause lasts when the server asked for one without saying how long (its limiter says ten seconds) */
export const DEFAULT_PAUSE_MS = 10_000;
/** how long `halt` waits for the round in flight: a request that hangs must not hold its caller */
export const HALT_WAIT_MS = 5_000;

const isTransient = (err: unknown): err is SyncHttpError => err instanceof SyncHttpError && TRANSIENT_STATUSES.has(err.status);

export interface SyncEngineOptions {
  now?: () => number;
  /** #505: this identity's role per space — each round's heads update it, a read-only space takes no push */
  access?: SpaceAccess;
  /** true once the store belongs to another identity (a profile adopted it): nothing syncs or is purged from here on */
  frozen?: () => boolean;
}

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

/** `changes`: what the round has fetched so far — one large space holds a first sync at `done: 0` for a long time */
export type RoundProgress = { phase: 'server' } | { phase: 'spaces'; done: number; total: number; changes: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// any interleaving is safe: pushes are idempotent (op ids), pulls cursor-based, the merge commutative
// freshness: SSE stream, a 10s visible poll as fallback, wake-ups on focus/online; web push covers a closed app
export class SyncEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private roundOk = false;
  private readonly listeners = new Set<(status: SyncStatus) => void>();
  private readonly progressListeners = new Set<(progress: RoundProgress) => void>();
  private status: SyncStatus = 'idle';
  private eventsAbort: AbortController | null = null;
  private eventDebounce: ReturnType<typeof setTimeout> | null = null;
  /** #569: a trigger that met a round in flight or a pause — one more round follows */
  private rerun = false;
  /** #569: until when the server asked for quiet (Retry-After); no request leaves before it */
  private pausedUntil = 0;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  /** the identity is leaving sync: a round now would read its ended memberships as evictions and purge */
  private halted = false;
  private readonly frozen: () => boolean;
  private inFlight: Promise<void> | null = null;
  private finishedOk = false;
  private readonly now: () => number;
  private readonly access: SpaceAccess | null;

  constructor(
    private readonly store: StorageBackend,
    private readonly repo: Repo,
    private readonly backend: SyncBackend,
    private readonly clientId: string,
    options: SyncEngineOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.access = options.access ?? null;
    this.frozen = options.frozen ?? (() => false);
  }

  private get stopped(): boolean {
    return this.halted || this.frozen();
  }

  onStatus(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** where a round stands — a first start has nothing else to show (#594) */
  onProgress(listener: (progress: RoundProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  private tell(progress: RoundProgress): void {
    for (const listener of this.progressListeners) listener(progress);
  }

  private setStatus(status: SyncStatus) {
    this.status = status;
    for (const l of this.listeners) l(status);
  }

  lastError: string | null = null;

  getStatus(): SyncStatus {
    return this.status;
  }

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
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    this.eventsAbort?.abort();
    this.eventsAbort = null;
  }

  /**
   * No round begins until `resume`, whatever asks. Resolves once the round in flight is over
   * (waited for HALT_WAIT_MS at most) — it evicts and purges nothing meanwhile.
   */
  async halt(): Promise<void> {
    this.halted = true;
    const round = this.inFlight;
    if (round) await Promise.race([round, sleep(HALT_WAIT_MS)]);
  }

  resume(): void {
    this.halted = false;
    void this.syncAll();
  }

  /**
   * One whole round that begins now, after any in flight (those may have asked the server before
   * the latest change). True when it reached its end: everything the server holds is on the device.
   */
  async catchUp(): Promise<boolean> {
    while (this.inFlight) await this.inFlight;
    if (this.stopped || this.now() < this.pausedUntil) return false;
    await this.syncAll();
    return this.finishedOk;
  }

  private async listenEvents(): Promise<void> {
    if (!this.backend.events) return;
    this.eventsAbort = new AbortController();
    const { signal } = this.eventsAbort;
    let retryMs = 1_000;
    while (!signal.aborted) {
      try {
        await this.backend.events(signal, (frame) => {
          if (frame.kind === 'connector') {
            publishConnectorFrame(frame);
            return;
          }
          if (this.eventDebounce) clearTimeout(this.eventDebounce);
          this.eventDebounce = setTimeout(() => void this.syncAll(), 300);
        });
        retryMs = 1_000;
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

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  nudge(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.syncAll(), 2_000);
  }

  /** counts for the round's span: how much moved, never what */
  private pushed = 0;
  private pulled = 0;

  async syncAll(): Promise<void> {
    // #569: a trigger that meets a round in flight or a pause folds into ONE more round after it
    // (a burst of writes used to stack rounds until the rate limiter answered 429)
    if (this.stopped) return;
    if (this.running || this.now() < this.pausedUntil) {
      this.rerun = true;
      return;
    }
    this.running = true;
    this.rerun = false;
    this.roundOk = false;
    this.pushed = 0;
    this.pulled = 0;
    this.setStatus('syncing');
    // one span per round, always a root of its own: the first round starts inside the boot span and usually outlives it
    // an idle round under budget never leaves the device (lib/perf)
    this.inFlight = measure('sync.round', (round) => this.runRound(round), undefined, { parent: null });
    await this.inFlight;
    // kept apart from roundOk: the follow-up round below resets that flag before a waiting caller reads it
    this.finishedOk = this.roundOk;
    this.inFlight = null;
    if (this.rerun && this.now() >= this.pausedUntil) void this.syncAll();
  }

  // every space in turn: one space's failure must not starve the rest (a poisoned outbox once stopped all sync);
  // returns the first failure
  private async syncEach(spaceIds: string[], serverSet: ReadonlySet<string>, headOf: ReadonlyMap<string, number>, round: Span): Promise<unknown> {
    let firstError: unknown = null;
    this.spacesDone = 0;
    this.spacesTotal = spaceIds.length;
    this.tellSpaces();
    for (const spaceId of spaceIds) {
      if (this.stopped) return firstError;
      try {
        // #306: a space we KNOW evicted us stays untouched until the server re-grants it: no request may leave for it
        if (!(await this.skipKnownEvicted(spaceId, serverSet))) await this.syncSpace(spaceId, round, headOf.get(spaceId));
      } catch (err) {
        // #569: the server's pause (or its gateway's) holds for every space alike: stop asking
        if (isTransient(err)) throw err;
        firstError ??= err;
      }
      this.spacesDone += 1;
      this.tellSpaces();
    }
    return firstError;
  }

  private spacesDone = 0;
  private spacesTotal = 0;

  private tellSpaces(): void {
    this.tell({ phase: 'spaces', done: this.spacesDone, total: this.spacesTotal, changes: this.pulled });
  }

  private async runRound(round: Span): Promise<void> {
    try {
      this.tell({ phase: 'server' });
      // version handshake FIRST (lib/protocol.ts): native apps and the API deploy separately; a mismatch must refuse to sync
      // checked fresh each cycle: an updated server lifts the block by itself
      resetApiCapabilitiesCache();
      await measure('sync.handshake', () => getApiCapabilities(), undefined, { parent: round });
      if (getProtocolIssue()) {
        this.lastError = `protocol mismatch: ${getProtocolIssue()}`;
        this.setStatus('error');
        return;
      }
      const spaces = (await this.store.allRows('space')).filter((s) => s.deleted === 0);
      // also flush outbox ops for spaces we no longer have rows for
      const outboxSpaces = await this.store.outboxSpaceIds();
      // pull spaces the server knows us in (fresh device / new invite), with each head: an unmoved space costs no request (#569)
      const heads = await measure('sync.spaces', () => this.backend.heads(), undefined, { parent: round });
      // #505: the heads name this identity's role per space: writes into a read-only space are refused from here on
      await this.access?.record(heads);
      const serverSpaces = heads.map((h) => h.spaceId);
      const headOf = new Map(heads.map((h) => [h.spaceId, h.latestSeq]));
      const spaceIds = [...new Set([...spaces.map((s) => s.id), ...outboxSpaces, ...serverSpaces])];
      round.setAttribute('sync.spaces', spaceIds.length);
      const firstError = await this.syncEach(spaceIds, new Set(serverSpaces), headOf, round);
      if (this.stopped) return;
      await this.purgeDeletedSpaces(new Set(serverSpaces));
      await this.purgeOrphanFeeds(serverSpaces);
      if (firstError) throw firstError;
      await this.store.metaPut(LAST_SYNC_KEY, Date.now());
      this.roundOk = true;
      this.setStatus('idle');
    } catch (err) {
      this.settleFailure(err);
    } finally {
      this.running = false;
      round.setAttributes({ 'sync.ops_pushed': this.pushed, 'sync.rows_pulled': this.pulled, 'sync.ok': this.roundOk });
    }
  }

  // whether the LAST round reached the end: the bootstrap fails closed on this, as a refused token leaves the status idle
  lastRoundOk(): boolean {
    return this.roundOk;
  }

  // offline (a fetch TypeError) is the next tick's business; a 429 or a gateway 502/503/504 is waited out (#569)
  // a breadcrumb, never an event; 401/403 are identity states the auth path reports itself; only a real fault reports
  private settleFailure(err: unknown): void {
    this.lastError = String(err);
    const offline = isLostConnection(err); // a fetch that failed, or one that ran into its time limit
    const authState = err instanceof SyncHttpError && (err.status === 401 || err.status === 403);
    const transient = isTransient(err);
    if (transient) this.pause(err.retryAfterMs ?? DEFAULT_PAUSE_MS);
    else if (!offline && !authState) reportError('sync', err);
    // a 401 is the session's business: the banner names an expired session, and a request sent before the post-sign-in token
    // exists is tried again on the next tick without a word
    if (authState) {
      this.setStatus('idle');
      return;
    }
    this.setStatus(offline || transient ? 'offline' : 'error');
  }

  // #569: the server asked for quiet (429 Retry-After, default ten seconds) or its gateway is away: no request leaves until
  // then, and a running engine syncs by itself once it is over; every trigger meanwhile folds into that one round
  private pause(ms: number): void {
    console.warn(`sync paused for ${Math.ceil(ms / 1000)} s: the server asked for a pause`);
    this.pausedUntil = this.now() + ms;
    if (!this.timer) return;
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      void this.syncAll();
    }, ms);
  }

  // a 400 means the server REJECTS an op in the chunk, and endless retries wedge the space as "offline" until reinstall
  // bisect to the guilty op(s) and QUARANTINE them in meta (kept: a later server fix can rescue them), so the rest syncs
  private async pushChunk(spaceId: string, chunk: OutboxRow[]): Promise<void> {
    try {
      await this.backend.push(spaceId, this.clientId, chunk);
      await this.store.outboxDelete(chunk.map((o) => o.opId));
      this.pushed += chunk.length;
    } catch (err) {
      // 413: the request outgrew what the server or a proxy before it takes — the same ops fit in smaller pushes
      if (!(err instanceof SyncHttpError) || (err.status !== 400 && err.status !== 413)) throw err;
      if (chunk.length === 1) {
        const op = chunk[0];
        const parked = ((await this.store.metaGet(parkedKey(spaceId)))?.value as OutboxRow[] | undefined) ?? [];
        await this.store.metaPut(parkedKey(spaceId), [...parked, op].slice(-500));
        await this.store.outboxDelete([op.opId]);
        reportError('sync', new Error(`server rejected op (${err.status}), parked: entity=${op.entity} entityId=${String(op.entityId).slice(0, 140)} space=${spaceId}`));
        return;
      }
      const mid = Math.ceil(chunk.length / 2);
      await this.pushChunk(spaceId, chunk.slice(0, mid));
      await this.pushChunk(spaceId, chunk.slice(mid));
    }
  }

  /** once per app session, parked ops are offered back to the server: a fixed validator accepts them */
  private readonly parkedRetried = new Set<string>();
  private async retryParked(spaceId: string): Promise<void> {
    if (this.parkedRetried.has(spaceId)) return;
    this.parkedRetried.add(spaceId);
    const parked = ((await this.store.metaGet(parkedKey(spaceId)))?.value as OutboxRow[] | undefined) ?? [];
    if (!parked.length) return;
    const stillParked: OutboxRow[] = [];
    for (const [i, op] of parked.entries()) {
      try {
        await this.backend.push(spaceId, this.clientId, [op]);
      } catch (err) {
        stillParked.push(op);
        // #306: 403 = the space denies us as a whole (read-only role or lost membership): the rest would fail identically
        if (err instanceof SyncHttpError && err.status === 403) {
          stillParked.push(...parked.slice(i + 1));
          break;
        }
      }
    }
    if (stillParked.length !== parked.length) await this.store.metaPut(parkedKey(spaceId), stillParked);
  }

  /** what leaves for a space before its pull; a 403 on the push means write access is gone */
  private async pushPhase(spaceId: string, round?: Span): Promise<{ queued: number; writeDenied: boolean }> {
    if (this.access?.isReadOnly(spaceId)) {
      // #505: no push leaves for a space this identity only reads; what is still queued can never land: undone here, said once
      await this.undoUnsaved(spaceId);
      return { queued: 0, writeDenied: false };
    }
    await this.retryParked(spaceId);
    try {
      return { queued: await this.pushOutbox(spaceId, round), writeDenied: false };
    } catch (err) {
      if (!(err instanceof SyncHttpError) || err.status !== 403) throw err;
      return { queued: 0, writeDenied: true };
    }
  }

  // `round`: the sync.round span the push/pull spans nest under; `head`: the space's head as the round read it (#569):
  // at or below the cursor with nothing pushed, the space did not move and needs no pull
  async syncSpace(spaceId: string, round?: Span, head?: number): Promise<void> {
    try {
      // #306: a push-403 alone is AMBIGUOUS (a reader may pull but never push): the pull judges, success = read-only member,
      // a denied pull = true eviction; treating every push-403 as one looped: purge, then the pull resurrected the space
      const { queued, writeDenied } = await this.pushPhase(spaceId, round);

      // an undo waits for the server's values from the START, never the cursor: another tab or the worker may stamp it past them
      const undoing = !!(await this.store.metaGet(undoKey(spaceId)));
      const since = undoing ? 0 : (((await this.store.metaGet(cursorKey(spaceId)))?.value as number | undefined) ?? 0);
      if (undoing || head === undefined || head > since || queued > 0 || writeDenied) await this.pullSpace(spaceId, since, round);
      if (writeDenied) {
        // #505: the pull answered: still a member without write access (role changed after the heads, or a server naming no roles)
        await this.access?.note(spaceId, 'reader');
        if (await this.undoUnsaved(spaceId)) await this.pullSpace(spaceId, 0, round);
      }
      await this.settleUndo(spaceId);
    } catch (err) {
      if (err instanceof SyncHttpError && err.status === 403 && !this.stopped) {
        // #173: a 403 on a MEMBER space is an eviction (feed sweeps stay silent: they go through purgeOrphanFeeds)
        await this.evictSpace(spaceId, err.reason === SPACE_DELETED);
        return;
      }
      throw err;
    }
  }

  // ordered by HLC and CHUNKED: the server caps a push at 1000 ops and proxies cap body size; each chunk that lands is
  // deleted at once so progress survives a failure
  private async pushOutbox(spaceId: string, round?: Span): Promise<number> {
    return measure(
      'sync.push',
      async (push) => {
        const outbox = await this.store.outboxBySpace(spaceId);
        push.setAttribute('sync.ops', outbox.length);
        for (const chunk of pushChunks(outbox)) await this.pushChunk(spaceId, chunk);
        return outbox.length;
      },
      undefined,
      { parent: round },
    );
  }

  private async pullSpace(spaceId: string, since: number, round?: Span): Promise<void> {
    await measure(
      'sync.pull',
      async (pull) => {
        const onPage = (applied: number) => {
          this.pulled += applied;
          this.tellSpaces();
        };
        const rows = await drainPull(this.store, this.repo, this.backend, spaceId, { since, onPage });
        pull.setAttribute('sync.rows', rows);
      },
      undefined,
      { parent: round },
    );
  }

  // #505: changes queued for a read-only space never land; parking them left edits no other member saw, so they are undone:
  // written fields lose their stamp, the cursor restarts so the pull lays the server's values back (settleUndo drops
  // what only this device wrote), and a notice says so once
  private async undoUnsaved(spaceId: string): Promise<boolean> {
    const parked = ((await this.store.metaGet(parkedKey(spaceId)))?.value as OutboxRow[] | undefined) ?? [];
    const queued = await this.store.outboxBySpace(spaceId);
    const ops = [...parked, ...queued];
    if (ops.length === 0) return false;
    const own = new Set(ops.map((o) => o.hlc));
    const rows = [...new Set(ops.filter((o) => KNOWN_ENTITIES.has(o.entity)).map((o) => `${o.entity}:${o.entityId}`))];
    const pending = ((await this.store.metaGet(undoKey(spaceId)))?.value as string[] | undefined) ?? [];
    const space = await this.store.get('space', spaceId);
    // a feed has no space row: the notice names the account another member shares through it
    const accountName = space ? undefined : (await this.store.bySpace('account', spaceId)).find((a) => a.deleted === 0)?.name;
    await this.store.transact([...entitiesOf(rows), 'outbox', 'meta'], async () => {
      for (const key of rows) {
        const [entity, entityId] = splitRowKey(key);
        const row = (await this.store.get(entity, entityId)) as (Record<string, unknown> & SyncEnvelope & { id: string }) | undefined;
        if (row) await this.store.put(entity, unstampWrites(row, own));
      }
      await this.store.outboxDelete(queued.map((o) => o.opId));
      await this.store.metaDelete(parkedKey(spaceId));
      await this.store.metaDelete(cursorKey(spaceId));
      // a snapshot cut short would go on at the page it stopped: the rows before it would keep their unstamped fields
      await this.store.metaDelete(snapshotKey(spaceId));
      await this.store.metaPut(undoKey(spaceId), [...new Set([...pending, ...rows])]);
      // counted by row: one change of the person is several ops, and the app's own passes queued ops too
      if (rows.length > 0) {
        await noteUnsavedUndone(this.store, { spaceId, spaceName: space?.name ?? '', ...(accountName ? { accountName } : {}), count: rows.length });
      }
    });
    return true;
  }

  /** #505: the pull from the start is through — what no server op wrote back only ever lived here */
  private async settleUndo(spaceId: string): Promise<void> {
    const rows = (await this.store.metaGet(undoKey(spaceId)))?.value as string[] | undefined;
    if (!rows) return;
    await this.store.transact([...entitiesOf(rows), 'meta'], async () => {
      for (const key of rows) {
        const [entity, entityId] = splitRowKey(key);
        const row = (await this.store.get(entity, entityId)) as (Record<string, unknown> & SyncEnvelope & { id: string }) | undefined;
        if (!row) continue;
        const kept = dropUnstamped(row);
        if (kept) await this.store.put(entity, kept);
        else await this.store.deleteRow(entity, entityId);
      }
      await this.store.metaDelete(undoKey(spaceId));
    });
  }

  /** #173/#306: membership revoked: ONE durable notice, then purge. The tombstone survives boots so stragglers or a half-done
  purge never re-raise the sheet; syncAll clears it when the server lists the space again (re-invite) */
  private async evictSpace(spaceId: string, deleted = false): Promise<void> {
    const seen = await this.store.metaGet(evictedKey(spaceId));
    await this.store.metaPut(evictedKey(spaceId), Date.now());
    if (!seen) {
      // tell the app before the purge erases the name — unless this person deleted the space (#615): they know
      const space = await this.store.get('space', spaceId);
      if (space?.name && space.deleted === 0) reportEviction({ spaceId, spaceName: space.name, ...(deleted ? { deleted } : {}) });
    }
    await this.purgeSpace(spaceId);
  }

  // #615: a space held as deleted that the server no longer lists and has nothing left to send was erased there: purge it
  // while its delete is still queued it stays: the queue is what tells the server
  private async purgeDeletedSpaces(serverSpaces: ReadonlySet<string>): Promise<void> {
    const queued = new Set(await this.store.outboxSpaceIds());
    for (const space of await this.store.allRows('space')) {
      if (space.deleted === 1 && !serverSpaces.has(space.id) && !queued.has(space.id)) await this.purgeSpace(space.id);
    }
  }

  /** #306: tombstone gate: while the server does not grant the space no request leaves for it and stray ops are swept;
  a re-grant clears it */
  private async skipKnownEvicted(spaceId: string, serverSpaces: ReadonlySet<string>): Promise<boolean> {
    if (!(await this.store.metaGet(evictedKey(spaceId)))) return false;
    if (serverSpaces.has(spaceId)) {
      await this.store.metaDelete(evictedKey(spaceId)); // re-invited — sync (and a future eviction) proceed
      return false;
    }
    await this.purgeSpace(spaceId);
    return true;
  }

  // feed spaces have no space row, so they skip the 403 purge and their accounts linger as ghosts: local data of any space
  // the server no longer grants is purged here (owned feeds stay). DATA-LOSS trap: re-read everything at sweep time
  // (an import finishing mid-cycle was purged with its un-pushed ops) and protect feeds a live accountLink points at
  // #648: a receipt feed is read only while the server grants it (a space stopped including it, its owner removed it) —
  // its rows are not a member's to keep, so the row a space holds for the feed protects nothing
  private async purgeOrphanFeeds(serverSpaces: string[]): Promise<void> {
    const [spaces, queued, links] = await Promise.all([
      this.store.allRows('space'),
      this.store.outboxSpaceIds(),
      this.store.allRows('accountLink'),
    ]);
    const held = new Set([...spaces.filter((s) => s.deleted === 0).map((s) => s.id), ...queued, ...serverSpaces]);
    const known = new Set([...held, ...links.filter((l) => l.deleted === 0).map((l) => l.feedSpaceId)]);
    const orphans = new Set(
      (await this.store.allRows('account'))
        .map((a) => a.spaceId)
        .filter((id) => !known.has(id)),
    );
    for (const receipt of await this.store.allRows('receipt')) {
      if (!held.has(receipt.spaceId)) orphans.add(receipt.spaceId);
    }
    for (const id of orphans) await this.purgeSpace(id);
  }

  /** membership revoked (403) or explicitly left: remove all local data of the space */
  async purgeSpace(spaceId: string): Promise<void> {
    // must list EVERY space-scoped entity: a shorter list left receipts, budgets, goals & co. behind as ghosts
    const scoped = [
      'account', 'category', 'transaction', 'txMeta', 'accountLink',
      'recurring', 'recurringDismiss', 'budget', 'event', 'goal', 'goalContribution',
      'receipt', 'receiptLink', 'receiptFile', 'storeConn', 'storeConnLink',
      'holding', 'lot', 'insightDismiss', 'plan', 'planSubject', 'activity',
    ] as const;
    await this.store.transact(['space', ...scoped, 'outbox', 'meta'], async () => {
      await this.store.deleteRow('space', spaceId);
      for (const entity of scoped) {
        await this.store.deleteBySpace(entity, spaceId);
      }
      await this.store.outboxDeleteBySpace(spaceId);
      await this.store.metaDelete(cursorKey(spaceId));
      await this.store.metaDelete(snapshotKey(spaceId));
      // #306: parked ops die with the space (re-offered, they cost a 403 POST per boot); the eviction tombstone survives the purge
      await this.store.metaDelete(parkedKey(spaceId));
      await this.store.metaDelete(undoKey(spaceId));
    });
  }
}
