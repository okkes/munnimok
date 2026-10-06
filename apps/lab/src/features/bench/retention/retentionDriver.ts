import type { Call } from '../../../app/api';
import type { AgentView, ProviderEntry, RetentionRun, RetentionStepState } from '../../../types';
import { fetchOnce, isPersistent, keptLoginVerdict, latestFetchJob, noLoginVerdict, readAgent, retentionTuning, wipeVerdict } from './retentionFacts';

export type Phase = 'sign-in' | 'fetch' | 'kept-login' | 'fetch-again' | 'release' | 'done';

export interface StepWrite {
  name: string;
  state: RetentionStepState;
  detail?: string;
  jobId?: string | null;
  sessionId?: string | null;
}

/** what a phase needs: the run, the session the sign-in made, the party and the agent, and the pen */
export interface DriverContext {
  call: Call;
  run: RetentionRun;
  sessionId: string;
  party: ProviderEntry | null;
  agent: AgentView | undefined;
  wantsRelease: boolean;
  write: (step: StepWrite) => Promise<void>;
  finish: (state: 'passed' | 'failed' | 'aborted') => Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** step 2: one recorded fetch; a refusal ends the run */
export async function runFetch(ctx: DriverContext): Promise<Phase> {
  await ctx.write({ name: 'fetch', state: 'running' });
  const first = await fetchOnce(ctx.call, ctx.run.provider, ctx.sessionId, ctx.run.resource);
  await ctx.write({ name: 'fetch', state: first.ok ? 'pass' : 'fail', detail: first.detail, jobId: first.jobId });
  if (first.ok) return 'kept-login';
  await ctx.finish('failed');
  return 'done';
}

/** step 3: what the agent keeps now, read off the fleet */
export async function runKeptLogin(ctx: DriverContext): Promise<Phase> {
  if (!ctx.run.agentId) {
    await ctx.write({ name: 'kept-login', state: 'skip', detail: 'no agent was pinned; the queue chose' });
    return 'fetch-again';
  }
  const now = await readAgent(ctx.call, ctx.run.agentId);
  await ctx.write({ name: 'kept-login', ...keptLoginVerdict(now, ctx.run.provider, isPersistent(ctx.party)) });
  return 'fetch-again';
}

/** step 4: a second fetch, judged by the steps the run went through */
export async function runFetchAgain(ctx: DriverContext): Promise<Phase> {
  await ctx.write({ name: 'fetch-again', state: 'running' });
  const second = await fetchOnce(ctx.call, ctx.run.provider, ctx.sessionId, ctx.run.resource);
  if (!second.ok) {
    await ctx.write({ name: 'fetch-again', state: 'fail', detail: second.detail, jobId: second.jobId });
    return 'release';
  }
  const job = await latestFetchJob(ctx.call, ctx.sessionId);
  const verdict = noLoginVerdict(job);
  await ctx.write({ name: 'fetch-again', state: verdict.state, detail: `${second.detail}; ${verdict.detail}`, jobId: job?.jobId ?? second.jobId });
  return 'release';
}

/** step 5: the hosted slot released and the wipe watched, when asked for */
export async function runRelease(ctx: DriverContext): Promise<Phase> {
  if (!ctx.wantsRelease || !ctx.run.agentId || !ctx.agent?.hosted) {
    await ctx.write({ name: 'release', state: 'skip', detail: ctx.agent?.hosted ? 'not asked for' : 'not a hosted slot' });
    return 'done';
  }
  await ctx.write({ name: 'release', state: 'running', detail: 'the slot is released; waiting for the wipe' });
  const released = await ctx.call(`/lab/private-agents/${encodeURIComponent(ctx.run.agentId)}/release`, { method: 'POST' }).catch(() => null);
  if (!released?.ok) {
    await ctx.write({ name: 'release', state: 'fail', detail: `the release was refused (HTTP ${released?.status ?? 'network'})` });
    return 'done';
  }
  const deadline = Date.now() + retentionTuning.wipeTimeoutMs;
  let verdict = wipeVerdict(await readAgent(ctx.call, ctx.run.agentId));
  while (verdict.state === 'running' && Date.now() < deadline) {
    await sleep(retentionTuning.wipePollMs);
    verdict = wipeVerdict(await readAgent(ctx.call, ctx.run.agentId));
  }
  const timedOut = verdict.state === 'running';
  await ctx.write({ name: 'release', state: timedOut ? 'fail' : verdict.state, detail: timedOut ? `the wipe did not finish in time: ${verdict.detail}` : verdict.detail });
  return 'done';
}

/** the phases after the sign-in, each handing over to the next */
export const DRIVERS: Record<'fetch' | 'kept-login' | 'fetch-again' | 'release', (ctx: DriverContext) => Promise<Phase>> = {
  fetch: runFetch,
  'kept-login': runKeptLogin,
  'fetch-again': runFetchAgain,
  release: runRelease,
};

export const isDriven = (phase: Phase): phase is keyof typeof DRIVERS => phase in DRIVERS;
