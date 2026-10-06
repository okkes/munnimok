import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { ConnectorConnRow, ConnectorLastError, ConnectorSessionState } from '@/db/types';
import type { SyncEngine } from '@/sync/engine';
import { includedSpaces, reevaluateSpace } from '@/application/receiptMatching';
import { ConnectorError, connectorApi } from './api';
import { dropBundle, keepBundle, readBundle } from './bundles';
import { subscribeConnectorFrames } from './events';
import { useSyncActivity } from './syncActivity';
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
  /** bank rows the relay filed this pass (M4) */
  accounts: number;
  transactions: number;
  linked: number;
  proposed: number;
  /** the party holds more than this pass fetched (it walks newest first and caps itself) */
  partial?: boolean;
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

/** the follow's pace, a knob so a test can run a cut-off follow in milliseconds rather than half a minute */
export const syncTuning = { pollMs: 2_000, pollMisses: 15 };
// a first fetch of a long history (Amazon opens a page per order) runs for a quarter of an hour and more
const JOB_CEILING_MS = 45 * 60 * 1_000;
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

const lastErrorOf = (envelope: ErrorEnvelope, artifactsJobId?: string): ConnectorLastError => ({
  code: envelope.code,
  messageKey: envelope.messageKey,
  userAction: envelope.userAction,
  retryAfterSeconds: envelope.retryAfterSeconds ?? undefined,
  at: new Date().toISOString(),
  ...(artifactsJobId ? { artifactsJobId } : {}),
});

const empty = (): SyncReport => ({ status: 'error', added: 0, accounts: 0, transactions: 0, linked: 0, proposed: 0 });

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
async function nextView(provider: string, job: JobView, waitMs: number): Promise<JobView | null> {
  let unsubscribe = () => {};
  const fromStream = new Promise<JobView | null>((resolve) => {
    unsubscribe = subscribeConnectorFrames(job.sessionId, () => resolve(null), job.jobId);
  });
  // a frame says "something moved" — the view itself is read afresh, because
  // frames never carry the bundle a rotation may have attached
  await Promise.race([fromStream, sleep(waitMs)]);
  unsubscribe();
  // a poll that dies on the network — a phone that slept mid-request, a
  // tunnel — is a miss, not the end of the follow (prod 2026-10-06)
  return connectorApi.job(provider, job.jobId).catch((err: unknown) => {
    if (err instanceof ConnectorError) throw err;
    return null;
  });
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
  let misses = 0;
  const deadline = Date.now() + JOB_CEILING_MS;
  for (;;) {
    current = await keepRotated(storage, connectionId, job, current);
    options.onProgress?.(job);
    if (TERMINAL_JOB.has(job.state)) return { job, bundle: current };
    if (job.state === 'awaiting_input' && job.challenge) {
      const answered = await answerIfPresent(provider, job, options);
      if (!answered) return { asked: job };
      job = answered;
      continue;
    }
    if (Date.now() > deadline) return { asked: job };
    ({ job, misses } = await pollWithPatience(provider, job, misses));
  }
}

/** a question mid-run, answered through the caller when a human is there; null when nobody is */
async function answerIfPresent(provider: string, job: JobView, options: SyncOptions): Promise<JobView | null> {
  const value = options.onChallenge ? await options.onChallenge(job) : null;
  if (value === null || !job.challenge) return null;
  return connectorApi.answerJob(provider, job.jobId, job.challenge.id, value);
}

/** the next view, or the same one after a miss — and the end of the follow once the misses pile up */
async function pollWithPatience(provider: string, job: JobView, misses: number): Promise<{ job: JobView; misses: number }> {
  const next = await nextView(provider, job, syncTuning.pollMs);
  if (next) return { job: next, misses: 0 };
  if (misses + 1 >= syncTuning.pollMisses) throw new Error(`job ${job.jobId} could not be followed: the relay stopped answering`);
  return { job, misses: misses + 1 };
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
  return new ConnectorError(expired ? 410 : 500, envelope, job.artifactsJobId ?? undefined);
}

type Landed = { ingested: IngestedCounts | undefined; partial: boolean } | { asked: JobView };

/**
 * The accepted-job path: follow, then collect the page with the latest
 * bundle. A collect may answer 202 again: the relay walks on to the
 * resources after the job's, and the next pass became a job of its own
 * (prod 2026-10-04: a bank's accounts pass outran its window and the
 * transactions were never asked for) — follow that one and collect
 * again, until the relay says the walk is done.
 */
async function collectJob(
  storage: StorageBackend,
  row: ConnectorConnRow,
  first: JobView,
  bundle: string,
  options: SyncOptions,
  since: string | undefined,
): Promise<Landed> {
  let job = first;
  let current = bundle;
  for (;;) {
    // remembered on the row: a device that closes on it resumes it on the
    // next sync instead of asking the party all over again (prod 2026-10-06)
    await patchRow(storage, row.id, { pendingJob: { jobId: job.jobId, since, startedAt: new Date().toISOString() } });
    const followed = await followJob(storage, row.id, row.provider, job, current, options);
    if ('asked' in followed) return followed;
    if (followed.job.state !== 'succeeded') throw jobFailure(followed.job);
    const collected = await connectorApi.collect(row.provider, followed.job.jobId, followed.bundle, since);
    current = await keepRotated(storage, row.id, collected.job, followed.bundle);
    if (!collected.running) {
      await patchRow(storage, row.id, { pendingJob: undefined });
      return { ingested: collected.job.ingested, partial: collected.job.complete === false };
    }
    job = collected.job;
  }
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
  // #441 L1: the picture a failed run left waits on the person's word — or
  // goes at once where they said "always"
  const row = await storage.connectorConnGet(connectionId);
  let artifactsJobId = err.artifactsJobId;
  if (artifactsJobId && row?.reportFailures) {
    await connectorApi.shareArtifacts(row.provider, artifactsJobId).catch(() => undefined);
    artifactsJobId = undefined;
  }
  await patchRow(storage, connectionId, { ...(state ? { state } : {}), pendingJob: undefined, lastError: lastErrorOf(envelope, artifactsJobId) });
  return report;
}

/**
 * A job the relay accepted earlier and this device never collected — the
 * app was closed on it — is followed and collected before anything new is
 * asked for; one the relay has since forgotten (a day) is let go and the
 * sync starts afresh. Prod 2026-10-06: a phone that kept reopening the app
 * started a fresh half-hour Amazon fetch each time and collected none of
 * them, while the hub read "Fetching…" for ever.
 */
async function resumePending(storage: StorageBackend, row: ConnectorConnRow, bundle: string, options: SyncOptions): Promise<Landed | null> {
  const pending = row.pendingJob;
  if (!pending) return null;
  let first: JobView | null;
  try {
    first = await connectorApi.job(row.provider, pending.jobId);
  } catch (err) {
    if (!(err instanceof ConnectorError) || (err.status !== 404 && err.envelope.code !== 'unsupported_resource')) throw err;
    first = null;
  }
  if (!first) {
    await patchRow(storage, row.id, { pendingJob: undefined });
    return null;
  }
  return collectJob(storage, row, first, bundle, options, pending.since);
}

/** the relay's answer, landed: the counts it ingested, or the question it stopped at */
async function land(storage: StorageBackend, row: ConnectorConnRow, bundle: string, options: SyncOptions): Promise<Landed> {
  const resumed = await resumePending(storage, row, bundle, options);
  if (resumed) return resumed;
  const since = sinceFor(row);
  const answer = await connectorApi.sync(row.provider, { connectionId: row.id, bundle, since });
  if (answer.accepted) return collectJob(storage, row, answer.job, bundle, options, since);
  if (answer.outcome.session?.bundle) await keepBundle(storage, row.id, answer.outcome.session.bundle);
  return { ingested: answer.outcome.ingested, partial: answer.outcome.complete === false };
}

/** the pass itself: the relay's answer landed and matched, or its refusal spoken */
async function run(storage: StorageBackend, repo: Repo, row: ConnectorConnRow, bundle: string, options: SyncOptions): Promise<SyncReport> {
  try {
    const landed = await land(storage, row, bundle, options);
    if ('asked' in landed) {
      await patchRow(storage, row.id, { lastError: undefined });
      return { ...empty(), status: 'asking', jobId: landed.asked.jobId };
    }
    await patchRow(storage, row.id, { state: 'active', lastSyncAt: new Date().toISOString(), lastError: undefined });
    const matched = await landAndMatch(storage, repo, options.engine, row.id);
    return {
      ...empty(),
      status: 'ok',
      added: landed.ingested?.receipts ?? 0,
      accounts: landed.ingested?.accounts ?? 0,
      transactions: landed.ingested?.transactions ?? 0,
      partial: landed.partial,
      ...matched,
    };
  } catch (err) {
    if (err instanceof ConnectorError) return refused(storage, row.id, err);
    throw err;
  }
}

/**
 * One sync per connection at a time: a second ask while one runs joins it
 * (prod 2026-10-06: the keep-alive, the auto-sync after a bank cycle and
 * Sync now each queued their own half-hour Amazon fetch).
 */
const inFlight = new Map<string, Promise<SyncReport>>();

export function syncConnection(storage: StorageBackend, repo: Repo, connectionId: string, options: SyncOptions = {}): Promise<SyncReport> {
  const running = inFlight.get(connectionId);
  if (running) return running;
  const task = syncOnce(storage, repo, connectionId, options).finally(() => inFlight.delete(connectionId));
  inFlight.set(connectionId, task);
  return task;
}

/**
 * One sync, reported to the activity store from start to end whoever
 * started it (the connect, the app-open keep-alive, Sync now), so the
 * rows show it running — with the count the party's run has found so far
 * — and show what it brought once done (user request 2026-10-02).
 */
async function syncOnce(storage: StorageBackend, repo: Repo, connectionId: string, options: SyncOptions): Promise<SyncReport> {
  const row = await storage.connectorConnGet(connectionId);
  if (!row) return empty();
  const bundle = await readBundle(storage, connectionId);
  if (!bundle) return { ...empty(), status: 'signin' };

  useSyncActivity.getState().begin(connectionId);
  const followed: SyncOptions = {
    ...options,
    onProgress: (job) => {
      if (typeof job.progress?.found === 'number') useSyncActivity.getState().found(connectionId, job.progress.found);
      options.onProgress?.(job);
    },
  };
  try {
    const report = await run(storage, repo, row, bundle, followed);
    useSyncActivity.getState().end(connectionId, report);
    return report;
  } catch (err) {
    useSyncActivity.getState().forget(connectionId);
    throw err;
  }
}
