import { useEffect, useReducer, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import type { Lang, TranslationKey } from '@/i18n';
import type { ConnectorConnRow } from '@/db/types';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { connectorsAvailable, useConnectionOps, useConnections, useConnectorAccounts, useFetchedRanges, useLiveConnectionIds } from '@/application/connections';
import { uncoveredSince } from '@/domain/accountCoverage';
import { uncoveredDateText } from '@/features/accounts/coverage';
import type { AdoptResult, ConnectionView, ConnectorAccountView } from '@/application/connections';
import { setSpaceAttachIntent } from '@/features/accounts/openHandoff';
import { fmtTimeAgo } from '@/lib/text';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { FormBlockerNote, blockerRing } from '@/ui/FormBlockerNote';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { CatalogueSheet } from './CatalogueSheet';
import { takeCatalogueIntent } from './catalogueIntent';
import { ChallengeCard } from './ChallengeCard';
import { ConnectFlowSheet, forgetTypedValues } from './ConnectFlowSheet';
import type { ResumeLogin } from './ConnectFlowSheet';
import { connectorApi } from './api';
import { usePendingLoginFollower, usePendingLogins } from './pendingLogins';
import type { PendingLogin } from './pendingLogins';
import { ConnectionSheet } from './ConnectionSheet';
import { rangeLine } from './ConnectionReceiptsScreen';
import { SpacePicker } from './SpacePicker';
import { RESULT_TTL_MS, resultStillFresh, useSyncActivity } from './syncActivity';
import { ReportAsk } from './ReportAsk';
import { ConnectionSyncCard } from './ConnectionSyncCard';
import type { SyncReport } from './connectorSync';
import { kindIcon, partyLogo, partyName } from './logos';
import { errorKey } from './manifestForm';
import type { BindingView, JobView, ProviderKind, ProviderManifest } from './types';
import { useCatalogue, useRelayBindings } from './useCatalogue';

/** the hub's sections, in the order they read */
const SECTIONS: { kind: ProviderKind; captionKey: 'conn.banks' | 'conn.shops' | 'conn.registries' }[] = [
  { kind: 'bank', captionKey: 'conn.banks' },
  { kind: 'store', captionKey: 'conn.shops' },
  { kind: 'registry', captionKey: 'conn.registries' },
];

type Translate = ReturnType<typeof useLang>['t'];

/** what a settled sync brought: bank rows first, else receipts, then what the matcher did with them */
function okLine(state: SyncReport, t: Translate): string {
  let text: string;
  if (state.transactions > 0 || state.accounts > 0) {
    text = t('conn.syncAddedTx', { n: state.transactions });
    if (state.accounts > 0) text += ` · ${t('conn.syncAccounts', { n: state.accounts })}`;
  } else {
    text = state.added > 0 ? t('conn.syncAdded', { n: state.added }) : t('conn.syncNone');
  }
  if (state.linked > 0) text += ` · ${t('conn.syncLinked', { n: state.linked })}`;
  if (state.proposed > 0) text += ` · ${t('conn.syncProposed', { n: state.proposed })}`;
  if (state.partial) text += ` · ${t('conn.syncPartial')}`;
  return text;
}

const REFUSAL_KEYS: Partial<Record<SyncReport['status'], TranslationKey>> = {
  signin: 'conn.state.signIn',
  blocked: 'conn.state.blocked',
  wait: 'conn.state.wait',
  asking: 'conn.state.asking',
};

/** a sync attempt's outcome, spoken out loud */
function SyncResultLine({ id, state, found }: Readonly<{ id: string; state: 'busy' | SyncReport; found?: number | null }>) {
  const { t } = useLang();
  if (state === 'busy') {
    return (
      <span className="block text-[11px] text-accent-deep" data-testid={`conn-syncing-${id}`}>
        {found == null ? t('conn.syncBusy') : t('conn.syncFound', { n: found })}
      </span>
    );
  }
  const ok = state.status === 'ok';
  const text = ok ? okLine(state, t) : t(REFUSAL_KEYS[state.status] ?? errorKey(state.error?.code));
  return (
    <span className={`block text-[11px] ${ok ? 'text-accent-deep' : 'text-negative'}`} data-testid={`conn-result-${id}`}>
      {text}
    </span>
  );
}

interface StateLine {
  text: string;
  warn: boolean;
}

/** what the relay heard last, where it knows more than this device; null where it does not */
function relayLine(binding: BindingView | undefined, t: Translate, lang: Lang): StateLine | null {
  if (!binding) return null;
  if (binding.state === 'awaiting_input') return { text: t('conn.state.asking'), warn: true };
  if (binding.state === 'needs_reauth') return { text: t('conn.state.reconnect'), warn: true };
  if (binding.state === 'blocked') return { text: t('conn.state.blocked'), warn: true };
  if (!binding.scheduled) return null;
  if (binding.lastScheduleError) return { text: t('conn.state.scheduledError', { what: t(errorKey(binding.lastScheduleError)) }), warn: true };
  const text = binding.lastScheduledSyncAt ? t('conn.state.scheduled', { when: fmtTimeAgo(binding.lastScheduledSyncAt, lang) }) : t('conn.state.scheduledSoon');
  return { text, warn: false };
}

/** the party asked for a pause — with the moment it is over when the relay said how long (user question 2026-10-01: "what does the pause mean?") */
function pauseLine(error: NonNullable<ConnectorConnRow['lastError']>, t: Translate, lang: Lang): string {
  if (!error.at || !error.retryAfterSeconds) return t('conn.state.wait');
  const until = new Date(Date.parse(error.at) + error.retryAfterSeconds * 1000);
  if (until.getTime() <= Date.now()) return t('conn.state.wait');
  return t('conn.state.waitUntil', { time: until.toLocaleString(LOCALES[lang], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) });
}

/** a sign-in in flight: where it stands, in one line */
function pendingLine(login: PendingLogin, t: Translate): StateLine {
  if (login.error) return { text: t('conn.pending.failed'), warn: true };
  if (login.asking) return { text: t('conn.pending.asking'), warn: true };
  return { text: t('conn.pending.signingIn'), warn: false };
}

/** what this device knows about the connection */
function deviceLine(view: ConnectionView, t: Translate, lang: Lang): StateLine {
  const { device, meta, hasBundle } = view;
  if (!device) return meta.status === 'expired' ? { text: t('conn.state.reconnect'), warn: true } : { text: t('conn.state.elsewhere'), warn: false };
  if (device.state === 'blocked') return { text: t('conn.state.blocked'), warn: true };
  if (device.state === 'awaiting_input') return { text: t('conn.state.asking'), warn: true };
  if (device.state !== 'active' || meta.status === 'expired') return { text: t('conn.state.reconnect'), warn: true };
  if (!hasBundle) return { text: t('conn.state.signIn'), warn: true };
  if (device.lastError?.code === 'rate_limited') return { text: pauseLine(device.lastError, t, lang), warn: false };
  const text = device.lastSyncAt ? t('conn.state.synced', { when: fmtTimeAgo(device.lastSyncAt, lang) }) : t('conn.state.neverSynced');
  return { text, warn: false };
}

/** a job's question while a sync runs from the hub */
interface JobAsk {
  job: JobView;
  provider: string;
  resolve: (value: string | null) => void;
}

const accountTail = (account: ConnectorAccountView['account']): string =>
  account.iban ? `…${account.iban.slice(-4)}` : (account.maskedNumber ?? '');

/** #441 L1: the failed job whose picture still waits on the person's word — this device's, else the relay's */
const pendingQuestionOf = (view: ConnectionView, binding: BindingView | undefined): string | undefined =>
  view.device?.lastError?.artifactsJobId ?? binding?.artifactsJobId ?? undefined;

/** the questions a standing "always report" answered this page load — once per job, so a row that
 *  keeps its id a moment longer (the relay's copy stays until the next load) never shares twice */
const autoAnswered = new Set<string>();

/**
 * Settings → Connections (#367, the hub): every party the user connected,
 * as cards with the party's status and the connection's state, one
 * primary action per state, the spaces a shop's receipts flow into or
 * the accounts a bank handed over — and the catalogue to connect one
 * more. Banks and shops; registries join with their slice.
 */
export function ConnectionsScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store, spaceId } = useData();
  const connections = useConnections();
  const bankAccounts = useConnectorAccounts();
  const ops = useConnectionOps();
  const catalogue = useCatalogue();
  const bindings = useRelayBindings();
  // #445: which connections still exist - an account stamped with a gone one is not fetched any more
  const liveIds = useLiveConnectionIds();
  const { connect: connectParam } = useSearch({ strict: false }) as { connect?: string };
  const allSpaces = useQuery(store, async () => (await store.allRows('space')).filter((s) => s.deleted === 0), []);
  const links = useQuery(store, async () => (await store.allRows('storeConnLink')).filter((l) => l.deleted === 0), []);

  // an accounts screen's Connect door arrives with the catalogue already open (#414)
  const [catalogueOpen, setCatalogueOpen] = useState(() => takeCatalogueIntent());
  const [flow, setFlow] = useState<{ manifest: ProviderManifest; reconnectId: string | null; resume?: ResumeLogin } | null>(null);
  // sign-ins in flight (closed sheets included): followed here and adopted when they settle
  const pendingLogins = usePendingLogins((s) => s.logins);
  const forgetPending = usePendingLogins((s) => s.remove);
  const [naming, setNaming] = useState<{ connectionId: string; duplicateOf?: string } | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [manageId, setManageId] = useState<string | null>(null);
  // the step after naming a shop: which spaces its receipts reach (none until picked, user ruling 2026-10-02)
  const [spacesStep, setSpacesStep] = useState<{ connectionId: string; picked: string[] } | null>(null);
  const [ask, setAsk] = useState<JobAsk | null>(null);
  // #441 L1: answers given to "report this failure?" this visit (the relay's copy refreshes on the next load)
  const [reportAnswers, setReportAnswers] = useState<Record<string, 'yes' | 'no'>>({});
  // every sync in flight or just finished, whoever started it; the rows read it
  const activity = useSyncActivity((s) => s.activity);
  const ranges = useFetchedRanges();

  // a finished sync's result leaves the row after a while: re-render when the soonest one expires
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const waits = Object.values(activity)
      .filter((a) => a.phase === 'done')
      .map((a) => (a.finishedAt ?? 0) + RESULT_TTL_MS - Date.now())
      .filter((ms) => ms > 0);
    if (waits.length === 0) return undefined;
    const handle = setTimeout(tick, Math.min(...waits) + 50);
    return () => clearTimeout(handle);
  }, [activity]);

  const signedIn = connectorsAvailable();

  // user 2026-10-07: "Always report" means never asked — a question under a card whose
  // connection carries the standing answer is answered yes here, the moment it lands
  useEffect(() => {
    if (!signedIn) return;
    for (const view of connections ?? []) {
      const jobId = pendingQuestionOf(view, bindings.get(view.meta.id));
      if (!jobId || !view.device?.reportFailures || autoAnswered.has(jobId)) continue;
      autoAnswered.add(jobId);
      setReportAnswers((s) => ({ ...s, [jobId]: 'yes' }));
      void ops.answerReport(view.meta.id, jobId, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the rows and the relay's word are the inputs; ops is rebuilt every render
  }, [connections, bindings, signedIn]);

  // #445: party-fed accounts no live connection fetches, whose party has no card to sit under
  const orphaned = (bankAccounts ?? [])
    .map(({ account }) => ({ account, since: liveIds ? uncoveredSince(account, liveIds) : null }))
    .filter((entry): entry is { account: typeof entry.account; since: string } => entry.since !== null)
    .filter(({ account }) => !(connections ?? []).some((view) => view.meta.store === (account.provider ?? account.source)));
  const managed = connections?.find((c) => c.meta.id === manageId) ?? null;
  const spaceNames = new Map((allSpaces ?? []).map((s) => [s.id, s.name]));
  const kindOf = (view: ConnectionView): ProviderKind => view.meta.kind ?? catalogue.byId.get(view.meta.store)?.kind ?? 'store';

  const runSync = async (view: ConnectionView) => {
    // the row follows the sync through the activity store, wherever it was started
    await ops.syncNow(view.meta.id, {
      // a question mid-fetch is asked right here — a human is present
      onChallenge: (job) => new Promise<string | null>((resolve) => setAsk({ job, provider: view.meta.store, resolve })),
    });
    setAsk(null);
  };

  const afterConnect = async (result: AdoptResult, reconnect: boolean) => {
    setFlow(null);
    if (reconnect) return;
    // fresh connection: ask for a display name right away (user ruling)
    const meta = (await store.allRows('storeConn')).find((c) => c.id === result.connectionId);
    setNameDraft(meta?.displayName ?? '');
    setAttempted(false);
    setNaming({ connectionId: result.connectionId, duplicateOf: result.duplicateOf });
  };

  const saveName = async () => {
    if (!naming) return;
    const named = naming.connectionId;
    await ops.rename(named, nameDraft);
    setNaming(null);
    // a shop's receipts reach no space until picked (user ruling 2026-10-02): the step follows the name
    const meta = (await store.allRows('storeConn')).find((c) => c.id === named && c.deleted === 0);
    const kind = meta?.kind ?? (meta ? catalogue.byId.get(meta.store)?.kind : undefined) ?? 'store';
    if (meta && kind === 'store' && (allSpaces ?? []).length > 0) setSpacesStep({ connectionId: named, picked: [] });
  };

  const saveSpaces = async () => {
    if (!spacesStep) return;
    if (spacesStep.picked.length > 0) await ops.setIncludedSpaces(spacesStep.connectionId, spacesStep.picked);
    setSpacesStep(null);
  };

  const togglePicked = (spaceId: string) =>
    setSpacesStep((step) => step && { ...step, picked: step.picked.includes(spaceId) ? step.picked.filter((id) => id !== spaceId) : [...step.picked, spaceId] });

  const openFlow = (manifest: ProviderManifest, reconnectId: string | null) => {
    setCatalogueOpen(false);
    setFlow({ manifest, reconnectId });
  };

  /** user 2026-10-07: the manage sheet's "Sign in again" — the card's own reconnect door, for any connection not mid-sign-in */
  const signInAgainFor = (view: ConnectionView): (() => void) | undefined => {
    const manifest = catalogue.byId.get(view.meta.store);
    if (!signedIn || !manifest || pendingLogins[view.meta.id]) return undefined;
    return () => openFlow(manifest, view.meta.id);
  };

  // #445: an accounts sheet's "Reconnect <party>" door arrives with the party
  // named in the URL - the flow opens for it at once, and the name leaves the URL
  useEffect(() => {
    if (!connectParam || !signedIn) return;
    const manifest = catalogue.byId.get(connectParam);
    if (!manifest) return;
    openFlow(manifest, null);
    void navigate({ to: '/connections', replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the manifest map is the only input that changes
  }, [connectParam, catalogue.byId]);

  /** back into a sign-in that was closed mid-way */
  const continueLogin = (login: PendingLogin) => {
    const manifest = catalogue.byId.get(login.provider);
    if (!manifest) return;
    setFlow({ manifest, reconnectId: login.reconnect ? login.connectionId : null, resume: { connectionId: login.connectionId, sessionId: login.sessionId, reconnect: login.reconnect } });
  };

  const cancelLogin = (login: PendingLogin) => {
    if (!login.error) void connectorApi.cancel(login.provider, login.sessionId).catch(() => undefined);
    forgetPending(login.connectionId);
  };

  // a sign-in that settles while its sheet is closed is adopted right here
  usePendingLoginFollower({
    exclude: flow?.resume?.connectionId ?? null,
    onActive: async (login, view) => {
      const manifest = catalogue.byId.get(login.provider);
      if (!manifest) return;
      const full = view.bundle ? view : await connectorApi.login(login.provider, view.sessionId);
      const result = await ops.adopt({ manifest, view: full, connectionId: login.connectionId, reconnect: login.reconnect });
      forgetTypedValues(login.reconnect ? login.connectionId : null, login.provider);
      await afterConnect(result, login.reconnect);
    },
  });

  /** the attach step on the active space's accounts screen, the account already picked (#310) */
  const attach = (accountId: string) => {
    setSpaceAttachIntent(accountId);
    void navigate({ to: '/spaces/$spaceId/accounts', params: { spaceId } });
  };

  const stateLine = (view: ConnectionView) => {
    const running = activity[view.meta.id];
    if (running?.phase === 'fetching') return <SyncResultLine id={view.meta.id} state="busy" found={running.found} />;
    if (resultStillFresh(running)) return <SyncResultLine id={view.meta.id} state={running.report} />;
    // a sign-in in flight for this connection outranks every other word
    const inFlight = pendingLogins[view.meta.id];
    if (inFlight) {
      const line = pendingLine(inFlight, t);
      return (
        <span className={`block text-[11px] ${line.warn ? 'text-warning' : 'text-ink-4'}`} data-testid={`conn-state-${view.meta.id}`}>
          {line.text}
        </span>
      );
    }
    // what the relay heard last wins where it knows more than this device: a
    // question the scheduler left, a session it found dead, a sync it ran itself
    const line = relayLine(bindings.get(view.meta.id), t, lang) ?? deviceLine(view, t, lang);
    return (
      <span className={`block text-[11px] ${line.warn ? 'text-warning' : 'text-ink-4'}`} data-testid={`conn-state-${view.meta.id}`}>
        {line.text}
      </span>
    );
  };

  /** how far the fetches reach — the dates covered and the count — under the state (user request 2026-10-02) */
  const rangeOf = (view: ConnectionView) =>
    kindOf(view) === 'registry' ? null : (
      <span className="block text-[11px] text-ink-4" data-testid={`conn-range-${view.meta.id}`}>
        {rangeLine(ranges?.[view.meta.id], t, lang)}
      </span>
    );

  /** the one action a state asks for */
  const primaryAction = (view: ConnectionView) => {
    if (!signedIn) return null;
    const manifest = catalogue.byId.get(view.meta.store);
    const reconnect = (label: string) =>
      manifest ? (
        <Button size="sm" variant="outline" data-testid={`conn-signin-${view.meta.id}`} onClick={() => openFlow(manifest, view.meta.id)}>
          {label}
        </Button>
      ) : null;
    const inFlight = pendingLogins[view.meta.id];
    if (inFlight) {
      return (
        <Button size="sm" variant="outline" data-testid={`conn-continue-${view.meta.id}`} onClick={() => continueLogin(inFlight)}>
          {t('conn.pending.continue')}
        </Button>
      );
    }
    if (view.device?.state === 'blocked') return null;
    if (view.device?.state !== 'active' || view.meta.status === 'expired') return reconnect(t('conn.reconnect'));
    if (!view.hasBundle) return reconnect(t('conn.signIn'));
    return (
      <button
        data-testid={`conn-sync-${view.meta.id}`}
        onClick={() => void runSync(view)}
        className="m-tap border-none bg-transparent text-[12px] font-medium text-accent-deep"
      >
        {t('conn.syncNow')}
      </button>
    );
  };

  /** a shop's receipts flow into these spaces */
  const usedIn = (view: ConnectionView) => {
    const names = (links ?? []).filter((l) => l.instanceId === view.meta.id).map((l) => spaceNames.get(l.spaceId) ?? '').filter(Boolean);
    if (names.length === 0) return null;
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-9" data-testid={`conn-usedin-${view.meta.id}`}>
        <span className="text-[10px] text-ink-4">{t('conn.usedIn')}</span>
        {names.map((name) => (
          <span key={name} className="rounded-full bg-bg-2 px-2 py-0.5 text-[10px] font-medium text-ink-3">
            {name}
          </span>
        ))}
      </div>
    );
  };

  /** a bank's accounts, each with where it is attached and the door to attach it here */
  const accountsOf = (view: ConnectionView) => {
    const mine = (bankAccounts ?? []).filter((a) => a.account.provider === view.meta.store);
    return (
      <div className="mt-1.5 pl-9" data-testid={`conn-accounts-${view.meta.id}`}>
        {mine.length === 0 ? (
          <span className="block text-[11px] text-ink-4">{t('conn.noAccountsYet')}</span>
        ) : (
          mine.map(({ account, attachedTo }) => {
            const here = attachedTo.some((s) => s.spaceId === spaceId);
            const since = liveIds ? uncoveredSince(account, liveIds) : null;
            return (
              <div key={account.id} className="flex items-center gap-2 py-1" data-testid={`conn-account-${account.id}`}>
                <Icon name="bank-outline" size={14} color="var(--m-ink-4)" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-ink">
                    {account.name} <span className="text-ink-4">{accountTail(account)}</span>
                  </span>
                  {/* #445: the connection that fetched this row is gone - a new consent that reaches it lands on the same row */}
                  {since !== null && (
                    <span className="block text-[11px] text-warning" data-testid={`conn-account-uncovered-${account.id}`}>
                      {t('acct.uncovered', { date: uncoveredDateText(since, lang), party: partyName(view.meta.store) })}
                    </span>
                  )}
                  {attachedTo.length > 0 && (
                    <span className="flex flex-wrap gap-1" data-testid={`conn-account-usedin-${account.id}`}>
                      {attachedTo.map((s) => (
                        <span key={s.spaceId} className="rounded-full bg-bg-2 px-2 py-0.5 text-[10px] font-medium text-ink-3">
                          {s.name}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                {signedIn && !here && (
                  <Button size="sm" variant="outline" data-testid={`conn-attach-${account.id}`} onClick={() => attach(account.id)}>
                    {t('conn.attachTo', { space: spaceNames.get(spaceId) ?? '' })}
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>
    );
  };

  /** a sign-in in flight for a connection that does not exist yet: where it stands, the way back in, the way out */
  const renderPending = (login: PendingLogin) => {
    const manifest = catalogue.byId.get(login.provider);
    const line = pendingLine(login, t);
    const logo = partyLogo(manifest?.logoRef);
    return (
      <div key={login.connectionId} className="border-b border-line-2 px-4 py-3.5 last:border-0" data-testid={`conn-pending-${login.connectionId}`}>
        <div className="flex items-center gap-3">
          {logo ? <img src={logo} alt="" className="h-6 w-6 rounded object-contain" /> : <Icon name="progress-clock" size={20} color="var(--m-ink-3)" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] text-ink">{manifest?.name ?? login.provider}</span>
            <span className={`block text-[11px] ${line.warn ? 'text-warning' : 'text-ink-4'}`} data-testid={`conn-pending-state-${login.connectionId}`}>
              {line.text}
            </span>
          </span>
          {!login.error && (
            <Button size="sm" variant="outline" data-testid={`conn-pending-continue-${login.connectionId}`} onClick={() => continueLogin(login)}>
              {t('conn.pending.continue')}
            </Button>
          )}
          <button
            data-testid={`conn-pending-cancel-${login.connectionId}`}
            aria-label={login.error ? t('conn.pending.dismiss') : t('conn.pending.cancel')}
            onClick={() => cancelLogin(login)}
            className="m-tap border-none bg-transparent text-ink-4"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
      </div>
    );
  };

  /** #441 L1: a failed run left a picture that waits on the person's word — asked once, under the card */
  const reportAsk = (view: ConnectionView) => {
    const jobId = pendingQuestionOf(view, bindings.get(view.meta.id));
    if (!jobId || !signedIn) return null;
    // a standing "always report" reads as answered from the first paint — the effect above sends it
    const answered = reportAnswers[jobId] ?? (view.device?.reportFailures ? 'yes' : null);
    return (
      <div className="mt-2 pl-9">
        <ReportAsk
          testId={`conn-report-${view.meta.id}`}
          answered={answered}
          busy={false}
          onAnswer={(share) => {
            setReportAnswers((s) => ({ ...s, [jobId]: share ? 'yes' : 'no' }));
            void ops.answerReport(view.meta.id, jobId, share);
          }}
        />
      </div>
    );
  };

  const renderCard = (view: ConnectionView) => {
    const manifest = catalogue.byId.get(view.meta.store);
    const kind = kindOf(view);
    const logo = view.meta.icon ?? partyLogo(manifest?.logoRef);
    const healthy = view.device?.state === 'active' && view.hasBundle;
    return (
      <div key={view.meta.id} className="border-b border-line-2 px-4 py-3.5 last:border-0" data-testid={`conn-card-${view.meta.id}`}>
        <div className="flex items-center gap-3">
          {logo ? (
            <img src={logo} alt="" className="h-6 w-6 rounded object-contain" />
          ) : (
            <Icon name={kindIcon(kind)} size={20} color={healthy ? 'var(--m-accent-deep)' : 'var(--m-ink-3)'} />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[15px] text-ink">{view.meta.displayName}</span>
              {healthy && <Icon name="check-circle" size={14} color="var(--m-accent-deep)" />}
              {manifest?.status.state === 'degraded' && (
                <span className="rounded-full bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold text-warning" data-testid={`conn-party-state-${view.meta.id}`}>
                  {t('conn.partyDegraded')}
                </span>
              )}
              {manifest?.status.state === 'paused' && (
                <span className="rounded-full bg-bg-2 px-1.5 py-0.5 text-[10px] font-semibold text-ink-4" data-testid={`conn-party-state-${view.meta.id}`}>
                  {t('conn.partyPaused')}
                </span>
              )}
            </span>
            {stateLine(view)}
            {rangeOf(view)}
          </span>
          {primaryAction(view)}
          <button
            data-testid={`conn-manage-${view.meta.id}`}
            aria-label={t('conn.manage')}
            onClick={() => setManageId(view.meta.id)}
            className="m-tap border-none bg-transparent text-ink-4"
          >
            <Icon name="dots-horizontal" size={18} />
          </button>
        </div>
        {kind === 'store' ? usedIn(view) : accountsOf(view)}
        {reportAsk(view)}
      </div>
    );
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-connections">
      <AppBar
        title={t('conn.title')}
        leading={
          <IconButton label={t('action.back')} testId="connections-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
        trailing={<HelpButton tourId="connections" />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="flex items-start gap-3 rounded-card border border-line bg-surface px-4 py-3" data-testid="conn-privacy">
          <Icon name="shield-lock-outline" size={18} color="var(--m-accent-deep)" />
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink-2">{t('conn.privacy')}</p>
        </div>

        {!signedIn && (
          <p className="mt-2 px-1 text-[12px] text-ink-4" data-testid="conn-signin-note">
            {t('conn.signInNote')}
          </p>
        )}

        {SECTIONS.map(({ kind, captionKey }) => {
          const rows = (connections ?? []).filter((c) => kindOf(c) === kind);
          // sign-ins in flight for connections that are not rows yet sit at the top of their section
          const known = new Set(rows.map((c) => c.meta.id));
          const starting = Object.values(pendingLogins).filter(
            (l) => !known.has(l.connectionId) && (catalogue.byId.get(l.provider)?.kind ?? 'store') === kind,
          );
          if (rows.length === 0 && starting.length === 0) return null;
          return (
            <div key={kind}>
              <div className="m-cap mt-4 mb-1 px-1">{t(captionKey)}</div>
              <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid={`conn-list-${kind}`}>
                {starting.map(renderPending)}
                {rows.map(renderCard)}
              </div>
            </div>
          );
        })}

        {/* #445: accounts whose party has no card left - the connection that fetched
            them is gone - still belong to the person: say so, and offer the way back */}
        {orphaned.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface" data-testid="conn-uncovered">
            <div className="px-4 pt-3.5 pb-1">
              <span className="block text-[15px] text-ink">{t('conn.uncoveredTitle')}</span>
              <span className="block text-[12px] text-ink-4">{t('conn.uncoveredBody')}</span>
            </div>
            {orphaned.map(({ account, since }) => {
              const party = account.provider ?? account.source;
              const manifest = catalogue.byId.get(party);
              return (
                <div key={account.id} className="flex items-center gap-3 border-t border-line-2 px-4 py-3" data-testid={`conn-uncovered-${account.id}`}>
                  <Icon name="bank-off-outline" size={18} color="var(--m-ink-4)" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink">
                      {account.name} <span className="text-ink-4">{accountTail(account)}</span>
                    </span>
                    <span className="block text-[11px] text-ink-4">{t('acct.uncovered', { date: uncoveredDateText(since, lang), party: partyName(party) })}</span>
                  </span>
                  {manifest && signedIn && (
                    <Button size="sm" data-testid={`conn-uncovered-reconnect-${account.id}`} onClick={() => openFlow(manifest, null)}>
                      {t('conn.reconnect')}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* the catalogue door — always visible, honest about sign-in */}
        <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface">
          <div className="flex items-center gap-3 px-4 py-3.5" data-testid="conn-add">
            <Icon name="plus-circle-outline" size={20} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] text-ink">{t('conn.add')}</span>
              <span className="block text-[12px] text-ink-4">{t('conn.addSub')}</span>
            </span>
            {signedIn ? (
              <Button size="sm" data-testid="conn-add-open" onClick={() => setCatalogueOpen(true)}>
                {t('conn.connect')}
              </Button>
            ) : (
              <span className="rounded-full bg-bg-2 px-2 py-0.5 text-[11px] font-medium text-ink-4">{t('conn.signInShort')}</span>
            )}
          </div>
        </div>

        {/* the household agents (§10.4): the parties that only talk to a browser on the person's own connection */}
        {signedIn && (
          <button
            data-testid="conn-agents"
            onClick={() => void navigate({ to: '/connections/agents' })}
            className="m-tap mt-3 flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3.5 text-left"
          >
            <Icon name="desktop-classic" size={20} color="var(--m-ink-2)" />
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] text-ink">{t('conn.agents')}</span>
              <span className="block text-[12px] text-ink-4">{t('conn.agentsSub')}</span>
            </span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
        )}

        {/* the hub's own receipts: everything the shops handed over, per connection (a space's Receipts carry the matching) */}
        <button
          data-testid="conn-view-receipts"
          onClick={() => void navigate({ to: '/connections/receipts' })}
          className="m-tap mt-3 flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3.5 text-left"
        >
          <Icon name="receipt-text-outline" size={20} color="var(--m-ink-2)" />
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] text-ink">{t('receipts.globalTitle')}</span>
            <span className="block text-[12px] text-ink-4">{t('receipts.globalSub')}</span>
          </span>
          <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
        </button>

        <p className="mt-3 px-1 text-[12px] text-ink-4" data-testid="conn-photo-note">
          {t('conn.photoNote')}
        </p>
        {signedIn && <ConnectionSyncCard />}
      </div>

      <CatalogueSheet
        open={catalogueOpen}
        onOpenChange={setCatalogueOpen}
        providers={catalogue.providers}
        loading={catalogue.loading}
        error={catalogue.error}
        onRetry={catalogue.reload}
        onPick={(manifest) => openFlow(manifest, null)}
      />

      <ConnectFlowSheet
        open={flow !== null}
        manifest={flow?.manifest ?? null}
        reconnectId={flow?.reconnectId ?? null}
        resume={flow?.resume ?? null}
        onOpenChange={(open) => !open && setFlow(null)}
        onDone={(result, reconnect) => void afterConnect(result, reconnect)}
      />

      {/* name-the-connection step right after a successful connect */}
      <Sheet
        open={naming !== null}
        onOpenChange={(open) => {
          if (open) return;
          setNaming(null);
          setAttempted(false);
        }}
        title={t('conn.nameTitle')}
        size="form"
      >
        <div className="flex flex-col gap-3 pt-1">
          <p className="text-[13px] leading-relaxed text-ink-2">{t('conn.nameHint')}</p>
          {naming?.duplicateOf && (
            <p className="rounded-card bg-warning-soft px-3 py-2 text-[12px] leading-relaxed text-ink-2" data-testid="conn-dup-note">
              {t('conn.duplicateNote')}
            </p>
          )}
          <input
            data-testid="conn-name-input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            aria-invalid={attempted && !nameDraft.trim()}
            className={`h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none${blockerRing(attempted && !nameDraft.trim())}`}
          />
          <FormBlockerNote show={attempted && !nameDraft.trim()} text={t('form.needName')} testId="conn-name-save-blocker" />
          <Button
            data-testid="conn-name-save"
            onClick={() => {
              if (!nameDraft.trim()) {
                setAttempted(true);
                return;
              }
              void saveName();
            }}
          >
            {t('action.save')}
          </Button>
        </div>
      </Sheet>

      {/* the step after naming: which spaces a shop's receipts reach — none until picked (user ruling 2026-10-02) */}
      <Sheet open={spacesStep !== null} onOpenChange={(open) => !open && setSpacesStep(null)} title={t('conn.spacesTitle')} size="tall">
        {spacesStep && (
          <div className="flex flex-col gap-3 pt-1" data-testid="conn-spaces-step">
            <p className="text-[13px] leading-relaxed text-ink-2">{t('conn.spacesHint')}</p>
            <SpacePicker spaces={allSpaces ?? []} selected={spacesStep.picked} onToggle={togglePicked} testId="conn-spaces-list" />
            <Button data-testid="conn-spaces-save" onClick={() => void saveSpaces()}>
              {t('action.save')}
            </Button>
            <Button variant="outline" data-testid="conn-spaces-skip" onClick={() => setSpacesStep(null)}>
              {t('conn.spacesSkip')}
            </Button>
          </div>
        )}
      </Sheet>

      {/* a party's question while a sync runs from here */}
      <Sheet
        open={ask !== null}
        onOpenChange={(open) => {
          if (open || !ask) return;
          ask.resolve(null);
          setAsk(null);
        }}
        title={t('conn.askTitle')}
        size="tall"
      >
        {ask?.job.challenge && (
          <div className="pt-1">
            <ChallengeCard provider={ask.provider} sessionId={ask.job.sessionId} challenge={ask.job.challenge} busy={false} onAnswer={(value) => ask.resolve(value)} />
          </div>
        )}
      </Sheet>

      {managed && (
        <ConnectionSheet
          view={managed}
          kind={kindOf(managed)}
          allSpaces={allSpaces ?? []}
          includedSpaceIds={(links ?? []).filter((l) => l.instanceId === managed.meta.id).map((l) => l.spaceId)}
          onSignInAgain={signInAgainFor(managed)}
          onClose={() => setManageId(null)}
        />
      )}
    </div>
  );
}
