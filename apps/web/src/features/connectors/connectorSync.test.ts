// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { HlcClock } from '@/sync/hlc';
import { storeConnLinkId } from '@/domain/feedIds';
import { NO_INGEST } from '@/test/connectorFixtures';
import { ConnectorError, connectorApi } from './api';
import { readBundle } from './bundles';
import { MAX_OLDER_PASSES, nextBackfill, noteSignInFailure, settleQuestion, syncConnection, syncTuning } from './connectorSync';
import { activityLine } from './ConnectionReceiptsScreen';
import { publishConnectorFrame, resetConnectorFrames, subscribeConnectorFrames } from './events';
import { useSyncActivity } from './syncActivity';
import type { ErrorEnvelope, JobView } from './types';

const SPACE = 's1';
const CONN = 'conn-1';
const PROVIDER = 'mock-store-simple';
let counter = 0;
let db: MunniDB;
let repo: Repo;
let backend: DexieBackend;

const envelope = (code: string, extra: Partial<ErrorEnvelope> = {}): ErrorEnvelope => ({
  code,
  retriable: false,
  userAction: 'none',
  messageKey: `connect.error.${code}`,
  ...extra,
});

const job = (fields: Partial<JobView>): JobView => ({ jobId: 'job_1', sessionId: 'ses_1', state: 'running', complete: false, ...fields });

beforeEach(async () => {
  db = new MunniDB(`connector_sync_${++counter}`);
  backend = new DexieBackend(db);
  repo = new Repo(backend, new HlcClock('dev'), { trackOutbox: false });
  await repo.upsert('space', SPACE, SPACE, { name: 'One', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
  await repo.upsert('storeConn', 'feed', CONN, { store: PROVIDER, displayName: 'Mock', connectedAt: '2026-09-01', status: 'ok' });
  await repo.upsert('storeConnLink', SPACE, storeConnLinkId(SPACE, CONN), { instanceId: CONN, store: PROVIDER, displayName: 'Mock' });
  await backend.connectorConnPut({ id: CONN, provider: PROVIDER, bundle: 'sb_v1.old', sessionId: 'ses_1', state: 'active', refreshedAt: '2026-09-01T00:00:00Z' });
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  resetConnectorFrames();
});

describe('syncConnection — one pass through the relay', () => {
  it('a settled sync keeps the rotated bundle, marks the connection synced and counts what landed', async () => {
    vi.spyOn(connectorApi, 'sync').mockResolvedValue({
      accepted: false,
      outcome: { sessionId: 'ses_1', state: 'active', ingested: { ...NO_INGEST, records: 2, receipts: 2 }, session: { bundle: 'sb_v1.new', rotated: true } },
    });
    const report = await syncConnection(backend, repo, CONN);
    expect(report).toMatchObject({ status: 'ok', added: 2, linked: 0, proposed: 0 });
    expect(connectorApi.sync).toHaveBeenCalledWith(PROVIDER, { connectionId: CONN, bundle: 'sb_v1.old', since: undefined });
    expect(await readBundle(backend, CONN)).toBe('sb_v1.new');
    const row = (await backend.connectorConnGet(CONN))!;
    expect(row.state).toBe('active');
    expect(row.lastSyncAt).toBeTruthy();
    expect(row.lastError).toBeUndefined();
  });

  it("a bank's sync re-reads every space with a shop against the shop's receipts (user 2026-10-09: proposals before the review)", async () => {
    // the shop's receipt and the reviewed transaction it fits, in a space that includes the shop
    await repo.upsert('storeConn', 'feed', 'conn-ah', { store: 'ah', kind: 'store', displayName: 'Albert Heijn', connectedAt: '2026-09-01', status: 'ok' });
    await repo.upsert('storeConnLink', SPACE, storeConnLinkId(SPACE, 'conn-ah'), { instanceId: 'conn-ah', store: 'ah', displayName: 'Albert Heijn' });
    await repo.upsert('receipt', 'feed', 'rcpt:ah:conn-ah:1', { source: 'ah', instanceId: 'conn-ah', date: '2026-07-05', totalCents: 2350, merchant: 'Albert Heijn', storeRef: 'ah:1' });
    await repo.upsert('transaction', SPACE, 'tx-ah', { accountId: 'a1', date: '2026-07-05', amountCents: -2350, currency: 'EUR', merchant: 'Albert Heijn', needsReview: 0 });
    // the bank is included nowhere (its accounts attach, its connection does not): the pass walks the spaces with a shop
    await repo.upsert('storeConn', 'feed', 'conn-bank', { store: 'mock-bank', kind: 'bank', displayName: 'Mock bank', connectedAt: '2026-09-01', status: 'ok' });
    await backend.connectorConnPut({ id: 'conn-bank', provider: 'mock-bank', bundle: 'sb_v1.bank', sessionId: 'ses_b', state: 'active', refreshedAt: '2026-09-01T00:00:00Z' });
    vi.spyOn(connectorApi, 'sync').mockResolvedValue({
      accepted: false,
      outcome: { sessionId: 'ses_b', state: 'active', ingested: { ...NO_INGEST, records: 3, transactions: 3 } },
    });
    const report = await syncConnection(backend, repo, 'conn-bank');
    expect(report).toMatchObject({ status: 'ok', transactions: 3, proposed: 1 });
    expect((await backend.bySpace('receiptLink', SPACE)).find((l) => l.proposedTxId === 'tx-ah')?.instanceId).toBe('conn-ah');
  });

  it('a dead session drops the bundle and asks for a sign-in; a budget refusal asks for patience', async () => {
    vi.spyOn(connectorApi, 'sync').mockRejectedValueOnce(new ConnectorError(401, envelope('session_expired', { userAction: 'reauth' })));
    const refused = await syncConnection(backend, repo, CONN);
    expect(refused.status).toBe('signin');
    expect(await readBundle(backend, CONN)).toBeUndefined();
    expect((await backend.connectorConnGet(CONN))?.state).toBe('needs_reauth');
    expect((await backend.connectorConnGet(CONN))?.lastError?.code).toBe('session_expired');

    // no bundle on this device now: the relay is not even asked
    expect((await syncConnection(backend, repo, CONN)).status).toBe('signin');

    await backend.connectorConnPut({ id: CONN, provider: PROVIDER, bundle: 'sb_v1.b', sessionId: 'ses_1', state: 'active', refreshedAt: '2026-09-01T00:00:00Z' });
    vi.spyOn(connectorApi, 'sync').mockRejectedValueOnce(new ConnectorError(429, envelope('rate_limited', { retriable: true, userAction: 'wait', retryAfterSeconds: 900 })));
    const waited = await syncConnection(backend, repo, CONN);
    expect(waited).toMatchObject({ status: 'wait', retryAfterSeconds: 900 });
    expect((await backend.connectorConnGet(CONN))?.state).toBe('active');
  });

  it('a fetch that became a job is followed to its end and collected — the poll keeps a rotated bundle', async () => {
    vi.spyOn(connectorApi, 'sync').mockResolvedValue({ accepted: true, job: job({ state: 'running' }) });
    vi.spyOn(connectorApi, 'job').mockResolvedValue(job({ state: 'succeeded', complete: true, session: { bundle: 'sb_v1.rotated', rotated: true } }));
    const collect = vi.spyOn(connectorApi, 'collect').mockResolvedValue({ running: false, job: job({ state: 'succeeded', complete: true, ingested: { ...NO_INGEST, receipts: 1 } }) });
    // the stream says "something moved" the moment the follow subscribes — no poll wait
    const publishSoon = setInterval(() => publishConnectorFrame({ kind: 'connector', provider: PROVIDER, sessionId: 'ses_1', jobId: 'job_1', state: 'succeeded' }), 20);
    try {
      const report = await syncConnection(backend, repo, CONN);
      expect(report).toMatchObject({ status: 'ok', added: 1 });
    } finally {
      clearInterval(publishSoon);
    }
    // the collect carries the sync's window too (none here: the row was never synced)
    expect(collect).toHaveBeenCalledWith(PROVIDER, 'job_1', 'sb_v1.rotated', undefined, undefined);
    expect(await readBundle(backend, CONN)).toBe('sb_v1.rotated');
  });

  it('a collect that answers 202 is the next resource’s job: followed and collected in turn, until the walk is done', async () => {
    vi.spyOn(connectorApi, 'sync').mockResolvedValue({ accepted: true, job: job({ state: 'running' }) });
    vi.spyOn(connectorApi, 'job')
      .mockResolvedValueOnce(job({ state: 'succeeded', complete: true }))
      .mockResolvedValue(job({ jobId: 'job_2', state: 'succeeded', complete: true }));
    const collect = vi.spyOn(connectorApi, 'collect')
      // the accounts landed; the transactions pass became the next job
      .mockResolvedValueOnce({ running: true, job: job({ jobId: 'job_2', state: 'running', ingested: { ...NO_INGEST, accounts: 1 } }) })
      .mockResolvedValue({ running: false, job: job({ jobId: 'job_2', state: 'succeeded', complete: true, ingested: { ...NO_INGEST, accounts: 1, transactions: 3 } }) });
    const publishSoon = setInterval(() => {
      publishConnectorFrame({ kind: 'connector', provider: PROVIDER, sessionId: 'ses_1', jobId: 'job_1', state: 'succeeded' });
      publishConnectorFrame({ kind: 'connector', provider: PROVIDER, sessionId: 'ses_1', jobId: 'job_2', state: 'succeeded' });
    }, 20);
    try {
      const report = await syncConnection(backend, repo, CONN);
      expect(report).toMatchObject({ status: 'ok', accounts: 1, transactions: 3 });
    } finally {
      clearInterval(publishSoon);
    }
    expect(collect.mock.calls.map((c) => c[1])).toEqual(['job_1', 'job_2']);
  });

  it('a question mid-fetch is answered through the caller, or left for the hub when nobody is there', async () => {
    const asking = job({ state: 'awaiting_input', challenge: { id: 'ch_1', type: 'mfa_code', answerKind: 'text', expiresAt: '2030-01-01T00:00:00Z' } });
    vi.spyOn(connectorApi, 'sync').mockResolvedValue({ accepted: true, job: asking });
    const answer = vi.spyOn(connectorApi, 'answerJob').mockResolvedValue(job({ state: 'succeeded', complete: true }));
    vi.spyOn(connectorApi, 'collect').mockResolvedValue({ running: false, job: job({ state: 'succeeded', complete: true, ingested: NO_INGEST }) });

    const report = await syncConnection(backend, repo, CONN, { onChallenge: async () => '123456' });
    expect(report.status).toBe('ok');
    expect(answer).toHaveBeenCalledWith(PROVIDER, 'job_1', 'ch_1', '123456');

    const unattended = await syncConnection(backend, repo, CONN);
    expect(unattended).toMatchObject({ status: 'asking', jobId: 'job_1' });
  });

  it('a job that failed speaks the connector envelope', async () => {
    vi.spyOn(connectorApi, 'sync').mockResolvedValue({
      accepted: true,
      job: job({ state: 'failed', complete: true, error: envelope('blocked_by_provider', { userAction: 'wait' }) }),
    });
    const report = await syncConnection(backend, repo, CONN);
    expect(report).toMatchObject({ status: 'blocked' });
    expect((await backend.connectorConnGet(CONN))?.state).toBe('blocked');
  });

  it('prod 2026-10-06: a job accepted earlier is remembered on the row and resumed before any new fetch — gone, it is let go', async () => {
    // the first sync is cut off mid-follow (the app closed on it): the job stays on the row
    const pace = { ...syncTuning };
    Object.assign(syncTuning, { pollMs: 1, pollMisses: 2 });
    try {
      vi.spyOn(connectorApi, 'sync').mockResolvedValue({ accepted: true, job: job({ state: 'running' }) });
      vi.spyOn(connectorApi, 'job').mockRejectedValue(new TypeError('the phone slept'));
      await expect(syncConnection(backend, repo, CONN)).rejects.toThrow(/stopped answering/);
    } finally {
      Object.assign(syncTuning, pace);
    }
    expect((await backend.connectorConnGet(CONN))?.pendingJob).toMatchObject({ jobId: 'job_1' });

    // the next sync follows THAT job to its end and collects it: no second fetch is asked for
    const sync = vi.spyOn(connectorApi, 'sync').mockResolvedValue({ accepted: true, job: job({ jobId: 'job_2', state: 'running' }) });
    sync.mockClear();
    vi.spyOn(connectorApi, 'job').mockResolvedValue(job({ state: 'succeeded', complete: true }));
    const collect = vi.spyOn(connectorApi, 'collect').mockResolvedValue({ running: false, job: job({ state: 'succeeded', complete: true, ingested: { ...NO_INGEST, receipts: 3 } }) });
    const report = await syncConnection(backend, repo, CONN);
    expect(report).toMatchObject({ status: 'ok', added: 3 });
    expect(sync).not.toHaveBeenCalled();
    expect(collect).toHaveBeenCalledWith(PROVIDER, 'job_1', 'sb_v1.old', undefined, undefined);
    expect((await backend.connectorConnGet(CONN))?.pendingJob).toBeUndefined();

    // a remembered job the relay no longer holds is forgotten, and the sync starts afresh
    await backend.connectorConnPut({ ...(await backend.connectorConnGet(CONN))!, pendingJob: { jobId: 'job_gone', startedAt: '2026-10-05T00:00:00Z' } });
    vi.spyOn(connectorApi, 'job').mockRejectedValue(new ConnectorError(404, envelope('unsupported_resource')));
    sync.mockClear();
    sync.mockResolvedValue({ accepted: false, outcome: { sessionId: 'ses_1', state: 'active', ingested: { ...NO_INGEST } } });
    expect((await syncConnection(backend, repo, CONN)).status).toBe('ok');
    expect(sync).toHaveBeenCalledTimes(1);
    expect((await backend.connectorConnGet(CONN))?.pendingJob).toBeUndefined();
  }, 15_000);

  it('one sync per connection at a time: a second ask joins the one running', async () => {
    let release: (answer: Awaited<ReturnType<typeof connectorApi.sync>>) => void = () => {};
    const gate = new Promise<Awaited<ReturnType<typeof connectorApi.sync>>>((resolve) => {
      release = resolve;
    });
    const sync = vi.spyOn(connectorApi, 'sync').mockImplementation(() => gate);
    const first = syncConnection(backend, repo, CONN);
    const second = syncConnection(backend, repo, CONN);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    release({ accepted: false, outcome: { sessionId: 'ses_1', state: 'active', ingested: { ...NO_INGEST, records: 1, receipts: 1 } } });
    expect((await first).added).toBe(1);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('#441 L1: a failed job that left a picture puts the question on the row — or answers it where the person said "always"', async () => {
    vi.spyOn(connectorApi, 'sync').mockResolvedValue({
      accepted: true,
      job: job({ state: 'failed', complete: true, error: envelope('provider_changed'), artifactsJobId: 'job_1' }),
    });
    await syncConnection(backend, repo, CONN);
    expect((await backend.connectorConnGet(CONN))?.lastError?.artifactsJobId).toBe('job_1');

    await backend.connectorConnPut({ ...(await backend.connectorConnGet(CONN))!, reportFailures: true });
    const share = vi.spyOn(connectorApi, 'shareArtifacts').mockResolvedValue();
    await syncConnection(backend, repo, CONN);
    expect(share).toHaveBeenCalledWith(PROVIDER, 'job_1');
    expect((await backend.connectorConnGet(CONN))?.lastError?.artifactsJobId).toBeUndefined();
  });

  it('user 2026-10-07: a sign-in that failed in the sheet leaves its question on the row — shared at once where the person said "always"; a connection without a row keeps it in the sheet', async () => {
    const failure = envelope('provider_changed');
    expect(await noteSignInFailure(backend, 'conn-new', failure, 'job_n')).toBe('none');
    expect(await noteSignInFailure(backend, CONN, failure, 'job_1')).toBe('asked');
    expect((await backend.connectorConnGet(CONN))?.lastError).toMatchObject({ code: 'provider_changed', artifactsJobId: 'job_1' });
    // answered: the id leaves the row, the failure itself stays
    await settleQuestion(backend, CONN, 'job_1');
    const settled = (await backend.connectorConnGet(CONN))?.lastError;
    expect(settled?.code).toBe('provider_changed');
    expect(settled?.artifactsJobId).toBeUndefined();

    // the standing answer: shared here, nothing left to ask; a failure without a picture asks nothing either
    await backend.connectorConnPut({ ...(await backend.connectorConnGet(CONN))!, reportFailures: true });
    const share = vi.spyOn(connectorApi, 'shareArtifacts').mockResolvedValue();
    expect(await noteSignInFailure(backend, CONN, failure, 'job_2')).toBe('shared');
    expect(share).toHaveBeenCalledWith(PROVIDER, 'job_2');
    expect((await backend.connectorConnGet(CONN))?.lastError?.artifactsJobId).toBeUndefined();
    expect(await noteSignInFailure(backend, CONN, failure)).toBe('none');
    expect(share).toHaveBeenCalledTimes(1);
  });
});

describe('#460 — older history after a partial pass', () => {
  const outcome = (fields: { transactions?: number; receipts?: number; complete: boolean; oldest?: string }) => ({
    accepted: false as const,
    outcome: {
      sessionId: 'ses_1',
      state: 'active' as const,
      ingested: { ...NO_INGEST, transactions: fields.transactions ?? 0, receipts: fields.receipts ?? 0 },
      complete: fields.complete,
      ...(fields.oldest ? { oldest: fields.oldest } : {}),
    },
  });

  it('goes on to older history right away, pass after pass, the hub line following how far back it reached', async () => {
    const reached: (string | undefined)[] = [];
    const sync = vi.spyOn(connectorApi, 'sync').mockImplementation(async () => {
      reached.push(useSyncActivity.getState().activity[CONN]?.older);
      switch (sync.mock.calls.length) {
        case 1:
          return outcome({ transactions: 200, complete: false, oldest: '2026-03-10' });
        case 2:
          return outcome({ transactions: 200, complete: false, oldest: '2025-11-02' });
        default:
          return outcome({ transactions: 40, complete: true });
      }
    });

    const report = await syncConnection(backend, repo, CONN);

    expect(sync.mock.calls.map((c) => c[1])).toEqual([
      { connectionId: CONN, bundle: 'sb_v1.old', since: undefined },
      // the frontier day is asked again: a pass's cap can cut a day in half
      { connectionId: CONN, bundle: 'sb_v1.old', since: undefined, until: '2026-03-10' },
      { connectionId: CONN, bundle: 'sb_v1.old', since: undefined, until: '2025-11-02' },
    ]);
    expect(reached).toEqual([undefined, '2026-03-10', '2025-11-02']);
    expect(report).toMatchObject({ status: 'ok', transactions: 440, partial: false, olderPending: false });
    expect((await backend.connectorConnGet(CONN))?.backfill).toBeUndefined();
  });

  it('a regular sync that comes back partial reaches down to its own since, never past it', async () => {
    await backend.connectorConnPut({ ...(await backend.connectorConnGet(CONN))!, lastSyncAt: '2026-11-01T10:00:00Z' });
    const sync = vi.spyOn(connectorApi, 'sync')
      .mockResolvedValueOnce(outcome({ receipts: 2000, complete: false, oldest: '2026-11-04' }))
      .mockResolvedValue(outcome({ receipts: 12, complete: true }));

    await syncConnection(backend, repo, CONN);

    expect(sync.mock.calls[1][1]).toEqual({ connectionId: CONN, bundle: 'sb_v1.old', since: '2026-10-31', until: '2026-11-04' });
  });

  it('a refusal mid-way leaves the rest on the row, and the next sync goes on with it', async () => {
    const sync = vi.spyOn(connectorApi, 'sync')
      .mockResolvedValueOnce(outcome({ transactions: 200, complete: false, oldest: '2026-03-10' }))
      .mockRejectedValueOnce(new ConnectorError(429, envelope('rate_limited', { retriable: true, userAction: 'wait', retryAfterSeconds: 600 })));

    const first = await syncConnection(backend, repo, CONN);
    // the newest rows landed and say so; the party's pause is no failure of the sync
    expect(first).toMatchObject({ status: 'ok', transactions: 200, olderPending: true });
    expect((await backend.connectorConnGet(CONN))?.backfill).toEqual({ until: '2026-03-10' });

    sync.mockReset();
    sync.mockResolvedValueOnce(outcome({ complete: true })).mockResolvedValue(outcome({ transactions: 80, complete: true }));
    const second = await syncConnection(backend, repo, CONN);
    expect(sync.mock.calls[1][1]).toMatchObject({ until: '2026-03-10' });
    expect(second).toMatchObject({ status: 'ok', transactions: 80, olderPending: false });
    expect((await backend.connectorConnGet(CONN))?.backfill).toBeUndefined();
  });

  it('a pass that reaches no further ends it, and a sign-in refusal mid-way is the sync’s to speak', async () => {
    const sync = vi.spyOn(connectorApi, 'sync')
      .mockResolvedValueOnce(outcome({ transactions: 200, complete: false, oldest: '2026-03-10' }))
      // a cap filled by the frontier day alone: nothing older came
      .mockResolvedValueOnce(outcome({ transactions: 200, complete: false, oldest: '2026-03-10' }));
    expect((await syncConnection(backend, repo, CONN)).olderPending).toBe(false);
    expect(sync).toHaveBeenCalledTimes(2);

    sync.mockReset();
    sync
      .mockResolvedValueOnce(outcome({ transactions: 5, complete: false, oldest: '2026-03-10' }))
      .mockRejectedValueOnce(new ConnectorError(401, envelope('session_expired', { userAction: 'reauth' })));
    expect((await syncConnection(backend, repo, CONN)).status).toBe('signin');
    expect((await backend.connectorConnGet(CONN))?.state).toBe('needs_reauth');
  });

  it('a pass over older history that became a job is collected with its window — and remembered with it', async () => {
    vi.spyOn(connectorApi, 'sync')
      .mockResolvedValueOnce(outcome({ transactions: 200, complete: false, oldest: '2026-03-10' }))
      .mockResolvedValueOnce({ accepted: true, job: job({ jobId: 'job_old', state: 'running' }) });
    vi.spyOn(connectorApi, 'job').mockImplementation(async () => {
      expect((await backend.connectorConnGet(CONN))?.pendingJob).toMatchObject({ jobId: 'job_old', until: '2026-03-10' });
      return job({ jobId: 'job_old', state: 'succeeded', complete: true });
    });
    const collect = vi.spyOn(connectorApi, 'collect').mockResolvedValue({
      running: false,
      job: job({ jobId: 'job_old', state: 'succeeded', complete: true, ingested: { ...NO_INGEST, transactions: 31 } }),
    });
    const publishSoon = setInterval(() => publishConnectorFrame({ kind: 'connector', provider: PROVIDER, sessionId: 'ses_1', jobId: 'job_old', state: 'succeeded' }), 20);
    try {
      expect(await syncConnection(backend, repo, CONN)).toMatchObject({ status: 'ok', transactions: 231, olderPending: false });
    } finally {
      clearInterval(publishSoon);
    }
    expect(collect).toHaveBeenCalledWith(PROVIDER, 'job_old', 'sb_v1.old', undefined, '2026-03-10');
  });

  it('one sync makes a bounded number of passes; the rest follows on the next sync', async () => {
    // every pass partial and reaching a month further back: only the cap stops the run
    let month = 12;
    const sync = vi.spyOn(connectorApi, 'sync').mockImplementation(async () => {
      month -= 1;
      return outcome({ transactions: 10, complete: false, oldest: `2025-${String(month).padStart(2, '0')}-01` });
    });
    const report = await syncConnection(backend, repo, CONN);
    expect(sync).toHaveBeenCalledTimes(1 + MAX_OLDER_PASSES);
    expect(report.olderPending).toBe(true);
    expect((await backend.connectorConnGet(CONN))?.backfill).toEqual({ until: '2025-01-01' });
  });

  it('the rule: a whole pass leaves a pending backfill as it was; a new partial one joins it; a pass over older history moves or ends it', () => {
    const pending = { since: '2025-01-01', until: '2025-06-01' };
    expect(nextBackfill(pending, { since: '2026-11-01' }, { partial: false })).toBe(pending);
    expect(nextBackfill(pending, { since: '2026-11-01' }, { partial: true, oldest: '2026-11-05' })).toEqual({ since: '2025-01-01', until: '2026-11-05' });
    expect(nextBackfill(pending, {}, { partial: true, oldest: '2026-11-05' })).toEqual({ until: '2026-11-05' });
    expect(nextBackfill(undefined, { since: '2026-11-01' }, { partial: true })).toBeUndefined();
    expect(nextBackfill(pending, pending, { partial: true, oldest: '2025-03-01' })).toEqual({ since: '2025-01-01', until: '2025-03-01' });
    expect(nextBackfill(pending, pending, { partial: false, oldest: '2025-03-01' })).toBeUndefined();
    expect(nextBackfill(pending, pending, { partial: true })).toBeUndefined();
  });

  it('the receipts screen says how far back a running sync reached, and that older history follows', () => {
    const t = (key: string, vars?: Record<string, unknown>) => `${key}${vars ? JSON.stringify(vars) : ''}`;
    const base = { connectionId: CONN, found: 5, startedAt: 0 };
    expect(activityLine({ ...base, phase: 'fetching', older: '2025-11-02' }, t as never, 'en')?.text).toContain('conn.syncOlder');
    const done = { ...base, phase: 'done' as const, finishedAt: Date.now(), report: { status: 'ok' as const, added: 3, accounts: 0, transactions: 0, linked: 0, proposed: 0, olderPending: true } };
    expect(activityLine(done, t as never, 'en')?.text).toContain('conn.syncOlderLater');
  });
});

describe('connector frames in-process', () => {
  it('reach only the subscriber of that session (and job), and only connector frames count', () => {
    const seen: string[] = [];
    const stop = subscribeConnectorFrames('ses_1', (frame) => seen.push(`${frame.jobId ?? '-'}:${frame.state}`));
    const stopJob = subscribeConnectorFrames('ses_1', (frame) => seen.push(`job:${frame.state}`), 'job_9');
    publishConnectorFrame({ kind: 'connector', provider: 'p', sessionId: 'ses_1', state: 'running' });
    publishConnectorFrame({ kind: 'connector', provider: 'p', sessionId: 'ses_2', state: 'running' });
    publishConnectorFrame({ kind: 'connector', provider: 'p', sessionId: 'ses_1', jobId: 'job_9', state: 'succeeded' });
    publishConnectorFrame({ spaceId: 'x' });
    publishConnectorFrame(null);
    stop();
    stopJob();
    publishConnectorFrame({ kind: 'connector', provider: 'p', sessionId: 'ses_1', state: 'failed' });
    expect(seen).toEqual(['-:running', 'job_9:succeeded', 'job:succeeded']);
  });
});
