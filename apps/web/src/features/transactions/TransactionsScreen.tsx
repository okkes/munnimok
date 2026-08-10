import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useSpaceAccounts, useSpaceTransactions } from '@/application/transactions';
import { catName, useCategories } from '@/features/categories/useCategories';
import { REIMBURSED_ID } from '@/domain/categories';
import { orDefaultLabel, txTitle } from '@/lib/text';
import { EMPTY_FILTERS, FilterSheet, countActive } from './FilterSheet';
import type { SheetFilters } from './FilterSheet';
import { useLang } from '@/i18n';
import type { TransactionRow } from '@/db/types';
import { filterTxs, matchingPartIndexes } from '@/domain/txFilter';
import { hasUnsettledReimbursement } from '@/domain/reimbursement';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
import { AddAccountChooser } from '@/features/accounts/AddAccountChooser';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { TxRow } from '@/ui/TxRow';
import { TxPartRow } from '@/ui/TxPartRow';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { useScrollMemory } from '@/lib/scrollMemory';
import { TxFormSheet } from './TxFormSheet';

const DATE_FMT: Record<string, string> = { en: 'en-GB', nl: 'nl-NL', tr: 'tr-TR' };

/** the parts a filter singled out, standing alone (#126 r8) —
 *  module-level for S2004 */
function TxPartSoloRows({
  tx,
  parts,
  shownIdx,
  fmt,
  onOpen,
}: Readonly<{
  tx: TransactionRow;
  parts: readonly NonNullable<TransactionRow['splits']>[number][];
  shownIdx: readonly number[];
  fmt: ReturnType<typeof useDisplayMoney>['fmt'];
  onOpen: (partId: string | undefined) => void;
}>) {
  const sign = tx.amountCents < 0 ? -1 : 1;
  return (
    <>
      {shownIdx.map((i) => (
        <TxPartRow
          key={parts[i].id ?? `${tx.id}-${i}`}
          tx={tx}
          part={parts[i]}
          index={i}
          amountText={fmt(sign * Math.abs(parts[i].amountCents), tx.currency, { date: tx.date })}
          onClick={() => onOpen(parts[i].id)}
        />
      ))}
    </>
  );
}

/** a split's parts standing IN the list (#126 r5, restyled r6 to the
 *  user's inspiration): a compact header band names the original
 *  transaction — split badge, part count, the FULL amount, a collapse
 *  chevron — and a curved branch line walks into each sub-transaction
 *  row below it. r9: the whole group lives in its own bordered card so
 *  it never reads as a tail of the row above. Module-level for S2004. */
function TxPartGroupRows({
  tx,
  parts,
  fmt,
  onOpen,
}: Readonly<{
  tx: TransactionRow;
  parts: readonly NonNullable<TransactionRow['splits']>[number][];
  fmt: ReturnType<typeof useDisplayMoney>['fmt'];
  onOpen: (partId: string | undefined) => void;
}>) {
  const { t } = useLang();
  const cats = useCategories();
  const [collapsed, setCollapsed] = useState(false);
  const sign = tx.amountCents < 0 ? -1 : 1;
  const totalCents = sign * parts.reduce((sum, part) => sum + Math.abs(part.amountCents), 0);
  return (
    <div
      className="my-2 overflow-hidden rounded-card border border-accent-deep/20 bg-accent-soft/15"
      data-testid={`tx-parts-${tx.id}`}
    >
      <div className="flex items-center bg-accent-soft/45">
        <button
          data-testid={`tx-parts-head-${tx.id}`}
          onClick={() => onOpen(undefined)}
          className="m-tap flex min-w-0 flex-1 items-center gap-2 border-none bg-transparent px-3 py-2 text-left"
        >
          <Icon name="call-split" size={15} color="var(--m-accent-deep)" />
          <span className="min-w-0 truncate text-[13px] font-medium text-ink">{txTitle(tx)}</span>
          <span className="shrink-0 text-[12px] text-ink-3">· {t('tx.linkedParts', { n: parts.length })}</span>
          <span className="m-num ml-auto shrink-0 pl-2 text-[13px] font-medium text-ink">
            {fmt(totalCents, tx.currency, { date: tx.date })}
          </span>
        </button>
        <button
          aria-label={t('split.title')}
          data-testid={`tx-parts-toggle-${tx.id}`}
          onClick={() => setCollapsed((v) => !v)}
          className="m-tap shrink-0 border-none bg-transparent py-2 pr-3 pl-1 text-ink-3"
        >
          <Icon name={collapsed ? 'chevron-down' : 'chevron-up'} size={15} />
        </button>
      </div>
      {!collapsed &&
        parts.map((part, i) => {
          const partCat = cats.byId(part.catId);
          const partColor = partCat.color ?? cats.byId(partCat.parentId ?? '').color;
          return (
            <div key={part.id ?? i} className="flex w-full items-stretch">
              {/* the branch: a spine from the header curving into this
                  row's icon — OUTSIDE the pressable row, so the press
                  effect never drags the line along (#126 r8) */}
              <span aria-hidden className="relative w-7 shrink-0 self-stretch">
                <span className="absolute top-[-8px] left-[13px] h-[26px] w-[12px] rounded-bl-[10px] border-b-2 border-l-2 border-accent-deep/35" />
                {i < parts.length - 1 && (
                  <span className="absolute top-[-8px] bottom-[-8px] left-[13px] border-l-2 border-accent-deep/35" />
                )}
              </span>
              <button
                data-testid={`tx-part-row-${tx.id}-${i}`}
                onClick={() => onOpen(part.id)}
                className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent py-2 pr-2 pl-0 text-left"
              >
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                  style={{ background: `color-mix(in srgb, ${partColor ?? 'var(--m-ink-4)'} 14%, transparent)` }}
                >
                  <Icon name={partCat.icon} size={17} color={partColor ?? 'var(--m-ink-3)'} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-ink">
                    {orDefaultLabel(part.label, `${txTitle(tx)} – ${t('split.partN', { n: i + 1 })}`)}
                  </span>
                  <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
                    <span className="truncate">{catName(partCat, t)}</span>
                    {i === 0 && tx.needsReview === 1 && (
                      <span className="shrink-0 rounded-full bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                        {t('tx.unreviewed')}
                      </span>
                    )}
                  </span>
                </span>
                {/* #139: the amount wears exactly TxRow's face */}
                <span className={`m-num text-[14px] font-semibold ${sign > 0 ? 'text-accent-deep' : 'text-ink'}`}>
                  {fmt(sign * Math.abs(part.amountCents), tx.currency, { date: tx.date })}
                </span>
              </button>
            </div>
          );
        })}
    </div>
  );
}

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
  const [uncatOnly, setUncatOnly] = useState(false);
  const [unsettledOnly, setUnsettledOnly] = useState(false);
  const [filters, setFilters] = useState<SheetFilters>(EMPTY_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const cats = useCategories();

  const allTxs = useSpaceTransactions();
  // desktop density (D2): the account column needs names, one lookup for all rows
  const accounts = useSpaceAccounts();
  // AE3: the empty state opens the shared chooser IN PLACE
  const [chooserOpen, setChooserOpen] = useState(false);
  const accountNames = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a.name])), [accounts]);
  // credits net out what they refunded: one pass over the links for the whole list
  const givenByCredit = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of allTxs ?? []) {
      for (const link of item.reimbursements ?? []) {
        map.set(link.txId, (map.get(link.txId) ?? 0) + link.amountCents);
      }
    }
    return map;
  }, [allTxs]);
  // when embedded as a master pane (§4.2) the open detail's row lights up
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const openTxId = /^\/transactions\/([^/]+)$/.exec(pathname)?.[1];
  // the list remembers where you were (#131)
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollMemory(scrollRef, 'transactions');
  // #126 r5: a part row opens its own page
  const openPartPage = (txId: string, partId: string | undefined) =>
    void navigate({ to: '/transactions/$txId', params: { txId }, search: { part: partId } });

  // desktop keyboard (§4.5): `/` jumps to search unless already typing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
      e.preventDefault();
      document.querySelector<HTMLInputElement>('[data-testid="tx-search"]')?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const fmtDay = (iso: string) =>
    new Intl.DateTimeFormat(DATE_FMT[lang], { weekday: 'short', day: 'numeric', month: 'short' }).format(
      new Date(iso),
    );

  // a main category matches itself and all of its subs
  const catIds = useMemo(() => {
    const mains = [...filters.mainCatIds];
    if (mains.length === 0) return undefined;
    return new Set(mains.flatMap((id) => [id, ...cats.childrenOf(id).map((c) => c.id)]));
  }, [filters.mainCatIds, cats]);

  // filter FIRST, then newest-first capped at 200 — an old category match
  // must not vanish behind the recency cap
  const txs = useMemo(() => {
    if (!allTxs) return undefined;
    // filterTxs returns a fresh array — sorting it in place mutates no input
    let matched = filterTxs(allTxs, {
      query,
      accountIds: filters.accountIds,
      onlyUncategorized: uncatOnly,
      catIds,
      txTypes: filters.txTypes,
      from: filters.from,
      to: filters.to,
    });
    // quick filter (redesign): expected/received value still open
    if (unsettledOnly) matched = matched.filter(hasUnsettledReimbursement);
    // paired transfers are ONE event (arc 1): the incoming leg hides when
    // its outgoing peer is listed too — unless an account filter is on
    // (a per-account view needs its own leg for the running story)
    if (filters.accountIds.size === 0) {
      const ids = new Set(matched.map((item) => item.id));
      matched = matched.filter((item) => !(item.transferPeerId && item.amountCents > 0 && ids.has(item.transferPeerId)));
    }
    matched.sort((a, b) => b.date.localeCompare(a.date));
    return matched.slice(0, 200);
  }, [allTxs, query, filters, uncatOnly, unsettledOnly, catIds]);

  // the collapsed row says where the money went: "Checking → Savings"
  const peerNotes = useMemo(() => {
    if (filters.accountIds.size > 0) return new Map<string, string>();
    const byId = new Map((allTxs ?? []).map((item) => [item.id, item]));
    const map = new Map<string, string>();
    for (const item of txs ?? []) {
      if (!item.transferPeerId || item.amountCents > 0) continue;
      const peer = byId.get(item.transferPeerId);
      const from = accountNames.get(item.accountId);
      const to = peer && accountNames.get(peer.accountId);
      if (from && to) map.set(item.id, `${from} → ${to}`);
    }
    return map;
  }, [txs, allTxs, accountNames, filters.accountIds]);

  // display-currency lens: rows convert at their own day's fixing —
  // warm the rate cache for every date this list is about to show
  const { fmt, ensureDates } = useDisplayMoney();
  useEffect(() => {
    ensureDates([...new Set((txs ?? []).map((tx) => tx.date))]);
  }, [txs, ensureDates]);

  const groups = groupByDate(txs ?? []);
  const activeCount = countActive(filters);
  const filtering = !!query || uncatOnly || unsettledOnly || !!catIds || activeCount > 0;

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-transactions">
      <AppBar
        large
        title={t('tab.transactions')}
        trailing={
          <>
            <HelpButton tourId="transactions" />
            <IconButton label={t('txform.addTitle')} testId="tx-add" onClick={() => setAddOpen(true)}>
              <Icon name="plus" size={22} />
            </IconButton>
          </>
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
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {/* accounts/types/categories/dates live in the filter sheet —
              chips per account stopped scaling once feeds multiplied */}
          <Chip testId="tx-filter-open" selected={activeCount > 0} onClick={() => setFilterOpen(true)}>
            <Icon name="filter-variant" size={14} />
            {t('tx.filters')}
            {activeCount > 0 && (
              <span className="rounded-full bg-accent px-1.5 text-[10px] font-bold text-on-brand" data-testid="tx-filter-count">
                {activeCount}
              </span>
            )}
          </Chip>
          <Chip testId="tx-filter-uncat" tone="warning" selected={uncatOnly} onClick={() => setUncatOnly((v) => !v)}>
            {t('tx.uncategorizedFilter')}
          </Chip>
          <Chip testId="tx-filter-unsettled" selected={unsettledOnly} onClick={() => setUnsettledOnly((v) => !v)}>
            {t('tx.unsettledFilter')}
          </Chip>
          {activeCount > 0 && (
            <button
              data-testid="tx-filter-clear"
              onClick={() => setFilters(EMPTY_FILTERS)}
              className="m-tap flex shrink-0 items-center gap-1 rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] text-ink-3"
            >
              <Icon name="close" size={12} />
              {t('tx.filtersReset')}
            </button>
          )}
        </div>
      </div>
      <FilterSheet open={filterOpen} onOpenChange={setFilterOpen} value={filters} onChange={setFilters} />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-6" data-testid="tx-list">
        {txs && groups.length === 0 && (
          <EmptyState
            testId="tx-empty"
            icon={filtering ? 'magnify' : 'receipt-text-outline'}
            text={t(filtering ? 'tx.emptyFiltered' : 'tx.emptyList')}
            action={
              filtering ? undefined : (
                <Button size="sm" variant="outline" data-testid="tx-empty-add-account" onClick={() => setChooserOpen(true)}>
                  <Icon name="bank-plus" size={16} />
                  {t('tx.emptyCta')}
                </Button>
              )
            }
          />
        )}
        {groups.map(([date, list]) => (
          <div key={date}>
            {/* sticky (D2): the group's date stays readable while its rows scroll */}
            <div className="m-cap sticky top-0 z-10 -mx-1 mt-4 mb-1 bg-bg px-2 py-1">{fmtDay(date)}</div>
            <div className="rounded-card border border-line bg-surface px-3 py-1">
              {list.map((tx) => {
                // #126 r5: a real split doesn't show its container in the
                // list — the sub-transactions stand as rows of their own,
                // the shared rail linking them; each opens its own page
                const rowParts = (tx.splits ?? []).filter((s) => s.catId !== REIMBURSED_ID);
                // #149: EVERY multi-part row branches — a flat category
                // spread is a split to the user, labels or not
                if (rowParts.length > 1) {
                  // r8 (user request): a filter that matches only SOME
                  // parts shows exactly those, aligned like normal rows
                  // with the split glyph — the band stays for full groups
                  const shown = matchingPartIndexes(tx, { catIds, txTypes: filters.txTypes, onlyUncategorized: uncatOnly });
                  if (shown.length < rowParts.length) {
                    return (
                      <TxPartSoloRows
                        key={tx.id}
                        tx={tx}
                        parts={rowParts}
                        shownIdx={shown}
                        fmt={fmt}
                        onOpen={(partId) => openPartPage(tx.id, partId)}
                      />
                    );
                  }
                  return (
                    <TxPartGroupRows
                      key={tx.id}
                      tx={tx}
                      parts={rowParts}
                      fmt={fmt}
                      onOpen={(partId) => openPartPage(tx.id, partId)}
                    />
                  );
                }
                return (
                  <TxRow
                    key={tx.id}
                    tx={tx}
                    highlight={query}
                    selected={tx.id === openTxId}
                    accountName={accountNames.get(tx.accountId)}
                    givenCents={givenByCredit.get(tx.id) ?? 0}
                    transferNote={peerNotes.get(tx.id)}
                    onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: tx.id } })}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <AddAccountChooser open={chooserOpen} onOpenChange={setChooserOpen} gcAvailable />
    </div>
  );
}
