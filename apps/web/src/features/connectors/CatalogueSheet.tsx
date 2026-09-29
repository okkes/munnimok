import { useMemo, useState } from 'react';
import { useLang } from '@/i18n';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Pill } from '@/ui/primitives';
import { SearchField } from '@/ui/SearchField';
import { Sheet } from '@/ui/Sheet';
import { deviceClass } from './api';
import { kindIcon, partyLogo } from './logos';
import { connectableHere, needsOwnComputer } from './manifestForm';
import type { ErrorEnvelope, ProviderManifest } from './types';

/**
 * The catalogue (§10.1): every party the environment runs, rendered from
 * the manifests — grouped by kind, searchable, its status shown
 * honestly, "needs your own computer" marked. Shops for now; banks and
 * registries join with their slices.
 */
export function CatalogueSheet({
  open,
  onOpenChange,
  providers,
  loading,
  error,
  onRetry,
  onPick,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: readonly ProviderManifest[];
  loading: boolean;
  error: ErrorEnvelope | null;
  onRetry: () => void;
  onPick: (manifest: ProviderManifest) => void;
}>) {
  const { t } = useLang();
  const [query, setQuery] = useState('');
  const device = deviceClass();

  // banks first, then shops; registries join with their slice
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = providers
      .filter((p) => p.status.state !== 'retired')
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [
      { kind: 'bank' as const, captionKey: 'conn.banks' as const, rows: matching.filter((p) => p.kind === 'bank') },
      { kind: 'store' as const, captionKey: 'conn.shops' as const, rows: matching.filter((p) => p.kind === 'store') },
    ].filter((g) => g.rows.length > 0);
  }, [providers, query]);
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('conn.catalogueTitle')} size="tall" steady>
      <div className="flex flex-col gap-3 pt-1">
        <SearchField testId="conn-catalogue-search" value={query} onChange={setQuery} placeholder={t('conn.searchParties')} />
        {error && shown === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-6 text-center" data-testid="conn-catalogue-failed">
            <p className="text-[13px] text-ink-3">{t('conn.catalogueFailed')}</p>
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t('connect.action.retry')}
            </Button>
          </div>
        )}
        {groups.map((group) => (
          <div key={group.kind}>
            <div className="m-cap mb-1 px-1">{t(group.captionKey)}</div>
            <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid={`conn-catalogue-${group.kind}`}>
              {group.rows.map((manifest) => {
                const logo = partyLogo(manifest.logoRef);
                const offered = connectableHere(manifest, device);
                const ownComputer = needsOwnComputer(manifest);
                return (
                  <button
                    key={manifest.id}
                    data-testid={`conn-party-${manifest.id}`}
                    disabled={!offered}
                    onClick={() => onPick(manifest)}
                    className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3.5 text-left last:border-0 disabled:opacity-60"
                  >
                    {logo ? <img src={logo} alt="" className="h-6 w-6 rounded object-contain" /> : <Icon name={kindIcon(manifest.kind)} size={20} color="var(--m-ink-3)" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] text-ink">{manifest.name}</span>
                      {ownComputer && (
                        <span className="block text-[11px] text-ink-4" data-testid={`conn-party-${manifest.id}-agent`}>
                          {t('conn.needsComputer')}
                        </span>
                      )}
                      {device === 'web' && manifest.webSupport === 'none' && (
                        <span className="block text-[11px] text-ink-4" data-testid={`conn-party-${manifest.id}-app`}>
                          {t('conn.useApp')}
                        </span>
                      )}
                    </span>
                    {manifest.status.state === 'degraded' && (
                      <Pill tone="warning" testId={`conn-party-${manifest.id}-degraded`}>
                        {t('conn.partyDegraded')}
                      </Pill>
                    )}
                    {manifest.status.state === 'paused' && <Pill testId={`conn-party-${manifest.id}-paused`}>{t('conn.partyPaused')}</Pill>}
                    {offered && <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {!loading && !error && shown === 0 && (
          <p className="px-1 py-6 text-center text-[13px] text-ink-4" data-testid="conn-catalogue-empty">
            {t('conn.catalogueEmpty')}
          </p>
        )}
        {loading && shown === 0 && !error && (
          <p className="px-1 py-6 text-center text-[13px] text-ink-4" data-testid="conn-catalogue-loading">
            {t('conn.catalogueLoading')}
          </p>
        )}
        <p className="px-1 text-[11px] leading-snug text-ink-4">{t('conn.addSub')}</p>
      </div>
    </Sheet>
  );
}
