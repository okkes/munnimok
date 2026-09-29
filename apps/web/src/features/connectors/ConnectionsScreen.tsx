import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { connectorsAvailable, useConnectionOps, useConnections } from '@/application/connections';
import type { AdoptResult, ConnectionView } from '@/application/connections';
import { fmtTimeAgo } from '@/lib/text';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { FormBlockerNote, blockerRing } from '@/ui/FormBlockerNote';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { CatalogueSheet } from './CatalogueSheet';
import { ChallengeCard } from './ChallengeCard';
import { ConnectFlowSheet } from './ConnectFlowSheet';
import { ConnectionSheet } from './ConnectionSheet';
import { ConnectionSyncCard } from './ConnectionSyncCard';
import type { SyncReport } from './connectorSync';
import { kindIcon, partyLogo } from './logos';
import { errorKey } from './manifestForm';
import type { JobView, ProviderManifest } from './types';
import { useCatalogue } from './useCatalogue';

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
  let text: string;
  let ok = false;
  switch (state.status) {
    case 'ok': {
      ok = true;
      text = state.added > 0 ? t('conn.syncAdded', { n: state.added }) : t('conn.syncNone');
      if (state.linked > 0) text += ` · ${t('conn.syncLinked', { n: state.linked })}`;
      if (state.proposed > 0) text += ` · ${t('conn.syncProposed', { n: state.proposed })}`;
      break;
    }
    case 'signin':
      text = t('conn.state.signIn');
      break;
    case 'blocked':
      text = t('conn.state.blocked');
      break;
    case 'wait':
      text = t('conn.state.wait');
      break;
    case 'asking':
      text = t('conn.state.asking');
      break;
    default:
      text = t(errorKey(state.error?.code));
  }
  return (
    <span className={`block text-[11px] ${ok ? 'text-accent-deep' : 'text-negative'}`} data-testid={`conn-result-${id}`}>
      {text}
    </span>
  );
}

/** a job's question while a sync runs from the hub */
interface JobAsk {
  job: JobView;
  provider: string;
  resolve: (value: string | null) => void;
}

/**
 * Settings → Connections (#367, the hub): every party the user connected,
 * as cards with the party's status and the connection's state, one
 * primary action per state, the spaces it is used in — and the catalogue
 * to connect one more. Shops first; banks and registries join with their
 * slices.
 */
export function ConnectionsScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store } = useData();
  const connections = useConnections();
  const ops = useConnectionOps();
  const catalogue = useCatalogue();
  const allSpaces = useQuery(store, async () => (await store.allRows('space')).filter((s) => s.deleted === 0), []);
  const links = useQuery(store, async () => (await store.allRows('storeConnLink')).filter((l) => l.deleted === 0), []);

  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [flow, setFlow] = useState<{ manifest: ProviderManifest; reconnectId: string | null } | null>(null);
  const [naming, setNaming] = useState<{ connectionId: string; duplicateOf?: string } | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [manageId, setManageId] = useState<string | null>(null);
  const [syncStates, setSyncStates] = useState<Record<string, 'busy' | SyncReport>>({});
  const [ask, setAsk] = useState<JobAsk | null>(null);

  const signedIn = connectorsAvailable();
  const managed = connections?.find((c) => c.meta.id === manageId) ?? null;
  const spaceNames = new Map((allSpaces ?? []).map((s) => [s.id, s.name]));

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

  const stateLine = (view: ConnectionView) => {
    const syncState = syncStates[view.meta.id];
    if (syncState) return <SyncResultLine id={view.meta.id} state={syncState} />;
    const testId = `conn-state-${view.meta.id}`;
    const warn = (text: string) => (
      <span className="block text-[11px] text-warning" data-testid={testId}>
        {text}
      </span>
    );
    const calm = (text: string) => (
      <span className="block text-[11px] text-ink-4" data-testid={testId}>
        {text}
      </span>
    );
    if (!view.device) return view.meta.status === 'expired' ? warn(t('conn.state.reconnect')) : calm(t('conn.state.elsewhere'));
    if (view.device.state === 'blocked') return warn(t('conn.state.blocked'));
    if (view.device.state === 'awaiting_input') return warn(t('conn.state.asking'));
    if (view.device.state !== 'active' || view.meta.status === 'expired') return warn(t('conn.state.reconnect'));
    if (!view.hasBundle) return warn(t('conn.state.signIn'));
    if (view.device.lastError?.code === 'rate_limited') return calm(t('conn.state.wait'));
    return calm(view.device.lastSyncAt ? t('conn.state.synced', { when: fmtTimeAgo(view.device.lastSyncAt, lang) }) : t('conn.state.neverSynced'));
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

  const renderCard = (view: ConnectionView) => {
    const manifest = catalogue.byId.get(view.meta.store);
    const logo = view.meta.icon ?? partyLogo(manifest?.logoRef);
    const usedIn = (links ?? []).filter((l) => l.instanceId === view.meta.id).map((l) => spaceNames.get(l.spaceId) ?? '').filter(Boolean);
    const healthy = view.device?.state === 'active' && view.hasBundle;
    return (
      <div key={view.meta.id} className="border-b border-line-2 px-4 py-3.5 last:border-0" data-testid={`conn-card-${view.meta.id}`}>
        <div className="flex items-center gap-3">
          {logo ? (
            <img src={logo} alt="" className="h-6 w-6 rounded object-contain" />
          ) : (
            <Icon name={kindIcon(manifest?.kind)} size={20} color={healthy ? 'var(--m-accent-deep)' : 'var(--m-ink-3)'} />
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
        {usedIn.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-9" data-testid={`conn-usedin-${view.meta.id}`}>
            <span className="text-[10px] text-ink-4">{t('conn.usedIn')}</span>
            {usedIn.map((name) => (
              <span key={name} className="rounded-full bg-bg-2 px-2 py-0.5 text-[10px] font-medium text-ink-3">
                {name}
              </span>
            ))}
          </div>
        )}
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

        {connections && connections.length > 0 && (
          <>
            <div className="m-cap mt-4 mb-1 px-1">{t('conn.shops')}</div>
            <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="conn-list">
              {connections.map(renderCard)}
            </div>
          </>
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
          kind={catalogue.byId.get(managed.meta.store)?.kind}
          allSpaces={allSpaces ?? []}
          includedSpaceIds={(links ?? []).filter((l) => l.instanceId === managed.meta.id).map((l) => l.spaceId)}
          onClose={() => setManageId(null)}
        />
      )}
    </div>
  );
}
