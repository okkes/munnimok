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
import { SyncHttpError } from './backend';
import { cursorKey, drainPull } from './drain';
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
export const LAST_SYNC_KEY = 'lastSyncAt';
/** #569: how long a pause lasts when the server asked for one without saying how long (its limiter says ten seconds) */
export const DEFAULT_PAUSE_MS = 10_000;
/** how long `halt` waits for the round in flight: a request that hangs must not hold its caller */
export const HALT_WAIT_MS = 5_000;

const isTransient = (err: unknown): err is SyncHttpError => err instanceof SyncHttpError && TRANSIENT_STATUSES.has(err.status);

export interface SyncEngineOptions {
  /** the engine's clock, for the pause a server asks for; a test passes its own */
  now?: () => number;
  /** #505: this identity's role per space — each round's heads update it, a read-only space takes no push */
  access?: SpaceAccess;
  /** true once the store belongs to another identity (a profile adopted it): nothing syncs or is purged from here on */
  frozen?: () => boolean;
}

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
  private roundOk = false;
  private readonly listeners = new Set<(status: SyncStatus) => void>();
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

  /** near-real-time: the server announces changed spaces over SSE */
  private async listenEvents(): Promise<void> {
    if (!this.backend.events) return;
    this.eventsAbort = new AbortController();
    const { signal } = this.eventsAbort;
    let retryMs = 1_000;
    while (!signal.aborted) {
      try {
        await this.backend.events(signal, (frame) => {
          // a connector run in flight is the hub's business, not a sync
          if (frame.kind === 'connector') {
            publishConnectorFrame(frame);
            return;
          }
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

  /** the round's counts for its span (user 2026-10-09): how much moved, never what */
  private pushed = 0;
  private pulled = 0;

  async syncAll(): Promise<void> {
    // #569: a trigger that meets a round in flight (a write, a frame from the
    // stream) is folded into ONE more round after it, and one inside a pause
    // the server asked for waits for its end — a burst of writes used to
    // stack round on round until the rate limiter answered 429 for everything
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
    // one span per round (user 2026-10-09, docs/observability.md): its
    // handshake and per-space push/pull children, with the fetches under
    // them, show where a slow sync spent its time; an idle round that
    // stayed under budget never leaves the device (lib/perf). Always a
    // root of its own: the first round starts inside the boot span and
    // usually outlives it
    this.inFlight = measure('sync.round', (round) => this.runRound(round), undefined, { parent: null });
    await this.inFlight;
    this.inFlight = null;
    if (this.rerun && this.now() >= this.pausedUntil) void this.syncAll();
  }

  private async runRound(round: Span): Promise<void> {
    try {
      // version handshake FIRST (lib/protocol.ts): native apps and the
      // API deploy separately — a contract mismatch must refuse to sync
      // instead of exchanging ops both sides half-understand. Fresh
      // check each cycle: an updated server lifts the block by itself.
      resetApiCapabilitiesCache();
      await measure('sync.handshake', () => getApiCapabilities(), undefined, { parent: round });
      if (getProtocolIssue()) {
        this.lastError = `protocol mismatch: ${getProtocolIssue()}`;
        this.setStatus('error');
        return;
      }
      const spaces = (await this.store.allRows('space')).filter((s) => s.deleted === 0);
      // also flush outbox ops for spaces we no longer have rows for
      const outboxSpaces = (await this.store.outboxAll()).map((o) => o.spaceId);
      // and pull spaces the server knows us to be in (fresh device / new
      // invite) — #569: with the head of each, so a space that did not move
      // costs no request at all (a round used to ask every space in turn)
      const heads = await measure('sync.spaces', () => this.backend.heads(), undefined, { parent: round });
      // #505: the heads name this identity's role per space — writes into a
      // space it may only read are refused from here on
      await this.access?.record(heads);
      const serverSpaces = heads.map((h) => h.spaceId);
      const headOf = new Map(heads.map((h) => [h.spaceId, h.latestSeq]));
      const spaceIds = [...new Set([...spaces.map((s) => s.id), ...outboxSpaces, ...serverSpaces])];
      round.setAttribute('sync.spaces', spaceIds.length);
      // one space's failure must not starve the rest: a single poisoned
      // outbox (one rejected op) used to abort the whole loop, so nothing
      // else on the device synced anymore (user report: store receipts +
      // "offline" while the server was fine)
      let firstError: unknown = null;
      const serverSet = new Set(serverSpaces);
      for (const spaceId of spaceIds) {
        if (this.stopped) return;
        try {
          // #306 (user): a space we KNOW evicted us stays untouched until
          // the server re-grants it — no request may leave for it
          if (await this.skipKnownEvicted(spaceId, serverSet)) continue;
          await this.syncSpace(spaceId, round, headOf.get(spaceId));
        } catch (err) {
          // #569: the server's pause (or its gateway's) holds for every space
          // alike — the rest would only be answered the same, so stop asking
          if (isTransient(err)) throw err;
          firstError ??= err;
        }
      }
      if (this.stopped) return;
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

  /**
   * Whether the LAST round reached the end: the bootstrap fails closed on
   * this, not on the status — a refused token leaves the status idle
   * (nothing to show the person) yet the server has confirmed nothing.
   */
  lastRoundOk(): boolean {
    return this.roundOk;
  }

  /**
   * A cycle that did not finish: what the person sees and whether anyone
   * is told. Offline (a fetch TypeError) is the next tick's business; a
   * pause the server asked for (429) or a gateway answering for it
   * (502/503/504: a deploy, a restart) is waited out (#569) — a
   * breadcrumb, never an event (GlitchTip 2/3/5/20, user rule 2026-10-05).
   * 401/403 are identity states the auth path reports and recovers itself.
   * Only a genuine sync fault reports.
   */
  private settleFailure(err: unknown): void {
    this.lastError = String(err); // surfaced on the connecting screen
    const offline = err instanceof TypeError; // fetch network errors are TypeError
    const authState = err instanceof SyncHttpError && (err.status === 401 || err.status === 403);
    const transient = isTransient(err);
    if (transient) this.pause(err.retryAfterMs ?? DEFAULT_PAUSE_MS);
    else if (!offline && !authState) reportError('sync', err);
    // a 401 is the session's business, not the network's: the banner names an
    // expired session on its own (sessionExpiry), and a request that simply
    // carried no token yet (the token is being minted right after a sign-in)
    // is tried again on the next tick without a word (user ss 2026-10-07)
    if (authState) {
      this.setStatus('idle');
      return;
    }
    this.setStatus(offline || transient ? 'offline' : 'error');
  }

  /**
   * #569: the server asked for quiet (429 with Retry-After, its limiter's
   * ten seconds by default) or its gateway is away: no request leaves until
   * then, and a running engine syncs by itself once it is over. Every
   * trigger meanwhile folds into that one round.
   */
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

  /**
   * Push one chunk; a 400 means the server REJECTS an op in it — and
   * endless retries wedge the space as "offline" until reinstall (user
   * report: a stale outbox left behind by the encrypted-store switch).
   * Bisect to the guilty op(s), QUARANTINE them in meta (preserved, not
   * destroyed — a later server fix can still rescue them, like the
   * topic-whitelist outage did) and report them, so everything queued
   * behind keeps syncing.
   */
  private async pushChunk(spaceId: string, chunk: OutboxRow[]): Promise<void> {
    try {
      await this.backend.push(spaceId, this.clientId, chunk);
      await this.store.outboxDelete(chunk.map((o) => o.opId));
      this.pushed += chunk.length;
    } catch (err) {
      if (!(err instanceof SyncHttpError) || err.status !== 400) throw err;
      if (chunk.length === 1) {
        const op = chunk[0];
        const parked = ((await this.store.metaGet(parkedKey(spaceId)))?.value as OutboxRow[] | undefined) ?? [];
        await this.store.metaPut(parkedKey(spaceId), [...parked, op].slice(-500));
        await this.store.outboxDelete([op.opId]);
        reportError('sync', new Error(`server rejected op (400), parked: entity=${op.entity} entityId=${String(op.entityId).slice(0, 140)} space=${spaceId}`));
        return;
      }
      const mid = Math.ceil(chunk.length / 2);
      await this.pushChunk(spaceId, chunk.slice(0, mid));
      await this.pushChunk(spaceId, chunk.slice(mid));
    }
  }

  /** once per app session, offer parked ops back to the server — a fixed
   *  validator accepts them and the data catches up */
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
        // #306: 403 = the space denies us as a whole (read-only role or
        // lost membership) — the rest would fail identically, stop here
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
      // #505: no push leaves for a space this identity only reads; what
      // is still queued for it can never land — undone here, said once
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

  /**
   * `round`: the sync.round span this space's push/pull spans nest under;
   * `head`: the space's head as the round read it (#569) — at or below the
   * cursor, with nothing pushed, the space did not move and needs no pull
   */
  async syncSpace(spaceId: string, round?: Span, head?: number): Promise<void> {
    try {
      // #306 (user): a push-403 alone is AMBIGUOUS — a reader role may
      // pull but never push. The pull below is the judge: succeeding
      // means we are still a member, only read-only; a denied pull is a
      // true eviction. Before this, every push-403 raised the "removed
      // from space" sheet and purged — and the still-granted pull
      // resurrected the space, looping forever.
      const { queued, writeDenied } = await this.pushPhase(spaceId, round);

      // pull everything after our cursor and merge (own ops no-op) —
      // paged until drained (#305 bug 4; the loop lives in sync/drain.ts)
      // an undo waits for the server's values from the START — never from the cursor, which
      // another tab or the service worker may have stamped past them meanwhile
      const undoing = !!(await this.store.metaGet(undoKey(spaceId)));
      const since = undoing ? 0 : (((await this.store.metaGet(cursorKey(spaceId)))?.value as number | undefined) ?? 0);
      if (undoing || head === undefined || head > since || queued > 0 || writeDenied) await this.pullSpace(spaceId, since, round);
      if (writeDenied) {
        // #505: the pull answered — still a member, without write access (a
        // role changed after the round's heads, or a server naming no roles)
        await this.access?.note(spaceId, 'reader');
        if (await this.undoUnsaved(spaceId)) await this.pullSpace(spaceId, 0, round);
      }
      await this.settleUndo(spaceId);
    } catch (err) {
      if (err instanceof SyncHttpError && err.status === 403 && !this.stopped) {
        // #173: a 403 on a MEMBER space is an eviction (feed sweeps stay
        // silent: they route through purgeOrphanFeeds, not this catch)
        await this.evictSpace(spaceId);
        return;
      }
      throw err;
    }
  }

  /**
   * Push queued local ops (ordered by HLC), CHUNKED: the server caps a
   * push at 1000 ops and proxies cap body size — a store-receipt sync
   * alone can queue hundreds of fat ops, and each chunk that lands is
   * deleted immediately so progress survives a failure.
   * @returns how many ops were queued
   */
  private async pushOutbox(spaceId: string, round?: Span): Promise<number> {
    return measure(
      'sync.push',
      async (push) => {
        const outbox = await this.store.outboxBySpace(spaceId);
        push.setAttribute('sync.ops', outbox.length);
        for (let i = 0; i < outbox.length; i += PUSH_CHUNK) {
          await this.pushChunk(spaceId, outbox.slice(i, i + PUSH_CHUNK));
        }
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
        const rows = await drainPull(this.store, this.repo, this.backend, spaceId, { since });
        this.pulled += rows;
        pull.setAttribute('sync.rows', rows);
      },
      undefined,
      { parent: round },
    );
  }

  /**
   * #505 (user): changes queued for a space this identity may only read —
   * made before the app knew, or before a demotion — never land: the
   * server refuses every push there. Parking them (#306) left the device
   * showing edits no other member ever saw. Now they are undone: the
   * fields they wrote lose their stamp, the cursor restarts so this
   * round's pull lays the server's values back (settleUndo then drops what
   * only this device ever wrote), and a notice says so once.
   * @returns whether anything was undone
   */
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

  /** #173/#306: membership truly revoked — ONE durable notice, then purge.
   *  The tombstone survives boots/logins, so late straggler ops or a
   *  half-done purge can never re-raise the sheet; syncAll clears it
   *  when the server lists the space again (re-invite). */
  private async evictSpace(spaceId: string): Promise<void> {
    const seen = await this.store.metaGet(evictedKey(spaceId));
    await this.store.metaPut(evictedKey(spaceId), Date.now());
    if (!seen) {
      // tell the app before the purge erases the name
      const name = (await this.store.get('space', spaceId))?.name;
      if (name) reportEviction({ spaceId, spaceName: name });
    }
    await this.purgeSpace(spaceId);
  }

  /** #306: evicted tombstone gate — while the server does not grant the
   *  space, no sync request leaves for it and stray local ops (writers
   *  that raced the purge) are swept; a re-grant clears the tombstone. */
  private async skipKnownEvicted(spaceId: string, serverSpaces: ReadonlySet<string>): Promise<boolean> {
    if (!(await this.store.metaGet(evictedKey(spaceId)))) return false;
    if (serverSpaces.has(spaceId)) {
      await this.store.metaDelete(evictedKey(spaceId)); // re-invited — sync (and a future eviction) proceed
      return false;
    }
    await this.purgeSpace(spaceId);
    return true;
  }

  /**
   * Feed spaces carry no local 'space' row, so after leaving (or being
   * removed from) the space that shared them, they drop out of the pull
   * loop without ever hitting the 403 that purges member spaces — their
   * accounts lingered forever as ghost "shared with me" rows (user
   * report). Any local account data in a space the server no longer
   * grants is removed here; the owner's own feeds stay reachable
   * (owned), so only genuinely lost access is purged.
   *
   * DATA-LOSS regression (user report: "imported 200 transactions, then
   * everything disappeared"): this sweep used the space/outbox snapshots
   * taken at the START of the cycle, but read accounts LIVE — a
   * statement import finishing while a cycle was mid-flight created its
   * feed after the snapshot, so the sweep purged the fresh account, all
   * its transactions AND their un-pushed outbox ops. Everything local is
   * therefore re-read at sweep time, and any feed a live accountLink
   * mirror points at is protected even when the server's space list was
   * fetched before that feed existed.
   */
  private async purgeOrphanFeeds(serverSpaces: string[]): Promise<void> {
    const [spaces, outbox, links] = await Promise.all([
      this.store.allRows('space'),
      this.store.outboxAll(),
      this.store.allRows('accountLink'),
    ]);
    const known = new Set([
      ...spaces.filter((s) => s.deleted === 0).map((s) => s.id),
      ...outbox.map((o) => o.spaceId),
      ...links.filter((l) => l.deleted === 0).map((l) => l.feedSpaceId),
      ...serverSpaces,
    ]);
    const orphans = new Set(
      (await this.store.allRows('account'))
        .map((a) => a.spaceId)
        .filter((id) => !known.has(id)),
    );
    for (const id of orphans) await this.purgeSpace(id);
  }

  /** membership revoked (403) or explicitly left: remove all local data of the space */
  async purgeSpace(spaceId: string): Promise<void> {
    // every space-scoped entity — the original five left receipts,
    // budgets, goals & co. behind as ghosts after leaving a space
    const scoped = [
      'account', 'category', 'transaction', 'txMeta', 'accountLink',
      'recurring', 'recurringDismiss', 'budget', 'event', 'goal', 'goalContribution',
      'receipt', 'receiptLink', 'storeConn', 'storeConnLink',
      'holding', 'lot', 'insightDismiss', 'plan', 'planSubject', 'activity',
    ] as const;
    await this.store.transact(['space', ...scoped, 'outbox', 'meta'], async () => {
      await this.store.deleteRow('space', spaceId);
      for (const entity of scoped) {
        await this.store.deleteBySpace(entity, spaceId);
      }
      await this.store.outboxDeleteBySpace(spaceId);
      await this.store.metaDelete(cursorKey(spaceId));
      // #306: parked ops died with the space (they were re-offered every
      // session — a lingering 403 POST per boot); the eviction tombstone
      // deliberately survives this purge
      await this.store.metaDelete(parkedKey(spaceId));
      await this.store.metaDelete(undoKey(spaceId));
    });
  }
}
