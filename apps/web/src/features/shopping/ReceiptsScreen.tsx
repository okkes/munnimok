import { useMemo, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useNavigate } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { globalAsEntry, linkAsEntry, useProposedMatches, useSpaceReceipts } from '@/application/receiptLinks';
import type { ReceiptEntry } from '@/application/receiptLinks';
import { useSpaceStoreConnLinks, useUnmatchedReceipts } from '@/application/connections';
import { useReceiptOps } from '@/application/receipts';
import { useSpaceTransactions } from '@/application/transactions';
import { partyName } from '@/features/connectors/logos';
import { fmtCents } from '@/lib/money';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';
import { SearchField } from '@/ui/SearchField';

const sourceIcon = (source: string): string => (source === 'photo' ? 'camera-outline' : 'storefront-outline');

/** store, merchant, item names and the amount's digits are all searchable */
function entryMatches(entry: ReceiptEntry, q: string, amountQ: string | null): boolean {
  const receipt = entry.data;
  const haystack = [receipt.merchant ?? '', receipt.source, ...(receipt.items?.map((i) => i.name) ?? [])]
    .join(' ')
    .toLowerCase();
  if (haystack.includes(q)) return true;
  return !!amountQ && String(Math.abs(receipt.totalCents)).includes(amountQ);
}

/**
 * Receipts v3 home (R7): everything the space sees — snapshot-linked
 * receipts (store-born and photo-born) and the owner's still-unmatched
 * store pulls — searchable by name/item/amount, filterable by
 * linked-state and by connection instance, grouped by store.
 */
export function ReceiptsScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store, spaceId } = useData();
  const [query, setQuery] = useState('');
  const [unlinkedOnly, setUnlinkedOnly] = useState(false);
  const [instanceFilter, setInstanceFilter] = useState<string | null>(null);

  const links = useSpaceReceipts();
  const unmatched = useUnmatchedReceipts();
  const connLinks = useSpaceStoreConnLinks();
  const proposals = useProposedMatches();
  const txs = useSpaceTransactions();
  const receiptOps = useReceiptOps();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const currency = space?.currency ?? 'EUR';

  const entries = useMemo(() => {
    const linked = (links ?? []).map(linkAsEntry);
    const open = (unmatched ?? []).map(globalAsEntry);
    const all = [...linked, ...open];
    all.sort((a, b) => b.data.date.localeCompare(a.data.date));
    return all;
  }, [links, unmatched]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const digits = q.replaceAll(/[\s.,€-]/g, '');
    const amountQ = /^\d+$/.test(digits) && digits.length > 0 ? digits : null;
    const visible = entries.filter(
      (entry) =>
        (!unlinkedOnly || !entry.txId) &&
        (!instanceFilter || entry.data.instanceId === instanceFilter) &&
        (!q || entryMatches(entry, q, amountQ)),
    );
    const bySource = new Map<string, ReceiptEntry[]>();
    for (const entry of visible) {
      const list = bySource.get(entry.data.source) ?? [];
      list.push(entry);
      bySource.set(entry.data.source, list);
    }
    // stores first (alphabetical), the photo bucket last
    return [...bySource.entries()].sort(([a], [b]) => {
      if (a === 'photo') return 1;
      if (b === 'photo') return -1;
      return a.localeCompare(b);
    });
  }, [entries, query, unlinkedOnly, instanceFilter]);

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' });
  const unlinkedCount = entries.filter((e) => !e.txId).length;

  const renderRow = (entry: ReceiptEntry) => {
    const receipt = entry.data;
    return (
      <button
        key={receipt.id}
        data-testid={`receipt-row-${receipt.id}`}
        onClick={() => void navigate({ to: '/receipts/$receiptId', params: { receiptId: receipt.id } })}
        className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-4 py-3 text-left last:border-0"
      >
        <Icon name={sourceIcon(receipt.source)} size={18} color="var(--m-ink-3)" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{receipt.merchant ?? t('receipt.sourcePhoto')}</span>
          <span className="block text-[11px] text-ink-4">
            {fmtDate(receipt.date)}
            {receipt.items?.length ? ` · ${receipt.items.length} ${t('receipt.items')}` : ''}
            {receipt.documents?.length ? ` · ${t('receipts.invoice')}` : ''}
          </span>
        </span>
        {!!receipt.documents?.length && <Icon name="file-pdf-box" size={16} color="var(--m-ink-4)" data-testid={`receipt-invoice-${receipt.id}`} />}
        {!entry.txId && (
          <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[10px] font-semibold text-warning" data-testid={`receipt-unmatched-${receipt.id}`}>
            {t('receipts.unmatched')}
          </span>
        )}
        <span className="m-num text-[13px] font-semibold text-ink">{fmtCents(receipt.totalCents, currency, lang)}</span>
      </button>
    );
  };

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
          <IconButton label={t('receipts.connections')} testId="receipts-connections" onClick={() => void navigate({ to: '/connections' })}>
            <Icon name="link-variant" size={20} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <SearchField
          testId="receipts-search"
          value={query}
          onChange={setQuery}
          placeholder={t('receipts.searchPlaceholder')}
          className="mb-2"
        />
        {(unlinkedCount > 0 || (connLinks ?? []).length > 0) && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {unlinkedCount > 0 && (
              <Chip testId="receipts-filter-unlinked" selected={unlinkedOnly} onClick={() => setUnlinkedOnly((v) => !v)}>
                {t('receipts.unlinkedOnly', { n: unlinkedCount })}
              </Chip>
            )}
            {/* one chip per included connection instance (R7 filters) */}
            {(connLinks ?? []).map((link) => (
              <Chip
                key={link.instanceId}
                testId={`receipts-filter-${link.instanceId}`}
                selected={instanceFilter === link.instanceId}
                onClick={() => setInstanceFilter((v) => (v === link.instanceId ? null : link.instanceId))}
              >
                {link.displayName}
              </Chip>
            ))}
          </div>
        )}

        {/* #367 §5.7: receipts whose best match is a reviewed transaction ask first */}
        {!!proposals?.length && (
          <div className="mt-3" data-testid="receipts-to-check">
            <div className="m-cap mb-1 px-1">{t('receipts.toCheckTitle')}</div>
            <p className="mb-1 px-1 text-[11px] leading-snug text-ink-4">{t('receipts.toCheckSub')}</p>
            <div className="overflow-hidden rounded-card border border-line bg-surface">
              {proposals.map((link) => {
                const proposed = txs?.find((tx) => tx.id === link.proposedTxId);
                return (
                  <div key={link.id} className="border-b border-line-2 px-4 py-3 last:border-0" data-testid={`receipt-proposal-${link.id}`}>
                    <div className="flex items-center gap-3">
                      <Icon name="storefront-outline" size={18} color="var(--m-ink-3)" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-ink">{link.merchant ?? partyName(link.source)}</span>
                        <span className="block truncate text-[11px] text-ink-4">
                          {t('receipts.proposedFor')} {proposed?.merchant ?? proposed?.description ?? '…'} · {fmtDate(link.date)}
                        </span>
                      </span>
                      <span className="m-num text-[13px] font-semibold text-ink">{fmtCents(link.totalCents, currency, lang)}</span>
                    </div>
                    <div className="mt-2 flex gap-2 pl-8">
                      <Button size="sm" data-testid={`receipt-proposal-accept-${link.id}`} onClick={() => void receiptOps.acceptMatch(link)}>
                        {t('receipts.accept')}
                      </Button>
                      <Button size="sm" variant="outline" data-testid={`receipt-proposal-reject-${link.id}`} onClick={() => void receiptOps.rejectMatch(link)}>
                        {t('receipts.reject')}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {groups.length > 0 ? (
          groups.map(([source, rows]) => (
            <div key={source}>
              <div className="m-cap mt-3 mb-1 flex items-center gap-1.5 px-1">
                <Icon name={sourceIcon(source)} size={13} />
                {source === 'photo' ? t('receipt.sourcePhoto') : (rows.find((r) => r.data.merchant)?.data.merchant ?? partyName(source))} · {rows.length}
              </div>
              <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid={`receipts-group-${source}`}>
                {rows.map(renderRow)}
              </div>
            </div>
          ))
        ) : (
          links && (
            <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center" data-testid="receipts-empty">
              <Icon name="receipt-text-outline" size={34} color="var(--m-ink-4)" />
              <p className="text-[14px] font-medium text-ink-2">{t('receipts.emptyTitle')}</p>
              <p className="text-[12px] text-ink-4">{t('receipts.emptyBody')}</p>
            </div>
          )
        )}
      </div>
    </div>
  );
}
