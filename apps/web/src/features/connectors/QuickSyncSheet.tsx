import { useEffect, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { connectorsAvailable, useConnectionOps, useConnections } from '@/application/connections';
import type { ConnectionView } from '@/application/connections';
import { fmtTimeAgo } from '@/lib/text';
import { IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Picture } from '@/ui/Picture';
import { Sheet } from '@/ui/Sheet';
import { ChallengeCard } from './ChallengeCard';
import { ConnectSteps } from './ConnectSteps';
import type { FlowRequest } from './ConnectSteps';
import { sessionOver, syncsByHand } from './connectionRules';
import { kindIcon, partyLogo } from './logos';
import { errorKey } from './manifestForm';
import { resultStillFresh, useSyncActivity } from './syncActivity';
import type { JobView } from './types';
import { CATALOGUE_META_KEY, refreshCatalogueCache, useCatalogue } from './useCatalogue';
import type { Cached } from './useCatalogue';

/** Home's door to the quick sync: only for a signed-in person who has a connection to sync by hand */
export function QuickSyncButton() {
  const { t } = useLang();
  const { store } = useData();
  const [open, setOpen] = useState(false);
  const signedIn = connectorsAvailable();
  // the cached catalogue answers without a call — Home is opened far more often than this sheet
  const state = useQuery(
    store,
    async () => {
      if (!signedIn) return null;
      const cached = (await store.metaGet(CATALOGUE_META_KEY))?.value as Cached | undefined;
      const manifests = new Map((cached?.catalogue.providers ?? []).map((p) => [p.id, p]));
      const parties = (await store.allRows('storeConn')).filter((meta) => meta.deleted === 0);
      return {
        due: parties.some((meta) => syncsByHand(meta, manifests)),
        unknown: [...new Set(parties.filter((meta) => !manifests.has(meta.store)).map((meta) => meta.store))].sort((a, b) => a.localeCompare(b)).join(','),
      };
    },
    [signedIn],
  );
  // A connection made on another device arrives without this device's cache knowing its party:
  // the relay is asked once per set of unknown parties, so one it retired is not asked for again.
  const unknown = state?.unknown ?? '';
  const asked = useRef('');
  useEffect(() => {
    if (!unknown || asked.current === unknown) return;
    asked.current = unknown;
    void (async () => {
      const cached = (await store.metaGet(CATALOGUE_META_KEY))?.value as Cached | undefined;
      await refreshCatalogueCache(store, cached);
    })().catch(() => undefined);
  }, [store, unknown]);
  if (!state?.due) return null;
  return (
    <>
      <IconButton label={t('quicksync.open')} testId="home-quick-sync" onClick={() => setOpen(true)}>
        <Icon name="sync" size={20} />
      </IconButton>
      {open && <QuickSyncSheet onClose={() => setOpen(false)} />}
    </>
  );
}

/** a job's question while a sync runs from the sheet */
interface JobAsk {
  job: JobView;
  provider: string;
  resolve: (value: string | null) => void;
}

/**
 * #548: the connections to sync by hand, each with when it last synced and
 * a Sync of its own. A session the party already ended is signed in again
 * first (the login kept on this device where the party offers that, #543),
 * and a question mid-fetch is asked right here.
 */
export function QuickSyncSheet({ onClose }: Readonly<{ onClose: () => void }>) {
  const { t, lang } = useLang();
  const catalogue = useCatalogue();
  const connections = useConnections();
  const ops = useConnectionOps();
  const activity = useSyncActivity((s) => s.activity);
  const [flow, setFlow] = useState<FlowRequest | null>(null);
  const [ask, setAsk] = useState<JobAsk | null>(null);
  const rows = (connections ?? []).filter((view) => syncsByHand(view.meta, catalogue.byId));

  const signIn = (view: ConnectionView) => {
    const manifest = catalogue.byId.get(view.meta.store);
    if (manifest) setFlow({ manifest, reconnectId: view.meta.id });
  };

  const sync = async (view: ConnectionView) => {
    if (sessionOver(view, catalogue.byId.get(view.meta.store))) {
      signIn(view);
      return;
    }
    const report = await ops.syncNow(view.meta.id, {
      onChallenge: (job) => new Promise<string | null>((resolve) => setAsk({ job, provider: view.meta.store, resolve })),
    });
    setAsk(null);
    // the party ended the session after all: the sign-in follows at once rather than a second tap
    if (report.status === 'signin') signIn(view);
  };

  /** where the connection stands: syncing now, what the last sync brought, or when it last synced */
  const line = (view: ConnectionView): { text: string; warn: boolean } => {
    const running = activity[view.meta.id];
    if (running?.phase === 'fetching') return { text: running.found == null ? t('conn.syncBusy') : t('conn.syncFound', { n: running.found }), warn: false };
    if (resultStillFresh(running) && running.report.status !== 'ok') {
      return { text: t((running.report.status === 'signin' ? 'conn.state.signIn' : errorKey(running.report.error?.code)) as TranslationKey), warn: true };
    }
    const last = view.device?.lastSyncAt;
    return { text: last ? t('conn.state.synced', { when: fmtTimeAgo(last, lang) }) : t('quicksync.never'), warn: false };
  };

  return (
    <>
      <Sheet open onOpenChange={(next) => !next && onClose()} title={t('quicksync.title')} size="tall">
        <div className="flex flex-col gap-3 pt-1" data-testid="quick-sync">
          <p className="px-1 text-[13px] leading-relaxed text-ink-2">{t('quicksync.intro')}</p>
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            {rows.map((view) => {
              const manifest = catalogue.byId.get(view.meta.store);
              const logo = view.meta.icon ?? partyLogo(manifest?.logoRef);
              const state = line(view);
              const busy = activity[view.meta.id]?.phase === 'fetching';
              return (
                <div key={view.meta.id} className="flex items-center gap-3 border-b border-line-2 px-4 py-3.5 last:border-0" data-testid={`quick-sync-${view.meta.id}`}>
                  {logo ? <Picture src={logo} className="h-6 w-6 rounded object-contain" /> : <Icon name={kindIcon(view.meta.kind ?? manifest?.kind)} size={20} color="var(--m-ink-3)" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-ink">{view.meta.displayName}</span>
                    <span className={`block text-[11px] ${state.warn ? 'text-warning' : 'text-ink-4'}`} data-testid={`quick-sync-state-${view.meta.id}`}>
                      {state.text}
                    </span>
                  </span>
                  <Button size="sm" variant="outline" disabled={busy || !manifest} data-testid={`quick-sync-go-${view.meta.id}`} onClick={() => void sync(view)}>
                    {t('quicksync.sync')}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      </Sheet>

      <ConnectSteps flow={flow} onFlowChange={setFlow} catalogue={catalogue} />

      {/* a party's question while a sync runs from here */}
      <Sheet
        open={ask !== null}
        onOpenChange={(next) => {
          if (next || !ask) return;
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
    </>
  );
}
