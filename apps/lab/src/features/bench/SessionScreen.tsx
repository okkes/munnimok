import { useCallback, useEffect, useState } from 'react';
import { getJson, reasonOf } from '../../app/api';
import type { Call } from '../../app/api';
import type { ScreenProps } from '../../app/LabApp';
import { hrefOf, navigate, useRouteQuery } from '../../app/router';
import { ago, when } from '../../lib/format';
import type { FetchView, JobList, JobView, LabSessionRow, OperatorJob, ParamSpec, ProviderEntry, SessionView } from '../../types';
import { cellText, columnsOf, fetchParams, paramsBody, SIGNING_IN, TERMINAL } from './benchFacts';
import { sessionChip } from './BenchScreen';
import { EXPLORE, RunCard } from './ConnectScreen';

const JOB_POLL_MS = 2_000;

type Page = { resource: string; records: Record<string, unknown>[]; complete: boolean; cursor?: string | null; notes: string[]; via: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** what the Bundle fact says — a sign-in still running has none yet (S3776) */
function bundleFact(hasBundle: boolean, signingIn: boolean): string {
  if (signingIn) return 'not yet — the sign-in is still running';
  return hasBundle ? 'kept by the relay' : 'none — sign in again';
}

/** one lab session in full: the facts, a fetch of any resource with its params and the records that came back, the canary flip, the disconnect */
export function SessionScreen({ id, call, busy, act }: Readonly<{ id: string } & ScreenProps>) {
  const query = useRouteQuery();
  const [session, setSession] = useState<LabSessionRow | null | 'loading'>('loading');
  const [party, setParty] = useState<ProviderEntry | null>(null);
  const [resource, setResource] = useState(query.get('resource') ?? '');
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [page, setPage] = useState<Page | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [job, setJob] = useState<JobView | null>(null);
  const [canaryResource, setCanaryResource] = useState('');
  const [every, setEvery] = useState('60');
  const [record, setRecord] = useState(false);
  // the sign-in itself while the session is still signing in — where a run left behind is picked up again (#576)
  const [run, setRun] = useState<SessionView | null>(null);

  const load = useCallback(async () => {
    const list = await getJson<LabSessionRow[]>(call, '/lab/bench/sessions');
    const row = list && list !== 'unreachable' ? (list.find((s) => s.sessionId === id) ?? null) : null;
    setSession(row);
    if (row) setParty((await getJson<ProviderEntry>(call, `/lab/providers/${encodeURIComponent(row.provider)}`)) as ProviderEntry | null);
  }, [call, id]);
  useEffect(() => {
    void load();
  }, [load]);

  const signingIn = session !== null && session !== 'loading' && SIGNING_IN.has(session.state);
  const provider = session !== null && session !== 'loading' ? session.provider : null;
  useEffect(() => {
    if (!signingIn || !provider) return undefined;
    let alive = true;
    void (async () => {
      const view = await getJson<SessionView>(call, `/lab/bench/${encodeURIComponent(provider)}/login/${encodeURIComponent(id)}`);
      if (alive && view && view !== 'unreachable') setRun(view);
    })();
    return () => {
      alive = false;
    };
  }, [call, id, provider, signingIn]);

  // the run settled under the operator's eyes: the session's own row says what it left (a bundle, a failure)
  const onRun = useCallback(
    (next: SessionView) => {
      setRun(next);
      if (TERMINAL.has(next.state)) void load();
    },
    [load],
  );

  const resources = party?.resources ?? [];
  const spec = resources.find((r) => r.id === (resource || resources[0]?.id));
  const chosen = spec?.id ?? '';
  const params = fetchParams(spec);

  const landed = (view: { resource?: string | null; data?: Record<string, unknown>[] | null; complete?: boolean; cursor?: string | null; notes?: string[] }, via: string) =>
    setPage({ resource: view.resource ?? chosen, records: view.data ?? [], complete: view.complete !== false, cursor: view.cursor, notes: view.notes ?? [], via });

  /** a fetch that became a job: followed here until it ends, its question answered from the box below */
  const follow = async (provider: string, jobId: string) => {
    setRunning(jobId);
    for (;;) {
      const view = await getJson<JobView>(call, `/lab/bench/${encodeURIComponent(provider)}/jobs/${encodeURIComponent(jobId)}`);
      if (!view || view === 'unreachable') {
        setFetchError('the job could not be read');
        break;
      }
      setJob(view);
      if (view.state === 'succeeded') {
        landed(view, `job ${jobId}`);
        break;
      }
      if (TERMINAL.has(view.state)) {
        setFetchError(view.error ? `${view.error.code} (${view.error.userAction})` : view.state);
        break;
      }
      if (view.state === 'awaiting_input') {
        await sleep(JOB_POLL_MS);
        continue;
      }
      await sleep(JOB_POLL_MS);
    }
    setRunning(null);
    await load();
  };

  const fetchNow = async () => {
    if (!session || session === 'loading' || !chosen) return;
    setFetchError(null);
    setPage(null);
    setJob(null);
    setRunning('fetch');
    const res = await call(`/lab/bench/sessions/${encodeURIComponent(id)}/fetch`, {
      method: 'POST',
      body: JSON.stringify({ resource: chosen, params: paramsBody(params, values), ...(record ? { record: true } : {}) }),
    }).catch(() => null);
    if (!res?.ok) {
      setFetchError(await reasonOf(res));
      setRunning(null);
      await load();
      return;
    }
    const view = (await res.json()) as FetchView;
    if (view.accepted && view.jobId) {
      await follow(session.provider, view.jobId);
      return;
    }
    landed(view, 'one round trip');
    setRunning(null);
    await load();
  };

  const answerJob = async () => {
    if (!session || session === 'loading' || !job?.challenge) return;
    const ok = await act(() =>
      call(`/lab/bench/${encodeURIComponent(session.provider)}/jobs/${encodeURIComponent(job.jobId)}/answer`, {
        method: 'POST',
        body: JSON.stringify({ challengeId: job.challenge?.id, value: answer }),
      }),
    );
    if (ok) setAnswer('');
  };

  const makeCanary = async () => {
    if (!session || session === 'loading') return;
    const pick = canaryResource || chosen;
    if (!globalThis.confirm(`Make this session the canary of ${session.provider} (${pick}, every ${every} min)? The control plane keeps its bundle from now on and this lab session goes.`)) return;
    const ok = await act(() =>
      call(`/lab/bench/sessions/${encodeURIComponent(id)}/canary`, { method: 'POST', body: JSON.stringify({ resource: pick, intervalMinutes: Number(every) }) }),
    );
    if (ok) navigate('canaries');
  };

  const disconnect = async () => {
    if (!session || session === 'loading') return;
    if (!globalThis.confirm(`Disconnect this lab session at ${session.provider}? The party is signed out where it allows it, and the session is forgotten here.`)) return;
    const ok = await act(() => call(`/lab/bench/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    if (ok) navigate('bench');
  };

  if (session === 'loading') return <p className="hint">loading…</p>;
  if (session === null) {
    return (
      <>
        <p>
          <a href={hrefOf('bench')}>← Bench</a>
        </p>
        <section className="card" data-testid="bench-session-missing">
          <p className="hint">No lab session named {id}. It may have become a canary, or been disconnected.</p>
        </section>
      </>
    );
  }

  const setValue = (key: string, value: string | string[]) => setValues((v) => ({ ...v, [key]: value }));
  const explore = session.provider === EXPLORE;
  // an explore run (or any party without a resource) has nothing to fetch and nothing a canary could prove
  const fetchable = !explore && (party === null || resources.length > 0);
  const bundle = bundleFact(session.hasBundle, signingIn);
  // the relay's row is the state it last read; the run read just now is the newer word
  const shownState = signingIn && run ? run.state : session.state;

  return (
    <>
      <p>
        <a href={hrefOf('bench')}>← Bench</a>
      </p>
      <div className="head-row">
        <h1 data-testid="bench-session-title">{party?.name ?? session.provider}</h1>
        <span className={`chip ${sessionChip(shownState)}`} data-testid="bench-session-state">
          {shownState}
        </span>
        <span className="sub mono">{session.sessionId}</span>
        <span className="spacer" />
        <button className="btn danger" data-testid="bench-disconnect" disabled={busy} onClick={() => void disconnect()}>
          disconnect
        </button>
      </div>

      {run && <RunCard provider={session.provider} call={call} busy={busy} view={run} onView={onRun} sessionLink={false} />}

      <section className="card" data-testid="bench-session-facts">
        <div className="facts">
          <Fact label="Party" value={explore ? 'explore' : <a href={hrefOf(`providers/${encodeURIComponent(session.provider)}`)}>{session.provider}</a>} />
          <Fact label="Label" value={session.label ?? '—'} />
          <Fact label="Bundle" value={bundle} />
          <Fact label="Runs on" value={session.preferAgent ?? 'no preference'} />
          <Fact label="Started" value={when(session.createdAt)} />
          <Fact label="Last used" value={session.lastError ? `${ago(session.lastUsedAt)} · ${session.lastError}` : ago(session.lastUsedAt)} />
        </div>
      </section>

      {explore && <ExploreRecording call={call} sessionId={session.sessionId} settled={!signingIn} />}

      {fetchable && (
        <>
      <section className="card" data-testid="bench-fetch-card">
        <h2>Fetch</h2>
        <p className="hint">One round trip with the kept bundle, exactly as a sync would ask — the records come back here and nowhere else.</p>
        <div className="row">
          <select data-testid="bench-fetch-resource" value={chosen} onChange={(e) => setResource(e.target.value)}>
            {resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id} → {r.returns}
              </option>
            ))}
          </select>
          {params.map((p) => (
            <ParamInput key={p.key} spec={p} value={values[p.key]} onChange={(v) => setValue(p.key, v)} />
          ))}
          <button type="button" role="switch" aria-checked={record} className={`btn quiet${record ? ' on' : ''}`} data-testid="bench-fetch-record" onClick={() => setRecord((v) => !v)}>
            {record ? 'recording' : 'record'}
          </button>
          <button className="btn" data-testid="bench-fetch" disabled={!session.hasBundle || running !== null || !chosen} onClick={() => void fetchNow()}>
            {running ? 'fetching…' : 'fetch'}
          </button>
        </div>
        {fetchError && (
          <p className="error" data-testid="bench-fetch-error">
            {fetchError}
          </p>
        )}
        {job && running && <FetchJob job={job} answer={answer} onAnswer={setAnswer} busy={busy} onSend={() => void answerJob()} />}
        {page && <FetchedRecords page={page} />}
      </section>

      <section className="card" data-testid="bench-canary-card">
        <h2>Make it the canary</h2>
        <p className="hint">
          The control plane takes this session&apos;s bundle and fetches the resource on the interval, rotating the bundle as the party does;
          this lab session goes with it. One canary per party — a new one replaces the old.
        </p>
        <div className="row">
          <select data-testid="bench-canary-resource" value={canaryResource || chosen} onChange={(e) => setCanaryResource(e.target.value)}>
            {resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
          </select>
          <input data-testid="bench-canary-interval" type="number" min={15} max={10080} value={every} onChange={(e) => setEvery(e.target.value)} style={{ width: 90 }} />
          <span className="sub">minutes</span>
          <button className="btn" data-testid="bench-make-canary" disabled={busy || !session.hasBundle || Number(every) < 15} onClick={() => void makeCanary()}>
            make canary
          </button>
        </div>
      </section>
        </>
      )}
    </>
  );
}

/** the job a fetch became, followed until it ends — the party's question answered in place */
function FetchJob({
  job,
  answer,
  onAnswer,
  busy,
  onSend,
}: Readonly<{ job: JobView; answer: string; onAnswer: (value: string) => void; busy: boolean; onSend: () => void }>) {
  return (
    <div data-testid="bench-fetch-job">
      <p className="hint">
        job <span className="mono">{job.jobId}</span> · {job.state} · {job.progress?.step ?? '—'}
        {job.progress?.found != null ? ` · ${job.progress.found} found` : ''}
      </p>
      {job.state === 'awaiting_input' && job.challenge && (
        <div className="row">
          <span className="sub">
            the party asks: {job.challenge.type}
            {job.challenge.delivery ? ` (${job.challenge.delivery})` : ''}
          </span>
          <input data-testid="bench-job-answer" value={answer} onChange={(e) => onAnswer(e.target.value)} placeholder="the code" />
          <button className="btn" data-testid="bench-job-answer-send" disabled={busy || !answer} onClick={onSend}>
            answer
          </button>
        </div>
      )}
    </div>
  );
}

/** a record's own id keys its row where the party sent one; else its place in the page */
function rowKey(record: Record<string, unknown>, index: number): string {
  const id = record.id ?? record.externalId;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : String(index);
}

/** the records a fetch brought back, as the party sent them */
function FetchedRecords({ page }: Readonly<{ page: Page }>) {
  const columns = columnsOf(page.records);
  return (
    <div data-testid="bench-records">
      <p className="hint">
        <strong>{page.records.length}</strong> record(s) of <span className="mono">{page.resource}</span> · {page.complete ? 'complete' : 'the party holds more'} · {page.via}
        {page.cursor ? ` · cursor ${page.cursor}` : ''}
      </p>
      {page.notes.length > 0 && <pre className="code">{page.notes.join('\n')}</pre>}
      <div style={{ overflowX: 'auto' }}>
        <table data-testid="bench-records-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.records.map((r, i) => (
              <tr key={rowKey(r, i)}>
                {columns.map((c) => (
                  <td key={c} className="mono">
                    {cellText(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** an explore run's deliverable (#441 L3): its recording, found in the job history by the session */
function ExploreRecording({ call, sessionId, settled }: Readonly<{ call: Call; sessionId: string; settled: boolean }>) {
  const [job, setJob] = useState<OperatorJob | null | 'loading'>('loading');
  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = await getJson<JobList>(call, `/lab/jobs?session=${encodeURIComponent(sessionId)}&limit=1`);
      if (alive) setJob(list && list !== 'unreachable' ? (list.jobs[0] ?? null) : null);
    })();
    return () => {
      alive = false;
    };
  }, [call, sessionId, settled]);

  return (
    <section className="card" data-testid="bench-explore-recording">
      <div className="card-head">
        <h2>The recording</h2>
        {job !== 'loading' && job?.trace && (
          <button className="btn" data-testid="bench-session-recording" onClick={() => navigate(`jobs/${encodeURIComponent(job.jobId)}/trace`)}>
            open the recording
          </button>
        )}
      </div>
      <p className="hint">
        An explore run fetches nothing: what it leaves is the recording of everything the browser did, with the secrets taken out.
        {job !== 'loading' && job && !job.trace && (settled ? ' This run kept none.' : ' It is written when you press done, or when the window closes.')}
        {job === null && ' The control plane lists no run for this session any more.'}
      </p>
      {job !== 'loading' && job && (
        <a href={hrefOf(`jobs/${encodeURIComponent(job.jobId)}`)} data-testid="bench-session-job">
          the run in the job history →
        </a>
      )}
    </section>
  );
}

/** one fetch param as the operator fills it: a date box, a pick list for an enum, a multi pick for a multi one, else text */
function ParamInput({ spec, value, onChange }: Readonly<{ spec: ParamSpec; value: string | string[] | undefined; onChange: (v: string | string[]) => void }>) {
  const id = `bench-param-${spec.key}`;
  if (spec.values && spec.values.length > 0 && spec.multi) {
    const picked = Array.isArray(value) ? value : [];
    return (
      <span className="chips" data-testid={id}>
        <span className="sub">{spec.key}:</span>
        {spec.values.map((v) => (
          <button
            key={v}
            type="button"
            className={`chip ${picked.includes(v) ? 'on' : ''}`}
            data-testid={`${id}-${v}`}
            onClick={() => onChange(picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v])}
          >
            {v}
          </button>
        ))}
      </span>
    );
  }
  if (spec.values && spec.values.length > 0) {
    return (
      <select data-testid={id} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">{spec.key}{spec.required ? ' *' : ''}</option>
        {spec.values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      data-testid={id}
      type={spec.type === 'date' ? 'date' : 'text'}
      placeholder={`${spec.key}${spec.required ? ' *' : ''}`}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: spec.type === 'date' ? 150 : 160 }}
    />
  );
}

function Fact({ label, value }: Readonly<{ label: string; value: React.ReactNode }>) {
  return (
    <div className="fact">
      <span className="fact-label">{label}</span>
      <span className="fact-value">{value}</span>
    </div>
  );
}
