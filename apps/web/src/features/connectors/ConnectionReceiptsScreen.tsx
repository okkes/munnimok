import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import type { Lang } from '@/i18n';
import { useFetchedRanges, useGlobalReceipts, useStoreConnMetas } from '@/application/connections';
import type { FetchedRange } from '@/application/connections';
import { partyName } from '@/features/connectors/logos';
import { fmtCents } from '@/lib/money';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { SearchField } from '@/ui/SearchField';
import type { ReceiptRow, StoreConnRow } from '@/db/types';
import { resultStillFresh, useSyncActivity } from './syncActivity';
import type { SyncActivity } from './syncActivity';

type Translate = ReturnType<typeof useLang>['t'];

/** merchant, item names and the amount's digits are all searchable */
function rowMatches(receipt: ReceiptRow, q: string, amountQ: string | null): boolean {
  const haystack = [receipt.merchant ?? '', receipt.source, ...(receipt.items?.map((i) => i.name) ?? [])].join(' ').toLowerCase();
  if (haystack.includes(q)) return true;
  return !!amountQ && String(Math.abs(receipt.totalCents)).includes(amountQ);
}

const fmtDay = (iso: string, lang: Lang) => new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' });

/** the dates a connection's fetches cover, with the count — or that nothing came yet */
export function rangeLine(range: FetchedRange | undefined, t: Translate, lang: Lang): string {
  if (!range || range.count === 0) return t('conn.rangeNone');
  return t('conn.range', { from: fmtDay(range.from, lang), to: fmtDay(range.to, lang), n: range.count });
}

/** what a sync is doing for this connection right now, in one line; null when nothing is running or fresh */
export function activityLine(activity: SyncActivity | undefined, t: Translate): { text: string; busy: boolean } | null {
  if (!activity) return null;
  if (activity.phase === 'fetching') {
    return { text: activity.found === null ? t('receipts.fetching') : t('receipts.fetchingFound', { n: activity.found }), busy: true };
  }
  if (!resultStillFresh(activity)) return null;
  const report = activity.report;
  if (report.status !== 'ok') return null;
  let text = t('receipts.fetchedDone', { n: report.added });
  if (report.partial) text += ` · ${t('conn.syncPartial')}`;
  return { text, busy: false };
}

/**
 * Every receipt the shops handed over, per connection — the hub's own
 * receipts screen (user ruling 2026-10-02): the data is global, so this
 * lists it without a space's matched/unmatched labels or linking; a space's
 * Receipts screen carries those. Each connection says how far its fetches
 * reach and what a running fetch has found so far.
 */
export function ConnectionReceiptsScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const metas = useStoreConnMetas();
  const receipts = useGlobalReceipts();
  const ranges = useFetchedRanges();
  const activity = useSyncActivity((s) => s.activity);
  const [query, setQuery] = useState('');
  // user 2026-10-06: every shop folded by default — a search unfolds the ones with hits
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setUnfolded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const shops = useMemo(() => (metas ?? []).filter((m) => (m.kind ?? 'store') === 'store').sort((a, b) => a.displayName.localeCompare(b.displayName)), [metas]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const digits = q.replaceAll(/[\s.,€-]/g, '');
    const amountQ = /^\d+$/.test(digits) && digits.length > 0 ? digits : null;
    return shops.map((meta) => ({
      meta,
      rows: (receipts ?? []).filter((r) => r.instanceId === meta.id && (!q || rowMatches(r, q, amountQ))),
    }));
  }, [shops, receipts, query]);

  const renderRow = (receipt: ReceiptRow) => (
    <button
      key={receipt.id}
      data-testid={`receipt-row-${receipt.id}`}
      onClick={() => void navigate({ to: '/connections/receipts/$receiptId', params: { receiptId: receipt.id } })}
      className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-4 py-3 text-left last:border-0"
    >
      <Icon name="storefront-outline" size={18} color="var(--m-ink-3)" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink">{receipt.merchant ?? partyName(receipt.source)}</span>
        <span className="block text-[11px] text-ink-4">
          {fmtDay(receipt.date, lang)}
          {receipt.items?.length ? ` · ${receipt.items.length} ${t('receipt.items')}` : ''}
          {receipt.documents?.length ? ` · ${t('receipts.invoice')}` : ''}
        </span>
      </span>
      {!!receipt.documents?.length && <Icon name="file-pdf-box" size={16} color="var(--m-ink-4)" data-testid={`receipt-invoice-${receipt.id}`} />}
      <span className="m-num text-[13px] font-semibold text-ink">{fmtCents(receipt.totalCents, receipt.currency ?? 'EUR', lang)}</span>
    </button>
  );

  const renderGroup = ({ meta, rows }: { meta: StoreConnRow; rows: ReceiptRow[] }) => {
    const running = activityLine(activity[meta.id], t);
    const open = unfolded.has(meta.id) || (query.trim().length > 0 && rows.length > 0);
    return (
      <div key={meta.id} data-testid={`receipts-conn-${meta.id}`}>
        <div className="mt-4 mb-1 px-1">
          <button
            type="button"
            data-testid={`receipts-conn-toggle-${meta.id}`}
            aria-expanded={open}
            onClick={() => toggle(meta.id)}
            className="m-tap flex w-full items-center gap-2 border-none bg-transparent p-0 text-left"
          >
            {meta.icon ? <img src={meta.icon} alt="" className="h-5 w-5 rounded object-contain" /> : <Icon name="storefront-outline" size={16} color="var(--m-ink-3)" />}
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{meta.displayName}</span>
            <span className="text-[12px] text-ink-4" data-testid={`receipts-conn-count-${meta.id}`}>
              {rows.length}
            </span>
            <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} color="var(--m-ink-4)" />
          </button>
          <p className="text-[11px] text-ink-4" data-testid={`receipts-conn-range-${meta.id}`}>
            {rangeLine(ranges?.[meta.id], t, lang)}
          </p>
          {running && (
            <p className={`flex items-center gap-1 text-[11px] ${running.busy ? 'text-accent-deep' : 'text-ink-3'}`} data-testid={`receipts-conn-activity-${meta.id}`}>
              {running.busy && <Icon name="progress-clock" size={13} color="var(--m-accent-deep)" />}
              {running.text}
            </p>
          )}
        </div>
        {open && rows.length > 0 && <div className="overflow-hidden rounded-card border border-line bg-surface">{rows.map(renderRow)}</div>}
        {open && rows.length === 0 && (
          <p className="rounded-card border border-dashed border-line px-4 py-3 text-[12px] text-ink-4" data-testid={`receipts-conn-empty-${meta.id}`}>
            {t('receipts.noneYet')}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-connection-receipts">
      <AppBar
        title={t('receipts.globalTitle')}
        leading={
          <IconButton label={t('action.back')} testId="receipts-global-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <p className="mb-2 px-1 text-[12px] leading-relaxed text-ink-4" data-testid="receipts-global-note">
          {t('receipts.globalNote')}
        </p>
        {shops.length > 0 ? (
          <>
            <SearchField testId="receipts-global-search" value={query} onChange={setQuery} placeholder={t('receipts.searchPlaceholder')} />
            {groups.map(renderGroup)}
          </>
        ) : (
          metas && (
            <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center" data-testid="receipts-global-empty">
              <Icon name="receipt-text-outline" size={34} color="var(--m-ink-4)" />
              <p className="text-[14px] font-medium text-ink-2">{t('receipts.globalEmpty')}</p>
              <p className="text-[12px] text-ink-4">{t('receipts.globalEmptyBody')}</p>
              <Button variant="outline" size="sm" data-testid="receipts-global-connect" onClick={() => void navigate({ to: '/connections' })}>
                {t('conn.title')}
              </Button>
            </div>
          )
        )}
      </div>
    </div>
  );
}
