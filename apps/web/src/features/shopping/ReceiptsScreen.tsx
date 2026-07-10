import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import type { ReceiptRow } from '@/db/types';
import { fmtCents } from '@/lib/money';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { ReceiptViewSheet } from './ReceiptViewSheet';

const SOURCE_ICON: Record<string, string> = {
  photo: 'camera-outline',
  ah: 'storefront-outline',
  jumbo: 'storefront-outline',
  bol: 'package-variant-closed',
  coolblue: 'package-variant-closed',
  mediamarkt: 'package-variant-closed',
  amazon: 'package-variant-closed',
};

/**
 * Every receipt the space holds — photos and store fetches alike —
 * newest first, with the matched/unmatched state visible at a glance.
 * The browsing surface the connections screen links into.
 */
export function ReceiptsScreen() {
  const { t, lang } = useLang();
  const { db, spaceId } = useData();
  const [selected, setSelected] = useState<string | null>(null);

  const receipts = useLiveQuery(async () => {
    const rows = await db.receipts.filter((r) => r.deleted === 0 && r.spaceId === spaceId).toArray();
    rows.sort((a, b) => b.date.localeCompare(a.date));
    return rows;
  }, [db, spaceId]);
  const space = useLiveQuery(() => db.spaces.get(spaceId), [spaceId]);
  const currency = space?.currency ?? 'EUR';

  // keep the sheet live: deletions/links flow straight into the view
  const current = useMemo(() => receipts?.find((r) => r.id === selected) ?? null, [receipts, selected]);
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' });

  const renderRow = (receipt: ReceiptRow) => (
    <button
      key={receipt.id}
      data-testid={`receipt-row-${receipt.id}`}
      onClick={() => setSelected(receipt.id)}
      className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-4 py-3 text-left last:border-0"
    >
      <Icon name={SOURCE_ICON[receipt.source] ?? 'receipt-text-outline'} size={18} color="var(--m-ink-3)" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink">{receipt.merchant ?? t('receipt.sourcePhoto')}</span>
        <span className="block text-[11px] text-ink-4">
          {fmtDate(receipt.date)}
          {receipt.items?.length ? ` · ${receipt.items.length} ${t('receipt.items')}` : ''}
        </span>
      </span>
      {!receipt.txId && (
        <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[10px] font-semibold text-warning" data-testid={`receipt-unmatched-${receipt.id}`}>
          {t('receipts.unmatched')}
        </span>
      )}
      <span className="m-num text-[13px] font-semibold text-ink">{fmtCents(receipt.totalCents, currency, lang)}</span>
    </button>
  );

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-receipts">
      <AppBar
        title={t('receipts.title')}
        leading={
          <IconButton label={t('action.back')} testId="receipts-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {(receipts?.length ?? 0) > 0 ? (
          <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="receipts-list">
            {receipts!.map(renderRow)}
          </div>
        ) : (
          receipts && (
            <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center" data-testid="receipts-empty">
              <Icon name="receipt-text-outline" size={34} color="var(--m-ink-4)" />
              <p className="text-[14px] font-medium text-ink-2">{t('receipts.emptyTitle')}</p>
              <p className="text-[12px] text-ink-4">{t('receipts.emptyBody')}</p>
            </div>
          )
        )}
      </div>
      <ReceiptViewSheet receipt={current} currency={currency} onClose={() => setSelected(null)} />
    </div>
  );
}
