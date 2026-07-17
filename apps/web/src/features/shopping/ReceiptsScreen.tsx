import { useMemo, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useNavigate } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import type { ReceiptRow } from '@/db/types';
import { fmtCents } from '@/lib/money';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Chip } from '@/ui/primitives';
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

/** brand names stay brand names; only the photo bucket is translated */
const SOURCE_NAMES: Record<string, string> = {
  ah: 'Albert Heijn',
  jumbo: 'Jumbo',
  bol: 'bol.com',
  coolblue: 'Coolblue',
  mediamarkt: 'MediaMarkt',
  amazon: 'Amazon',
};

/** store, merchant, item names and the amount's digits are all searchable */
function receiptMatches(receipt: ReceiptRow, q: string, amountQ: string | null): boolean {
  const haystack = [receipt.merchant ?? '', receipt.source, ...(receipt.items?.map((i) => i.name) ?? [])]
    .join(' ')
    .toLowerCase();
  if (haystack.includes(q)) return true;
  return !!amountQ && String(Math.abs(receipt.totalCents)).includes(amountQ);
}

/**
 * Receipts v2 (approved): the feature's home — every receipt the space
 * sees, grouped by store, searchable by name, item or amount, with an
 * unlinked filter and the connected-stores door. Receipts are facts:
 * photos sync with the space, store receipts arrive in every space
 * their connection is shared with.
 */
export function ReceiptsScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store, spaceId } = useData();
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [unlinkedOnly, setUnlinkedOnly] = useState(false);

  const receipts = useQuery(store, async () => {
    const rows = (await store.bySpace('receipt', spaceId)).filter((r) => r.deleted === 0);
    rows.sort((a, b) => b.date.localeCompare(a.date));
    return rows;
  }, [spaceId]);
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const currency = space?.currency ?? 'EUR';

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const digits = q.replaceAll(/[\s.,€-]/g, '');
    const amountQ = /^\d+$/.test(digits) && digits.length > 0 ? digits : null;
    const visible = (receipts ?? []).filter(
      (r) => (!unlinkedOnly || !r.txId) && (!q || receiptMatches(r, q, amountQ)),
    );
    const bySource = new Map<string, ReceiptRow[]>();
    for (const receipt of visible) {
      const list = bySource.get(receipt.source) ?? [];
      list.push(receipt);
      bySource.set(receipt.source, list);
    }
    // stores first (alphabetical), the photo bucket last
    return [...bySource.entries()].sort(([a], [b]) => {
      if (a === 'photo') return 1;
      if (b === 'photo') return -1;
      return a.localeCompare(b);
    });
  }, [receipts, query, unlinkedOnly]);

  // keep the sheet live: deletions/links flow straight into the view
  const current = useMemo(() => receipts?.find((r) => r.id === selected) ?? null, [receipts, selected]);
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' });
  const unlinkedCount = receipts?.filter((r) => !r.txId).length ?? 0;

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
        trailing={
          <IconButton label={t('receipts.connectedStores')} testId="receipts-stores" onClick={() => void navigate({ to: '/shopping' })}>
            <Icon name="storefront-outline" size={20} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <input
          data-testid="receipts-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('receipts.searchPlaceholder')}
          className="mb-2 h-11 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
        />
        {unlinkedCount > 0 && (
          <div className="mb-2 flex gap-1.5">
            <Chip testId="receipts-filter-unlinked" selected={unlinkedOnly} onClick={() => setUnlinkedOnly((v) => !v)}>
              {t('receipts.unlinkedOnly', { n: unlinkedCount })}
            </Chip>
          </div>
        )}

        {groups.length > 0 ? (
          groups.map(([source, rows]) => (
            <div key={source}>
              <div className="m-cap mt-3 mb-1 flex items-center gap-1.5 px-1">
                <Icon name={SOURCE_ICON[source] ?? 'receipt-text-outline'} size={13} />
                {SOURCE_NAMES[source] ?? t('receipt.sourcePhoto')} · {rows.length}
              </div>
              <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid={`receipts-group-${source}`}>
                {rows.map(renderRow)}
              </div>
            </div>
          ))
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
