import { useCallback, useEffect, useState } from 'react';
import { useLang } from '@/i18n';
import { connectorsAvailable } from '@/application/connections';
import { fmtTimeAgo } from '@/lib/text';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { FormBlockerNote, blockerRing } from '@/ui/FormBlockerNote';
import { Icon } from '@/ui/Icon';
import { Pill } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { ConnectorError, connectorApi } from './api';
import { errorKey } from './manifestForm';
import type { AgentView, EnrollmentView, ErrorEnvelope, PrivateAgentStatus } from './types';

const INPUT = 'h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4';

/** the clipboard, when the platform offers one — a failure is the person's cue to select the text */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Settings → Connections → Your own computer (#367 §10.4): the household
 * agents a person runs on their own machine for the parties that will only
 * ever talk to a browser on the account holder's own connection. Enrol
 * (a name, a one-time code, the compose line to paste), see each agent's
 * health and the logins it keeps, revoke one — with the warning that the
 * revocation destroys the profile that keeps the login alive.
 *
 * And the hosted private agent (#420 A2): the same thing on munni's own
 * hardware, one browser for this person alone. Ask for one, wait for the
 * admin, and the slot shows up in the list as hosted; giving it back wipes
 * the sign-ins it keeps before the next person gets it.
 */
export function AgentsScreen() {
  const { t, lang } = useLang();
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [offered, setOffered] = useState<boolean | null>(null);
  const [error, setError] = useState<ErrorEnvelope | null>(null);
  const [enrolOpen, setEnrolOpen] = useState(false);
  const [name, setName] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [enrollment, setEnrollment] = useState<EnrollmentView | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<AgentView | null>(null);
  const [hosted, setHosted] = useState<PrivateAgentStatus | null>(null);
  const signedIn = connectorsAvailable();

  const reload = useCallback(async () => {
    if (!signedIn) {
      setAgents([]);
      setOffered(false);
      setHosted(null);
      return;
    }
    try {
      // the hosted private agents (#420 A2) are a separate answer: a relay without the route hides the card, nothing else
      const [info, list, standing] = await Promise.all([connectorApi.info(), connectorApi.agents(), connectorApi.privateAgents().catch(() => null)]);
      setOffered(info?.householdAgents ?? false);
      setAgents(list);
      setHosted(standing);
      setError(null);
    } catch (err) {
      setError(err instanceof ConnectorError ? err.envelope : { code: 'provider_unavailable', retriable: true, userAction: 'retry', messageKey: 'connect.error.provider_unavailable' });
      setAgents([]);
    }
  }, [signedIn]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // an enrolled agent dials in within a minute: keep the list fresh while a code is out
  useEffect(() => {
    if (!enrollment) return;
    const timer = setInterval(() => void reload(), 10_000);
    return () => clearInterval(timer);
  }, [enrollment, reload]);

  // a request waits on the admin: keep asking while it is pending, so the slot shows up the moment it is handed over
  const pendingRequest = hosted?.request?.state === 'pending';
  useEffect(() => {
    if (!pendingRequest) return;
    const timer = setInterval(() => void reload(), 15_000);
    return () => clearInterval(timer);
  }, [pendingRequest, reload]);

  const enrol = async () => {
    if (!name.trim()) {
      setAttempted(true);
      return;
    }
    setBusy(true);
    try {
      setEnrollment(await connectorApi.enrol(name.trim()));
      setCopied(false);
    } catch (err) {
      setError(err instanceof ConnectorError ? err.envelope : null);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (agent: AgentView) => {
    setBusy(true);
    try {
      // a hosted slot is munni's container: it is given back, never revoked
      if (agent.hosted) await connectorApi.giveBackPrivateAgent();
      else await connectorApi.revokeAgent(agent.id);
      await reload();
    } finally {
      setBusy(false);
      setRevoking(null);
    }
  };

  const askPrivate = async () => {
    setBusy(true);
    try {
      await connectorApi.requestPrivateAgent();
      await reload();
    } catch (err) {
      setError(err instanceof ConnectorError ? err.envelope : null);
    } finally {
      setBusy(false);
    }
  };

  const withdrawPrivate = async (requestId: string) => {
    setBusy(true);
    try {
      await connectorApi.withdrawPrivateRequest(requestId);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  /** the private card's lower half: the slot held, the wait, or the ask */
  const privateBody = (standing: PrivateAgentStatus) => {
    if (standing.agent) {
      return (
        <p className="mt-2 text-[12px] leading-relaxed text-ink-2" data-testid="agents-private-held">
          {t('agents.private.held', { name: standing.agent.name })}
        </p>
      );
    }
    const request = standing.request;
    if (request?.state === 'pending') {
      return (
        <div className="mt-2 flex items-center gap-3">
          <p className="min-w-0 flex-1 text-[12px] text-ink-2" data-testid="agents-private-pending">
            {t('agents.private.pending')}
          </p>
          <Button size="sm" variant="outline" data-testid="agents-private-withdraw" disabled={busy} onClick={() => void withdrawPrivate(request.id)}>
            {t('agents.private.withdraw')}
          </Button>
        </div>
      );
    }
    const denied = request?.state === 'denied';
    return (
      <div className="mt-2 flex items-center gap-3">
        <p className="min-w-0 flex-1 text-[12px] text-ink-4" data-testid="agents-private-free">
          {denied ? `${t('agents.private.denied')} ` : ''}
          {standing.free > 0 ? t('agents.private.free', { n: standing.free }) : t('agents.private.noneFree')}
        </p>
        <Button size="sm" data-testid="agents-private-request" disabled={busy} onClick={() => void askPrivate()}>
          {denied ? t('agents.private.again') : t('agents.private.request')}
        </Button>
      </div>
    );
  };

  const closeEnrol = () => {
    setEnrolOpen(false);
    setEnrollment(null);
    setName('');
    setAttempted(false);
  };

  const health = (agent: AgentView) => {
    if (agent.revoked) return <Pill testId={`agent-health-${agent.id}`}>{t('agents.revoked')}</Pill>;
    if (agent.stale) return <Pill tone="warning" testId={`agent-health-${agent.id}`}>{t('agents.stale')}</Pill>;
    if (agent.online) return <Pill tone="accent" testId={`agent-health-${agent.id}`}>{t('agents.online')}</Pill>;
    return <Pill tone="warning" testId={`agent-health-${agent.id}`}>{t('agents.offline')}</Pill>;
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-agents">
      <AppBar
        title={t('agents.title')}
        leading={
          <IconButton label={t('action.back')} testId="agents-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
        trailing={<HelpButton tourId="connections" />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="flex items-start gap-3 rounded-card border border-line bg-surface px-4 py-3" data-testid="agents-what">
          <Icon name="desktop-classic" size={18} color="var(--m-accent-deep)" />
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink-2">{t('agents.what')}</p>
        </div>

        {!signedIn && (
          <p className="mt-2 px-1 text-[12px] text-ink-4" data-testid="agents-signin-note">
            {t('conn.signInNote')}
          </p>
        )}
        {signedIn && offered === false && (
          <p className="mt-2 px-1 text-[12px] text-ink-4" data-testid="agents-not-offered">
            {t('agents.notOffered')}
          </p>
        )}
        {error && (
          <p className="mt-2 px-1 text-[12px] text-negative" data-testid="agents-error">
            {t(errorKey(error.code))}
          </p>
        )}

        {agents && agents.length > 0 && (
          <>
            <div className="m-cap mt-4 mb-1 px-1">{t('agents.yours')}</div>
            <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="agents-list">
              {agents.map((agent) => (
                <div key={agent.id} className="border-b border-line-2 px-4 py-3.5 last:border-0" data-testid={`agent-${agent.id}`}>
                  <div className="flex items-center gap-3">
                    <Icon name="desktop-classic" size={20} color={agent.online ? 'var(--m-accent-deep)' : 'var(--m-ink-3)'} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[15px] text-ink">{agent.name}</span>
                        {health(agent)}
                        {agent.hosted && (
                          <Pill testId={`agent-hosted-${agent.id}`}>{t('agents.hosted')}</Pill>
                        )}
                      </span>
                      <span className="block text-[11px] text-ink-4">
                        {agent.lastHeartbeatAt ? t('agents.lastSeen', { when: fmtTimeAgo(agent.lastHeartbeatAt, lang) }) : t('agents.neverSeen')}
                      </span>
                    </span>
                    {!agent.revoked && (
                      <Button size="sm" variant="outline" data-testid={`agent-revoke-${agent.id}`} disabled={busy} onClick={() => setRevoking(agent)}>
                        {agent.hosted ? t('agents.giveBack') : t('agents.revoke')}
                      </Button>
                    )}
                  </div>
                  {agent.profiles.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1 pl-9" data-testid={`agent-profiles-${agent.id}`}>
                      {agent.profiles.map((profile) => (
                        <span key={profile.id} className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${profile.healthy ? 'bg-accent-soft text-accent-deep' : 'bg-warning-soft text-warning'}`}>
                          {profile.provider}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {signedIn && offered && (
          <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface">
            <div className="flex items-center gap-3 px-4 py-3.5" data-testid="agents-add">
              <Icon name="plus-circle-outline" size={20} color="var(--m-ink-3)" />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] text-ink">{t('agents.add')}</span>
                <span className="block text-[12px] text-ink-4">{t('agents.addSub')}</span>
              </span>
              <Button size="sm" data-testid="agents-add-open" onClick={() => setEnrolOpen(true)}>
                {t('agents.enrol')}
              </Button>
            </div>
          </div>
        )}

        {/* a hosted private agent (#420 A2): munni's own browser for this person alone, handed out by the admin on request */}
        {signedIn && hosted?.offered && (
          <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface px-4 py-3.5" data-testid="agents-private">
            <div className="flex items-start gap-3">
              <Icon name="desktop-classic" size={20} color="var(--m-accent-deep)" />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] text-ink">{t('agents.private.title')}</span>
                <span className="block text-[12px] leading-relaxed text-ink-4">{t('agents.private.what')}</span>
              </span>
            </div>
            {privateBody(hosted)}
          </div>
        )}
      </div>

      {/* enrol: a name, then the code and the line that starts the agent */}
      <Sheet open={enrolOpen} onOpenChange={(open) => !open && closeEnrol()} title={t('agents.enrolTitle')} size="tall">
        <div className="flex flex-col gap-3 pt-1">
          {enrollment ? (
            <>
              <p className="text-[13px] leading-relaxed text-ink-2">{t('agents.pasteLine')}</p>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-card bg-bg-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink" data-testid="agents-compose">
                {enrollment.composeCommand ?? enrollment.code}
              </pre>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  data-testid="agents-copy"
                  onClick={() => void copyText(enrollment.composeCommand ?? enrollment.code).then(setCopied)}
                >
                  <Icon name="content-copy" size={16} />
                  {copied ? t('agents.copied') : t('agents.copy')}
                </Button>
              </div>
              <p className="text-[12px] leading-relaxed text-ink-3" data-testid="agents-code-note">
                {t('agents.codeNote', { code: enrollment.code, when: fmtTimeAgo(enrollment.expiresAt, lang) })}
              </p>
              <Button data-testid="agents-enrol-done" onClick={closeEnrol}>
                {t('agents.done')}
              </Button>
            </>
          ) : (
            <>
              <p className="text-[13px] leading-relaxed text-ink-2">{t('agents.enrolHint')}</p>
              <input
                data-testid="agents-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('agents.namePlaceholder')}
                aria-invalid={attempted && !name.trim()}
                className={`${INPUT}${blockerRing(attempted && !name.trim())}`}
              />
              <FormBlockerNote show={attempted && !name.trim()} text={t('form.needName')} testId="agents-name-blocker" />
              <Button data-testid="agents-enrol" disabled={busy} onClick={() => void enrol()}>
                {t('agents.enrol')}
              </Button>
            </>
          )}
        </div>
      </Sheet>

      <DangerConfirmSheet
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={revoking?.hosted ? t('agents.giveBack') : t('agents.revoke')}
        body={t(revoking?.hosted ? 'agents.giveBackNote' : 'agents.revokeNote', { name: revoking?.name ?? '' })}
        onConfirm={() => revoking && void revoke(revoking)}
        testId="agent-revoke"
      />
    </div>
  );
}
