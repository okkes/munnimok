import type { Call } from '../../../app/api';
import type { AgentView, ProviderEntry, RetentionRun, RetentionStepState } from '../../../types';
import { fetchOnce, isPersistent, keptLoginVerdict, latestFetchJob, noLoginVerdict, readAgent, retentionTuning, wipeVerdict } from './retentionFacts';

export type Phase = 'sign-in' | 'fetch' | 'kept-login' | 'fetch-again' | 'release' | 'done';

/** the phases the lab drives itself, once the sign-in is in */
export type DrivenPhase = 'fetch' | 'kept-login' | 'fetch-again' | 'release';

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

/** step 2: one recorded fetch; whether the run goes on - a refusal ends it */
async function fetchStep(ctx: DriverContext): Promise<boolean> {
  await ctx.write({ name: 'fetch', state: 'running' });
  const first = await fetchOnce(ctx.call, ctx.run.provider, ctx.sessionId, ctx.run.resource);
  await ctx.write({ name: 'fetch', state: first.ok ? 'pass' : 'fail', detail: first.detail, jobId: first.jobId });
  if (!first.ok) await ctx.finish('failed');
  return first.ok;
}

/** step 3: what the agent keeps now, read off the fleet */
async function keptLoginStep(ctx: DriverContext): Promise<void> {
  if (!ctx.run.agentId) {
    await ctx.write({ name: 'kept-login', state: 'skip', detail: 'no agent was pinned; the queue chose' });
    return;
  }
  const now = await readAgent(ctx.call, ctx.run.agentId);
  await ctx.write({ name: 'kept-login', ...keptLoginVerdict(now, ctx.run.provider, isPersistent(ctx.party)) });
}

/** step 4: a second fetch, judged by the steps the run went through */
async function fetchAgainStep(ctx: DriverContext): Promise<void> {
  await ctx.write({ name: 'fetch-again', state: 'running' });
  const second = await fetchOnce(ctx.call, ctx.run.provider, ctx.sessionId, ctx.run.resource);
  if (!second.ok) {
    await ctx.write({ name: 'fetch-again', state: 'fail', detail: second.detail, jobId: second.jobId });
    return;
  }
  const job = await latestFetchJob(ctx.call, ctx.sessionId);
  const verdict = noLoginVerdict(job);
  await ctx.write({ name: 'fetch-again', state: verdict.state, detail: `${second.detail}; ${verdict.detail}`, jobId: job?.jobId ?? second.jobId });
}

/** step 5: the hosted slot released and the wipe watched, when asked for */
async function releaseStep(ctx: DriverContext): Promise<void> {
  if (!ctx.wantsRelease || !ctx.run.agentId || !ctx.agent?.hosted) {
    await ctx.write({ name: 'release', state: 'skip', detail: ctx.agent?.hosted ? 'not asked for' : 'not a hosted slot' });
    return;
  }
  await ctx.write({ name: 'release', state: 'running', detail: 'the slot is released; waiting for the wipe' });
  const released = await ctx.call(`/lab/private-agents/${encodeURIComponent(ctx.run.agentId)}/release`, { method: 'POST' }).catch(() => null);
  if (!released?.ok) {
    await ctx.write({ name: 'release', state: 'fail', detail: `the release was refused (HTTP ${released?.status ?? 'network'})` });
    return;
  }
  const deadline = Date.now() + retentionTuning.wipeTimeoutMs;
  let verdict = wipeVerdict(await readAgent(ctx.call, ctx.run.agentId));
  while (verdict.state === 'running' && Date.now() < deadline) {
    await sleep(retentionTuning.wipePollMs);
    verdict = wipeVerdict(await readAgent(ctx.call, ctx.run.agentId));
  }
  const timedOut = verdict.state === 'running';
  await ctx.write({ name: 'release', state: timedOut ? 'fail' : verdict.state, detail: timedOut ? `the wipe did not finish in time: ${verdict.detail}` : verdict.detail });
}

/** the phases after the sign-in: the step taken, then the phase that follows it */
export async function drive(phase: DrivenPhase, ctx: DriverContext): Promise<Phase> {
  switch (phase) {
    case 'fetch':
      return (await fetchStep(ctx)) ? 'kept-login' : 'done';
    case 'kept-login':
      await keptLoginStep(ctx);
      return 'fetch-again';
    case 'fetch-again':
      await fetchAgainStep(ctx);
      return 'release';
    default:
      await releaseStep(ctx);
      return 'done';
  }
}

const DRIVEN: ReadonlySet<Phase> = new Set<Phase>(['fetch', 'kept-login', 'fetch-again', 'release']);

export const isDriven = (phase: Phase): phase is DrivenPhase => DRIVEN.has(phase);
