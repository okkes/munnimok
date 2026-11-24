import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { ConnectorBackfill, ConnectorConnRow, ConnectorLastError, ConnectorSessionState } from '@/db/types';
import type { SyncEngine } from '@/sync/engine';
import { appendNotification, syncFailedKey } from '@/application/notifications';
import { includedSpaces, reevaluateSpace, rematchSpaces } from '@/application/receiptMatching';
import { myReceiptFeedId } from '@/application/storeFeed';
import { ConnectorError, connectorApi } from './api';
import { dropBundle, keepBundle, readBundle } from './bundles';
import { subscribeConnectorFrames } from './events';
import { useSyncActivity } from './syncActivity';
import type { ErrorEnvelope, IngestedCounts, JobView } from './types';

// rows land through normal sync, then the matcher runs per included space;
// a fetch that outran its window is a job, followed to its end

export interface SyncReport {
  status: 'ok' | 'signin' | 'blocked' | 'wait' | 'error' | 'asking';
  /** receipts the relay filed this pass */
  added: number;
  accounts: number;
  transactions: number;
  linked: number;
  proposed: number;
  /** the party holds more than this pass fetched (it walks newest first and caps itself) and no older pass could follow */
  partial?: boolean;
  /** #460: older history is still to come — the next sync goes on with it */
  olderPending?: boolean;
  error?: ErrorEnvelope;
  retryAfterSeconds?: number;
  /** a job stopped for a question nobody was there to answer */
  jobId?: string;
}

export interface SyncOptions {
  engine?: SyncEngine | null;
  onChallenge?: (job: JobView) => Promise<string | null>;
  onProgress?: (job: JobView) => void;
}

/** the follow's pace, a knob so a test can run a cut-off follow in milliseconds rather than half a minute */
export const syncTuning = { pollMs: 2_000, pollMisses: 15 };
// a first fetch of a long history (Amazon opens a page per order) runs for a quarter of an hour and more
const JOB_CEILING_MS = 45 * 60 * 1_000;
const SIGN_IN_CODES = new Set(['session_expired', 'invalid_credentials', 'mfa_failed', 'consent_expired', 'unsupported_resource']);
const TERMINAL_JOB = new Set(['succeeded', 'failed', 'expired']);
// #460: cap on older passes per sync; they run attended, and the cap spares the relay's hourly budget
// (the rest follows on the next sync)
export const MAX_OLDER_PASSES = 10;

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

// #441 L1: a failed run's picture waits on the person's word, or goes at once where they said "always";
// returns the job id still open, or nothing once shared
async function shareOrLeave(row: ConnectorConnRow | undefined, artifactsJobId: string | undefined): Promise<string | undefined> {
  if (!artifactsJobId || !row?.reportFailures) return artifactsJobId;
  await connectorApi.shareArtifacts(row.provider, artifactsJobId).catch(() => undefined);
  return undefined;
}

/** shared by the standing answer, left open for the hub's card, or nothing to ask */
export type FailureNoted = 'shared' | 'asked' | 'none';

// a sign-in that failed in the sheet also writes to the device row, so the question survives the sheet;
// a connection with no row yet (first sign-in) keeps it in the sheet alone
export async function noteSignInFailure(storage: StorageBackend, connectionId: string, envelope: ErrorEnvelope, artifactsJobId?: string): Promise<FailureNoted> {
  const row = await storage.connectorConnGet(connectionId);
  if (!row) return 'none';
  const open = await shareOrLeave(row, artifactsJobId);
  await storage.connectorConnPut({ ...row, lastError: lastErrorOf(envelope, open) });
  if (open) return 'asked';
  return artifactsJobId ? 'shared' : 'none';
}

export async function settleQuestion(storage: StorageBackend, connectionId: string, jobId: string): Promise<void> {
  const row = await storage.connectorConnGet(connectionId);
  if (row?.lastError?.artifactsJobId !== jobId) return;
  const { artifactsJobId: _answered, ...rest } = row.lastError;
  await storage.connectorConnPut({ ...row, lastError: rest });
}

const empty = (): SyncReport => ({ status: 'error', added: 0, accounts: 0, transactions: 0, linked: 0, proposed: 0 });

async function landAndMatch(storage: StorageBackend, repo: Repo, engine: SyncEngine | null | undefined, connectionId: string): Promise<Pick<SyncReport, 'linked' | 'proposed'>> {
  await engine?.syncAll().catch(() => undefined);
  // a bank's or registry's rows reach a space through its accounts, so every space with a shop re-reads its
  // transactions against the shop's receipts: proposals stand before the review opens
  const meta = (await storage.allRows('storeConn')).find((c) => c.id === connectionId && c.deleted === 0);
  if (meta?.kind === 'bank' || meta?.kind === 'registry') return rematchSpaces(storage, repo);
  let linked = 0;
  let proposed = 0;
  for (const spaceId of await includedSpaces(storage, connectionId)) {
    const outcome = await reevaluateSpace(storage, repo, spaceId, myReceiptFeedId(connectionId) ?? undefined);
    linked += outcome.linked;
    proposed += outcome.proposed;
  }
  return { linked, proposed };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function nextView(provider: string, job: JobView, waitMs: number): Promise<JobView | null> {
  let unsubscribe = () => {};
  const fromStream = new Promise<JobView | null>((resolve) => {
    unsubscribe = subscribeConnectorFrames(job.sessionId, () => resolve(null), job.jobId);
  });
  // a frame only says "something moved": the view is read afresh, as frames never carry a rotated bundle
  await Promise.race([fromStream, sleep(waitMs)]);
  unsubscribe();
  // a poll that dies on the network (a phone that slept, a tunnel) is a miss, not the end of the follow
  // (prod 2026-10-06)
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

async function answerIfPresent(provider: string, job: JobView, options: SyncOptions): Promise<JobView | null> {
  const value = options.onChallenge ? await options.onChallenge(job) : null;
  if (value === null || !job.challenge) return null;
  return connectorApi.answerJob(provider, job.jobId, job.challenge.id, value);
}

async function pollWithPatience(provider: string, job: JobView, misses: number): Promise<{ job: JobView; misses: number }> {
  const next = await nextView(provider, job, syncTuning.pollMs);
  if (next) return { job: next, misses: 0 };
  if (misses + 1 >= syncTuning.pollMisses) throw new Error(`job ${job.jobId} could not be followed: the relay stopped answering`);
  return { job, misses: misses + 1 };
}

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

/** since absent: the party's floor; until only on a pass over older history (#460) */
interface PassWindow {
  since?: string;
  until?: string;
}

type Landed = { ingested: IngestedCounts | undefined; partial: boolean; oldest?: string; window: PassWindow } | { asked: JobView };

// a collect can answer 202 again: the next resource's pass became a job of its own (prod 2026-10-04: a bank's
// accounts pass outran its window and the transactions were never asked for); follow it, collect until the walk is done
async function collectJob(
  storage: StorageBackend,
  row: ConnectorConnRow,
  first: JobView,
  bundle: string,
  options: SyncOptions,
  window: PassWindow,
): Promise<Landed> {
  let job = first;
  let current = bundle;
  for (;;) {
    // remembered on the row: a device closed on it resumes it next sync instead of asking the party again (prod 2026-10-06)
    await patchRow(storage, row.id, { pendingJob: { jobId: job.jobId, ...window, startedAt: new Date().toISOString() } });
    const followed = await followJob(storage, row.id, row.provider, job, current, options);
    if ('asked' in followed) return followed;
    if (followed.job.state !== 'succeeded') throw jobFailure(followed.job);
    const collected = await connectorApi.collect(row.provider, followed.job.jobId, followed.bundle, window.since, window.until);
    current = await keepRotated(storage, row.id, collected.job, followed.bundle);
    if (!collected.running) {
      await patchRow(storage, row.id, { pendingJob: undefined });
      return { ingested: collected.job.ingested, partial: collected.job.complete === false, oldest: collected.job.oldest, window };
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
  const row = await storage.connectorConnGet(connectionId);
  const artifactsJobId = await shareOrLeave(row, err.artifactsJobId);
  await patchRow(storage, connectionId, { ...(state ? { state } : {}), pendingJob: undefined, lastError: lastErrorOf(envelope, artifactsJobId) });
  await tellFailed(storage, connectionId, envelope.code);
  return report;
}

// #640: most syncs run with nobody watching (after a sign-in, after a bank sync, on the keep-alive), so a failure
// goes to the bell. Not a pause the party asked for (the card says until when), and not a session that ended: for a
// party that wants a sign-in for every sync that is how each sync ends, and the card asks for the sign-in
async function tellFailed(storage: StorageBackend, connectionId: string, code: string): Promise<void> {
  if (code === 'rate_limited' || SIGN_IN_CODES.has(code)) return;
  const meta = (await storage.allRows('storeConn')).find((c) => c.id === connectionId && c.deleted === 0);
  if (!meta) return;
  const hub = meta.kind === 'bank' ? 'accounts' : 'connections';
  await appendNotification(storage, 'syncFailed', { name: meta.displayName, code, hub, connectionId }, syncFailedKey(connectionId, code, new Date().toISOString().slice(0, 10)));
}

// a job accepted earlier and never collected is resumed before any new fetch; one the relay forgot (a day) is let go
// prod 2026-10-06: a phone that kept reopening the app started a fresh half-hour Amazon fetch each time, collected none
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
  return collectJob(storage, row, first, bundle, options, { since: pending.since, until: pending.until });
}

async function passOnce(storage: StorageBackend, row: ConnectorConnRow, bundle: string, window: PassWindow, options: SyncOptions): Promise<Landed> {
  const answer = await connectorApi.sync(row.provider, { connectionId: row.id, bundle, ...window });
  if (answer.accepted) return collectJob(storage, row, answer.job, bundle, options, window);
  if (answer.outcome.session?.bundle) await keepBundle(storage, row.id, answer.outcome.session.bundle);
  return { ingested: answer.outcome.ingested, partial: answer.outcome.complete === false, oldest: answer.outcome.oldest, window };
}

async function land(storage: StorageBackend, row: ConnectorConnRow, bundle: string, options: SyncOptions): Promise<Landed> {
  const resumed = await resumePending(storage, row, bundle, options);
  if (resumed) return resumed;
  return passOnce(storage, row, bundle, { since: sinceFor(row) }, options);
}

const lowest = (a: string, b: string): string => (a < b ? a : b);

const withSince = (since: string | undefined, until: string): ConnectorBackfill => (since ? { since, until } : { until });

// #460: a partial regular pass leaves the days below its oldest day as backfill; a pass over older history moves
// the frontier down or ends it; the frontier day is asked again (a cap can cut a day in half, the ingest absorbs the
// overlap); ConnectorScheduleService keeps the same rule
export function nextBackfill(
  current: ConnectorBackfill | undefined,
  window: PassWindow,
  landed: { partial: boolean; oldest?: string },
): ConnectorBackfill | undefined {
  const { oldest } = landed;
  if (!landed.partial || !oldest) return window.until === undefined ? current : undefined;
  // the party widens a since by its settlement lag, so a pass can bring days below it: never ask from above them
  const since = window.since ? lowest(window.since, oldest) : undefined;
  if (window.until !== undefined) return oldest < window.until ? withSince(since, oldest) : undefined;
  if (!current) return withSince(since, oldest);
  // either bound absent means the party's floor, the earliest of all
  return withSince(since && current.since ? lowest(since, current.since) : undefined, current.until > oldest ? current.until : oldest);
}

/** a refusal no older pass can get past: the session is gone, or the party stopped it */
const ENDS_SESSION = new Set([...SIGN_IN_CODES, 'blocked_by_provider']);

interface Older {
  ingested: IngestedCounts[];
  remaining?: ConnectorBackfill;
  asked?: JobView;
}

/** one older pass; null when a refusal or a fault ends the walk for now — a refusal that ends the session is thrown on */
async function olderPass(storage: StorageBackend, row: ConnectorConnRow, bundle: string, backfill: ConnectorBackfill, options: SyncOptions): Promise<Landed | null> {
  try {
    return await passOnce(storage, row, bundle, { since: backfill.since, until: backfill.until }, options);
  } catch (err) {
    if (!(err instanceof ConnectorError)) return null;
    if (ENDS_SESSION.has(err.envelope.code)) throw err;
    // a refusal ended that job: left as pending, the next sync would resume it and report its failure as its own
    await patchRow(storage, row.id, { pendingJob: undefined });
    return null;
  }
}

// #460: fetches the older history a partial pass left while the person is here; a budget refusal or passing fault
// leaves the rest on the row, only a refusal that ends the session is the caller's to speak
async function fetchOlder(storage: StorageBackend, row: ConnectorConnRow, start: ConnectorBackfill | undefined, options: SyncOptions): Promise<Older> {
  const ingested: IngestedCounts[] = [];
  let backfill = start;
  for (let passes = 0; backfill && passes < MAX_OLDER_PASSES; passes++) {
    useSyncActivity.getState().older(row.id, backfill.until);
    const bundle = await readBundle(storage, row.id);
    if (!bundle) break;
    const landed = await olderPass(storage, row, bundle, backfill, options);
    if (!landed) break;
    if ('asked' in landed) return { ingested, remaining: backfill, asked: landed.asked };
    if (landed.ingested) ingested.push(landed.ingested);
    backfill = nextBackfill(backfill, landed.window, landed);
    await patchRow(storage, row.id, { backfill });
  }
  return { ingested, remaining: backfill };
}

const sum = (counts: IngestedCounts[], key: 'receipts' | 'accounts' | 'transactions'): number =>
  counts.reduce((total, c) => total + c[key], 0);

async function run(storage: StorageBackend, repo: Repo, row: ConnectorConnRow, bundle: string, options: SyncOptions): Promise<SyncReport> {
  try {
    const landed = await land(storage, row, bundle, options);
    if ('asked' in landed) {
      await patchRow(storage, row.id, { lastError: undefined });
      return { ...empty(), status: 'asking', jobId: landed.asked.jobId };
    }
    const backfill = nextBackfill(row.backfill, landed.window, landed);
    await patchRow(storage, row.id, { state: 'active', lastSyncAt: new Date().toISOString(), lastError: undefined, backfill });
    const older = await fetchOlder(storage, row, backfill, options);
    if (older.asked) return { ...empty(), status: 'asking', jobId: older.asked.jobId };
    const counts = [...(landed.ingested ? [landed.ingested] : []), ...older.ingested];
    const matched = await landAndMatch(storage, repo, options.engine, row.id);
    return {
      ...empty(),
      status: 'ok',
      added: sum(counts, 'receipts'),
      accounts: sum(counts, 'accounts'),
      transactions: sum(counts, 'transactions'),
      // a partial pass no older pass could follow (it brought nothing dated) still says so
      partial: landed.partial && !backfill,
      olderPending: !!older.remaining,
      ...matched,
    };
  } catch (err) {
    if (err instanceof ConnectorError) return refused(storage, row.id, err);
    throw err;
  }
}

// one sync per connection: a second ask joins it (prod 2026-10-06: the keep-alive, the auto-sync after a bank cycle
// and Sync now each queued their own half-hour Amazon fetch)
const inFlight = new Map<string, Promise<SyncReport>>();

export function syncConnection(storage: StorageBackend, repo: Repo, connectionId: string, options: SyncOptions = {}): Promise<SyncReport> {
  const running = inFlight.get(connectionId);
  if (running) return running;
  const task = syncOnce(storage, repo, connectionId, options).finally(() => inFlight.delete(connectionId));
  inFlight.set(connectionId, task);
  return task;
}

// reported to the activity store from start to end whoever started it, so the rows show it running and what it brought
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
