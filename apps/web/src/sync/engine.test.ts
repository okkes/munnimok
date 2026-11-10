import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_PROTOCOL } from '@/lib/protocol';
import { HlcClock } from './hlc';
import { applyOp } from './merge';
import type { Op, SyncEnvelope } from './merge';
import type { PullResult, PushResult, SpaceHead, SyncBackend } from './backend';
import { SyncHttpError } from './backend';
import { reportError } from '@/lib/report';

vi.mock('@/lib/report', () => ({ reportError: vi.fn(), reportWarning: vi.fn() }));
// the round's spans (user 2026-10-09): a pass-through measure that keeps
// every span's attributes by name, so a test reads what a round reported
const perfSpans = vi.hoisted(() => ({ attrs: new Map<string, Record<string, unknown>>() }));
vi.mock('@/lib/perf', () => ({
  measure: (name: string, fn: (span: unknown) => unknown) => {
    const attrs: Record<string, unknown> = {};
    perfSpans.attrs.set(name, attrs);
    return fn({
      setAttribute: (key: string, value: unknown) => {
        attrs[key] = value;
      },
      setAttributes: (values: Record<string, unknown>) => Object.assign(attrs, values),
    });
  },
}));
import { DEFAULT_PAUSE_MS, SyncEngine } from './engine';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { useEvicted } from '@/app/evicted';
import type { AccountRow } from '@/db/types';
import { SpaceAccess, SpaceReadOnlyError, readUnsavedUndone } from './spaceAccess';

/** Minimal in-memory server with the same semantics as Munni.Api. */
class InMemoryServer implements SyncBackend {
  private ops: (Op & { seq: number })[] = [];
  private state = new Map<string, Record<string, unknown> & SyncEnvelope>();
  private seenOpIds = new Set<string>();
  private lastSeq = 0;
  forbiddenSpaces = new Set<string>();
  /** #306: reader role — push 403s while pull/list stay granted */
  readerSpaces = new Set<string>();
  rejectedSpaces = new Set<string>(); // 400s (a poisoned op) — never 403
  /** the pull (and the heads) answer with this status instead (429: the server's pause, 500: a fault) */
  pullStatus: number | null = null;
  /** the pause a 429 names (Retry-After), when it names one */
  retryAfterMs: number | undefined = undefined;
  headsCalls = 0;
  /** the spaces each pull asked for, in order */
  pulledSpaces: string[] = [];
  pushCalls: number[] = [];
  /** every push REQUEST that arrived, denied ones included */
  pushAttempts: string[] = [];

  async push(spaceId: string, _clientId: string, ops: Op[]): Promise<PushResult> {
    this.pushAttempts.push(spaceId);
    if (this.forbiddenSpaces.has(spaceId) || this.readerSpaces.has(spaceId)) throw new SyncHttpError(403);
    if (this.rejectedSpaces.has(spaceId)) throw new SyncHttpError(400);
    this.pushCalls.push(ops.length);
    for (const op of ops) {
      if (this.seenOpIds.has(op.opId)) continue;
      this.seenOpIds.add(op.opId);
      const key = `${op.entity}:${op.entityId}`;
      const { row } = applyOp(this.state.get(key) ?? null, op);
      this.state.set(key, row);
      this.ops.push({ ...op, seq: ++this.lastSeq });
    }
    return { lastSeq: this.lastSeq };
  }

  /** page like Munni.Api does (Take(1000)); Infinity = everything */
  pageSize = Number.POSITIVE_INFINITY;
  /** old servers predate the nextSince cursor — the client must survive */
  omitNextSince = false;
  pullCalls = 0;

  async pull(spaceId: string, since: number): Promise<PullResult> {
    if (this.forbiddenSpaces.has(spaceId)) throw new SyncHttpError(403);
    if (this.pullStatus !== null) throw new SyncHttpError(this.pullStatus, this.retryAfterMs);
    this.pullCalls++;
    this.pulledSpaces.push(spaceId);
    const all = this.ops.filter((o) => o.seq > since && o.spaceId === spaceId);
    const page = all.slice(0, this.pageSize);
    const nextSince = page.length > 0 ? page.at(-1)!.seq : since;
    return {
      ops: page,
      latestSeq: this.lastSeq,
      ...(this.omitNextSince ? {} : { nextSince }),
    };
  }

  async listSpaces(): Promise<string[]> {
    return [...new Set(this.ops.map((o) => o.spaceId))].filter((id) => !this.forbiddenSpaces.has(id));
  }

  /** #569: every granted space with its head — the seq of its newest op; #505: and the caller's role */
  async heads(): Promise<SpaceHead[]> {
    this.headsCalls++;
    if (this.pullStatus !== null) throw new SyncHttpError(this.pullStatus, this.retryAfterMs);
    return (await this.listSpaces()).map((spaceId) => ({
      spaceId,
      latestSeq: Math.max(0, ...this.ops.filter((o) => o.spaceId === spaceId).map((o) => o.seq)),
      role: this.readerSpaces.has(spaceId) ? 'reader' : 'owner',
    }));
  }
}

let dbCounter = 0;

/** `guarded`: the app's wiring (#505) — the engine records roles and the repo refuses a reader's writes */
function device(name: string, wall: () => number, server: InMemoryServer, now?: () => number, guarded = false, frozen?: () => boolean) {
  const db = new MunniDB(`engine_test_${name}_${dbCounter}`);
  const storeBackend = new DexieBackend(db);
  const access = new SpaceAccess(storeBackend);
  const repo = new Repo(storeBackend, new HlcClock(name, undefined, wall), {
    trackOutbox: true,
    ...(guarded ? { readOnly: (spaceId: string) => access.isReadOnly(spaceId) } : {}),
  });
  const engine = new SyncEngine(storeBackend, repo, server, name, { ...(now ? { now } : {}), ...(guarded ? { access } : {}), ...(frozen ? { frozen } : {}) });
  return { db, repo, engine, storeBackend, access };
}

describe('SyncEngine', () => {
  let server: InMemoryServer;
  beforeEach(() => {
    dbCounter++;
    server = new InMemoryServer();
    useEvicted.getState().clear();
    // hermetic: syncAll's /health handshake must never reach a REAL
    // server (a running local stack once answered with an older
    // protocol and silently blocked every cycle here)
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ capabilities: {}, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  const dbs: MunniDB[] = [];
  afterEach(async () => {
    while (dbs.length) await dbs.pop()!.delete();
  });

  it('a refused token (401) leaves the engine idle — the session\'s business, never an outage (user ss 2026-10-07: "Offline" right after a sign-in)', async () => {
    let w = 2_000_000;
    const a = device('devAuth', () => ++w, server);
    dbs.push(a.db);
    await a.repo.upsert('space', 's1', 's1', { name: 'Paced', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.engine.syncAll();
    const statuses: string[] = [];
    const off = a.engine.onStatus((s) => statuses.push(s));
    vi.mocked(reportError).mockClear();

    server.pullStatus = 401;
    await a.engine.syncAll();
    expect(statuses.at(-1)).toBe('idle');
    expect(a.engine.lastRoundOk()).toBe(false); // idle to look at, but the round did not reach its end
    expect(reportError).not.toHaveBeenCalled();

    server.pullStatus = null;
    await a.engine.syncAll();
    expect(statuses.at(-1)).toBe('idle');
    expect(a.engine.lastRoundOk()).toBe(true);
    off();
  });

  it('a pause the server asked for (429) or a gateway answer (502/503/504) is waited out — no report, status offline; a 500 is a fault and reports (user rule 2026-10-05)', async () => {
    let w = 1_000_000;
    let now = 0;
    const a = device('devA', () => ++w, server, () => now);
    dbs.push(a.db);
    await a.repo.upsert('space', 's1', 's1', { name: 'Paced', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.engine.syncAll();
    const statuses: string[] = [];
    const off = a.engine.onStatus((s) => statuses.push(s));
    vi.mocked(reportError).mockClear();

    for (const status of [429, 502, 503, 504]) {
      server.pullStatus = status;
      await a.engine.syncAll();
      expect(statuses.at(-1)).toBe('offline');
      now += DEFAULT_PAUSE_MS; // the pause is over before the next one
    }
    expect(reportError).not.toHaveBeenCalled();

    server.pullStatus = 500;
    await a.engine.syncAll();
    expect(statuses.at(-1)).toBe('error');
    expect(reportError).toHaveBeenCalledTimes(1);

    server.pullStatus = null;
    await a.engine.syncAll();
    expect(statuses.at(-1)).toBe('idle');
    off();
  });

  it('#569: a round asks every space’s head at once and pulls only the spaces that moved', async () => {
    let wa = 1_000_000;
    let wb = 2_000_000;
    const a = device('devA', () => ++wa, server);
    const b = device('devB', () => ++wb, server);
    dbs.push(a.db, b.db);
    for (const id of ['s1', 's2', 's3']) {
      await a.repo.upsert('space', id, id, { name: id, kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    }
    await a.engine.syncAll();
    await b.engine.syncAll();

    // nothing moved: one request for the heads, not one per space
    server.pulledSpaces = [];
    await a.engine.syncAll();
    expect(server.pulledSpaces).toEqual([]);

    // another device writes into s2: only s2 is pulled — and a space this device pushed to reads its ops back
    await b.repo.upsert('account', 's2', 'acc-b', { name: 'From B' });
    await b.engine.syncAll();
    await a.repo.upsert('account', 's3', 'acc-a', { name: 'From A' });
    server.pulledSpaces = [];
    await a.engine.syncAll();
    expect([...new Set(server.pulledSpaces)].sort()).toEqual(['s2', 's3']);
    expect((await a.db.accounts.get('acc-b'))?.name).toBe('From B');
  });

  it('#569: a 429 ends the round at once and the engine waits out its Retry-After; a trigger meanwhile runs once it is over', async () => {
    let w = 1_000_000;
    let now = 0;
    const a = device('devA', () => ++w, server, () => now);
    dbs.push(a.db);
    for (const id of ['s1', 's2', 's3']) {
      await a.repo.upsert('space', id, id, { name: id, kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    }
    await a.engine.syncAll();
    // a burst of writes in every space, then the limiter answers
    for (const id of ['s1', 's2', 's3']) await a.repo.upsert('account', id, `acc-${id}`, { name: id });
    server.pullStatus = 429;
    server.retryAfterMs = 30_000;
    const pushesBefore = server.pushAttempts.length;
    await a.engine.syncAll();

    // the first space met the pause; none after it was asked
    expect(server.pushAttempts.length - pushesBefore).toBeLessThanOrEqual(1);
    expect(a.engine.getStatus()).toBe('offline');

    // inside the pause no request leaves, whatever asks
    const heads = server.headsCalls;
    now += 29_000;
    await a.engine.syncAll();
    expect(server.headsCalls).toBe(heads);

    // past it, the round runs and drains every space
    server.pullStatus = null;
    now += 2_000;
    await a.engine.syncAll();
    expect(server.headsCalls).toBe(heads + 1);
    expect(await a.db.outbox.count()).toBe(0);
    expect(a.engine.getStatus()).toBe('idle');
  });

  it('#569: a trigger that meets a running round is folded into one more round after it, never dropped', async () => {
    let w = 1_000_000;
    const a = device('devA', () => ++w, server);
    dbs.push(a.db);
    await a.repo.upsert('space', 's1', 's1', { name: 'Busy', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    const first = a.engine.syncAll();
    // two triggers while the round is out (a write's nudge, a frame from the stream): neither starts a round now…
    await a.engine.syncAll();
    await a.engine.syncAll();
    await first;
    // …but ONE more round follows by itself — never dropped, never stacked
    await vi.waitFor(() => expect(server.headsCalls).toBe(2));
    await vi.waitFor(() => expect(a.engine.getStatus()).toBe('idle'));
    expect(server.headsCalls).toBe(2);
  });

  it('two devices editing offline converge regardless of sync order', async () => {
    let wa = 1_000_000;
    let wb = 2_000_000;
    const a = device('devA', () => ++wa, server);
    const b = device('devB', () => ++wb, server);
    dbs.push(a.db, b.db);

    // both edit the same account while "offline"
    await a.repo.upsert('space', 's1', 's1', { name: 'Shared', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.repo.upsert('account', 's1', 'acc1', { name: 'From A', balanceCents: 100 });
    await b.repo.upsert('space', 's1', 's1', { name: 'Shared', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await b.repo.upsert('account', 's1', 'acc1', { name: 'From B', color: '#abc' });

    // A syncs first, then B, then A again to receive B's ops
    await a.engine.syncSpace('s1');
    await b.engine.syncSpace('s1');
    await a.engine.syncSpace('s1');

    const rowA = (await a.db.accounts.get('acc1')) as AccountRow;
    const rowB = (await b.db.accounts.get('acc1')) as AccountRow;
    expect(rowA.fieldVersions).toEqual(rowB.fieldVersions);
    expect(rowA.name).toBe('From B'); // B's clock is ahead
    expect(rowA.balanceCents).toBe(100);
    expect(rowA.color).toBe('#abc');

    // outboxes drained, cursors advanced
    expect(await a.db.outbox.count()).toBe(0);
    expect(await b.db.outbox.count()).toBe(0);
  });

  it('pull cursor prevents re-fetch; own ops are no-ops on replay', async () => {
    let w = 1_000_000;
    const a = device('devA', () => ++w, server);
    dbs.push(a.db);

    await a.repo.upsert('space', 's1', 's1', { name: 'Solo', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.engine.syncSpace('s1');
    const cursor1 = (await a.db.meta.get('syncCursor_s1'))?.value;
    await a.engine.syncSpace('s1'); // nothing new
    const cursor2 = (await a.db.meta.get('syncCursor_s1'))?.value;
    expect(cursor1).toBe(cursor2);
    const space = await a.db.spaces.get('s1');
    expect(space?.name).toBe('Solo');
  });

  it('403 purges the local copy of the space', async () => {
    let w = 1_000_000;
    const a = device('devA', () => ++w, server);
    dbs.push(a.db);

    await a.repo.upsert('space', 's1', 's1', { name: 'Shared', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.repo.upsert('account', 's1', 'acc1', { name: 'Mine', balanceCents: 5 });
    await a.engine.syncSpace('s1');
    expect(await a.db.spaces.get('s1')).toBeTruthy();

    server.forbiddenSpaces.add('s1');
    await a.repo.upsert('account', 's1', 'acc1', { name: 'More' });
    await a.engine.syncSpace('s1');

    expect(await a.db.spaces.get('s1')).toBeUndefined();
    expect(await a.db.accounts.get('acc1')).toBeUndefined();
    expect(await a.db.outbox.count()).toBe(0);
  });

  /** an owner's shared space s1 on the server, with an account and an event */
  async function sharedSpace() {
    let wa = 1_000_000;
    const owner = device('owner', () => ++wa, server);
    dbs.push(owner.db);
    await owner.repo.upsert('space', 's1', 's1', { name: 'Shared', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await owner.repo.upsert('account', 's1', 'acc1', { name: 'Theirs', balanceCents: 7 });
    await owner.engine.syncAll();
    return owner;
  }

  it('#306/#505: a read-only member (push 403, pull OK) is no eviction — the refused change is undone and said once', async () => {
    await sharedSpace();
    // the reader device discovers and pulls the space fine…
    let wb = 2_000_000;
    const reader = device('reader', () => ++wb, server);
    dbs.push(reader.db);
    server.readerSpaces.add('s1');
    await reader.engine.syncAll();
    expect((await reader.db.spaces.get('s1'))?.name).toBe('Shared');

    // …then writes locally — an unguarded write (an older build) whose push is denied
    await reader.repo.upsert('account', 's1', 'acc1', { name: 'Mine now', color: '#abc' });
    await reader.repo.upsert('event', 's1', 'ev1', { name: 'Trip', from: '2026-07-01', to: '2026-07-03' });
    await reader.engine.syncAll();

    // no "removed from space" sheet, nothing purged (the old code
    // popped the sheet and wiped the space on every cycle — user4 loop)
    expect(useEvicted.getState().evicted).toBeNull();
    expect((await reader.db.spaces.get('s1'))?.name).toBe('Shared');
    // #505: the device shows what the other members see again — the
    // server's value back, what only this device wrote gone
    const account = await reader.db.accounts.get('acc1');
    expect(account?.name).toBe('Theirs');
    expect(account?.color).toBeUndefined();
    expect(await reader.db.events.get('ev1')).toBeUndefined();
    expect(await reader.db.outbox.count()).toBe(0);
    expect(await reader.db.meta.get('parkedOps_s1')).toBeUndefined();
    expect(await readUnsavedUndone(reader.storeBackend)).toEqual([{ spaceId: 's1', spaceName: 'Shared', count: 2 }]);
    const attempts = server.pushAttempts.filter((s) => s === 's1').length;
    await reader.engine.syncAll();
    expect(server.pushAttempts.filter((s) => s === 's1')).toHaveLength(attempts); // quiet now
  });

  it('#505: the heads name the role — a reader’s device refuses its own writes and asks the server nothing', async () => {
    await sharedSpace();
    const ownersPushes = server.pushAttempts.length;
    server.readerSpaces.add('s1');
    let wb = 2_000_000;
    const reader = device('reader', () => ++wb, server, undefined, true);
    dbs.push(reader.db);
    await reader.engine.syncAll();

    expect(reader.access.roleOf('s1')).toBe('reader');
    expect((await reader.db.meta.get('spaceRoles'))?.value).toEqual({ s1: 'reader' });
    await expect(reader.repo.upsert('account', 's1', 'acc1', { color: '#abc' })).rejects.toBeInstanceOf(SpaceReadOnlyError);
    // the upkeep view leaves the space alone instead of failing
    await reader.repo.upkeep().upsert('account', 's1', 'acc1', { color: '#abc' });
    expect((await reader.db.accounts.get('acc1'))?.color).toBeUndefined();
    expect(await reader.db.outbox.count()).toBe(0);
    await reader.engine.syncAll();
    expect(server.pushAttempts.slice(ownersPushes)).not.toContain('s1');
  });

  it('#505: changes parked before the role was known are undone on the first round that knows it, once', async () => {
    await sharedSpace();
    const ownersPushes = server.pushAttempts.length;
    let wb = 2_000_000;
    const reader = device('reader', () => ++wb, server, undefined, true);
    dbs.push(reader.db);
    await reader.engine.syncAll(); // still a contributor here
    await reader.repo.upsert('account', 's1', 'acc1', { name: 'Edited offline' });
    // demoted while the change waited in the outbox
    server.readerSpaces.add('s1');
    await reader.engine.syncAll();

    expect((await reader.db.accounts.get('acc1'))?.name).toBe('Theirs');
    expect(await reader.db.outbox.count()).toBe(0);
    expect(await readUnsavedUndone(reader.storeBackend)).toEqual([{ spaceId: 's1', spaceName: 'Shared', count: 1 }]);
    expect(await reader.db.meta.get('undoPending_s1')).toBeUndefined();
    expect(server.pushAttempts.slice(ownersPushes)).not.toContain('s1');
  });

  it('#505: changes undone in another member’s account are told by the account’s name, one per row', async () => {
    let wa = 1_000_000;
    const owner = device('feedOwner', () => ++wa, server);
    dbs.push(owner.db);
    // a feed carries no space row: its account is all there is to name
    await owner.repo.upsert('account', 'feed-x', 'loan', { name: 'DUO', type: 'loan', source: 'connector', currency: 'EUR', balanceCents: -500_000 });
    await owner.engine.syncAll();
    server.readerSpaces.add('feed-x');
    let wb = 2_000_000;
    const member = device('feedReader', () => ++wb, server, undefined, true);
    dbs.push(member.db);
    await member.engine.syncAll();
    // what an older build left parked: two edits of that one account, refused by the server
    const parked = (field: string, value: number, n: number) => ({ opId: `old-${n}`, spaceId: 'feed-x', entity: 'account', entityId: 'loan', fields: { [field]: value }, hlc: `00300000${n}-0000-feedReader` });
    await member.db.meta.put({ key: 'parkedOps_feed-x', value: [parked('debtStress', 3, 1), parked('paymentCents', 10_000, 2)] });

    await member.engine.syncAll();

    expect(await readUnsavedUndone(member.storeBackend)).toEqual([{ spaceId: 'feed-x', spaceName: '', accountName: 'DUO', count: 1 }]);
  });

  it('#505: a cursor another tab or the worker stamps between the undo and the pull does not cost the server’s values', async () => {
    await sharedSpace();
    let wb = 2_000_000;
    const member = device('racer', () => ++wb, server, undefined, true);
    dbs.push(member.db);
    await member.engine.syncAll();
    await member.repo.upsert('account', 's1', 'acc1', { name: 'Edited offline' });
    server.readerSpaces.add('s1');
    // the other context is mid-pull of the same space: its drain stamps the head right after this one's undo dropped the cursor
    const head = (await server.pull('s1', 0)).latestSeq;
    const store = member.storeBackend;
    const transact = store.transact.bind(store);
    let stamped = false;
    store.transact = async (tables, fn) => {
      await transact(tables, fn);
      if (!stamped && (await store.metaGet('undoPending_s1'))) {
        stamped = true;
        await store.metaPut('syncCursor_s1', head);
      }
    };

    await member.engine.syncAll();

    expect(stamped).toBe(true);
    expect((await member.db.accounts.get('acc1'))?.name).toBe('Theirs');
    expect(await member.db.meta.get('undoPending_s1')).toBeUndefined();
  });

  it('#505: promoted again, the device writes and pushes as before', async () => {
    await sharedSpace();
    server.readerSpaces.add('s1');
    let wb = 2_000_000;
    const member = device('member', () => ++wb, server, undefined, true);
    dbs.push(member.db);
    await member.engine.syncAll();
    expect(member.repo.canWrite('s1')).toBe(false);

    server.readerSpaces.delete('s1');
    await member.engine.syncAll();
    await member.repo.upsert('account', 's1', 'acc1', { color: '#0a0' });
    await member.engine.syncAll();

    expect(member.repo.canWrite('s1')).toBe(true);
    expect((await server.pull('s1', 0)).ops.some((op) => op.fields.color === '#0a0')).toBe(true);
  });

  it('halted, the engine starts no round whoever asks; resumed, it sends what waited', async () => {
    let w = 1_000_000;
    const a = device('devHalt', () => ++w, server);
    dbs.push(a.db);
    await a.repo.upsert('space', 's1', 's1', { name: 'Leaving', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.engine.syncAll();

    await a.engine.halt();
    const heads = server.headsCalls;
    await a.repo.upsert('account', 's1', 'acc', { name: 'Typed after' });
    await a.engine.syncAll();
    expect(server.headsCalls).toBe(heads);
    expect(await a.db.outbox.count()).toBe(1);

    a.engine.resume();
    await vi.waitFor(async () => expect(await a.db.outbox.count()).toBe(0));
    expect(server.headsCalls).toBeGreaterThan(heads);
  });

  it('halt waits out the round in flight, and a membership that ends under that round purges nothing', async () => {
    const owner = await sharedSpace();
    let wb = 2_000_000;
    const leaver = device('leaver', () => ++wb, server);
    dbs.push(leaver.db);
    await leaver.engine.syncAll();
    // the space moved, so the next round pulls it — and the server holds that answer back
    await owner.repo.upsert('account', 's1', 'acc2', { name: 'New' });
    await owner.engine.syncAll();
    let reached: () => void = () => undefined;
    let release: () => void = () => undefined;
    const pulling = new Promise<void>((resolve) => (reached = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    const pull = server.pull.bind(server);
    server.pull = async (spaceId, since) => {
      reached();
      await held;
      return pull(spaceId, since);
    };
    const round = leaver.engine.syncAll();
    await pulling;

    let halted = false;
    const halting = leaver.engine.halt().then(() => (halted = true));
    // the account leaves the server while the request hangs: the pull comes back refused
    server.forbiddenSpaces.add('s1');
    expect(halted).toBe(false);
    release();
    await halting;
    await round;

    expect((await leaver.db.spaces.get('s1'))?.name).toBe('Shared');
    expect((await leaver.db.accounts.get('acc1'))?.name).toBe('Theirs');
    expect(useEvicted.getState().evicted).toBeNull();
  });

  it('a store another identity took over is frozen: no round runs on it and a refused space is never purged from it', async () => {
    const owner = await sharedSpace();
    let wb = 2_000_000;
    let frozen = false;
    const tab = device('otherTab', () => ++wb, server, undefined, false, () => frozen);
    dbs.push(tab.db);
    await tab.engine.syncAll();
    await owner.repo.upsert('account', 's1', 'acc2', { name: 'New' });
    await owner.engine.syncAll();

    // the account went offline in another tab: its server side is gone, and this tab's store is the profile's now
    frozen = true;
    server.forbiddenSpaces.add('s1');
    const heads = server.headsCalls;
    await tab.engine.syncAll();
    // a space whose sync was already under way when the store froze: refused, and left alone
    await tab.engine.syncSpace('s1').catch(() => undefined);

    expect(server.headsCalls).toBe(heads);
    expect((await tab.db.spaces.get('s1'))?.name).toBe('Shared');
    expect((await tab.db.accounts.get('acc1'))?.name).toBe('Theirs');
    expect(useEvicted.getState().evicted).toBeNull();
  });

  it('catchUp is one whole round that begins now: a round already under way does not count, and one that cannot finish says no (#499)', async () => {
    const owner = await sharedSpace();
    let wb = 2_000_000;
    const behind = device('behind', () => ++wb, server);
    dbs.push(behind.db);
    await behind.engine.syncAll();

    // a round that has the server's answer already, and is held there
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const heads = server.heads.bind(server);
    let held = false;
    server.heads = async () => {
      const answer = await heads();
      if (!held) {
        held = true;
        await gate;
      }
      return answer;
    };
    const early = behind.engine.syncAll();
    await vi.waitFor(() => expect(held).toBe(true));
    await owner.repo.upsert('account', 's1', 'acc2', { name: 'Written meanwhile' });
    await owner.engine.syncAll();

    const caughtUp = behind.engine.catchUp();
    open();
    expect(await caughtUp).toBe(true);
    await early;
    expect((await behind.db.accounts.get('acc2'))?.name).toBe('Written meanwhile');

    // a server that fails leaves the device unsure of what it misses
    server.pullStatus = 500;
    expect(await behind.engine.catchUp()).toBe(false);
    server.pullStatus = null;
    await behind.engine.halt();
    expect(await behind.engine.catchUp()).toBe(false);
  });

  it('#306: eviction (push AND pull 403) reports ONCE — stragglers never re-raise or re-push', async () => {
    let w = 1_000_000;
    const a = device('devA', () => ++w, server);
    dbs.push(a.db);
    await a.repo.upsert('space', 's1', 's1', { name: 'Shared', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.engine.syncAll();

    server.forbiddenSpaces.add('s1');
    await a.repo.upsert('account', 's1', 'acc1', { name: 'Late edit' });
    await a.engine.syncAll();

    // the one takeover sheet; the local copy is gone
    expect(useEvicted.getState().evicted?.spaceId).toBe('s1');
    expect(await a.db.spaces.get('s1')).toBeUndefined();
    expect(await a.db.outbox.count()).toBe(0);

    // the user confirms; a straggler write races in AFTER the purge
    useEvicted.getState().clear();
    await a.repo.upsert('account', 's1', 'acc2', { name: 'Straggler' });
    const attempts = server.pushAttempts.filter((s) => s === 's1').length;
    await a.engine.syncAll();

    // no second sheet, not one more push request, the straggler is swept
    expect(useEvicted.getState().evicted).toBeNull();
    expect(server.pushAttempts.filter((s) => s === 's1')).toHaveLength(attempts);
    expect(await a.db.outbox.count()).toBe(0);
    expect(await a.db.accounts.get('acc2')).toBeUndefined();
  });

  it('#306: a re-grant clears the tombstone — sync resumes and a LATER eviction reports again', async () => {
    let w = 1_000_000;
    const a = device('devA', () => ++w, server);
    dbs.push(a.db);
    await a.repo.upsert('space', 's1', 's1', { name: 'Shared', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.engine.syncAll();
    server.forbiddenSpaces.add('s1');
    await a.repo.upsert('account', 's1', 'acc1', { name: 'Late' });
    await a.engine.syncAll();
    expect(useEvicted.getState().evicted?.spaceId).toBe('s1');
    useEvicted.getState().clear();

    // re-invited: the server lists the space again, history intact
    server.forbiddenSpaces.delete('s1');
    await a.engine.syncAll();
    expect(await a.db.meta.get('evictedSpace_s1')).toBeUndefined();
    expect((await a.db.spaces.get('s1'))?.name).toBe('Shared');

    // kicked AGAIN much later — the new eviction may speak again
    server.forbiddenSpaces.add('s1');
    await a.engine.syncAll();
    expect(useEvicted.getState().evicted?.spaceId).toBe('s1');
  });

  it('#306: eviction clears parked ops with the space', async () => {
    let w = 1_000_000;
    const a = device('devA', () => ++w, server);
    dbs.push(a.db);
    await a.repo.upsert('space', 's1', 's1', { name: 'Shared', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.engine.syncAll();
    server.rejectedSpaces.add('s1');
    await a.repo.upsert('receipt', 's1', 'r1', { merchant: 'AH', totalCents: 100 });
    await a.engine.syncAll(); // 400 → parked
    expect(((await a.db.meta.get('parkedOps_s1'))?.value as unknown[]).length).toBeGreaterThan(0);

    server.rejectedSpaces.delete('s1');
    server.forbiddenSpaces.add('s1');
    await a.engine.syncAll(); // eviction — nothing of the space lingers
    expect(await a.db.meta.get('parkedOps_s1')).toBeUndefined();
    expect(await a.db.spaces.get('s1')).toBeUndefined();
  });

  it('feed data of a space the server no longer grants is purged (left-space ghost accounts)', async () => {
    // feed spaces have no local 'space' row — after leaving the space that
    // shared them, they dropped out of the pull loop and their accounts
    // lingered forever as ghost "shared with me" rows (user report)
    let w = 1_000_000;
    const a = device('devA', () => ++w, server);
    dbs.push(a.db);

    await a.repo.upsert('space', 's1', 's1', { name: 'Mine', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    // a shared feed pulled earlier: account row WITHOUT a local space row
    await a.db.accounts.put({ id: 'feed-acc', spaceId: 'feed-1', name: 'Their ING', deleted: 0, fieldVersions: {} } as unknown as AccountRow);
    await a.db.meta.put({ key: 'syncCursor_feed-1', value: 7 });

    await a.engine.syncAll(); // server lists only s1 — access to feed-1 is gone

    expect(await a.db.accounts.get('feed-acc')).toBeUndefined();
    expect(await a.db.meta.get('syncCursor_feed-1')).toBeUndefined();
    // the personal space itself is untouched
    expect((await a.db.spaces.get('s1'))?.name).toBe('Mine');
  });

  it('an import finishing mid-cycle is never swept away (data-loss regression)', async () => {
    // user report: "imported 200 transactions, then everything
    // disappeared" — the orphan-feed sweep at the END of a cycle used
    // the space/outbox snapshots from the START, so a statement import
    // completing while the cycle ran was judged an orphan and purged
    // (rows AND their un-pushed outbox ops)
    let w = 1_000_000;
    const a = device('devA', () => ++w, server);
    dbs.push(a.db);
    await a.repo.upsert('space', 's1', 's1', { name: 'Mine', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.engine.syncAll(); // clean baseline

    // the import lands right after the cycle fetched the server's list
    const origHeads = server.heads.bind(server);
    server.heads = async () => {
      const res = await origHeads();
      await a.repo.upsert('account', 'feed-1', 'facc', { name: 'ING import', balanceCents: 0 });
      await a.repo.upsert('transaction', 'feed-1', 'ftx', { accountId: 'facc', date: '2026-07-01', amountCents: -100, currency: 'EUR', merchant: 'X', needsReview: 1 });
      await a.repo.upsert('accountLink', 's1', 'link1', { feedSpaceId: 'feed-1', accountId: 'facc' });
      return res;
    };
    await a.engine.syncAll();
    server.heads = origHeads;

    // nothing was purged — the fresh import survived the sweep…
    expect(await a.db.accounts.get('facc')).toBeTruthy();
    expect(await a.db.transactions.get('ftx')).toBeTruthy();
    // …and the next cycle delivers its ops to the server
    await a.engine.syncAll();
    expect(await a.db.outbox.count()).toBe(0);
    expect((await server.pull('feed-1', 0)).ops.some((op) => op.entity === 'transaction')).toBe(true);
  });

  it('big outboxes push in chunks; a poisoned space never starves the others', async () => {
    let w = 1_000_000;
    const a = device('devA', () => ++w, server);
    dbs.push(a.db);

    // 650 queued ops → three chunked pushes (300/300/50), all drained
    await a.repo.upsert('space', 's1', 's1', { name: 'Big', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    for (let i = 0; i < 649; i++) await a.repo.upsert('receipt', 's1', `r${i}`, { merchant: 'AH', totalCents: i });
    await a.engine.syncAll();
    expect(server.pushCalls).toEqual([300, 300, 50]);
    expect(await a.db.outbox.count()).toBe(0);

    // s-poison rejects its push (a bad op) — s2 must still sync fine
    await a.repo.upsert('space', 's-poison', 's-poison', { name: 'Bad', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.repo.upsert('space', 's2', 's2', { name: 'Good', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    server.rejectedSpaces.add('s-poison');
    await a.engine.syncAll();
    const s2Outbox = (await a.db.outbox.toArray()).filter((o) => o.spaceId === 's2');
    expect(s2Outbox).toHaveLength(0); // the healthy space drained
    // rejected ops leave the OUTBOX (no eternal 400 wedge — user report:
    // "offline" until reinstall) but are QUARANTINED in meta, never lost
    const poisonOutbox = (await a.db.outbox.toArray()).filter((o) => o.spaceId === 's-poison');
    expect(poisonOutbox).toHaveLength(0);
    const parked = (await a.db.meta.get('parkedOps_s-poison'))?.value as unknown[];
    expect(parked.length).toBeGreaterThan(0);
  });

  it('parked (400-rejected) ops are re-offered and catch up once the server accepts them', async () => {
    let w = 1_000_000;
    const a = device('devA', () => ++w, server);
    dbs.push(a.db);
    await a.repo.upsert('space', 's-heal', 's-heal', { name: 'Heals', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    server.rejectedSpaces.add('s-heal');
    await a.engine.syncAll(); // parks the space row op
    expect(((await a.db.meta.get('parkedOps_s-heal'))?.value as unknown[]).length).toBeGreaterThan(0);

    // the server-side fix ships (validator accepts the op now); a fresh
    // session (new engine instance) re-offers the parked ops exactly once
    server.rejectedSpaces.delete('s-heal');
    const revived = new SyncEngine(a.storeBackend, a.repo, server, 'devA');
    await revived.syncAll();
    expect((await a.db.meta.get('parkedOps_s-heal'))?.value as unknown[]).toHaveLength(0);
    expect((await server.pull('s-heal', 0)).ops.some((op) => op.entity === 'space')).toBe(true);
  });

  it('fresh device discovers and pulls spaces it has never seen', async () => {
    let wa = 1_000_000;
    const a = device('devA', () => ++wa, server);
    dbs.push(a.db);
    await a.repo.upsert('space', 's1', 's1', { name: 'Existing', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.repo.upsert('account', 's1', 'acc1', { name: 'Mine', balanceCents: 42 });
    await a.engine.syncAll();

    // brand-new device, empty database
    let wb = 2_000_000;
    const b = device('devB', () => ++wb, server);
    dbs.push(b.db);
    await b.engine.syncAll();

    expect((await b.db.spaces.get('s1'))?.name).toBe('Existing');
    expect((await b.db.accounts.get('acc1'))?.balanceCents).toBe(42);
  });

  it('interrupted push retries safely (idempotent op ids)', async () => {
    let w = 1_000_000;
    const a = device('devA', () => ++w, server);
    dbs.push(a.db);

    await a.repo.upsert('space', 's1', 's1', { name: 'Solo', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });

    // simulate: push reached the server but the response was lost
    const outbox = await a.db.outbox.toArray();
    await server.push('s1', 'devA', outbox);
    // engine retries the full outbox — server dedupes, then pull applies own ops as no-ops
    await a.engine.syncSpace('s1');

    const pull = await server.pull('s1', 0);
    expect(pull.ops).toHaveLength(outbox.length); // no duplicates server-side
    expect(await a.db.outbox.count()).toBe(0);
  });

  it('#305 bug 4: a paged server drains fully — the head cursor never eats the tail', async () => {
    let wa = 1_000_000;
    const a = device('devA', () => ++wa, server);
    dbs.push(a.db);
    for (let i = 0; i < 25; i++) {
      await a.repo.upsert('category', 's-page', `c${i}`, { name: `Cat ${i}` });
    }
    await a.engine.syncAll();

    server.pageSize = 10; // the real server pages at 1000
    let wb = 2_000_000;
    const b = device('devB', () => ++wb, server);
    dbs.push(b.db);
    await b.engine.syncAll();
    expect((await b.db.categories.toArray()).filter((row) => row.deleted === 0)).toHaveLength(25);
    expect(server.pullCalls).toBeGreaterThan(2); // it genuinely paged

    // an OLD server without nextSince: the dense-seq fallback still drains
    server.omitNextSince = true;
    let wc = 3_000_000;
    const c = device('devC', () => ++wc, server);
    dbs.push(c.db);
    await c.engine.syncAll();
    expect((await c.db.categories.toArray()).filter((row) => row.deleted === 0)).toHaveLength(25);
  });
});

describe('the sync round span (user 2026-10-09)', () => {
  beforeEach(() => {
    dbCounter++;
    perfSpans.attrs.clear();
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ capabilities: {}, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('carries what moved as counts — spaces, ops pushed, rows pulled — never contents', async () => {
    const server = new InMemoryServer();
    let w = 4_000_000;
    const a = device('spanA', () => ++w, server);
    const b = device('spanB', () => ++w, server);
    await a.repo.upsert('space', 's1', 's1', { name: 'Spanned', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.repo.upsert('account', 's1', 'acc1', { name: 'Main', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });

    await a.engine.syncAll();
    // two ops out; the pull after it reads them back (own ops merge as no-ops, they still count as rows pulled)
    expect(perfSpans.attrs.get('sync.round')).toEqual({ 'sync.spaces': 1, 'sync.ops_pushed': 2, 'sync.rows_pulled': 2, 'sync.ok': true });
    expect(perfSpans.attrs.get('sync.push')).toEqual({ 'sync.ops': 2 });
    expect(perfSpans.attrs.get('sync.pull')).toEqual({ 'sync.rows': 2 });
    expect(perfSpans.attrs.has('sync.handshake')).toBe(true);
    expect(perfSpans.attrs.has('sync.spaces')).toBe(true);

    await b.engine.syncAll();
    expect(perfSpans.attrs.get('sync.round')).toEqual({ 'sync.spaces': 1, 'sync.ops_pushed': 0, 'sync.rows_pulled': 2, 'sync.ok': true });

    // a round that did not reach its end says so
    server.pullStatus = 500;
    await b.engine.syncAll();
    expect(perfSpans.attrs.get('sync.round')).toMatchObject({ 'sync.ok': false });
    await a.db.delete();
    await b.db.delete();
  });
});
