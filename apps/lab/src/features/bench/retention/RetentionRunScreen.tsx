import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson } from '../../../app/api';
import type { Call } from '../../../app/api';
import type { ScreenProps } from '../../../app/LabApp';
import { hrefOf, navigate, useRouteQuery } from '../../../app/router';
import { when } from '../../../lib/format';
import type { AgentView, ProviderEntry, RetentionRun, RetentionStep, RetentionStepState, SessionView } from '../../../types';
import { ConnectScreen } from '../ConnectScreen';
import { fetchOnce, isPersistent, keptLoginVerdict, latestFetchJob, noLoginVerdict, readAgent, retentionTuning, runChip, runVerdict, STEPS, stepChip, wipeVerdict } from './retentionFacts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Phase = 'sign-in' | 'fetch' | 'kept-login' | 'fetch-again' | 'release' | 'done';

interface StepWrite {
  name: string;
  state: RetentionStepState;
  detail?: string;
  jobId?: string | null;
  sessionId?: string | null;
}

/** the run's report and the pen that writes it */
function useRun(call: Call, id: string) {
  const [run, setRun] = useState<RetentionRun | null | 'unreachable' | 'loading'>('loading');
  useEffect(() => {
    void (async () => setRun(await getJson<RetentionRun>(call, `/lab/bench/retention/runs/${encodeURIComponent(id)}`)))();
  }, [call, id]);

  const write = useCallback(
    async (step: StepWrite) => {
      const res = await call(`/lab/bench/retention/runs/${encodeURIComponent(id)}/steps`, { method: 'POST', body: JSON.stringify(step) }).catch(() => null);
      if (res?.ok) setRun((await res.json()) as RetentionRun);
    },
    [call, id],
  );

  const finish = useCallback(
    async (state: 'passed' | 'failed' | 'aborted') => {
      const res = await call(`/lab/bench/retention/runs/${encodeURIComponent(id)}/finish`, { method: 'POST', body: JSON.stringify({ state }) }).catch(() => null);
      if (res?.ok) setRun((await res.json()) as RetentionRun);
    },
    [call, id],
  );

  return { run, write, finish };
}

/** the party's manifest and the agent's listing, read once */
function useContext(call: Call, run: RetentionRun | null) {
  const [party, setParty] = useState<ProviderEntry | null>(null);
  const [agent, setAgent] = useState<AgentView | undefined>(undefined);
  const provider = run?.provider ?? null;
  const agentId = run?.agentId ?? null;
  useEffect(() => {
    if (!provider) return;
    void (async () => {
      const p = await getJson<ProviderEntry>(call, `/lab/providers/${encodeURIComponent(provider)}`);
      setParty(p && p !== 'unreachable' ? p : null);
      if (agentId) setAgent(await readAgent(call, agentId));
    })();
  }, [call, provider, agentId]);
  return { party, agent };
}

/** the steps as the report shows them: every step of the scenario, taken or not yet */
function StepList({ run }: Readonly<{ run: RetentionRun }>) {
  const byName = new Map(run.steps.map((s) => [s.name, s]));
  return (
    <ol data-testid="retention-steps" style={{ paddingLeft: 20 }}>
      {STEPS.map((s) => {
        const taken: RetentionStep | undefined = byName.get(s.name);
        return (
          <li key={s.name} data-testid={`retention-step-${s.name}`} style={{ marginBottom: 8 }}>
            <span className={`chip ${taken ? stepChip(taken.state) : ''}`} data-testid={`retention-step-state-${s.name}`}>
              {taken?.state ?? 'not yet'}
            </span>{' '}
            {s.label}
            {taken?.detail && <div className="sub">{taken.detail}</div>}
            {taken?.jobId && (
              <div className="sub">
                <a href={hrefOf(`jobs/${encodeURIComponent(taken.jobId)}`)}>job {taken.jobId}</a> · <a href={hrefOf(`jobs/${encodeURIComponent(taken.jobId)}/trace`)}>recording</a>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One retention run (#441 L4), driven here while it runs: the sign-in on
 * the pinned agent through the bench's own connect flow, then the fetch,
 * the inventory, the second fetch and the optional release, each verdict
 * written to the relay as it lands. A finished run is its report.
 */
export function RetentionRunScreen({ id, call, busy, act }: Readonly<{ id: string } & ScreenProps>) {
  const query = useRouteQuery();
  const wantsRelease = query.get('release') === '1';
  const { run, write, finish } = useRun(call, id);
  const live = run && run !== 'unreachable' && run !== 'loading' ? run : null;
  const { party, agent } = useContext(call, live);
  const [phase, setPhase] = useState<Phase>('sign-in');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const driving = useRef<Phase | null>(null);

  // the sign-in's outcome, told by the embedded connect flow
  const onSettled = useCallback(
    (view: SessionView) => {
      if (view.state === 'active') {
        setSessionId(view.sessionId);
        void write({ name: 'sign-in', state: 'pass', detail: `signed in as ${view.providerAccount?.displayName ?? 'the lab'}`, sessionId: view.sessionId }).then(() => setPhase('fetch'));
        return;
      }
      void write({ name: 'sign-in', state: 'fail', detail: view.error ? `${view.error.code} (${view.error.userAction})` : view.state, sessionId: view.sessionId }).then(() => finish('failed'));
    },
    [write, finish],
  );

  // the scenario after the sign-in, one phase at a time
  useEffect(() => {
    if (!live || live.state !== 'running' || !party || !sessionId || phase === 'sign-in' || phase === 'done' || driving.current === phase) return;
    driving.current = phase;
    void (async () => {
      if (phase === 'fetch') {
        await write({ name: 'fetch', state: 'running' });
        const first = await fetchOnce(call, live.provider, sessionId, live.resource);
        await write({ name: 'fetch', state: first.ok ? 'pass' : 'fail', detail: first.detail, jobId: first.jobId });
        if (!first.ok) {
          await finish('failed');
          setPhase('done');
          return;
        }
        setPhase('kept-login');
        return;
      }
      if (phase === 'kept-login') {
        const now = live.agentId ? await readAgent(call, live.agentId) : undefined;
        const verdict = live.agentId ? keptLoginVerdict(now, live.provider, isPersistent(party)) : { state: 'skip' as const, detail: 'no agent was pinned; the queue chose' };
        await write({ name: 'kept-login', ...verdict });
        setPhase('fetch-again');
        return;
      }
      if (phase === 'fetch-again') {
        await write({ name: 'fetch-again', state: 'running' });
        const second = await fetchOnce(call, live.provider, sessionId, live.resource);
        if (!second.ok) {
          await write({ name: 'fetch-again', state: 'fail', detail: second.detail, jobId: second.jobId });
        } else {
          const job = await latestFetchJob(call, sessionId);
          const verdict = noLoginVerdict(job);
          await write({ name: 'fetch-again', state: verdict.state, detail: `${second.detail}; ${verdict.detail}`, jobId: job?.jobId ?? second.jobId });
        }
        setPhase('release');
        return;
      }
      // release
      if (!wantsRelease || !live.agentId || !agent?.hosted) {
        await write({ name: 'release', state: 'skip', detail: agent?.hosted ? 'not asked for' : 'not a hosted slot' });
      } else {
        await write({ name: 'release', state: 'running', detail: 'the slot is released; waiting for the wipe' });
        const released = await call(`/lab/private-agents/${encodeURIComponent(live.agentId)}/release`, { method: 'POST' }).catch(() => null);
        if (!released?.ok) {
          await write({ name: 'release', state: 'fail', detail: `the release was refused (HTTP ${released?.status ?? 'network'})` });
        } else {
          const deadline = Date.now() + retentionTuning.wipeTimeoutMs;
          let verdict = wipeVerdict(await readAgent(call, live.agentId));
          while (verdict.state === 'running' && Date.now() < deadline) {
            await sleep(retentionTuning.wipePollMs);
            verdict = wipeVerdict(await readAgent(call, live.agentId));
          }
          await write({ name: 'release', state: verdict.state === 'running' ? 'fail' : verdict.state, detail: verdict.state === 'running' ? `the wipe did not finish in time: ${verdict.detail}` : verdict.detail });
        }
      }
      setPhase('done');
    })();
  }, [phase, live, party, sessionId, agent, wantsRelease, call, write, finish]);

  // the end: the verdict from the steps, written once
  useEffect(() => {
    if (phase !== 'done' || !live || live.state !== 'running') return;
    void finish(runVerdict(live.steps));
  }, [phase, live, finish]);

  const abort = async () => {
    if (!globalThis.confirm('Abort this run? The steps taken so far stay in the report.')) return;
    await act(() => call(`/lab/bench/retention/runs/${encodeURIComponent(id)}/finish`, { method: 'POST', body: JSON.stringify({ state: 'aborted' }) }));
    setPhase('done');
    setRunState('aborted');
  };
  const setRunState = (state: string) => {
    if (live) live.state = state;
  };

  const remove = async () => {
    if (!globalThis.confirm('Delete this run from the history?')) return;
    if (await act(() => call(`/lab/bench/retention/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }))) navigate('bench/retention');
  };

  if (run === 'loading') return <p className="hint">loading…</p>;
  if (!live) {
    return (
      <>
        <p>
          <a href={hrefOf('bench/retention')}>← Retention bench</a>
        </p>
        <section className="card" data-testid="retention-run-missing">
          <p className="hint">{run === null ? `No run named ${id}.` : 'The api did not answer.'}</p>
        </section>
      </>
    );
  }

  return (
    <>
      <p>
        <a href={hrefOf('bench/retention')}>← Retention bench</a>
      </p>
      <div className="head-row">
        <h1 data-testid="retention-run-title">
          {party?.name ?? live.provider} · {live.resource}
        </h1>
        <span className={`chip ${runChip(live.state)}`} data-testid="retention-run-state">
          {live.state}
        </span>
        <span className="sub mono">{live.id}</span>
        <span className="spacer" />
        {live.state === 'running' && (
          <button className="btn quiet" data-testid="retention-abort" disabled={busy} onClick={() => void abort()}>
            abort
          </button>
        )}
        {live.state !== 'running' && (
          <button className="btn danger" data-testid="retention-delete" disabled={busy} onClick={() => void remove()}>
            delete
          </button>
        )}
      </div>

      <section className="card" data-testid="retention-run-facts">
        <div className="facts">
          <div className="fact">
            <span className="fact-label">Agent</span>
            <span className="fact-value">{live.agentId ? <a href={hrefOf(`agents/${encodeURIComponent(live.agentId)}`)}>{live.agentName ?? live.agentId}</a> : 'whatever the queue decides'}</span>
          </div>
          <div className="fact">
            <span className="fact-label">Party</span>
            <span className="fact-value">
              <a href={hrefOf(`providers/${encodeURIComponent(live.provider)}`)}>{live.provider}</a>
              {isPersistent(party) ? ' · keeps a browser on the agent' : ' · keeps its session in the bundle'}
            </span>
          </div>
          <div className="fact">
            <span className="fact-label">Label</span>
            <span className="fact-value">{live.label ?? '—'}</span>
          </div>
          <div className="fact">
            <span className="fact-label">Started</span>
            <span className="fact-value">{when(live.createdAt)}</span>
          </div>
          <div className="fact">
            <span className="fact-label">Session</span>
            <span className="fact-value mono">{live.sessionId ? <a href={hrefOf(`bench/sessions/${encodeURIComponent(live.sessionId)}`)}>{live.sessionId}</a> : '—'}</span>
          </div>
        </div>
        <StepList run={live} />
      </section>

      {live.state === 'running' && phase === 'sign-in' && (
        <section className="card" data-testid="retention-sign-in">
          <h2>Step 1 — sign in on the agent</h2>
          <ConnectScreen provider={live.provider} call={call} busy={busy} act={act} embedded preset={{ runOn: live.agentId ?? undefined, runOnLabel: live.agentName ?? undefined, record: true }} onSettled={onSettled} />
        </section>
      )}
    </>
  );
}
