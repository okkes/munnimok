import { useMemo, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useSpaceAccounts, useSpaceTransactions } from '@/application/transactions';
import { catName, useCategories } from '@/features/categories/useCategories';
import { useLang } from '@/i18n';
import type { TransactionRow } from '@/db/types';
import { filterTxs } from '@/domain/txFilter';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
import { Icon } from '@/ui/Icon';
import { TxRow } from '@/ui/TxRow';
import { TxFormSheet } from './TxFormSheet';

const DATE_FMT: Record<string, string> = { en: 'en-GB', nl: 'nl-NL', tr: 'tr-TR' };

function groupByDate(txs: TransactionRow[]): [string, TransactionRow[]][] {
  const groups = new Map<string, TransactionRow[]>();
  for (const tx of txs) {
    const list = groups.get(tx.date) ?? [];
    list.push(tx);
    groups.set(tx.date, list);
  }
  return [...groups.entries()];
}

export function TransactionsScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [accountFilter, setAccountFilter] = useState<string | undefined>();
  const [reviewOnly, setReviewOnly] = useState(false);
  // overview drill-down: category + period arrive as search params
  const { catId, from, to } = useSearch({ strict: false }) as { catId?: string; from?: string; to?: string };
  const cats = useCategories();

  const accounts = useSpaceAccounts();
  const allTxs = useSpaceTransactions();

  const fmtDay = (iso: string) =>
    new Intl.DateTimeFormat(DATE_FMT[lang], { weekday: 'short', day: 'numeric', month: 'short' }).format(
      new Date(iso),
    );

  // a main category matches itself and all of its subs
  const catIds = useMemo(() => {
    if (!catId) return undefined;
    return new Set([catId, ...cats.childrenOf(catId).map((c) => c.id)]);
  }, [catId, cats]);

  // filter FIRST, then newest-first capped at 200 — an old category match
  // must not vanish behind the recency cap
  const txs = useMemo(() => {
    if (!allTxs) return undefined;
    // filterTxs returns a fresh array — sorting it in place mutates no input
    const matched = filterTxs(allTxs, { query, accountId: accountFilter, onlyNeedsReview: reviewOnly, catIds, from, to });
    matched.sort((a, b) => b.date.localeCompare(a.date));
    return matched.slice(0, 200);
  }, [allTxs, query, accountFilter, reviewOnly, catIds, from, to]);

  const groups = groupByDate(txs ?? []);
  const filtering = !!query || !!accountFilter || reviewOnly || !!catIds;
  const drillCat = catId ? cats.byId(catId) : null;

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-transactions">
      <AppBar
        large
        title={t('tab.transactions')}
        trailing={
          <IconButton label={t('txform.addTitle')} testId="tx-add" onClick={() => setAddOpen(true)}>
            <Icon name="plus" size={22} />
          </IconButton>
        }
      />
      <TxFormSheet open={addOpen} onOpenChange={setAddOpen} />
      {/* search + filters */}
      <div className="shrink-0 px-5 pb-1">
        <input
          data-testid="tx-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('tx.searchPlaceholder')}
          className="h-11 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
        />
        {/* overview drill-down chip: category + period, one tap to clear */}
        {drillCat && (
          <button
            data-testid="tx-drill-chip"
            onClick={() => void navigate({ to: '/transactions', search: {} })}
            className="m-tap mt-2 flex w-full items-center gap-2 rounded-card border border-accent bg-accent-soft px-3 py-2 text-left text-[12px] font-medium text-accent-deep"
          >
            <Icon name={drillCat.icon} size={15} />
            <span className="min-w-0 flex-1 truncate">
              {catName(drillCat, t)}
              {from && to && ` · ${from} – ${to}`}
            </span>
            <Icon name="close" size={14} />
          </button>
        )}
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          <button
            data-testid="tx-filter-review"
            onClick={() => setReviewOnly((v) => !v)}
            className={`m-tap shrink-0 rounded-full border px-3 py-1.5 text-[12px] ${
              reviewOnly ? 'border-warning bg-warning-soft font-medium text-warning' : 'border-line bg-surface text-ink-2'
            }`}
          >
            {t('review.confirm')}
          </button>
          {(accounts ?? []).map((a) => (
            <button
              key={a.id}
              data-testid={`tx-filter-account-${a.id}`}
              onClick={() => setAccountFilter((cur) => (cur === a.id ? undefined : a.id))}
              className={`m-tap shrink-0 rounded-full border px-3 py-1.5 text-[12px] ${
                accountFilter === a.id
                  ? 'border-accent bg-accent-soft font-medium text-accent-deep'
                  : 'border-line bg-surface text-ink-2'
              }`}
            >
              {a.name}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6" data-testid="tx-list">
        {txs && groups.length === 0 && (
          <EmptyState
            testId="tx-empty"
            icon={filtering ? 'magnify' : 'receipt-text-outline'}
            text={t(filtering ? 'tx.emptyFiltered' : 'tx.emptyList')}
            action={
              filtering ? undefined : (
                <Button size="sm" variant="outline" onClick={() => void navigate({ to: '/accounts' })}>
                  <Icon name="bank-plus" size={16} />
                  {t('tx.emptyCta')}
                </Button>
              )
            }
          />
        )}
        {groups.map(([date, list]) => (
          <div key={date}>
            <div className="m-cap mt-4 mb-1 px-1">{fmtDay(date)}</div>
            <div className="rounded-card border border-line bg-surface px-3 py-1">
              {list.map((tx) => (
                <TxRow
                  key={tx.id}
                  tx={tx}
                  onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: tx.id } })}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
