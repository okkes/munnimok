import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { ConnectorBackfill, ConnectorConnRow, ConnectorLastError, ConnectorSessionState } from '@/db/types';
import type { SyncEngine } from '@/sync/engine';
import { includedSpaces, reevaluateSpace, rematchSpaces } from '@/application/receiptMatching';
import { ConnectorError, connectorApi } from './api';
import { dropBundle, keepBundle, readBundle } from './bundles';
import { subscribeConnectorFrames } from './events';
import { useSyncActivity } from './syncActivity';
import type { ErrorEnvelope, IngestedCounts, JobView } from './types';

/**
 * One sync pass for one connection (docs/connectors/client.md, "Sync"):
 * the bundle goes to the relay, the relay resumes the session,
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
/**
 * #460: passes over older history one sync makes at most. They run while the
 * person is here (attended: the party's unattended budget never sees them),
 * and the cap keeps one sync from spending the relay's hourly budget on
 * history alone — the rest follows on the next sync.
 */
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

/**
 * #441 L1: the picture a failed run left waits on the person's word — or
 * goes at once where they said "always" (user 2026-10-07: the standing
 * answer means never asked, wherever the failure lands). What comes back
 * is the question still open: the job id, or nothing once shared.
 */
async function shareOrLeave(row: ConnectorConnRow | undefined, artifactsJobId: string | undefined): Promise<string | undefined> {
  if (!artifactsJobId || !row?.reportFailures) return artifactsJobId;
  await connectorApi.shareArtifacts(row.provider, artifactsJobId).catch(() => undefined);
  return undefined;
}

/** what a failed sign-in left on the device row: its question shared by the standing answer, left open for the hub's card, or nothing to ask */
export type FailureNoted = 'shared' | 'asked' | 'none';

/**
 * A sign-in that failed in the sheet writes its word on the device row
 * too (user 2026-10-07: "the tab closes and I cannot report it any more"):
 * the question a picture waits on then survives the sheet, under the
 * hub's card — and a standing "always report" shares it right here. A
 * connection that has no row yet (its first sign-in) keeps the question
 * in the sheet alone.
 */
export async function noteSignInFailure(storage: StorageBackend, connectionId: string, envelope: ErrorEnvelope, artifactsJobId?: string): Promise<FailureNoted> {
  const row = await storage.connectorConnGet(connectionId);
  if (!row) return 'none';
  const open = await shareOrLeave(row, artifactsJobId);
  await storage.connectorConnPut({ ...row, lastError: lastErrorOf(envelope, open) });
  if (open) return 'asked';
  return artifactsJobId ? 'shared' : 'none';
}

/** the question is answered (or lapsed): the job id leaves the row so no card asks it again */
export async function settleQuestion(storage: StorageBackend, connectionId: string, jobId: string): Promise<void> {
  const row = await storage.connectorConnGet(connectionId);
  if (row?.lastError?.artifactsJobId !== jobId) return;
  const { artifactsJobId: _answered, ...rest } = row.lastError;
  await storage.connectorConnPut({ ...row, lastError: rest });
}

const empty = (): SyncReport => ({ status: 'error', added: 0, accounts: 0, transactions: 0, linked: 0, proposed: 0 });

/** pull the rows the relay filed, then match them into every included space */
async function landAndMatch(storage: StorageBackend, repo: Repo, engine: SyncEngine | null | undefined, connectionId: string): Promise<Pick<SyncReport, 'linked' | 'proposed'>> {
  await engine?.syncAll().catch(() => undefined);
  // a shop's receipts flow into the spaces that include it; a bank's (or a registry's) rows reach a space through
  // its accounts instead, so every space with a shop re-reads its transactions against the shop's receipts — the
  // proposals stand before the review opens (user 2026-10-09)
  const meta = (await storage.allRows('storeConn')).find((c) => c.id === connectionId && c.deleted === 0);
  if (meta?.kind === 'bank' || meta?.kind === 'registry') return rematchSpaces(storage, repo);
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

/** the window a pass asks for: since (absent: the party's floor), and until on a pass over older history (#460) */
interface PassWindow {
  since?: string;
  until?: string;
}

type Landed = { ingested: IngestedCounts | undefined; partial: boolean; oldest?: string; window: PassWindow } | { asked: JobView };

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
  window: PassWindow,
): Promise<Landed> {
  let job = first;
  let current = bundle;
  for (;;) {
    // remembered on the row: a device that closes on it resumes it on the
    // next sync instead of asking the party all over again (prod 2026-10-06)
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
  return collectJob(storage, row, first, bundle, options, { since: pending.since, until: pending.until });
}

/** one relay sync over a window: the counts it ingested, or the question it stopped at */
async function passOnce(storage: StorageBackend, row: ConnectorConnRow, bundle: string, window: PassWindow, options: SyncOptions): Promise<Landed> {
  const answer = await connectorApi.sync(row.provider, { connectionId: row.id, bundle, ...window });
  if (answer.accepted) return collectJob(storage, row, answer.job, bundle, options, window);
  if (answer.outcome.session?.bundle) await keepBundle(storage, row.id, answer.outcome.session.bundle);
  return { ingested: answer.outcome.ingested, partial: answer.outcome.complete === false, oldest: answer.outcome.oldest, window };
}

/** the relay's answer, landed: the counts it ingested, or the question it stopped at */
async function land(storage: StorageBackend, row: ConnectorConnRow, bundle: string, options: SyncOptions): Promise<Landed> {
  const resumed = await resumePending(storage, row, bundle, options);
  if (resumed) return resumed;
  return passOnce(storage, row, bundle, { since: sinceFor(row) }, options);
}

const lowest = (a: string, b: string): string => (a < b ? a : b);

const withSince = (since: string | undefined, until: string): ConnectorBackfill => (since ? { since, until } : { until });

/**
 * #460 — what a finished pass says about older history. A regular pass that
 * came back partial leaves the days below the oldest one it brought, down to
 * its own since (joined with a backfill already pending); a whole one leaves
 * a pending backfill as it was. A pass over older history moves the frontier
 * down to the oldest day it brought, or ends the backfill when it came back
 * whole, brought nothing dated, or reached no further. The frontier day is
 * asked again: a pass's cap can cut a day in half, and the ingest absorbs the
 * overlap. The relay's scheduler keeps the same rule (ConnectorScheduleService).
 */
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
  /** what is still to fetch once the passes stopped */
  remaining?: ConnectorBackfill;
  /** a pass stopped for a question nobody answered */
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

/**
 * #460 — the older history a partial pass left, fetched right away while the
 * person is here: pass after pass, each one relay sync with `until`, until a
 * pass comes back whole or brings nothing older. The hub line follows how
 * far back it reached. A refusal of the party's budget or a passing fault
 * leaves the rest on the row for the next sync; only a refusal that ends the
 * session is the caller's to speak.
 */
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

/** the pass itself: the relay's answer landed and matched, or its refusal spoken */
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
