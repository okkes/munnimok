import { useEffect, useMemo, useReducer, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import type { Lang, TranslationKey } from '@/i18n';
import type { ConnectorConnRow } from '@/db/types';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { useSession } from '@/app/session';
import {
  connectorsAvailable,
  mergedRange,
  useConnectionOps,
  useConnections,
  useConnectorAccounts,
  useFetchedRanges,
  useLiveConnectionIds,
  useMyFeedIds,
} from '@/application/connections';
import { fetchingConnectionIds, ownsFeed, uncoveredSince } from '@/domain/accountCoverage';
import { uncoveredDateText } from '@/features/accounts/coverage';
import type { ConnectionView, ConnectorAccountView } from '@/application/connections';
import { setSpaceAttachIntent } from '@/features/accounts/openHandoff';
import { fmtTimeAgo } from '@/lib/text';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Picture } from '@/ui/Picture';
import { Sheet } from '@/ui/Sheet';
import { BankPickerSheet } from './BankPickerSheet';
import { CatalogueSheet } from './CatalogueSheet';
import { takeCatalogueIntent } from './catalogueIntent';
import { ChallengeCard } from './ChallengeCard';
import { ConnectSteps } from './ConnectSteps';
import type { FlowRequest } from './ConnectSteps';
import { connectorApi } from './api';
import { usePendingLogins } from './pendingLogins';
import type { PendingLogin } from './pendingLogins';
import { ConnectionSheet } from './ConnectionSheet';
import { olderLine, rangeLine } from './ConnectionReceiptsScreen';
import { RESULT_TTL_MS, resultStillFresh, useSyncActivity } from './syncActivity';
import { ReportAsk } from './ReportAsk';
import { ConnectionSyncCard } from './ConnectionSyncCard';
import type { SyncReport } from './connectorSync';
import { kindIcon, partyLogo, partyName } from './logos';
import { errorKey } from './manifestForm';
import type { BindingView, JobView, ProviderKind, ProviderManifest } from './types';
import { useCatalogue, useRelayAccountLinks, useRelayBindingsRead } from './useCatalogue';
import { manageRouteFor, renewalOf } from './connectionRules';

/** the hub's sections, in the order they read */
const SECTIONS: { kind: ProviderKind; captionKey: 'conn.banks' | 'conn.shops' | 'conn.registries' }[] = [
  { kind: 'bank', captionKey: 'conn.banks' },
  { kind: 'store', captionKey: 'conn.shops' },
  { kind: 'registry', captionKey: 'conn.registries' },
];

/** #527: Connected services holds the shops and registries; the banks are managed with the accounts */
export const SERVICE_KINDS: readonly ProviderKind[] = ['store', 'registry'];
export const BANK_KINDS: readonly ProviderKind[] = ['bank'];

/** the deep links a hub answers: a party to connect (as a connection, to sign in again), a connection or an account to bring into view (#528) */
interface HubSearch {
  connect?: string;
  reconnect?: string;
  connection?: string;
  uncovered?: string;
}

/** #528: brings a card into view and flashes it once the smooth scroll settles (the accounts screen's own pulse) */
function flashIntoView(elementId: string): boolean {
  const target = document.getElementById(elementId);
  if (!target) return false;
  target.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  delete target.dataset.flash;
  globalThis.setTimeout(() => {
    target.dataset.flash = '1';
    globalThis.setTimeout(() => delete target.dataset.flash, 1600);
  }, 450);
  return true;
}

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
  if (state.olderPending) text += ` · ${t('conn.syncOlderLater')}`;
  return text;
}

const REFUSAL_KEYS: Partial<Record<SyncReport['status'], TranslationKey>> = {
  signin: 'conn.state.signIn',
  blocked: 'conn.state.blocked',
  wait: 'conn.state.wait',
  asking: 'conn.state.asking',
};

/** a sync attempt's outcome, spoken out loud */
function SyncResultLine({ id, state, found, older }: Readonly<{ id: string; state: 'busy' | SyncReport; found?: number | null; older?: string }>) {
  const { t, lang } = useLang();
  if (state === 'busy') {
    let busy = found == null ? t('conn.syncBusy') : t('conn.syncFound', { n: found });
    // #460: the sync went on to older history — how far back it reached so far
    if (older) busy = olderLine(older, t, lang);
    return (
      <span className="block text-[11px] text-accent-deep" data-testid={`conn-syncing-${id}`}>
        {busy}
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
 * The connections of some kinds (#367, the hub): every party the user
 * connected, as cards with the party's status and the connection's state,
 * one primary action per state, the spaces a shop's receipts flow into or
 * the accounts a bank handed over — and the door to connect one more.
 * #527: Connected services renders the shops and registries, All accounts
 * the banks (with a bank-only picker), on the same machinery.
 */
export function ConnectionHub({
  kinds,
  route,
  picker,
}: Readonly<{
  kinds: readonly ProviderKind[];
  /** the screen the hub sits on: a deep link's params are cleared back to it */
  route: '/connections' | '/accounts';
  /** a host whose own door (the Add-account chooser) opens the picker holds its state */
  picker?: { open: boolean; onOpenChange: (open: boolean) => void };
}>) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store, spaceId } = useData();
  const connections = useConnections();
  const bankAccounts = useConnectorAccounts();
  const ops = useConnectionOps();
  const catalogue = useCatalogue();
  // asked again once the set of connections changes: a fresh one is never read as dropped by the relay
  const connectionKey = (connections ?? []).map((view) => view.meta.id).join(',');
  const bindingsRead = useRelayBindingsRead(connectionKey);
  const bindings = useMemo(() => bindingsRead ?? new Map<string, BindingView>(), [bindingsRead]);
  /** #528: the session ended and only a new sign-in or consent revives it — the relay's word first (this device cannot see a consent end) */
  const ended = (view: ConnectionView): boolean =>
    renewalOf(view.meta, view.device, bindings.get(view.meta.id), bindingsRead !== undefined, catalogue.byId.get(view.meta.store)).ended;
  const banks = kinds.includes('bank');
  // #445: which connections still exist - an account stamped with a gone one is not fetched any more;
  // only for accounts the viewer's own connection feeds (a friend's ids are not in this device's set) -
  // the feed set says whose (user ss 2026-10-09), the attacher's name only while that set is out of reach
  const liveIds = useLiveConnectionIds();
  const myFeeds = useMyFeedIds();
  const identity = useSession((s) => s.identity);
  const mySub = identity?.kind === 'user' ? identity.sub : undefined;
  // every sync in flight or just finished, whoever started it; the rows read it
  const activity = useSyncActivity((s) => s.activity);
  // #524: which accounts each of the person's connections fetches, asked again after every finished sync
  const finishedSyncs = Object.values(activity).filter((a) => a.phase === 'done').length;
  const reachedBy = useRelayAccountLinks(finishedSyncs);
  const sinceOf = (view: ConnectorAccountView): string | null =>
    liveIds ? uncoveredSince(view.account, liveIds, ownsFeed(view.account.spaceId, myFeeds, view.attachedTo, mySub), Date.now(), reachedBy) : null;
  const search = useSearch({ strict: false }) as HubSearch;
  const { connect: connectParam, reconnect: reconnectParam } = search;
  const allSpaces = useQuery(store, async () => (await store.allRows('space')).filter((s) => s.deleted === 0), []);
  const links = useQuery(store, async () => (await store.allRows('storeConnLink')).filter((l) => l.deleted === 0), []);
  /** the kind of party an account was fetched by — a registry's positions live with Connected services */
  const partyKindOf = (provider: string | undefined): ProviderKind =>
    (provider ? (catalogue.byId.get(provider)?.kind ?? connections?.find((c) => c.meta.store === provider)?.meta.kind) : undefined) ?? 'bank';

  // an accounts screen's Connect door arrives with the bank picker already open (#414, #527); a host may hold it
  const [ownPicker, setOwnPicker] = useState(() => !picker && banks && takeCatalogueIntent());
  const catalogueOpen = picker?.open ?? ownPicker;
  const setCatalogueOpen = picker?.onOpenChange ?? setOwnPicker;
  const [flow, setFlow] = useState<FlowRequest | null>(null);
  // sign-ins in flight (closed sheets included): followed by the connect steps and adopted when they settle
  const pendingLogins = usePendingLogins((s) => s.logins);
  const forgetPending = usePendingLogins((s) => s.remove);
  const [manageId, setManageId] = useState<string | null>(null);
  const [ask, setAsk] = useState<JobAsk | null>(null);
  // #441 L1: answers given to "report this failure?" this visit (the relay's copy refreshes on the next load)
  const [reportAnswers, setReportAnswers] = useState<Record<string, 'yes' | 'no'>>({});
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

  // #445: party-fed accounts no live connection of the person's fetches any more — they sit under no card
  // (#524: a card lists only what its own connection fetches), so they are listed here, with the way back
  const orphaned = (bankAccounts ?? [])
    .filter((view) => kinds.includes(partyKindOf(view.account.provider ?? view.account.source)))
    .map((view) => ({ account: view.account, since: sinceOf(view) }))
    .filter((entry): entry is { account: typeof entry.account; since: string } => entry.since !== null);
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
  // named in the URL - the flow opens for it at once, and the name leaves the URL.
  // Prod 2026-10-08: it also names the connection the account was fetched by; while
  // that connection still exists here the sign-in runs AS it, so the server replaces
  // its session instead of scheduling a second one beside it (two sessions on one
  // consent shared the bank's daily budget, and the nightly sync "kept stopping")
  useEffect(() => {
    if (!connectParam || !signedIn) return;
    const manifest = catalogue.byId.get(connectParam);
    if (!manifest) return;
    // #527: a party another screen manages is connected there
    if (!kinds.includes(manifest.kind)) {
      void navigate({ to: manageRouteFor(manifest.kind), search: { connect: connectParam, reconnect: reconnectParam }, replace: true });
      return;
    }
    // the ids load a beat after the screen: a named connection waits for them rather than opening a fresh connect
    if (reconnectParam && liveIds === undefined) return;
    openFlow(manifest, reconnectParam && liveIds?.has(reconnectParam) ? reconnectParam : null);
    void navigate({ to: route, replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the manifest map and the live ids are the inputs that change
  }, [connectParam, reconnectParam, catalogue.byId, liveIds]);

  // #528: a reconnect door elsewhere names the connection (or the account no connection fetches any more):
  // it is brought into view and flashed, its own action right there — once the rows it names have rendered
  const focusId = search.connection ? `conn-row-${search.connection}` : search.uncovered && `conn-uncovered-row-${search.uncovered}`;
  const rendered = (connections?.length ?? 0) + orphaned.length;
  useEffect(() => {
    if (!focusId || !flashIntoView(focusId)) return;
    void navigate({ to: route, replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the rows rendering is what the effect waits for
  }, [focusId, rendered]);

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

  /** the attach step on the active space's accounts screen, the account already picked (#310) */
  const attach = (accountId: string) => {
    setSpaceAttachIntent(accountId);
    void navigate({ to: '/spaces/$spaceId/accounts', params: { spaceId } });
  };

  const stateLine = (view: ConnectionView) => {
    const running = activity[view.meta.id];
    if (running?.phase === 'fetching') return <SyncResultLine id={view.meta.id} state="busy" found={running.found} older={running.older} />;
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
    const binding = bindings.get(view.meta.id);
    // a consent the relay no longer keeps reads as one to renew, whatever this device last saw
    const gone = !binding && ended(view) ? { text: t('conn.state.reconnect'), warn: true } : null;
    const line = relayLine(binding, t, lang) ?? gone ?? deviceLine(view, t, lang);
    return (
      <span className={`block text-[11px] ${line.warn ? 'text-warning' : 'text-ink-4'}`} data-testid={`conn-state-${view.meta.id}`}>
        {line.text}
      </span>
    );
  };

  /** #524: the accounts this connection itself fetches — never every account its party fed */
  const fetchedBy = (view: ConnectionView) =>
    (bankAccounts ?? []).filter((entry) => fetchingConnectionIds(entry.account, reachedBy).includes(view.meta.id));

  /** how far the fetches reach — the dates covered and the count — under the state (user request 2026-10-02) */
  const rangeOf = (view: ConnectionView) => {
    const kind = kindOf(view);
    if (kind === 'registry') return null;
    const range = kind === 'bank' ? mergedRange(ranges, fetchedBy(view).map((entry) => entry.account.id)) : ranges?.[view.meta.id];
    return (
      <span className="block text-[11px] text-ink-4" data-testid={`conn-range-${view.meta.id}`}>
        {rangeLine(range, t, lang)}
      </span>
    );
  };

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
    if (view.device?.state !== 'active' || view.meta.status === 'expired' || ended(view)) return reconnect(t('conn.reconnect'));
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

  /** a bank's accounts — the ones this connection itself fetches (#524) — each with where it is attached and the door to attach it here */
  const accountsOf = (view: ConnectionView) => {
    const mine = fetchedBy(view);
    return (
      <div className="mt-1.5 pl-9" data-testid={`conn-accounts-${view.meta.id}`}>
        {mine.length === 0 ? (
          <span className="block text-[11px] text-ink-4">{t('conn.noAccountsYet')}</span>
        ) : (
          mine.map((entry) => {
            const { account, attachedTo } = entry;
            const here = attachedTo.some((s) => s.spaceId === spaceId);
            return (
              <div key={account.id} className="flex items-center gap-2 py-1" data-testid={`conn-account-${account.id}`}>
                <Icon name="bank-outline" size={14} color="var(--m-ink-4)" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-ink">
                    {account.name} <span className="text-ink-4">{accountTail(account)}</span>
                  </span>
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
          {logo ? <Picture src={logo} className="h-6 w-6 rounded object-contain" /> : <Icon name="progress-clock" size={20} color="var(--m-ink-3)" />}
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
      <div key={view.meta.id} id={`conn-row-${view.meta.id}`} className="border-b border-line-2 px-4 py-3.5 last:border-0" data-testid={`conn-card-${view.meta.id}`}>
        <div className="flex items-center gap-3">
          {logo ? (
            <Picture src={logo} className="h-6 w-6 rounded object-contain" />
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

  // All accounts stays quiet for an identity that can connect no bank and has none to show (demo, offline)
  const quiet = banks && !signedIn && (connections ?? []).length === 0 && orphaned.length === 0;

  return (
    <>
      <div data-testid={banks ? 'bank-connections' : 'service-connections'} hidden={quiet}>
        {!banks && (
          <div className="flex items-start gap-3 rounded-card border border-line bg-surface px-4 py-3" data-testid="conn-privacy">
            <Icon name="shield-lock-outline" size={18} color="var(--m-accent-deep)" />
            <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink-2">{t('conn.privacy')}</p>
          </div>
        )}

        {!signedIn && (
          <p className="mt-2 px-1 text-[12px] text-ink-4" data-testid="conn-signin-note">
            {t(banks ? 'conn.bankSignInNote' : 'conn.signInNote')}
          </p>
        )}

        {SECTIONS.filter(({ kind }) => kinds.includes(kind)).map(({ kind, captionKey }) => {
          const rows = (connections ?? []).filter((c) => kindOf(c) === kind);
          // sign-ins in flight for connections that are not rows yet sit at the top of their section
          const known = new Set(rows.map((c) => c.meta.id));
          const starting = Object.values(pendingLogins).filter(
            (l) => !known.has(l.connectionId) && (catalogue.byId.get(l.provider)?.kind ?? 'store') === kind,
          );
          if (rows.length === 0 && starting.length === 0) return null;
          return (
            <div key={kind}>
              <div className="m-cap mt-4 mb-1 px-1">{t(banks ? 'conn.bankConnections' : captionKey)}</div>
              <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid={`conn-list-${kind}`}>
                {starting.map(renderPending)}
                {rows.map(renderCard)}
              </div>
            </div>
          );
        })}

        {/* #445: accounts no connection of the person's fetches any more still belong
            to them: say so, and offer the way back */}
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
                <div
                  key={account.id}
                  id={`conn-uncovered-row-${account.id}`}
                  className="flex items-center gap-3 border-t border-line-2 px-4 py-3"
                  data-testid={`conn-uncovered-${account.id}`}
                >
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

        {/* the catalogue door — always visible, honest about sign-in; on All accounts the bank picker's */}
        <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface">
          <div className="flex items-center gap-3 px-4 py-3.5" data-testid="conn-add">
            <Icon name={banks ? 'bank-plus' : 'plus-circle-outline'} size={20} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] text-ink">{t(banks ? 'conn.addBank' : 'conn.add')}</span>
              <span className="block text-[12px] text-ink-4">{t(banks ? 'conn.addBankSub' : 'conn.addSub')}</span>
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
        {signedIn && !banks && (
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

        {!banks && (
          <>
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
          </>
        )}
      </div>

      {banks ? (
        <BankPickerSheet
          open={catalogueOpen}
          onOpenChange={setCatalogueOpen}
          providers={catalogue.providers}
          loading={catalogue.loading}
          error={catalogue.error}
          onRetry={catalogue.reload}
          onPick={(manifest) => openFlow(manifest, null)}
        />
      ) : (
        <CatalogueSheet
          open={catalogueOpen}
          onOpenChange={setCatalogueOpen}
          providers={catalogue.providers.filter((p) => kinds.includes(p.kind))}
          loading={catalogue.loading}
          error={catalogue.error}
          onRetry={catalogue.reload}
          onPick={(manifest) => openFlow(manifest, null)}
        />
      )}

      <ConnectSteps flow={flow} onFlowChange={setFlow} catalogue={catalogue} />

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
    </>
  );
}

/**
 * Settings → Connected services (#527, renamed from Connections): the shops
 * and registries. Banks are managed with the accounts (All accounts), on
 * the same machinery and the same relay.
 */
export function ConnectionsScreen() {
  const { t } = useLang();
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
        <ConnectionHub kinds={SERVICE_KINDS} route="/connections" />
      </div>
    </div>
  );
}
