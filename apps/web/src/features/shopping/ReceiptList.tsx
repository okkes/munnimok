import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { LOCALES, useLang } from '@/i18n';
import { partyName } from '@/features/connectors/logos';
import { fmtCents } from '@/lib/money';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { SearchField } from '@/ui/SearchField';
import type { ReceiptRow } from '@/db/types';
import { receiptFilter, receiptParties } from './receiptPick';

/** the source a photo carries; its chip reads "Scanned" */
export const PHOTO_SOURCE = 'photo';

export interface ReceiptListItem {
  receipt: ReceiptRow;
  /** a space's list: the transactions holding the receipt — absent where linking is not this list's business */
  txIds?: readonly string[];
  /** #648: a space's list says where each receipt lives — in the space itself, or in a feed shared with it */
  scope?: 'space' | 'global';
}

const byDay = (items: readonly ReceiptListItem[]): [string, ReceiptListItem[]][] => {
  const days = new Map<string, ReceiptListItem[]>();
  for (const item of items) {
    const day = item.receipt.date.slice(0, 10);
    const list = days.get(day) ?? [];
    list.push(item);
    days.set(day, list);
  }
  return [...days.entries()].sort(([a], [b]) => b.localeCompare(a));
};

// #648: one list for a space's receipts and the person's own: by day like the transactions, a chip per shop and one
// for the scanned ones, the transactions' search rule (a name, an item or an amount's digits)
export function ReceiptList({
  items,
  linkState = false,
  fallbackCurrency,
  onOpen,
  empty,
  children,
}: Readonly<{
  /** undefined while the rows are read */
  items: readonly ReceiptListItem[] | undefined;
  /** a space's list says which receipts hold no transaction yet and offers them as a filter */
  linkState?: boolean;
  /** what a receipt that names no currency is shown in */
  fallbackCurrency: string;
  onOpen: (receipt: ReceiptRow) => void;
  empty: ReactNode;
  /** stands between the filters and the days (a space's matches to check) */
  children?: ReactNode;
}>) {
  const { t, lang } = useLang();
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<string | null>(null);
  const [unlinkedOnly, setUnlinkedOnly] = useState(false);

  const all = useMemo(() => items ?? [], [items]);
  const shops = useMemo(() => receiptParties(all.map((item) => item.receipt).filter((r) => r.source !== PHOTO_SOURCE)), [all]);
  const scanned = all.some((item) => item.receipt.source === PHOTO_SOURCE);
  const unlinkedCount = linkState ? all.filter((item) => !item.txIds?.length).length : 0;

  const days = useMemo(() => {
    const matches = receiptFilter(query, source);
    return byDay(all.filter((item) => (!unlinkedOnly || !item.txIds?.length) && matches(item.receipt)));
  }, [all, query, source, unlinkedOnly]);

  const fmtDay = (iso: string) =>
    new Intl.DateTimeFormat(LOCALES[lang], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  const pick = (next: string) => setSource((current) => (current === next ? null : next));

  const renderRow = ({ receipt, txIds, scope }: ReceiptListItem) => {
    const photo = receipt.source === PHOTO_SOURCE;
    const holders = txIds?.length ?? 0;
    const facts = [
      receipt.items?.length ? `${receipt.items.length} ${t('receipt.items')}` : '',
      receipt.documents?.length ? t('receipts.invoice') : '',
      photo && receipt.merchant ? t('receipts.scanned') : '',
    ].filter(Boolean);
    return (
      <button
        key={receipt.id}
        data-testid={`receipt-row-${receipt.id}`}
        onClick={() => onOpen(receipt)}
        className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-4 py-3 text-left last:border-0"
      >
        <Icon name={photo ? 'camera-outline' : 'storefront-outline'} size={18} color="var(--m-ink-3)" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{receipt.merchant ?? (photo ? t('receipt.sourcePhoto') : partyName(receipt.source))}</span>
          {facts.length > 0 && <span className="block text-[11px] text-ink-4">{facts.join(' · ')}</span>}
        </span>
        {!!receipt.documents?.length && <Icon name="file-pdf-box" size={16} color="var(--m-ink-4)" data-testid={`receipt-invoice-${receipt.id}`} />}
        {scope && (
          <span className="rounded-full bg-bg-2 px-2 py-0.5 text-[10px] font-semibold text-ink-3" data-testid={`receipt-scope-${receipt.id}`} data-scope={scope}>
            {t(scope === 'space' ? 'receipts.markSpace' : 'receipts.markGlobal')}
          </span>
        )}
        {linkState && holders === 0 && (
          <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[10px] font-semibold text-warning" data-testid={`receipt-unmatched-${receipt.id}`}>
            {t('receipts.unmatched')}
          </span>
        )}
        {holders > 1 && (
          <span
            className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent-deep"
            data-testid={`receipt-multi-${receipt.id}`}
            title={t('receipt.attachedToN', { n: holders })}
          >
            {`× ${holders}`}
          </span>
        )}
        <span className="m-num text-[13px] font-semibold text-ink">{fmtCents(receipt.totalCents, receipt.currency ?? fallbackCurrency, lang)}</span>
      </button>
    );
  };

  return (
    <>
      <SearchField testId="receipts-search" value={query} onChange={setQuery} placeholder={t('receipts.searchPlaceholder')} className="mb-2" />
      {(unlinkedCount > 0 || scanned || shops.length > 0) && (
        <div className="mb-2 flex flex-wrap gap-1.5" data-testid="receipts-filters">
          {unlinkedCount > 0 && (
            <Chip testId="receipts-filter-unlinked" selected={unlinkedOnly} onClick={() => setUnlinkedOnly((v) => !v)}>
              {t('receipts.unlinkedOnly', { n: unlinkedCount })}
            </Chip>
          )}
          {scanned && (
            <Chip testId="receipts-filter-scanned" selected={source === PHOTO_SOURCE} onClick={() => pick(PHOTO_SOURCE)}>
              {t('receipts.scanned')}
            </Chip>
          )}
          {shops.map((shop) => (
            <Chip key={shop.source} testId={`receipts-filter-${shop.source}`} selected={source === shop.source} onClick={() => pick(shop.source)}>
              {shop.label}
            </Chip>
          ))}
        </div>
      )}
      {children}
      {days.map(([day, rows]) => (
        <div key={day} data-testid={`receipts-day-${day}`}>
          <div className="m-cap sticky top-0 z-10 -mx-1 mt-4 mb-1 bg-bg px-2 py-1">{fmtDay(day)}</div>
          <div className="overflow-hidden rounded-card border border-line bg-surface">{rows.map(renderRow)}</div>
        </div>
      ))}
      {items && days.length === 0 && (all.length === 0 ? empty : <p className="px-6 pt-10 text-center text-[13px] text-ink-4" data-testid="receipts-none-found">{t('receipts.noneFound')}</p>)}
    </>
  );
}
