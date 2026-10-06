import { getJson, reasonOf } from '../../../app/api';
import type { Call } from '../../../app/api';
import type { AgentView, FetchView, JobList, JobView, OperatorJob, ProviderEntry, RetentionRun, RetentionStep, RetentionStepState } from '../../../types';
import { TERMINAL } from '../benchFacts';

/** the scenario's steps, in the order the bench takes them */
export const STEPS = [
  { name: 'sign-in', label: 'Sign in on the agent, recorded' },
  { name: 'fetch', label: 'Fetch once' },
  { name: 'kept-login', label: 'The agent kept the login' },
  { name: 'fetch-again', label: 'Fetch again without a sign-in' },
  { name: 'release', label: 'Release the slot and watch the wipe' },
] as const;

export type StepName = (typeof STEPS)[number]['name'];

export const stepLabel = (name: string): string => STEPS.find((s) => s.name === name)?.label ?? name;

const STEP_CHIP: Record<string, string> = { pass: 'ok-chip', fail: 'danger-chip', running: 'warn-chip', skip: '' };
export const stepChip = (state: string): string => STEP_CHIP[state] ?? '';

const RUN_CHIP: Record<string, string> = { passed: 'ok-chip', failed: 'danger-chip', running: 'warn-chip', aborted: '' };
export const runChip = (state: string): string => RUN_CHIP[state] ?? '';

/** the knobs the tests turn down: how often a job or a wipe is read, how long a wipe may take */
export const retentionTuning = { pollMs: 2_000, wipePollMs: 3_000, wipeTimeoutMs: 90_000 };

export interface Verdict {
  state: RetentionStepState;
  detail: string;
}

/** a party whose login lives in a browser profile on the agent (T4), rather than in the bundle the relay holds */
export const isPersistent = (party: ProviderEntry | null | undefined): boolean => party?.runtime === 'browser_persistent';

/** whether the agent holds a healthy login for the party */
export function keptLoginVerdict(agent: AgentView | undefined, provider: string, persistent: boolean): Verdict {
  if (!persistent) return { state: 'skip', detail: 'the party keeps its session in the bundle the relay holds, not on the agent' };
  if (!agent) return { state: 'fail', detail: 'the agent is not listed any more' };
  const kept = agent.profiles.find((p) => p.provider === provider);
  if (!kept) return { state: 'fail', detail: `no login for ${provider} among the ${agent.profiles.length} the agent keeps` };
  if (!kept.healthy) return { state: 'fail', detail: `${kept.id} is kept but unhealthy` };
  return { state: 'pass', detail: `${kept.id} kept, last ok ${kept.lastOkAt ?? 'never'}` };
}

/** the steps a run that had to sign in again goes through */
export const LOGIN_STEPS = new Set(['authenticating', 'awaiting_human']);

/** whether the second fetch reused what was kept, read off the run's steps */
export function noLoginVerdict(job: OperatorJob | null): Verdict {
  if (!job) return { state: 'fail', detail: 'the second fetch left no run in the history' };
  if (job.state !== 'succeeded') {
    const code = job.error ? ` (${job.error.code})` : '';
    return { state: 'fail', detail: `the run ended ${job.state}${code}` };
  }
  const done = job.progress?.stepsDone ?? [];
  const signedIn = done.filter((s) => LOGIN_STEPS.has(s));
  if (signedIn.length > 0) return { state: 'fail', detail: `the run signed in again (${signedIn.join(', ')})` };
  return { state: 'pass', detail: `steps: ${done.join(', ') || 'none recorded'}` };
}

/** whether a released slot has wiped what it kept */
export function wipeVerdict(agent: AgentView | undefined): Verdict {
  if (!agent) return { state: 'fail', detail: 'the agent is not listed any more' };
  if (agent.resetting) return { state: 'running', detail: 'the wipe is asked for; the agent confirms it on its next heartbeat' };
  if (agent.bound) return { state: 'running', detail: 'the slot is still bound' };
  if (agent.profiles.length > 0) return { state: 'running', detail: `${agent.profiles.length} login(s) still kept` };
  return { state: 'pass', detail: 'the slot is free and keeps nothing' };
}

/** how the run ended, from its steps */
export const runVerdict = (steps: readonly RetentionStep[]): 'passed' | 'failed' => (steps.some((s) => s.state === 'fail') ? 'failed' : 'passed');

/** the steps in a few words: passed, failed, skipped */
export function runSummary(run: Pick<RetentionRun, 'steps'>): string {
  const count = (state: RetentionStepState) => run.steps.filter((s) => s.state === state).length;
  const parts = [
    count('pass') ? `${count('pass')} passed` : null,
    count('fail') ? `${count('fail')} failed` : null,
    count('skip') ? `${count('skip')} skipped` : null,
    count('running') ? `${count('running')} running` : null,
  ].filter(Boolean);
  return parts.length === 0 ? 'no steps yet' : parts.join(', ');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface FetchOutcome {
  ok: boolean;
  jobId?: string | null;
  records?: number;
  detail: string;
}

/** one recorded fetch through the bench, followed as a job when the run outruns the window */
export async function fetchOnce(call: Call, provider: string, sessionId: string, resource: string): Promise<FetchOutcome> {
  const res = await call(`/lab/bench/sessions/${encodeURIComponent(sessionId)}/fetch`, { method: 'POST', body: JSON.stringify({ resource, record: true }) }).catch(() => null);
  if (!res?.ok) return { ok: false, detail: await reasonOf(res) };
  const view = (await res.json()) as FetchView;
  if (!view.accepted || !view.jobId) return { ok: true, records: view.data?.length ?? 0, detail: `${view.data?.length ?? 0} record(s) in one round trip` };

  for (;;) {
    const job = await getJson<JobView>(call, `/lab/bench/${encodeURIComponent(provider)}/jobs/${encodeURIComponent(view.jobId)}`);
    if (!job || job === 'unreachable') return { ok: false, jobId: view.jobId, detail: 'the job could not be read' };
    if (job.state === 'succeeded') return { ok: true, jobId: view.jobId, records: job.data?.length ?? 0, detail: `${job.data?.length ?? 0} record(s) through job ${view.jobId}` };
    if (job.state === 'awaiting_input') return { ok: false, jobId: view.jobId, detail: `the run asked a question (${job.challenge?.type ?? 'unknown'}); the bench cannot answer it mid-scenario` };
    if (TERMINAL.has(job.state)) return { ok: false, jobId: view.jobId, detail: job.error ? `${job.error.code} (${job.error.userAction})` : job.state };
    await sleep(retentionTuning.pollMs);
  }
}

/** the newest fetch the history holds for the session */
export async function latestFetchJob(call: Call, sessionId: string): Promise<OperatorJob | null> {
  const list = await getJson<JobList>(call, `/lab/jobs?session=${encodeURIComponent(sessionId)}&kind=fetch&limit=1`);
  return list && list !== 'unreachable' ? (list.jobs[0] ?? null) : null;
}

/** the agent as the fleet lists it now */
export async function readAgent(call: Call, agentId: string): Promise<AgentView | undefined> {
  const list = await getJson<{ agents: AgentView[] }>(call, '/lab/agents');
  return list && list !== 'unreachable' ? list.agents.find((a) => a.id === agentId) : undefined;
}
