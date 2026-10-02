import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import type { Lang, TranslationKey } from '@/i18n';
import type { ConnectorConnRow } from '@/db/types';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { connectorsAvailable, useConnectionOps, useConnections, useConnectorAccounts } from '@/application/connections';
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
import { ConnectFlowSheet } from './ConnectFlowSheet';
import type { ResumeLogin } from './ConnectFlowSheet';
import { connectorApi } from './api';
import { usePendingLoginFollower, usePendingLogins } from './pendingLogins';
import type { PendingLogin } from './pendingLogins';
import { ConnectionSheet } from './ConnectionSheet';
import { ConnectionSyncCard } from './ConnectionSyncCard';
import type { SyncReport } from './connectorSync';
import { kindIcon, partyLogo } from './logos';
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
  return text;
}

const REFUSAL_KEYS: Partial<Record<SyncReport['status'], TranslationKey>> = {
  signin: 'conn.state.signIn',
  blocked: 'conn.state.blocked',
  wait: 'conn.state.wait',
  asking: 'conn.state.asking',
};

/** a sync attempt's outcome, spoken out loud */
function SyncResultLine({ id, state }: Readonly<{ id: string; state: 'busy' | SyncReport }>) {
  const { t } = useLang();
  if (state === 'busy') {
    return (
      <span className="block text-[11px] text-ink-4" data-testid={`conn-syncing-${id}`}>
        {t('conn.syncBusy')}
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
  const [syncStates, setSyncStates] = useState<Record<string, 'busy' | SyncReport>>({});
  const [ask, setAsk] = useState<JobAsk | null>(null);

  const signedIn = connectorsAvailable();
  const managed = connections?.find((c) => c.meta.id === manageId) ?? null;
  const spaceNames = new Map((allSpaces ?? []).map((s) => [s.id, s.name]));
  const kindOf = (view: ConnectionView): ProviderKind => view.meta.kind ?? catalogue.byId.get(view.meta.store)?.kind ?? 'store';

  const runSync = async (view: ConnectionView) => {
    setSyncStates((s) => ({ ...s, [view.meta.id]: 'busy' }));
    const result = await ops.syncNow(view.meta.id, {
      // a question mid-fetch is asked right here — a human is present
      onChallenge: (job) => new Promise<string | null>((resolve) => setAsk({ job, provider: view.meta.store, resolve })),
    });
    setAsk(null);
    setSyncStates((s) => ({ ...s, [view.meta.id]: result }));
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
    await ops.rename(naming.connectionId, nameDraft);
    setNaming(null);
  };

  const openFlow = (manifest: ProviderManifest, reconnectId: string | null) => {
    setCatalogueOpen(false);
    setFlow({ manifest, reconnectId });
  };

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
      await afterConnect(result, login.reconnect);
    },
  });

  /** the attach step on the active space's accounts screen, the account already picked (#310) */
  const attach = (accountId: string) => {
    setSpaceAttachIntent(accountId);
    void navigate({ to: '/spaces/$spaceId/accounts', params: { spaceId } });
  };

  const stateLine = (view: ConnectionView) => {
    const syncState = syncStates[view.meta.id];
    if (syncState) return <SyncResultLine id={view.meta.id} state={syncState} />;
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

        {/* the browsing door: every receipt, photos included */}
        <button
          data-testid="conn-view-receipts"
          onClick={() => void navigate({ to: '/receipts' })}
          className="m-tap mt-3 flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3.5 text-left"
        >
          <Icon name="receipt-text-outline" size={20} color="var(--m-ink-2)" />
          <span className="min-w-0 flex-1 text-[15px] text-ink">{t('receipts.title')}</span>
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
          onClose={() => setManageId(null)}
        />
      )}
    </div>
  );
}
