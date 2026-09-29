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
import { ConnectorError, connectorApi, deviceClass } from './api';
import { ChallengeCard } from './ChallengeCard';
import { subscribeConnectorFrames } from './events';
import { copyKey, errorKey, formSteps, needsOwnComputer, progressKey, splitValues, validateValues } from './manifestForm';
import type { FieldProblem, FormField } from './manifestForm';
import type { AgentView, ErrorEnvelope, ProviderManifest, SessionView } from './types';

/**
 * The connect flow (§10.2): the manifest's steps as a form, then the run
 * — progress from the typed `step`, every question the party asks
 * rendered by its kind — until the session is active and its bundle is
 * in custody. A run in flight is followed through the connector frames
 * on `/sync/events`, with a poll as the safety net.
 */
type Phase =
  | { kind: 'form' }
  | { kind: 'running'; view: SessionView }
  | { kind: 'challenge'; view: SessionView }
  | { kind: 'failed'; error: ErrorEnvelope }
  | { kind: 'done' };

const POLL_MS = 2_500;
const INPUT = 'h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4';

const TERMINAL = new Set(['failed', 'expired', 'disabled', 'blocked', 'needs_reauth']);

/** a terminal view without an envelope still gets one, in the connector's own words */
const FAILED_CODE: Record<string, string> = { blocked: 'blocked_by_provider', expired: 'session_expired' };

const failedWith = (state: string): ErrorEnvelope => {
  const code = FAILED_CODE[state] ?? 'internal';
  return {
    code,
    retriable: state !== 'blocked',
    userAction: state === 'blocked' ? 'wait' : 'retry',
    messageKey: `connect.error.${code}`,
  };
};

const inputModeFor = (field: FormField): React.HTMLAttributes<HTMLInputElement>['inputMode'] => {
  if (field.type === 'number') return 'numeric';
  if (field.type === 'phone') return 'tel';
  if (field.autofill === 'username' || field.autofill === 'email') return 'email';
  return undefined;
};

const INPUT_TYPE: Partial<Record<FormField['type'], string>> = { password: 'password', date: 'date' };
const inputTypeFor = (field: FormField): string => INPUT_TYPE[field.type] ?? 'text';

export function ConnectFlowSheet({
  open,
  manifest,
  reconnectId,
  onOpenChange,
  onDone,
}: Readonly<{
  open: boolean;
  manifest: ProviderManifest | null;
  /** an existing connection signing in again */
  reconnectId: string | null;
  onOpenChange: (open: boolean) => void;
  onDone: (result: AdoptResult, reconnect: boolean) => void;
}>) {
  const { t } = useLang();
  const navigate = useNavigate();
  const { store } = useData();
  const ops = useConnectionOps();
  const steps = useMemo(() => (manifest ? formSteps(manifest) : []), [manifest]);
  const ownComputer = !!manifest && needsOwnComputer(manifest);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [stepIndex, setStepIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  // a party that only talks to a browser on the person's own machine: the agent that will hold the sign-in
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const connectionId = useRef('');
  const attempt = useRef(0);
  const stopFollowing = useRef<() => void>(() => {});
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    setPhase({ kind: 'form' });
    setStepIndex(0);
    setValues({});
    setAttempted(false);
    setBusy(false);
    setAgents(null);
    setAgentId(null);
    connectionId.current = reconnectId ?? crypto.randomUUID();
    attempt.current += 1;
    return () => stopFollowing.current();
  }, [open, reconnectId]);

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
  const step = steps[stepIndex];
  const problems: Record<string, FieldProblem> = step ? validateValues(step.fields, values) : {};

  const fail = (error: ErrorEnvelope) => {
    stopFollowing.current();
    setPhase({ kind: 'failed', error });
  };

  const handleView = async (view: SessionView): Promise<void> => {
    stopFollowing.current();
    if (view.state === 'active') {
      // the bundle is handed over exactly once: on the settling answer, or
      // on the first view read after it
      const full = view.bundle ? view : await connectorApi.login(provider, view.sessionId);
      const result = await ops.adopt({ manifest, view: full, connectionId: connectionId.current, reconnect: !!reconnectId });
      setPhase({ kind: 'done' });
      onDone(result, !!reconnectId);
      return;
    }
    if (view.state === 'awaiting_input' && view.challenge) {
      setPhase({ kind: 'challenge', view });
      return;
    }
    if (TERMINAL.has(view.state)) {
      fail(view.error ?? failedWith(view.state));
      return;
    }
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

  const start = () =>
    guarded(async () => {
      const { inputs, config } = splitValues(manifest, values);
      const device = reconnectId ? await store.connectorConnGet(reconnectId) : undefined;
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

  const close = () => {
    stopFollowing.current();
    if (phase.kind === 'running' || phase.kind === 'challenge') {
      void connectorApi.cancel(provider, phase.view.sessionId).catch(() => undefined);
    }
    onOpenChange(false);
  };

  const retry = () => {
    attempt.current += 1;
    setPhase({ kind: 'form' });
    setStepIndex(0);
    setAttempted(false);
  };

  const renderField = (field: FormField) => {
    const problem = attempted ? problems[field.key] : undefined;
    const value = values[field.key] ?? '';
    const set = (v: string) => setValues((all) => ({ ...all, [field.key]: v }));
    return (
      <label key={field.key} className="flex flex-col gap-1 text-[12px] text-ink-3">
        {t(field.labelKey)}
        {field.type === 'select' ? (
          <select data-testid={`connect-field-${field.key}`} value={value} onChange={(e) => set(e.target.value)} className={`${INPUT}${blockerRing(!!problem)}`}>
            <option value="">—</option>
            {(field.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <input
            data-testid={`connect-field-${field.key}`}
            type={inputTypeFor(field)}
            inputMode={inputModeFor(field)}
            autoComplete={field.autofill ?? 'off'}
            value={value}
            onChange={(e) => set(e.target.value)}
            aria-invalid={!!problem}
            className={`${INPUT}${blockerRing(!!problem)}`}
          />
        )}
        <FormBlockerNote show={!!problem} text={t(problem === 'pattern' ? 'connect.field.pattern' : 'connect.field.required')} testId={`connect-field-${field.key}-blocker`} />
      </label>
    );
  };

  const title = reconnectId ? t('connect.reconnectTitle', { name: manifest.name }) : t('connect.title', { name: manifest.name });

  const body = () => {
    switch (phase.kind) {
      case 'form':
        return (
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
      case 'running':
        return (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center" data-testid="connect-progress">
            <Icon name="progress-clock" size={34} color="var(--m-accent-deep)" />
            <p className="text-[14px] font-medium text-ink-2">{t(progressKey(phase.view.progress?.step ?? 'queued'))}</p>
            {phase.view.notes?.[0] && <p className="text-[12px] text-ink-4">{phase.view.notes[0]}</p>}
          </div>
        );
      case 'challenge':
        return (
          <div className="pt-1">
            <ChallengeCard provider={provider} sessionId={phase.view.sessionId} challenge={phase.view.challenge!} busy={busy} onAnswer={(value) => void answer(phase.view)(value)} />
          </div>
        );
      case 'failed':
        return (
          <div className="flex flex-col gap-3 pt-1" data-testid="connect-failed">
            <p className="text-[14px] font-medium text-ink">{t('connect.failedTitle')}</p>
            <p className="text-[13px] leading-relaxed text-negative" data-testid="connect-error">
              {t(errorKey(phase.error.code))}
            </p>
            {phase.error.retriable !== false && (
              <Button data-testid="connect-retry" onClick={retry}>
                {t('connect.action.retry')}
              </Button>
            )}
            <Button variant="outline" data-testid="connect-cancel" onClick={close}>
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
    <Sheet open={open} onOpenChange={(next) => !next && close()} title={title} size="tall">
      {body()}
    </Sheet>
  );
}
