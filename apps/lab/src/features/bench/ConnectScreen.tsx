import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson, reasonOf } from '../../app/api';
import type { Call } from '../../app/api';
import type { ScreenProps } from '../../app/LabApp';
import { hrefOf, navigate, useRouteQuery } from '../../app/router';
import type { AgentView, ChallengeView, JobList, ProviderEntry, SessionView } from '../../types';
import { encodeTaps, signInFields, TERMINAL } from './benchFacts';
import { LiveView } from './LiveView';
import { sessionChip } from './BenchScreen';

const POLL_MS = 1_500;

/** the control plane's own provider for an explore run (#441 L3): a browser the operator drives, recorded throughout */
export const EXPLORE = 'explore';

/** the picture a challenge carries, fetched with the lab's credentials */
function useChallengeImage(call: Call, provider: string, sessionId: string | null, challenge: ChallengeView | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const wanted = !!challenge?.imageUrl && (challenge.type === 'image' || challenge.type === 'qr_display' || challenge.type === 'code_display');
  const challengeId = challenge?.id ?? null;
  useEffect(() => {
    if (!wanted || !sessionId || !challengeId) {
      setUrl(null);
      return undefined;
    }
    let revoke: string | null = null;
    void (async () => {
      const res = await call(`/lab/bench/${encodeURIComponent(provider)}/login/${encodeURIComponent(sessionId)}/challenges/${encodeURIComponent(challengeId)}/image`).catch(() => null);
      if (!res?.ok) return;
      if (typeof URL.createObjectURL !== 'function') {
        setUrl(`image-${challengeId}`);
        return;
      }
      revoke = URL.createObjectURL(await res.blob());
      setUrl(revoke);
    })();
    return () => {
      if (revoke && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(revoke);
    };
  }, [call, provider, sessionId, challengeId, wanted]);
  return url;
}

/**
 * Connect in the lab (#441 L2): the manifest's own sign-in form, the party's
 * config, a label, where the run happens — then the run as it goes: the
 * step, the notes, and whatever the party asks (a code, a picture to tap,
 * a choice, a page to open, the live browser), answered here.
 */
export function ConnectScreen({ provider, call, busy }: Readonly<{ provider: string } & ScreenProps>) {
  const explore = provider === EXPLORE;
  const query = useRouteQuery();
  const [party, setParty] = useState<ProviderEntry | null | 'loading'>('loading');
  const [record, setRecord] = useState(explore);
  const [recordingJob, setRecordingJob] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>(() => {
    const url = explore ? query.get('url') : null;
    const initial: Record<string, string> = url ? { url } : {};
    return initial;
  });
  const [config, setConfig] = useState<Record<string, string>>({});
  const [label, setLabel] = useState('');
  const [runOn, setRunOn] = useState('');
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [taps, setTaps] = useState<{ x: number; y: number }[]>([]);
  const [sending, setSending] = useState(false);
  const alive = useRef(true);
  const base = `/lab/bench/${encodeURIComponent(provider)}/login`;
  const image = useChallengeImage(call, provider, view?.sessionId ?? null, view?.challenge);

  useEffect(() => {
    alive.current = true;
    void (async () => {
      const [p, a] = await Promise.all([getJson<ProviderEntry>(call, `/lab/providers/${encodeURIComponent(provider)}`), getJson<{ agents: AgentView[] }>(call, '/lab/agents')]);
      if (!alive.current) return;
      setParty(p === 'unreachable' ? null : p);
      setAgents(a && a !== 'unreachable' ? a.agents.filter((x) => !x.revoked) : []);
    })();
    return () => {
      alive.current = false;
    };
  }, [call, provider]);

  // the run, read afresh every second and a half while it is not settled
  const refresh = useCallback(async (sessionId: string) => {
    const next = await getJson<SessionView>(call, `${base}/${encodeURIComponent(sessionId)}`);
    if (!alive.current) return;
    if (next && next !== 'unreachable') setView(next);
  }, [call, base]);

  useEffect(() => {
    if (!record || !view || !TERMINAL.has(view.state) || recordingJob) return;
    void (async () => {
      const list = await getJson<JobList>(call, `/lab/jobs?session=${encodeURIComponent(view.sessionId)}&limit=1`);
      if (!alive.current || !list || list === 'unreachable') return;
      setRecordingJob(list.jobs[0]?.jobId ?? null);
    })();
  }, [record, view, recordingJob, call]);

  useEffect(() => {
    if (!view || TERMINAL.has(view.state)) return undefined;
    if (view.state === 'awaiting_input' && view.challenge?.type === 'live_view') return undefined; // the live view says when the page moved on
    const timer = setInterval(() => void refresh(view.sessionId), POLL_MS);
    return () => clearInterval(timer);
  }, [view, refresh]);

  const start = async () => {
    setError(null);
    setSending(true);
    const res = explore
      ? await call('/lab/bench/explore', { method: 'POST', body: JSON.stringify({ url: inputs.url ?? '', label: label || undefined, preferAgent: runOn || undefined }) }).catch(() => null)
      : await call(base, { method: 'POST', body: JSON.stringify({ inputs, config, label: label || undefined, preferAgent: runOn || undefined, ...(record ? { record: true } : {}) }) }).catch(() => null);
    setSending(false);
    if (!res?.ok) {
      setError(await reasonOf(res));
      return;
    }
    setView((await res.json()) as SessionView);
  };

  const send = async (value: string) => {
    if (!view?.challenge) return;
    setSending(true);
    const res = await call(`${base}/${encodeURIComponent(view.sessionId)}/answer`, { method: 'POST', body: JSON.stringify({ challengeId: view.challenge.id, value }) }).catch(() => null);
    setSending(false);
    if (!res?.ok) {
      setError(await reasonOf(res));
      return;
    }
    setAnswer('');
    setTaps([]);
    setView((await res.json()) as SessionView);
  };

  const cancel = async () => {
    if (!view) return;
    const res = await call(`${base}/${encodeURIComponent(view.sessionId)}/cancel`, { method: 'POST' }).catch(() => null);
    if (res?.ok) setView((await res.json()) as SessionView);
  };

  if (party === 'loading') return <p className="hint">loading…</p>;
  if (party === null) {
    return (
      <>
        <p>
          <a href={hrefOf('bench')}>← Bench</a>
        </p>
        <section className="card" data-testid="bench-connect-missing">
          <p className="hint">No party named {provider} on this control plane.</p>
        </section>
      </>
    );
  }

  const fields = signInFields(party);
  const configFields = party.auth?.config ?? [];
  const ready = fields.every((f) => !f.required || (inputs[f.key] ?? '').length > 0) && configFields.every((f) => !f.required || (config[f.key] ?? '').length > 0);
  const challenge = view?.challenge ?? null;

  return (
    <>
      <p>
        <a href={hrefOf('bench')}>← Bench</a>
      </p>
      <div className="head-row">
        <h1 data-testid="bench-connect-title">{explore ? 'Explore a site' : `Connect to ${party.name}`}</h1>
        <span className="sub mono">{party.id}</span>
        <span className="spacer" />
      </div>

      {!view && (
        <section className="card" data-testid="bench-connect-form">
          <h2>{explore ? 'Start at' : 'Sign in'}</h2>
          {explore ? (
            <p className="hint" data-testid="bench-explore-hint">
              A browser on a fleet agent opens at this address (a public host — never the NAS&apos;s own network). Drive it through the live view:
              tap, type, open another address, go back, reload. Everything the browser does is recorded with the secrets taken out; press done
              when you have seen enough and read the recording in the job history.
            </p>
          ) : (
            <p className="hint">
              The manifest&apos;s own form ({party.auth?.flow ?? 'password'}); what you type goes to the party under the lab subject and is kept nowhere here.
              {party.auth?.challenges?.length ? ` It may ask: ${party.auth.challenges.join(', ')}.` : ''}
            </p>
          )}
          <div className="facts">
            {fields.map((f) => (
              <label key={`${f.step}:${f.key}`} className="fact">
                <span className="fact-label">
                  {f.key}
                  {f.required ? ' *' : ''} <span className="sub">({f.step})</span>
                </span>
                <input
                  data-testid={`bench-input-${f.key}`}
                  type={f.secret || f.type === 'password' ? 'password' : 'text'}
                  autoComplete="off"
                  value={inputs[f.key] ?? ''}
                  onChange={(e) => setInputs((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              </label>
            ))}
            {fields.length === 0 && <p className="hint">No typed fields — the party signs you in on its own page.</p>}
            {!explore && (
              <div className="fact">
                <span className="fact-label">record</span>
                <button type="button" role="switch" aria-checked={record} className={`btn quiet${record ? ' on' : ''}`} data-testid="bench-record" onClick={() => setRecord((v) => !v)}>
                  {record ? 'recording this run' : 'not recorded'}
                </button>
              </div>
            )}
            {configFields.map((f) => (
              <label key={f.key} className="fact">
                <span className="fact-label">
                  config · {f.key}
                  {f.required ? ' *' : ''}
                </span>
                <input data-testid={`bench-config-${f.key}`} value={config[f.key] ?? ''} onChange={(e) => setConfig((v) => ({ ...v, [f.key]: e.target.value }))} />
              </label>
            ))}
            <label className="fact">
              <span className="fact-label">label</span>
              <input data-testid="bench-label" value={label} placeholder="how the bench lists it" onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label className="fact">
              <span className="fact-label">runs on</span>
              <select data-testid="bench-run-on" value={runOn} onChange={(e) => setRunOn(e.target.value)}>
                <option value="">no preference (the queue decides)</option>
                <option value="fleet">the fleet (munni&apos;s pooled agents)</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.class} · {a.online ? 'online' : 'offline'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <button className="btn" data-testid="bench-start" disabled={!ready || sending} onClick={() => void start()}>
              {sending ? 'starting…' : explore ? 'open' : 'sign in'}
            </button>
          </div>
        </section>
      )}

      {error && (
        <p className="error" data-testid="bench-connect-error">
          {error}
        </p>
      )}

      {view && (
        <section className="card" data-testid="bench-run">
          <div className="card-head">
            <h2>The run</h2>
            <span className={`chip ${sessionChip(view.state)}`} data-testid="bench-run-state">
              {view.state}
            </span>
          </div>
          <div className="facts">
            <div className="fact">
              <span className="fact-label">Session</span>
              <span className="fact-value mono">{view.sessionId}</span>
            </div>
            <div className="fact">
              <span className="fact-label">Step</span>
              <span className="fact-value">
                {view.progress?.step ?? '—'}
                {view.progress?.ahead != null && view.progress.ahead > 0 ? ` · ${view.progress.ahead} ahead in the queue` : ''}
              </span>
            </div>
            <div className="fact">
              <span className="fact-label">Account</span>
              <span className="fact-value">{view.providerAccount?.displayName ?? '—'}</span>
            </div>
          </div>
          {view.notes && view.notes.length > 0 && <pre className="code">{view.notes.join('\n')}</pre>}
          {view.error && (
            <p className="error" data-testid="bench-run-error">
              {view.error.code} · the person is told to {view.error.userAction}
              {view.artifactsJobId ? ' · the picture of the page is in the job history' : ''}
            </p>
          )}

          {challenge && view.state === 'awaiting_input' && (
            <div data-testid={`bench-challenge-${challenge.type}`}>
              <h3>
                The party asks: {challenge.type}
                {challenge.delivery ? ` (${challenge.delivery})` : ''} <span className="sub">until {new Date(challenge.expiresAt).toLocaleTimeString()}</span>
              </h3>
              {challenge.promptKey && <p className="hint mono">{challenge.promptKey}</p>}
              {challenge.type === 'live_view' && (
                <>
                  <LiveView call={call} provider={provider} sessionId={view.sessionId} challengeId={challenge.id} navigation={explore} onEnded={() => void refresh(view.sessionId)} />
                  {explore && (
                    <div className="row" style={{ marginTop: 8 }}>
                      <button className="btn" data-testid="bench-explore-done" disabled={sending} onClick={() => void send('done')}>
                        done — stop recording
                      </button>
                      <button className="btn quiet" data-testid="bench-explore-more" disabled={sending} onClick={() => void send('more')}>
                        another 30 minutes
                      </button>
                    </div>
                  )}
                </>
              )}
              {(challenge.type === 'mfa_code' || (challenge.type === 'image' && challenge.answerKind !== 'taps')) && (
                <div className="row">
                  {image && <img src={image} alt="" data-testid="bench-challenge-image" style={{ maxWidth: 320, borderRadius: 8 }} />}
                  <input data-testid="bench-answer" value={answer} placeholder={challenge.length ? `${challenge.length} characters` : 'the answer'} onChange={(e) => setAnswer(e.target.value)} />
                  <button className="btn" data-testid="bench-answer-send" disabled={sending || !answer} onClick={() => void send(answer)}>
                    answer
                  </button>
                </div>
              )}
              {challenge.type === 'image' && challenge.answerKind === 'taps' && (
                <div>
                  <p className="hint">Tap the picture where the party asks; then submit.</p>
                  {image && (
                    <button
                      type="button"
                      data-testid="bench-taps-image"
                      aria-label="the picture to tap"
                      style={{ display: 'block', padding: 0, border: 0, background: 'none', maxWidth: 420, cursor: 'crosshair' }}
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) return;
                        setTaps((t) => [...t, { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }]);
                      }}
                    >
                      <img src={image} alt="" draggable={false} style={{ width: '100%', borderRadius: 8 }} />
                    </button>
                  )}
                  <div className="row">
                    <span className="sub" data-testid="bench-taps-count">
                      {taps.length} tap(s)
                    </span>
                    <button className="btn quiet" data-testid="bench-taps-clear" onClick={() => setTaps([])}>
                      clear
                    </button>
                    <button className="btn quiet" data-testid="bench-taps-none" disabled={sending} onClick={() => void send(encodeTaps([]))}>
                      nothing to tap
                    </button>
                    <button className="btn" data-testid="bench-taps-submit" disabled={sending || taps.length === 0} onClick={() => void send(encodeTaps(taps))}>
                      submit taps
                    </button>
                  </div>
                </div>
              )}
              {(challenge.type === 'code_display' || challenge.type === 'qr_display' || challenge.type === 'app_approval') && (
                <div>
                  {challenge.code && (
                    <p className="mono" data-testid="bench-challenge-code" style={{ fontSize: 20 }}>
                      {challenge.code}
                    </p>
                  )}
                  {image && <img src={image} alt="" data-testid="bench-challenge-image" style={{ maxWidth: 320, borderRadius: 8 }} />}
                  <p className="hint">Approve in the party&apos;s app or with the code shown, then press done.</p>
                  <button className="btn" data-testid="bench-approved" disabled={sending} onClick={() => void send('')}>
                    done
                  </button>
                </div>
              )}
              {challenge.type === 'select_option' && (
                <div className="row" data-testid="bench-options">
                  {(challenge.options ?? []).map((o) => (
                    <button key={o.value} className="btn" data-testid={`bench-option-${o.value}`} disabled={sending} onClick={() => void send(o.value)}>
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
              {challenge.type === 'redirect' && (
                <div>
                  <p className="hint">
                    Open the party&apos;s page, sign in there, and paste the address it returns to{challenge.returnPattern ? ` (it looks like ${challenge.returnPattern})` : ''}.
                  </p>
                  {challenge.url && (
                    <p>
                      <a href={challenge.url} target="_blank" rel="noreferrer" data-testid="bench-redirect-url">
                        {challenge.url}
                      </a>
                    </p>
                  )}
                  <div className="row">
                    <input data-testid="bench-answer" value={answer} placeholder="the returned address" onChange={(e) => setAnswer(e.target.value)} />
                    <button className="btn" data-testid="bench-answer-send" disabled={sending || !answer} onClick={() => void send(answer)}>
                      answer
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="row" style={{ marginTop: 12 }}>
            {!TERMINAL.has(view.state) && (
              <button className="btn quiet" data-testid="bench-cancel" disabled={busy} onClick={() => void cancel()}>
                cancel
              </button>
            )}
            {recordingJob && (
              <button className="btn" data-testid="bench-open-recording" onClick={() => navigate(`jobs/${encodeURIComponent(recordingJob)}/trace`)}>
                open the recording
              </button>
            )}
            {view.state === 'active' && !explore && (
              <button className="btn" data-testid="bench-open-session" onClick={() => navigate(`bench/sessions/${encodeURIComponent(view.sessionId)}`)}>
                connected — open the session
              </button>
            )}
            {TERMINAL.has(view.state) && view.state !== 'active' && (
              <button className="btn" data-testid="bench-again" onClick={() => setView(null)}>
                try again
              </button>
            )}
          </div>
        </section>
      )}
    </>
  );
}
