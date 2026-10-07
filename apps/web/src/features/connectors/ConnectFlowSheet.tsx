import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { en } from '@/i18n/en';
import { useData } from '@/app/data';
import { useConnectionOps } from '@/application/connections';
import type { AdoptResult } from '@/application/connections';
import { Button } from '@/ui/Button';
import { FormBlockerNote, blockerRing } from '@/ui/FormBlockerNote';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { publicOrigin } from '@/app/config';
import { ConnectorError, connectorApi, deviceClass } from './api';
import { ChallengeCard } from './ChallengeCard';
import { rememberReturn } from './connectorReturn';
import { noteSignInFailure, settleQuestion } from './connectorSync';
import type { FailureNoted } from './connectorSync';
import { ReportAsk } from './ReportAsk';
import { subscribeConnectorFrames } from './events';
import { LookupField } from './LookupField';
import {
  TERMINAL_STATES,
  appProvidedConfig,
  copyKey,
  errorKey,
  failedWith,
  formSteps,
  needsOwnComputer,
  ownReturn,
  progressKey,
  splitValues,
  validateValues,
} from './manifestForm';
import type { FieldProblem, FormField } from './manifestForm';
import { pendingFromView, usePendingLogins } from './pendingLogins';
import type { AgentView, ErrorEnvelope, ProviderManifest, SessionView } from './types';

/**
 * The connect flow (§10.2): the manifest's steps as a form, then the run
 * — progress from the typed `step`, every question the party asks
 * rendered by its kind — until the session is active and its bundle is
 * in custody. A run in flight is followed through the connector frames
 * on `/sync/events`, with a poll as the safety net.
 *
 * Closing the sheet DETACHES (user question 2026-10-01): the session runs
 * on the platform either way, the hub lists it as pending with a way back
 * in (`resume`), and the hub's follower adopts it when it settles. A
 * streamed page that the platform ends — the sign-in landed — moves the
 * sheet on at once instead of leaving someone looking at a finished page.
 */
type Phase =
  | { kind: 'form' }
  | { kind: 'running'; view: SessionView }
  | { kind: 'challenge'; view: SessionView }
  | { kind: 'failed'; error: ErrorEnvelope; artifactsJobId?: string }
  | { kind: 'done' };

/** a sign-in started earlier (and maybe closed) to pick up where it stands */
export interface ResumeLogin {
  connectionId: string;
  sessionId: string;
  reconnect: boolean;
}

const POLL_MS = 2_500;
const INPUT = 'h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4';

/**
 * What was typed into the form, kept for this page load only (user
 * 2026-10-07: a refused sign-in or a closed sheet emptied the form, and the
 * person typed everything again). Keyed by the connection signing in again,
 * or by the party for a connection that does not exist yet. Never stored
 * anywhere — a password is in it — and dropped the moment a sign-in lands.
 */
const typedDrafts = new Map<string, Record<string, string>>();
const draftKeyOf = (reconnectId: string | null, provider: string): string => reconnectId ?? provider;

/** a sign-in that landed while its sheet was closed (the hub's follower adopted it) needs its typed values no more */
export const forgetTypedValues = (reconnectId: string | null, provider: string): void => {
  typedDrafts.delete(draftKeyOf(reconnectId, provider));
};

/** the sheet's word on the picture a failed sign-in left: not known yet, to ask, or the answer given */
type ReportState = 'pending' | 'ask' | 'yes' | 'no';
const answerOf = (report: ReportState): 'yes' | 'no' | null => (report === 'yes' || report === 'no' ? report : null);

const inputModeFor = (field: FormField): React.HTMLAttributes<HTMLInputElement>['inputMode'] => {
  if (field.type === 'number') return 'numeric';
  if (field.type === 'phone') return 'tel';
  if (field.autofill === 'username' || field.autofill === 'email') return 'email';
  return undefined;
};

const INPUT_TYPE: Partial<Record<FormField['type'], string>> = { password: 'password', date: 'date' };
const inputTypeFor = (field: FormField): string => INPUT_TYPE[field.type] ?? 'text';

/** seconds since the run started waiting — so a spinner that is really a
 *  queue, or a browser starting, visibly moves (user request 2026-10-01) */
function useElapsedSeconds(active: boolean): number {
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      setSince(null);
      return;
    }
    const started = Date.now();
    setSince((s) => s ?? started);
    setNow(started);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return since === null ? 0 : Math.max(0, Math.round((now - since) / 1000));
}

/** a placeholder view while a resumed session is read: the sheet opens on the run, not on the form */
const resumingView = (sessionId: string): SessionView => ({ sessionId, state: 'running' });

export function ConnectFlowSheet({
  open,
  manifest,
  reconnectId,
  resume,
  onOpenChange,
  onDone,
}: Readonly<{
  open: boolean;
  manifest: ProviderManifest | null;
  /** an existing connection signing in again */
  reconnectId: string | null;
  /** a sign-in in flight to pick up instead of starting one */
  resume?: ResumeLogin | null;
  onOpenChange: (open: boolean) => void;
  onDone: (result: AdoptResult, reconnect: boolean) => void;
}>) {
  const { t } = useLang();
  const navigate = useNavigate();
  const { store } = useData();
  const ops = useConnectionOps();
  // config the app answers itself (where a party brings the person back) is never a field
  const provided = useMemo(() => appProvidedConfig(publicOrigin()), []);
  const steps = useMemo(() => (manifest ? formSteps(manifest, provided) : []), [manifest, provided]);
  const ownComputer = !!manifest && needsOwnComputer(manifest);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  // the clock on a waiting run — a hook, so above every early return
  const elapsed = useElapsedSeconds(phase.kind === 'running');
  const [stepIndex, setStepIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  // #441 L1: where "report this failure?" stands for the failure on screen
  const [report, setReport] = useState<ReportState>('pending');
  // a party that only talks to a browser on the person's own machine: the agent that will hold the sign-in
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  // a landscape page (a party that wants a desktop browser) gets the wider dialog
  const [landscape, setLandscape] = useState(false);
  const connectionId = useRef('');
  const attempt = useRef(0);
  const stopFollowing = useRef<() => void>(() => {});
  const inFlight = useRef(false);
  const startedAt = useRef('');
  // the resumed session is read once the handlers below exist (they close over this render)
  const pickUp = useRef<(sessionId: string) => void>(() => {});
  // the typed values' place in the page-load memory above
  const draftKey = draftKeyOf(reconnectId, manifest?.id ?? '');

  useEffect(() => {
    if (!open) return;
    setStepIndex(0);
    // the form comes back as it was left (user 2026-10-07)
    setValues(typedDrafts.get(draftKey) ?? {});
    setAttempted(false);
    setBusy(false);
    setAgents(null);
    setAgentId(null);
    setLandscape(false);
    attempt.current += 1;
    if (resume) {
      connectionId.current = resume.connectionId;
      startedAt.current = usePendingLogins.getState().logins[resume.connectionId]?.startedAt ?? new Date().toISOString();
      setPhase({ kind: 'running', view: resumingView(resume.sessionId) });
      pickUp.current(resume.sessionId);
    } else {
      connectionId.current = reconnectId ?? crypto.randomUUID();
      setPhase({ kind: 'form' });
    }
    return () => {
      stopFollowing.current();
      // the sheet is gone (unmounted with the hub, or closed): whatever is still pending is the hub's to follow
      usePendingLogins.getState().patch(connectionId.current, { attached: false });
    };
  }, [open, reconnectId, resume, draftKey]);

  useEffect(() => {
    if (!open || !ownComputer) return;
    let alive = true;
    connectorApi
      .agents()
      .then((list) => {
        if (!alive) return;
        const usable = list.filter((a) => !a.revoked);
        setAgents(usable);
        setAgentId(usable.find((a) => a.online)?.id ?? null);
      })
      .catch(() => alive && setAgents([]));
    return () => {
      alive = false;
    };
  }, [open, ownComputer]);

  if (!manifest) return null;
  const provider = manifest.id;
  const reconnect = resume ? resume.reconnect : !!reconnectId;
  const step = steps[stepIndex];
  const problems: Record<string, FieldProblem> = step ? validateValues(step.fields, values) : {};
  const pending = usePendingLogins.getState();

  /**
   * The failure's word goes on the device row too (user 2026-10-07: "the
   * tab closes and I cannot report it any more"): the question a picture
   * waits on then survives this sheet, under the hub's card — and a
   * standing "always report" shares it without asking. The sheet asks only
   * once the row has had its say, so no question flashes before a standing
   * answer.
   */
  const noteFailure = async (error: ErrorEnvelope, artifactsJobId?: string) => {
    const at = attempt.current;
    const noted = await noteSignInFailure(store, connectionId.current, error, artifactsJobId).catch((): FailureNoted => 'asked');
    // a later attempt has its own failure, or none: this word is stale
    if (attempt.current === at) setReport(noted === 'shared' ? 'yes' : 'ask');
  };

  const fail = (error: ErrorEnvelope, artifactsJobId?: string) => {
    stopFollowing.current();
    // the person reads the failure here; the hub needs no second copy of it
    pending.remove(connectionId.current);
    setReport('pending');
    setPhase({ kind: 'failed', error, artifactsJobId });
    void noteFailure(error, artifactsJobId);
  };

  // #441 L1: the person's word on the picture a failed sign-in left behind
  const answerReport = async (jobId: string, share: boolean) => {
    setBusy(true);
    // a question the relay no longer holds has lapsed by itself
    await (share ? connectorApi.shareArtifacts(provider, jobId) : connectorApi.declineArtifacts(provider, jobId)).catch(() => undefined);
    // answered here, the hub's card must not ask it again (user 2026-10-07)
    await settleQuestion(store, connectionId.current, jobId).catch(() => undefined);
    setReport(share ? 'yes' : 'no');
    setBusy(false);
  };

  const notePending = (view: SessionView) => {
    // attached: this sheet follows the session; the hub's follower takes
    // over only once the sheet lets go (close), never alongside it
    pending.put({ ...pendingFromView({ connectionId: connectionId.current, provider, reconnect, startedAt: startedAt.current }, view), attached: true });
  };

  const handleView = async (view: SessionView): Promise<void> => {
    stopFollowing.current();
    if (view.state === 'active') {
      // the bundle is handed over exactly once: on the settling answer, or
      // on the first view read after it
      const full = view.bundle ? view : await connectorApi.login(provider, view.sessionId);
      const result = await ops.adopt({ manifest, view: full, connectionId: connectionId.current, reconnect });
      pending.remove(connectionId.current);
      // the sign-in landed: what was typed for it is forgotten
      typedDrafts.delete(draftKey);
      setPhase({ kind: 'done' });
      onDone(result, reconnect);
      return;
    }
    if (view.state === 'awaiting_input' && view.challenge) {
      // a party that comes back to the app's own return page (§15): what that page needs to answer, written down first
      if (view.challenge.type === 'redirect' && view.challenge.code && ownReturn(view.challenge.returnPattern, publicOrigin())) {
        rememberReturn({
          provider,
          sessionId: view.sessionId,
          challengeId: view.challenge.id,
          code: view.challenge.code,
          connectionId: connectionId.current,
          reconnect,
        });
      }
      notePending(view);
      // the same question again is not a new render: a picture challenge
      // would refetch its picture on every poll
      setPhase((prev) => (prev.kind === 'challenge' && prev.view.challenge?.id === view.challenge?.id ? prev : { kind: 'challenge', view }));
      // still followed: the platform ends a streamed page by itself once
      // the sign-in lands, and the session moves on without a tap here
      follow(view.sessionId);
      return;
    }
    if (TERMINAL_STATES.has(view.state)) {
      fail(view.error ?? failedWith(view.state), view.artifactsJobId ?? undefined);
      return;
    }
    notePending(view);
    setPhase({ kind: 'running', view });
    follow(view.sessionId);
  };

  const guarded = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      fail(err instanceof ConnectorError ? err.envelope : failedWith('failed'));
    } finally {
      setBusy(false);
    }
  };

  /** a run in flight: every frame (and the poll) reads the view afresh */
  const follow = (sessionId: string) => {
    const refresh = () => {
      if (inFlight.current) return;
      inFlight.current = true;
      void connectorApi
        .login(provider, sessionId)
        .then((view) => handleView(view))
        .catch((err: unknown) => fail(err instanceof ConnectorError ? err.envelope : failedWith('failed')))
        .finally(() => {
          inFlight.current = false;
        });
    };
    const unsubscribe = subscribeConnectorFrames(sessionId, refresh);
    const timer = setInterval(refresh, POLL_MS);
    stopFollowing.current = () => {
      unsubscribe();
      clearInterval(timer);
      stopFollowing.current = () => {};
    };
  };

  pickUp.current = (sessionId: string) => void guarded(async () => handleView(await connectorApi.login(provider, sessionId)));

  const start = () =>
    guarded(async () => {
      const { inputs, config } = splitValues(manifest, values, provided);
      const device = reconnectId ? await store.connectorConnGet(reconnectId) : undefined;
      startedAt.current = new Date().toISOString();
      const { view } = await connectorApi.startLogin(provider, {
        connectionId: connectionId.current,
        inputs: Object.keys(inputs).length ? inputs : undefined,
        config: Object.keys(config).length ? config : undefined,
        credentialBundle: device?.credentialBundle,
        preferAgent: ownComputer ? (agentId ?? undefined) : undefined,
        idempotencyKey: `${connectionId.current}:${attempt.current}`,
      });
      await handleView(view);
    });

  const toAgents = () => {
    onOpenChange(false);
    void navigate({ to: '/connections/agents' });
  };

  const next = () => {
    if (Object.keys(problems).length > 0 || (ownComputer && !agentId)) {
      setAttempted(true);
      return;
    }
    if (stepIndex < steps.length - 1) {
      setStepIndex((i) => i + 1);
      setAttempted(false);
      return;
    }
    void start();
  };

  const answer = (view: SessionView) => (value: string) =>
    guarded(async () => {
      if (!view.challenge) return;
      await handleView(await connectorApi.answer(provider, view.sessionId, view.challenge.id, value));
    });

  // the party's own page needs every pixel: the sheet grows to the full
  // height and the content owns every pointer (see Sheet.dragLock)
  const live = phase.kind === 'challenge' && phase.view.challenge?.type === 'live_view';

  /** closing keeps the sign-in going: it is listed in the hub until it settles, and the hub follows it from here */
  const close = () => {
    stopFollowing.current();
    pending.patch(connectionId.current, { attached: false });
    onOpenChange(false);
  };

  /** giving up: the platform is told, and the hub forgets the attempt */
  const cancel = () => {
    stopFollowing.current();
    if (phase.kind === 'running' || phase.kind === 'challenge') {
      void connectorApi.cancel(provider, phase.view.sessionId).catch(() => undefined);
    }
    pending.remove(connectionId.current);
    onOpenChange(false);
  };

  const retry = () => {
    attempt.current += 1;
    setPhase({ kind: 'form' });
    setStepIndex(0);
    setAttempted(false);
  };

  /** the platform ended the streamed page: read where the session stands now */
  const liveEnded = (view: SessionView) => {
    stopFollowing.current();
    void guarded(async () => handleView(await connectorApi.login(provider, view.sessionId)));
  };

  /** the control a field is edited with: a party's own list, a fixed list, or a text box */
  const controlFor = (field: FormField, value: string, invalid: boolean, set: (v: string) => void) => {
    if (field.type === 'lookup') {
      // the step's other values ride along as context (the country picks the list)
      const context = Object.fromEntries((step?.fields ?? []).filter((f) => f.key !== field.key).map((f) => [f.key, values[f.key] ?? '']));
      return <LookupField provider={provider} field={field.key} value={value} context={context} invalid={invalid} onChange={(v) => set(v)} />;
    }
    if (field.type === 'select') {
      return (
        <select data-testid={`connect-field-${field.key}`} value={value} onChange={(e) => set(e.target.value)} className={`${INPUT}${blockerRing(invalid)}`}>
          <option value="">—</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }
    return (
      <input
        data-testid={`connect-field-${field.key}`}
        type={inputTypeFor(field)}
        inputMode={inputModeFor(field)}
        autoComplete={field.autofill ?? 'off'}
        value={value}
        onChange={(e) => set(e.target.value)}
        aria-invalid={invalid}
        className={`${INPUT}${blockerRing(invalid)}`}
      />
    );
  };

  const renderField = (field: FormField) => {
    const problem = attempted ? problems[field.key] : undefined;
    const value = values[field.key] ?? '';
    // remembered as typed: a refusal or a close must not empty the form (user 2026-10-07)
    const set = (v: string) => {
      const next = { ...values, [field.key]: v };
      typedDrafts.set(draftKey, next);
      setValues(next);
    };
    // A lookup is a search box AND a list of buttons, and it must not sit in a
    // <label>: Safari runs the label's activation for a tap on any descendant,
    // so a bank tapped from the list was re-dispatched to the first labelable
    // element — by then the just-picked button — and unpicked itself (user ss
    // 2026-10-02: "the bank item is not selectable"). A plain field keeps the
    // label, which is what gives its input a name.
    const Wrapper = field.type === 'lookup' ? 'div' : 'label';
    return (
      <Wrapper key={field.key} className="flex flex-col gap-1 text-[12px] text-ink-3" data-testid={`connect-fieldset-${field.key}`}>
        {t(field.labelKey)}
        {controlFor(field, value, !!problem, set)}
        <FormBlockerNote show={!!problem} text={t(problem === 'pattern' ? 'connect.field.pattern' : 'connect.field.required')} testId={`connect-field-${field.key}-blocker`} />
      </Wrapper>
    );
  };

  const title = reconnect ? t('connect.reconnectTitle', { name: manifest.name }) : t('connect.title', { name: manifest.name });

  const renderForm = () => (
    <div className="flex flex-col gap-3 pt-1" data-testid="connect-form">
      <p className="text-[13px] leading-relaxed text-ink-2" data-testid="connect-notes">
        {t(copyKey(manifest.notesKey, 'connect.notes.generic'))}
      </p>
      {/* what a fetch says about itself (a bank handing over its whole export, say) */}
      {manifest.resources
        .filter((r) => r.notesKey && r.notesKey in en)
        .map((r) => (
          <p key={r.id} className="text-[12px] leading-relaxed text-ink-3" data-testid={`connect-resource-note-${r.id}`}>
            {t(r.notesKey as TranslationKey)}
          </p>
        ))}
      {deviceClass() === 'web' && (
        <p className="rounded-card bg-bg-2 px-3 py-2 text-[12px] leading-relaxed text-ink-3" data-testid="connect-web-note">
          {t('connect.webNote')}
        </p>
      )}
      {ownComputer && stepIndex === 0 && (
        <div className="flex flex-col gap-2" data-testid="connect-agent-step">
          <p className="text-[12px] leading-relaxed text-ink-3">{t('connect.agentNote')}</p>
          {agents !== null && agents.length === 0 && (
            <>
              <p className="text-[12px] text-warning" data-testid="connect-agent-none">
                {t('connect.agentNone')}
              </p>
              <Button variant="outline" data-testid="connect-agent-setup" onClick={toAgents}>
                {t('connect.agentSetup')}
              </Button>
            </>
          )}
          {agents !== null && agents.length > 0 && (
            <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="connect-agents">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  data-testid={`connect-agent-${agent.id}`}
                  disabled={!agent.online}
                  onClick={() => setAgentId(agent.id)}
                  className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0 disabled:opacity-60"
                >
                  <Icon name={agentId === agent.id ? 'radiobox-marked' : 'radiobox-blank'} size={18} color={agentId === agent.id ? 'var(--m-accent)' : 'var(--m-ink-4)'} />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{agent.name}</span>
                  {!agent.online && <span className="text-[11px] text-ink-4">{t('connect.agentOffline')}</span>}
                </button>
              ))}
            </div>
          )}
          <FormBlockerNote show={attempted && !agentId} text={t('connect.agentNone')} testId="connect-agent-blocker" />
        </div>
      )}
      {step && (
        <>
          {steps.length > 1 && (
            <div className="m-cap px-1" data-testid="connect-step-title">
              {stepIndex + 1}/{steps.length} · {t(step.labelKey)}
            </div>
          )}
          {step.fields.map(renderField)}
        </>
      )}
      <Button data-testid="connect-next" disabled={busy} onClick={next}>
        {stepIndex < steps.length - 1 ? t('connect.next') : t('connect.start')}
      </Button>
    </div>
  );

  const renderRunning = (view: SessionView) => {
    const current = view.progress?.step ?? 'queued';
    const ahead = view.progress?.ahead ?? null;
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-10 text-center" data-testid="connect-progress">
        <Icon name="progress-clock" size={34} color="var(--m-accent-deep)" />
        <p className="text-[14px] font-medium text-ink-2" data-testid="connect-progress-step">
          {t(progressKey(current))}
        </p>
        {current === 'queued' && ahead !== null && ahead > 0 && (
          <p className="text-[12px] text-ink-3" data-testid="connect-progress-ahead">
            {t('connect.progress.ahead', { n: ahead })}
          </p>
        )}
        {current === 'opening_provider' && (
          <p className="text-[12px] text-ink-4" data-testid="connect-progress-hint">
            {t('connect.progress.openingHint')}
          </p>
        )}
        <p className="text-[11px] text-ink-4" data-testid="connect-progress-elapsed">
          {t('connect.progress.elapsed', { s: elapsed })}
        </p>
        {view.notes?.[0] && <p className="text-[12px] text-ink-4">{view.notes[0]}</p>}
        {/* the sign-in does not need this sheet open: it is listed in the hub until it settles */}
        <p className="mt-2 text-[11px] text-ink-4" data-testid="connect-progress-closenote">
          {t('connect.progress.closeNote')}
        </p>
        <Button size="sm" variant="ghost" data-testid="connect-running-close" onClick={close}>
          {t('connect.progress.close')}
        </Button>
      </div>
    );
  };

  const body = () => {
    switch (phase.kind) {
      case 'form':
        return renderForm();
      case 'running':
        return renderRunning(phase.view);
      case 'challenge':
        return (
          <div className={live ? '' : 'pt-1'}>
            <ChallengeCard
              provider={provider}
              sessionId={phase.view.sessionId}
              challenge={phase.view.challenge!}
              busy={busy}
              onAnswer={(value) => void answer(phase.view)(value)}
              onClose={close}
              onEnded={() => liveEnded(phase.view)}
              onFrame={(size) => setLandscape(size.width > size.height)}
            />
          </div>
        );
      case 'failed':
        return (
          <div className="flex flex-col gap-3 pt-1" data-testid="connect-failed">
            <p className="text-[14px] font-medium text-ink">{t('connect.failedTitle')}</p>
            <p className="text-[13px] leading-relaxed text-negative" data-testid="connect-error">
              {t(errorKey(phase.error.code))}
            </p>
            {phase.artifactsJobId && report !== 'pending' && (
              <ReportAsk testId="connect-report" answered={answerOf(report)} busy={busy} onAnswer={(share) => void answerReport(phase.artifactsJobId ?? '', share)} />
            )}
            {/* offered after EVERY refusal (user 2026-10-07): a party's "no" is as often a typo
                as a dead account, and the form comes back with what was typed */}
            <Button data-testid="connect-retry" onClick={retry}>
              {t('connect.action.retry')}
            </Button>
            <Button variant="outline" data-testid="connect-cancel" onClick={cancel}>
              {t('connect.cancel')}
            </Button>
          </div>
        );
      case 'done':
        return (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center" data-testid="connect-done">
            <Icon name="check-circle" size={34} color="var(--m-accent-deep)" />
            <p className="text-[14px] font-medium text-ink">{t('connect.done')}</p>
            <p className="text-[12px] text-ink-4">{t('connect.doneSub')}</p>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <Sheet open={open} onOpenChange={(next) => !next && close()} title={title} size={live ? 'full' : 'tall'} dragLock={live} wide={live && landscape}>
      {body()}
    </Sheet>
  );
}
