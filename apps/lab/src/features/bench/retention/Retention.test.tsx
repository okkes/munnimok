import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENTS, CATALOGUE, HAPPY, HOSTED_AGENT, JOBS, PERSISTENT_PROVIDER, RETENTION_RUNS, renderLab, scriptFetch } from '../../../test/harness';
import type { Handler } from '../../../test/harness';
import type { OperatorJob, RetentionRun, RetentionStep } from '../../../types';
import { keptLoginVerdict, noLoginVerdict, retentionTuning, runSummary, runVerdict, wipeVerdict } from './retentionFacts';

const CATALOGUE_WITH_PERSISTENT = { ...CATALOGUE, providers: [...CATALOGUE.providers, PERSISTENT_PROVIDER] };

/** a scripted relay for one run: the report is kept here, step by step, the way the api keeps it */
function scriptRun(run: RetentionRun): { routes: Record<string, Handler>; run: () => RetentionRun } {
  let current: RetentionRun = { ...run, steps: [...run.steps] };
  const routes: Record<string, Handler> = {
    [`GET /lab/bench/retention/runs/${run.id}`]: () => ({ body: current }),
    [`POST /lab/bench/retention/runs/${run.id}/steps`]: (init) => {
      const step = JSON.parse(String(init?.body)) as RetentionStep;
      const steps = current.steps.filter((s) => s.name !== step.name);
      current = { ...current, steps: [...steps, { ...step, at: '2026-10-06T12:00:00Z' }], sessionId: step.sessionId ?? current.sessionId };
      return { body: current };
    },
    [`POST /lab/bench/retention/runs/${run.id}/finish`]: (init) => {
      current = { ...current, state: (JSON.parse(String(init?.body)) as { state: string }).state };
      return { body: current };
    },
  };
  return { routes, run: () => current };
}

describe('Retention bench', () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.location.hash = '';
    vi.stubGlobal('confirm', vi.fn((_message?: string) => true));
    retentionTuning.pollMs = 10;
    retentionTuning.wipePollMs = 10;
    retentionTuning.wipeTimeoutMs = 2_000;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('the history lists runs with their verdicts; the form starts a run on a picked agent and party', async () => {
    const bodies: Record<string, unknown>[] = [];
    scriptFetch({
      ...HAPPY(),
      'GET /lab/providers': () => ({ body: CATALOGUE_WITH_PERSISTENT }),
      'GET /lab/agents': () => ({ body: { agents: [...AGENTS.agents, HOSTED_AGENT] } }),
      'POST /lab/bench/retention/runs': (init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return { status: 201, body: { ...RETENTION_RUNS[0], id: 'lrr_new', state: 'running', steps: [] } };
      },
    });
    renderLab('#/bench/retention?agent=agt_hosted');
    const runs = await screen.findByTestId('retention-runs');
    expect(runs.textContent).toContain('the kitchen laptop');
    expect(screen.getByTestId('retention-state-lrr_1').textContent).toBe('passed');
    expect(screen.getByTestId('retention-run-lrr_1').textContent).toContain('4 passed, 1 skipped');
    expect(screen.getByTestId('retention-state-lrr_2').textContent).toBe('failed');
    expect(screen.getByTestId('retention-run-lrr_2').textContent).toContain('the queue');

    expect((screen.getByTestId('retention-agent') as HTMLSelectElement).value).toBe('agt_hosted');
    expect((screen.getByTestId('retention-start') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('retention-party'), { target: { value: 'asn-persistent' } });
    fireEvent.change(screen.getByTestId('retention-resource'), { target: { value: 'transactions' } });
    fireEvent.change(screen.getByTestId('retention-label'), { target: { value: 'tonight' } });
    fireEvent.click(screen.getByTestId('retention-release'));
    fireEvent.click(screen.getByTestId('retention-start'));
    await waitFor(() => expect(globalThis.location.hash).toBe('#/bench/retention/lrr_new?release=1'));
    expect(bodies[0]).toEqual({ provider: 'asn-persistent', resource: 'transactions', agentId: 'agt_hosted', agentName: HOSTED_AGENT.name, label: 'tonight' });

    cleanup();
    scriptFetch({ ...HAPPY(), 'GET /lab/bench/retention/runs': () => ({ status: 404 }) });
    renderLab('#/bench/retention');
    await screen.findByTestId('lab-absent');
  });

  it('a run drives its steps on a hosted slot: the sign-in, a fetch, the kept login, a second fetch without a sign-in, the release and the wipe', async () => {
    const scripted = scriptRun({ ...RETENTION_RUNS[0], id: 'lrr_new', agentId: 'agt_hosted', agentName: HOSTED_AGENT.name, state: 'running', steps: [], sessionId: null });
    const logins: Record<string, unknown>[] = [];
    let fetches = 0;
    let released = false;
    scriptFetch({
      ...HAPPY(),
      ...scripted.routes,
      'GET /lab/agents': () => ({ body: { agents: [...AGENTS.agents, released ? { ...HOSTED_AGENT, bound: false, resetting: false, profiles: [] } : HOSTED_AGENT] } }),
      'POST /lab/bench/asn-persistent/login': (init) => {
        logins.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return { body: { sessionId: 'ses_ret', state: 'active', providerAccount: { displayName: 'O. Doker' } } };
      },
      'POST /lab/bench/sessions/ses_ret/fetch': () => {
        fetches += 1;
        return fetches === 1 ? { body: { accepted: false, resource: 'transactions', data: [{ id: 1 }, { id: 2 }], complete: true } } : { status: 202, body: { accepted: true, jobId: 'job_r2', state: 'queued' } };
      },
      'GET /lab/bench/asn-persistent/jobs/job_r2': () => ({ body: { jobId: 'job_r2', sessionId: 'ses_ret', state: 'succeeded', data: [{ id: 1 }], complete: true } }),
      'GET /lab/jobs': () => ({ body: { jobs: [{ ...JOBS.jobs[2], jobId: 'job_r2', state: 'succeeded', progress: { step: 'finalizing', stepsDone: ['queued', 'agent_assigned', 'opening_provider', 'downloading'] } }], truncated: false } }),
      'POST /lab/private-agents/agt_hosted/release': () => {
        released = true;
        return { status: 204 };
      },
    });
    renderLab('#/bench/retention/lrr_new?release=1');
    await screen.findByTestId('retention-run-title');
    await waitFor(() => expect(screen.getByTestId('retention-run-title').textContent).toContain('ASN (persistent) · transactions'));
    expect(screen.getByTestId('retention-run-state').textContent).toBe('running');
    expect(screen.getByTestId('retention-run-facts').textContent).toContain('keeps a browser on the agent');

    // step 1: the embedded connect flow, pinned to the agent, recording forced
    await screen.findByTestId('retention-sign-in');
    expect(screen.getByTestId('bench-run-on-fixed').textContent).toBe(HOSTED_AGENT.name);
    expect(screen.queryByTestId('bench-run-on')).toBeNull();
    expect(screen.queryByTestId('bench-record')).toBeNull();
    fireEvent.change(await screen.findByTestId('bench-input-username'), { target: { value: 'okkes' } });
    fireEvent.click(screen.getByTestId('bench-start'));
    await waitFor(() => expect(logins).toHaveLength(1));
    expect(logins[0]).toEqual({ inputs: { username: 'okkes' }, config: {}, preferAgent: 'agt_hosted', record: true });

    // the rest drives itself, down to the wipe
    await waitFor(() => expect(screen.getByTestId('retention-run-state').textContent).toBe('passed'), { timeout: 8_000 });
    const states = ['sign-in', 'fetch', 'kept-login', 'fetch-again', 'release'].map((name) => screen.getByTestId(`retention-step-state-${name}`).textContent);
    expect(states).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
    expect(screen.getByTestId('retention-step-sign-in').textContent).toContain('signed in as O. Doker');
    expect(screen.getByTestId('retention-step-fetch').textContent).toContain('2 record(s) in one round trip');
    expect(screen.getByTestId('retention-step-kept-login').textContent).toContain('prof_h kept');
    expect(screen.getByTestId('retention-step-fetch-again').textContent).toContain('through job job_r2');
    expect(screen.getByTestId('retention-step-fetch-again').textContent).toContain('steps: queued, agent_assigned, opening_provider, downloading');
    expect(screen.getByTestId('retention-step-release').textContent).toContain('the slot is free and keeps nothing');
    expect(screen.queryByTestId('retention-sign-in')).toBeNull();
    expect(scripted.run().state).toBe('passed');
    expect(fetches).toBe(2);
  }, 15_000);

  it('a second fetch that signed in again fails the run; a sign-in that failed ends it at once; abort and delete work', async () => {
    // pinned to a fleet agent that keeps nothing: the kept-login step fails, and the second fetch signed in again
    const scripted = scriptRun({ ...RETENTION_RUNS[0], id: 'lrr_fail', agentId: 'agt_fleet1', agentName: 'fleet 1', state: 'running', steps: [], sessionId: null });
    scriptFetch({
      ...HAPPY(),
      ...scripted.routes,
      'POST /lab/bench/asn-persistent/login': () => ({ body: { sessionId: 'ses_f', state: 'active' } }),
      'POST /lab/bench/sessions/ses_f/fetch': () => ({ body: { accepted: false, resource: 'transactions', data: [], complete: true } }),
      'GET /lab/jobs': () => ({ body: { jobs: [{ ...JOBS.jobs[2], jobId: 'job_f2', state: 'succeeded', progress: { step: 'finalizing', stepsDone: ['queued', 'authenticating', 'downloading'] } }], truncated: false } }),
    });
    renderLab('#/bench/retention/lrr_fail');
    fireEvent.change(await screen.findByTestId('bench-input-username'), { target: { value: 'okkes' } });
    fireEvent.click(screen.getByTestId('bench-start'));
    await waitFor(() => expect(screen.getByTestId('retention-run-state').textContent).toBe('failed'), { timeout: 8_000 });
    expect(screen.getByTestId('retention-step-state-kept-login').textContent).toBe('fail');
    expect(screen.getByTestId('retention-step-kept-login').textContent).toContain('no login for asn-persistent');
    expect(screen.getByTestId('retention-step-state-fetch-again').textContent).toBe('fail');
    expect(screen.getByTestId('retention-step-fetch-again').textContent).toContain('signed in again (authenticating)');
    expect(screen.getByTestId('retention-step-state-release').textContent).toBe('skip');
    cleanup();

    const refused = scriptRun({ ...RETENTION_RUNS[0], id: 'lrr_refused', state: 'running', steps: [], sessionId: null });
    scriptFetch({
      ...HAPPY(),
      ...refused.routes,
      'POST /lab/bench/asn-persistent/login': () => ({ body: { sessionId: 'ses_x', state: 'failed', error: { code: 'invalid_credentials', userAction: 'reconnect', retriable: false, messageKey: 'x' } } }),
    });
    renderLab('#/bench/retention/lrr_refused');
    fireEvent.change(await screen.findByTestId('bench-input-username'), { target: { value: 'okkes' } });
    fireEvent.click(screen.getByTestId('bench-start'));
    await waitFor(() => expect(screen.getByTestId('retention-run-state').textContent).toBe('failed'), { timeout: 8_000 });
    expect(screen.getByTestId('retention-step-sign-in').textContent).toContain('invalid_credentials (reconnect)');
    cleanup();

    const fresh = scriptRun({ ...RETENTION_RUNS[0], id: 'lrr_abort', state: 'running', steps: [], sessionId: null });
    const calls = scriptFetch({ ...HAPPY(), ...fresh.routes, 'DELETE /lab/bench/retention/runs/lrr_abort': () => ({ status: 204 }) });
    renderLab('#/bench/retention/lrr_abort');
    fireEvent.click(await screen.findByTestId('retention-abort'));
    await waitFor(() => expect(calls).toContain('POST /lab/bench/retention/runs/lrr_abort/finish'));
    await waitFor(() => expect(screen.getByTestId('retention-run-state').textContent).toBe('aborted'));
    fireEvent.click(screen.getByTestId('retention-delete'));
    await waitFor(() => expect(globalThis.location.hash).toBe('#/bench/retention'));
    cleanup();

    scriptFetch({ ...HAPPY(), 'GET /lab/bench/retention/runs/lrr_none': () => ({ status: 404 }) });
    renderLab('#/bench/retention/lrr_none');
    expect((await screen.findByTestId('retention-run-missing')).textContent).toContain('No run named');
  }, 20_000);

  it('a finished run is its report', async () => {
    scriptFetch(HAPPY());
    renderLab('#/bench/retention/lrr_1');
    expect((await screen.findByTestId('retention-run-state')).textContent).toBe('passed');
    expect(screen.getByTestId('retention-step-sign-in').textContent).toContain('job job_lab1');
    expect(screen.queryByTestId('retention-sign-in')).toBeNull();
    expect(screen.queryByTestId('retention-abort')).toBeNull();
  });

  it('the verdicts', () => {
    const agent = HOSTED_AGENT;
    expect(keptLoginVerdict(agent, 'asn-persistent', true).state).toBe('pass');
    expect(keptLoginVerdict(agent, 'asn-persistent', false)).toEqual({ state: 'skip', detail: 'the party keeps its session in the bundle the relay holds, not on the agent' });
    expect(keptLoginVerdict(undefined, 'asn-persistent', true).state).toBe('fail');
    expect(keptLoginVerdict({ ...agent, profiles: [{ id: 'p', provider: 'asn-persistent', healthy: false }] }, 'asn-persistent', true).detail).toBe('p is kept but unhealthy');
    expect(keptLoginVerdict({ ...agent, profiles: [] }, 'asn-persistent', true).detail).toContain('no login for asn-persistent');

    expect(noLoginVerdict(null).state).toBe('fail');
    const failed = JOBS.jobs[0] as unknown as OperatorJob;
    const succeeded = JOBS.jobs[2] as unknown as OperatorJob;
    expect(noLoginVerdict(failed).detail).toContain('the run ended failed (provider_changed)');
    expect(noLoginVerdict({ ...succeeded, progress: { step: 'finalizing', stepsDone: ['queued', 'awaiting_human'] } }).detail).toBe('the run signed in again (awaiting_human)');
    expect(noLoginVerdict({ ...succeeded, progress: null }).detail).toBe('steps: none recorded');

    expect(wipeVerdict(undefined).state).toBe('fail');
    expect(wipeVerdict({ ...agent, resetting: true }).state).toBe('running');
    expect(wipeVerdict({ ...agent, resetting: false, bound: false }).detail).toBe('1 login(s) still kept');
    expect(wipeVerdict({ ...agent, resetting: false, bound: false, profiles: [] }).state).toBe('pass');

    expect(runVerdict([{ name: 'a', state: 'pass', at: '' }, { name: 'b', state: 'skip', at: '' }])).toBe('passed');
    expect(runVerdict([{ name: 'a', state: 'fail', at: '' }])).toBe('failed');
    expect(runSummary({ steps: [] })).toBe('no steps yet');
    expect(runSummary({ steps: [{ name: 'a', state: 'running', at: '' }] })).toBe('1 running');
  });
});
