import { useMemo, useState } from 'react';
import { useLang } from '@/i18n';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { PartyRow } from './CatalogueSheet';
import type { ErrorEnvelope, ProviderManifest } from './types';

/** an aggregator reaches the bank through the bank's own consent page; munni's own connectors sign in at the bank */
export const isOpenBanking = (manifest: Pick<ProviderManifest, 'auth'>): boolean => manifest.auth.flow === 'oauth_redirect';

/**
 * #527: connecting a bank from an accounts screen offers the ways munni
 * reaches a bank — each open-banking party, and munni's own connector —
 * and goes straight on into the one picked (the hub's whole catalogue,
 * shops included, sat in between). munni's connector lists its banks on a
 * sheet of its own, over this one.
 */
export function BankPickerSheet({
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
  const [ownOpen, setOwnOpen] = useState(false);
  const { aggregators, own } = useMemo(() => {
    const banks = providers.filter((p) => p.kind === 'bank' && p.status.state !== 'retired').sort((a, b) => a.name.localeCompare(b.name));
    return { aggregators: banks.filter(isOpenBanking), own: banks.filter((p) => !isOpenBanking(p)) };
  }, [providers]);
  const empty = aggregators.length === 0 && own.length === 0;

  const pick = (manifest: ProviderManifest) => {
    setOwnOpen(false);
    onPick(manifest);
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} title={t('bankpick.title')} size="tall" steady>
        <div className="flex flex-col gap-3 pt-1" data-testid="bank-picker">
          <p className="px-1 text-[13px] leading-relaxed text-ink-2">{t('bankpick.intro')}</p>
          {aggregators.length > 0 && (
            <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="bank-picker-open-banking">
              {aggregators.map((manifest) => (
                <PartyRow key={manifest.id} manifest={manifest} sub={t('bankpick.openBankingSub')} onPick={pick} />
              ))}
            </div>
          )}
          {own.length > 0 && (
            <button
              data-testid="bank-picker-munni"
              onClick={() => setOwnOpen(true)}
              className="m-tap flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3.5 text-left"
            >
              <Icon name="robot-outline" size={20} color="var(--m-accent-deep)" />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] text-ink">{t('bankpick.munni')}</span>
                <span className="block text-[11px] text-ink-4">{t('bankpick.munniSub', { banks: own.map((p) => p.name).join(', ') })}</span>
              </span>
              <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
            </button>
          )}
          {empty && error && (
            <div className="flex flex-col items-center gap-2 px-4 py-6 text-center" data-testid="bank-picker-failed">
              <p className="text-[13px] text-ink-3">{t('conn.catalogueFailed')}</p>
              <Button size="sm" variant="outline" onClick={onRetry}>
                {t('connect.action.retry')}
              </Button>
            </div>
          )}
          {empty && !error && (
            <p className="px-1 py-6 text-center text-[13px] text-ink-4" data-testid={loading ? 'bank-picker-loading' : 'bank-picker-empty'}>
              {t(loading ? 'conn.catalogueLoading' : 'bankpick.none')}
            </p>
          )}
          <p className="px-1 text-[11px] leading-snug text-ink-4">{t('bankpick.note')}</p>
        </div>
      </Sheet>
      {/* munni's own bank connectors, stacked over the picker so closing it goes back there */}
      <Sheet open={open && ownOpen} onOpenChange={setOwnOpen} title={t('bankpick.munni')} size="tall" steady>
        <div className="flex flex-col gap-3 pt-1" data-testid="bank-picker-munni-list">
          <p className="px-1 text-[13px] leading-relaxed text-ink-2">{t('bankpick.munniIntro')}</p>
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            {own.map((manifest) => (
              <PartyRow key={manifest.id} manifest={manifest} onPick={pick} />
            ))}
          </div>
        </div>
      </Sheet>
    </>
  );
}
