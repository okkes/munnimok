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
import { syncConnection } from './connectorSync';
import { publishConnectorFrame, resetConnectorFrames, subscribeConnectorFrames } from './events';
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
    // the collect carries the sync's `since` too (none here: the row was never synced)
    expect(collect).toHaveBeenCalledWith(PROVIDER, 'job_1', 'sb_v1.rotated', undefined);
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
