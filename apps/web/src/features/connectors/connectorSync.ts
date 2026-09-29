import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { ConnectorConnRow, ConnectorLastError, ConnectorSessionState } from '@/db/types';
import type { SyncEngine } from '@/sync/engine';
import { includedSpaces, reevaluateSpace } from '@/application/receiptMatching';
import { ConnectorError, connectorApi } from './api';
import { dropBundle, keepBundle, readBundle } from './bundles';
import { subscribeConnectorFrames } from './events';
import type { ErrorEnvelope, IngestedCounts, JobView } from './types';

/**
 * One sync pass for one connection (docs/connector-integration-plan.md
 * §10.3): the bundle goes to the relay, the relay resumes the session,
 * fetches, ingests into the feeds and acknowledges; the rows then arrive
 * through normal sync and the matcher runs per included space. A fetch
 * that outran its window comes back as a job this follows to its end.
 */

export interface SyncReport {
  status: 'ok' | 'signin' | 'blocked' | 'wait' | 'error' | 'asking';
  /** receipts the relay filed this pass */
  added: number;
  linked: number;
  proposed: number;
  error?: ErrorEnvelope;
  retryAfterSeconds?: number;
  /** a job stopped for a question nobody was there to answer */
  jobId?: string;
}

export interface SyncOptions {
  engine?: SyncEngine | null;
  /** a human is present: answer a job's question (resolve with the value, or null to give up) */
  onChallenge?: (job: JobView) => Promise<string | null>;
  /** a job's progress, for the state line */
  onProgress?: (job: JobView) => void;
}

const JOB_POLL_MS = 2_000;
const JOB_CEILING_MS = 12 * 60 * 1_000;
const SIGN_IN_CODES = new Set(['session_expired', 'invalid_credentials', 'mfa_failed', 'consent_expired', 'unsupported_resource']);
const TERMINAL_JOB = new Set(['succeeded', 'failed', 'expired']);

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** yesterday relative to the last sync — the relay widens by the party's settlement lag itself */
const sinceFor = (row: ConnectorConnRow): string | undefined =>
  row.lastSyncAt ? isoDate(Date.parse(row.lastSyncAt) - 86_400_000) : undefined;

async function patchRow(storage: StorageBackend, id: string, patch: Partial<ConnectorConnRow>): Promise<void> {
  const row = await storage.connectorConnGet(id);
  if (row) await storage.connectorConnPut({ ...row, ...patch });
}

const lastErrorOf = (envelope: ErrorEnvelope): ConnectorLastError => ({
  code: envelope.code,
  messageKey: envelope.messageKey,
  userAction: envelope.userAction,
  retryAfterSeconds: envelope.retryAfterSeconds ?? undefined,
});

const empty = (): SyncReport => ({ status: 'error', added: 0, linked: 0, proposed: 0 });

/** pull the rows the relay filed, then match them into every included space */
async function landAndMatch(storage: StorageBackend, repo: Repo, engine: SyncEngine | null | undefined, connectionId: string): Promise<Pick<SyncReport, 'linked' | 'proposed'>> {
  await engine?.syncAll().catch(() => undefined);
  let linked = 0;
  let proposed = 0;
  for (const spaceId of await includedSpaces(storage, connectionId)) {
    const outcome = await reevaluateSpace(storage, repo, spaceId, connectionId);
    linked += outcome.linked;
    proposed += outcome.proposed;
  }
  return { linked, proposed };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** the job's view, freshest first: a frame when the stream carries one, the poll as the safety net */
async function nextView(provider: string, job: JobView, waitMs: number): Promise<JobView> {
  let unsubscribe = () => {};
  const fromStream = new Promise<JobView | null>((resolve) => {
    unsubscribe = subscribeConnectorFrames(job.sessionId, () => resolve(null), job.jobId);
  });
  // a frame says "something moved" — the view itself is read afresh, because
  // frames never carry the bundle a rotation may have attached
  await Promise.race([fromStream, sleep(waitMs)]);
  unsubscribe();
  return connectorApi.job(provider, job.jobId);
}

/** a view that shows a rotated bundle consumed the single delivery: keep it at once */
async function keepRotated(storage: StorageBackend, connectionId: string, job: JobView, current: string): Promise<string> {
  if (!job.session?.bundle) return current;
  await keepBundle(storage, connectionId, job.session.bundle);
  return job.session.bundle;
}

type Followed = { job: JobView; bundle: string } | { asked: JobView };

/**
 * Follow a job to a terminal state, answering its questions through the
 * caller when a human is there.
 */
async function followJob(storage: StorageBackend, connectionId: string, provider: string, first: JobView, bundle: string, options: SyncOptions): Promise<Followed> {
  let job = first;
  let current = bundle;
  const deadline = Date.now() + JOB_CEILING_MS;
  for (;;) {
    current = await keepRotated(storage, connectionId, job, current);
    options.onProgress?.(job);
    if (TERMINAL_JOB.has(job.state)) return { job, bundle: current };
    if (job.state === 'awaiting_input' && job.challenge) {
      const value = options.onChallenge ? await options.onChallenge(job) : null;
      if (value === null) return { asked: job };
      job = await connectorApi.answerJob(provider, job.jobId, job.challenge.id, value);
      continue;
    }
    if (Date.now() > deadline) return { asked: job };
    job = await nextView(provider, job, JOB_POLL_MS);
  }
}

/** a job that ended without succeeding speaks the envelope it carried, or the one its state implies */
function jobFailure(job: JobView): ConnectorError {
  const expired = job.state === 'expired';
  const envelope: ErrorEnvelope = job.error ?? {
    code: expired ? 'challenge_expired' : 'internal',
    retriable: true,
    userAction: 'retry',
    messageKey: `connect.error.${expired ? 'challenge_expired' : 'internal'}`,
  };
  return new ConnectorError(expired ? 410 : 500, envelope);
}

type Landed = { ingested: IngestedCounts | undefined } | { asked: JobView };

/** the accepted-job path: follow, then collect the page with the latest bundle */
async function collectJob(storage: StorageBackend, row: ConnectorConnRow, first: JobView, bundle: string, options: SyncOptions): Promise<Landed> {
  const followed = await followJob(storage, row.id, row.provider, first, bundle, options);
  if ('asked' in followed) return followed;
  if (followed.job.state !== 'succeeded') throw jobFailure(followed.job);
  const collected = await connectorApi.collect(row.provider, followed.job.jobId, followed.bundle);
  await keepRotated(storage, row.id, collected.job, followed.bundle);
  return { ingested: collected.job.ingested };
}

async function refused(storage: StorageBackend, connectionId: string, err: ConnectorError): Promise<SyncReport> {
  const envelope = err.envelope;
  const report: SyncReport = { ...empty(), error: envelope, retryAfterSeconds: envelope.retryAfterSeconds ?? undefined };
  let state: ConnectorSessionState | undefined;
  if (SIGN_IN_CODES.has(envelope.code)) {
    // the bundle is dead: nothing this device holds can revive the session
    await dropBundle(storage, connectionId);
    state = 'needs_reauth';
    report.status = 'signin';
  } else if (envelope.code === 'blocked_by_provider') {
    state = 'blocked';
    report.status = 'blocked';
  } else if (envelope.code === 'rate_limited') {
    report.status = 'wait';
  }
  await patchRow(storage, connectionId, { ...(state ? { state } : {}), lastError: lastErrorOf(envelope) });
  return report;
}

/** the relay's answer, landed: the counts it ingested, or the question it stopped at */
async function land(storage: StorageBackend, row: ConnectorConnRow, bundle: string, options: SyncOptions): Promise<Landed> {
  const answer = await connectorApi.sync(row.provider, { connectionId: row.id, bundle, since: sinceFor(row) });
  if (answer.accepted) return collectJob(storage, row, answer.job, bundle, options);
  if (answer.outcome.session?.bundle) await keepBundle(storage, row.id, answer.outcome.session.bundle);
  return { ingested: answer.outcome.ingested };
}

export async function syncConnection(storage: StorageBackend, repo: Repo, connectionId: string, options: SyncOptions = {}): Promise<SyncReport> {
  const row = await storage.connectorConnGet(connectionId);
  if (!row) return empty();
  const bundle = await readBundle(storage, connectionId);
  if (!bundle) return { ...empty(), status: 'signin' };

  try {
    const landed = await land(storage, row, bundle, options);
    if ('asked' in landed) {
      await patchRow(storage, connectionId, { lastError: undefined });
      return { ...empty(), status: 'asking', jobId: landed.asked.jobId };
    }
    await patchRow(storage, connectionId, { state: 'active', lastSyncAt: new Date().toISOString(), lastError: undefined });
    const matched = await landAndMatch(storage, repo, options.engine, connectionId);
    return { ...empty(), status: 'ok', added: landed.ingested?.receipts ?? 0, ...matched };
  } catch (err) {
    if (err instanceof ConnectorError) return refused(storage, connectionId, err);
    throw err;
  }
}
