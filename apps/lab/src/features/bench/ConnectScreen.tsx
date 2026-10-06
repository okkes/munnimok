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

/** what another screen fixes before the form is shown (#441 L4: the retention bench pins the agent and records) */
export interface ConnectPreset {
  /** `fleet` or an agent id; the runs-on select becomes a fact */
  runOn?: string;
  runOnLabel?: string;
  /** recording forced on; the switch is hidden */
  record?: boolean;
}

interface FormState {
  inputs: Record<string, string>;
  config: Record<string, string>;
  label: string;
  runOn: string;
  record: boolean;
}

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

/** the run's recording, found in the history once the run has settled (#441 L3) */
function useRecordingJob(call: Call, view: SessionView | null, wanted: boolean): string | null {
  const [jobId, setJobId] = useState<string | null>(null);
  const settled = !!view && TERMINAL.has(view.state);
  const sessionId = view?.sessionId ?? null;
  useEffect(() => {
    if (!wanted || !settled || !sessionId) return undefined;
    let alive = true;
    void (async () => {
      const list = await getJson<JobList>(call, `/lab/jobs?session=${encodeURIComponent(sessionId)}&limit=1`);
      if (alive && list && list !== 'unreachable') setJobId(list.jobs[0]?.jobId ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [call, wanted, settled, sessionId]);
  return jobId;
}

/** the party and the agents to pick from, read once */
function usePartyAndAgents(call: Call, provider: string): { party: ProviderEntry | null | 'loading'; agents: AgentView[] } {
  const [party, setParty] = useState<ProviderEntry | null | 'loading'>('loading');
  const [agents, setAgents] = useState<AgentView[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [p, a] = await Promise.all([getJson<ProviderEntry>(call, `/lab/providers/${encodeURIComponent(provider)}`), getJson<{ agents: AgentView[] }>(call, '/lab/agents')]);
      if (!alive) return;
      setParty(p === 'unreachable' ? null : p);
      setAgents(a && a !== 'unreachable' ? a.agents.filter((x) => !x.revoked) : []);
    })();
    return () => {
      alive = false;
    };
  }, [call, provider]);
  return { party, agents };
}

/** what the start button says */
function startLabel(sending: boolean, explore: boolean): string {
  if (sending) return 'starting…';
  return explore ? 'open' : 'sign in';
}

/** the form's heading: an explore run starts at an address, a connection signs in */
function FormIntro({ explore, party }: Readonly<{ explore: boolean; party: ProviderEntry }>) {
  if (explore) {
    return (
      <>
        <h2>Start at</h2>
        <p className="hint" data-testid="bench-explore-hint">
          A browser on a fleet agent opens at this address (a public host — never the NAS&apos;s own network). Drive it through the live view: tap,
          type, open another address, go back, reload. Everything the browser does is recorded with the secrets taken out; press done when you
          have seen enough and read the recording in the job history.
        </p>
      </>
    );
  }
  return (
    <>
      <h2>Sign in</h2>
      <p className="hint">
        The manifest&apos;s own form ({party.auth?.flow ?? 'password'}); what you type goes to the party under the lab subject and is kept nowhere here.
        {party.auth?.challenges?.length ? ` It may ask: ${party.auth.challenges.join(', ')}.` : ''}
      </p>
    </>
  );
}

/** where the run happens: a pick, or the fact another screen fixed */
function RunsOn({ form, patch, agents, preset }: Readonly<{ form: FormState; patch: (p: Partial<FormState>) => void; agents: AgentView[]; preset?: ConnectPreset }>) {
  if (preset?.runOn) {
    return (
      <div className="fact">
        <span className="fact-label">runs on</span>
        <span className="fact-value" data-testid="bench-run-on-fixed">
          {preset.runOnLabel ?? preset.runOn}
        </span>
      </div>
    );
  }
  return (
    <label className="fact">
      <span className="fact-label">runs on</span>
      <select data-testid="bench-run-on" value={form.runOn} onChange={(e) => patch({ runOn: e.target.value })}>
        <option value="">no preference (the queue decides)</option>
        <option value="fleet">the fleet (munni&apos;s pooled agents)</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · {a.class} · {a.online ? 'online' : 'offline'}
          </option>
        ))}
      </select>
    </label>
  );
}

/** the sign-in form: the manifest's fields, the party's config, a label, where it runs, whether it is recorded */
function SignInForm({
  party,
  explore,
  agents,
  form,
  patch,
  preset,
  sending,
  onStart,
}: Readonly<{ party: ProviderEntry; explore: boolean; agents: AgentView[]; form: FormState; patch: (p: Partial<FormState>) => void; preset?: ConnectPreset; sending: boolean; onStart: () => void }>) {
  const fields = signInFields(party);
  const configFields = party.auth?.config ?? [];
  const ready = fields.every((f) => !f.required || (form.inputs[f.key] ?? '').length > 0) && configFields.every((f) => !f.required || (form.config[f.key] ?? '').length > 0);
  const showRecord = !explore && !preset?.record;
  return (
    <section className="card" data-testid="bench-connect-form">
      <FormIntro explore={explore} party={party} />
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
              value={form.inputs[f.key] ?? ''}
              onChange={(e) => patch({ inputs: { ...form.inputs, [f.key]: e.target.value } })}
            />
          </label>
        ))}
        {fields.length === 0 && <p className="hint">No typed fields — the party signs you in on its own page.</p>}
        {showRecord && (
          <div className="fact">
            <span className="fact-label">record</span>
            <button type="button" role="switch" aria-checked={form.record} className={`btn quiet${form.record ? ' on' : ''}`} data-testid="bench-record" onClick={() => patch({ record: !form.record })}>
              {form.record ? 'recording this run' : 'not recorded'}
            </button>
          </div>
        )}
        {configFields.map((f) => (
          <label key={f.key} className="fact">
            <span className="fact-label">
              config · {f.key}
              {f.required ? ' *' : ''}
            </span>
            <input data-testid={`bench-config-${f.key}`} value={form.config[f.key] ?? ''} onChange={(e) => patch({ config: { ...form.config, [f.key]: e.target.value } })} />
          </label>
        ))}
        <label className="fact">
          <span className="fact-label">label</span>
          <input data-testid="bench-label" value={form.label} placeholder="how the bench lists it" onChange={(e) => patch({ label: e.target.value })} />
        </label>
        <RunsOn form={form} patch={patch} agents={agents} preset={preset} />
      </div>
      <div className="row">
        <button className="btn" data-testid="bench-start" disabled={!ready || sending} onClick={onStart}>
          {startLabel(sending, explore)}
        </button>
      </div>
    </section>
  );
}

/** an explore run's two words: done, or another window */
function ExploreControls({ sending, send }: Readonly<{ sending: boolean; send: (value: string) => void }>) {
  return (
    <div className="row" style={{ marginTop: 8 }}>
      <button className="btn" data-testid="bench-explore-done" disabled={sending} onClick={() => send('done')}>
        done — stop recording
      </button>
      <button className="btn quiet" data-testid="bench-explore-more" disabled={sending} onClick={() => send('more')}>
        another 30 minutes
      </button>
    </div>
  );
}

/** a picture to tap: the taps gathered as fractions, submitted as the control plane reads them */
function TapPanel({ image, taps, setTaps, sending, send }: Readonly<{ image: string | null; taps: { x: number; y: number }[]; setTaps: (t: { x: number; y: number }[]) => void; sending: boolean; send: (value: string) => void }>) {
  return (
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
            setTaps([...taps, { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }]);
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
        <button className="btn quiet" data-testid="bench-taps-none" disabled={sending} onClick={() => send(encodeTaps([]))}>
          nothing to tap
        </button>
        <button className="btn" data-testid="bench-taps-submit" disabled={sending || taps.length === 0} onClick={() => send(encodeTaps(taps))}>
          submit taps
        </button>
      </div>
    </div>
  );
}

/** whatever the party asks, answered here */
function ChallengePanel({
  challenge,
  provider,
  explore,
  call,
  view,
  image,
  sending,
  send,
  onLiveEnded,
}: Readonly<{ challenge: ChallengeView; provider: string; explore: boolean; call: Call; view: SessionView; image: string | null; sending: boolean; send: (value: string) => void; onLiveEnded: () => void }>) {
  const [answer, setAnswer] = useState('');
  const [taps, setTaps] = useState<{ x: number; y: number }[]>([]);
  const sendAndClear = (value: string) => {
    setAnswer('');
    setTaps([]);
    send(value);
  };
  const typed = challenge.type === 'mfa_code' || (challenge.type === 'image' && challenge.answerKind !== 'taps');
  const approval = challenge.type === 'code_display' || challenge.type === 'qr_display' || challenge.type === 'app_approval';
  return (
    <div data-testid={`bench-challenge-${challenge.type}`}>
      <h3>
        The party asks: {challenge.type}
        {challenge.delivery ? ` (${challenge.delivery})` : ''} <span className="sub">until {new Date(challenge.expiresAt).toLocaleTimeString()}</span>
      </h3>
      {challenge.promptKey && <p className="hint mono">{challenge.promptKey}</p>}
      {challenge.type === 'live_view' && (
        <>
          <LiveView call={call} provider={provider} sessionId={view.sessionId} challengeId={challenge.id} navigation={explore} onEnded={onLiveEnded} />
          {explore && <ExploreControls sending={sending} send={send} />}
        </>
      )}
      {typed && (
        <div className="row">
          {image && <img src={image} alt="" data-testid="bench-challenge-image" style={{ maxWidth: 320, borderRadius: 8 }} />}
          <input data-testid="bench-answer" value={answer} placeholder={challenge.length ? `${challenge.length} characters` : 'the answer'} onChange={(e) => setAnswer(e.target.value)} />
          <button className="btn" data-testid="bench-answer-send" disabled={sending || !answer} onClick={() => sendAndClear(answer)}>
            answer
          </button>
        </div>
      )}
      {challenge.type === 'image' && challenge.answerKind === 'taps' && <TapPanel image={image} taps={taps} setTaps={setTaps} sending={sending} send={sendAndClear} />}
      {approval && (
        <div>
          {challenge.code && (
            <p className="mono" data-testid="bench-challenge-code" style={{ fontSize: 20 }}>
              {challenge.code}
            </p>
          )}
          {image && <img src={image} alt="" data-testid="bench-challenge-image" style={{ maxWidth: 320, borderRadius: 8 }} />}
          <p className="hint">Approve in the party&apos;s app or with the code shown, then press done.</p>
          <button className="btn" data-testid="bench-approved" disabled={sending} onClick={() => send('')}>
            done
          </button>
        </div>
      )}
      {challenge.type === 'select_option' && (
        <div className="row" data-testid="bench-options">
          {(challenge.options ?? []).map((o) => (
            <button key={o.value} className="btn" data-testid={`bench-option-${o.value}`} disabled={sending} onClick={() => send(o.value)}>
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
            <button className="btn" data-testid="bench-answer-send" disabled={sending || !answer} onClick={() => sendAndClear(answer)}>
              answer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** the run's facts: the session, the step and the queue position, the account */
function RunFacts({ view }: Readonly<{ view: SessionView }>) {
  return (
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
  );
}

/**
 * Connect in the lab (#441 L2): the manifest's own sign-in form, the party's
 * config, a label, where the run happens — then the run as it goes: the
 * step, the notes, and whatever the party asks (a code, a picture to tap,
 * a choice, a page to open, the live browser), answered here. Embedded
 * (#441 L4), another screen fixes the agent and the recording and is told
 * when the run has settled.
 */
export function ConnectScreen({
  provider,
  call,
  busy,
  preset,
  embedded = false,
  onSettled,
}: Readonly<{ provider: string; preset?: ConnectPreset; embedded?: boolean; onSettled?: (view: SessionView) => void } & ScreenProps>) {
  const explore = provider === EXPLORE;
  const query = useRouteQuery();
  const { party, agents } = usePartyAndAgents(call, provider);
  const [form, setForm] = useState<FormState>(() => {
    const url = explore ? query.get('url') : null;
    const inputs: Record<string, string> = url ? { url } : {};
    return { inputs, config: {}, label: '', runOn: preset?.runOn ?? '', record: preset?.record ?? explore };
  });
  const patch = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }));
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const alive = useRef(true);
  const settledFor = useRef<string | null>(null);
  const base = `/lab/bench/${encodeURIComponent(provider)}/login`;
  const image = useChallengeImage(call, provider, view?.sessionId ?? null, view?.challenge);
  const recordingJob = useRecordingJob(call, view, form.record);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // the run, read afresh every second and a half while it is not settled
  const refresh = useCallback(async (sessionId: string) => {
    const next = await getJson<SessionView>(call, `${base}/${encodeURIComponent(sessionId)}`);
    if (!alive.current) return;
    if (next && next !== 'unreachable') setView(next);
  }, [call, base]);

  useEffect(() => {
    if (!view || TERMINAL.has(view.state)) return undefined;
    if (view.state === 'awaiting_input' && view.challenge?.type === 'live_view') return undefined; // the live view says when the page moved on
    const timer = setInterval(() => void refresh(view.sessionId), POLL_MS);
    return () => clearInterval(timer);
  }, [view, refresh]);

  // the settled run, told once to whoever embedded this screen
  useEffect(() => {
    if (!onSettled || !view || !TERMINAL.has(view.state) || settledFor.current === view.sessionId) return;
    settledFor.current = view.sessionId;
    onSettled(view);
  }, [view, onSettled]);

  const post = async (path: string, body: unknown) => {
    setError(null);
    setSending(true);
    const res = await call(path, { method: 'POST', body: JSON.stringify(body) }).catch(() => null);
    setSending(false);
    if (!res?.ok) {
      setError(await reasonOf(res));
      return;
    }
    setView((await res.json()) as SessionView);
  };

  const start = () =>
    explore
      ? post('/lab/bench/explore', { url: form.inputs.url ?? '', label: form.label || undefined, preferAgent: form.runOn || undefined })
      : post(base, { inputs: form.inputs, config: form.config, label: form.label || undefined, preferAgent: form.runOn || undefined, ...(form.record ? { record: true } : {}) });

  const send = (value: string) => {
    if (!view?.challenge) return;
    void post(`${base}/${encodeURIComponent(view.sessionId)}/answer`, { challengeId: view.challenge.id, value });
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
        {!embedded && (
          <p>
            <a href={hrefOf('bench')}>← Bench</a>
          </p>
        )}
        <section className="card" data-testid="bench-connect-missing">
          <p className="hint">No party named {provider} on this control plane.</p>
        </section>
      </>
    );
  }

  const challenge = view?.challenge ?? null;

  return (
    <>
      {!embedded && (
        <>
          <p>
            <a href={hrefOf('bench')}>← Bench</a>
          </p>
          <div className="head-row">
            <h1 data-testid="bench-connect-title">{explore ? 'Explore a site' : `Connect to ${party.name}`}</h1>
            <span className="sub mono">{party.id}</span>
            <span className="spacer" />
          </div>
        </>
      )}

      {!view && <SignInForm party={party} explore={explore} agents={agents} form={form} patch={patch} preset={preset} sending={sending} onStart={() => void start()} />}

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
          <RunFacts view={view} />
          {view.notes && view.notes.length > 0 && <pre className="code">{view.notes.join('\n')}</pre>}
          {view.error && (
            <p className="error" data-testid="bench-run-error">
              {view.error.code} · the person is told to {view.error.userAction}
              {view.artifactsJobId ? ' · the picture of the page is in the job history' : ''}
            </p>
          )}

          {challenge && view.state === 'awaiting_input' && (
            <ChallengePanel challenge={challenge} provider={provider} explore={explore} call={call} view={view} image={image} sending={sending} send={send} onLiveEnded={() => void refresh(view.sessionId)} />
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
            {view.state === 'active' && !explore && !embedded && (
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
