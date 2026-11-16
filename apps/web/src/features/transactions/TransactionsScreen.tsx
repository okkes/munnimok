import { ScrollRow } from '@/ui/ScrollRow';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MoreRows, PAGE_ROWS } from '@/ui/MoreRows';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useSpaceAccounts, useSpaceTransactions } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { catName, useCategories } from '@/features/categories/useCategories';
import { REIMBURSED_ID } from '@/domain/categories';
import { orDefaultLabel, txTitle } from '@/lib/text';
import { EMPTY_FILTERS, FilterSheet, countActive } from './FilterSheet';
import type { SheetFilters } from './FilterSheet';
import { useLang } from '@/i18n';
import { filterTxs, matchingPartIndexes } from '@/domain/txFilter';
import { hasUnsettledReimbursement, partNetCents } from '@/domain/reimbursement';
import { kindOf } from '@/domain/txKind';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
import { useData } from '@/app/data';
import { useCanEdit } from '@/app/useCanEdit';
import { useNewTransactions } from '@/application/newTxs';
import { readTxFilters, writeTxFilters } from './txFilters';
import { Icon } from '@/ui/Icon';
import { Chip, Pill } from '@/ui/primitives';
import { TxRow, type TxRowEdge } from '@/ui/TxRow';
import { TxPartRow } from '@/ui/TxPartRow';
import { SearchField } from '@/ui/SearchField';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { useScrollMemory } from '@/lib/scrollMemory';

const DATE_FMT: Record<string, string> = { en: 'en-GB', nl: 'nl-NL', tr: 'tr-TR' };

/** #492: rows are listed a page at a time (thousands of mounted rows made every visit heavy); depth is kept per session */
const ROWS_KEY = 'munni_txlist_rows';

function readShownRows(): number {
  try {
    const stored = Number(sessionStorage.getItem(ROWS_KEY));
    return Number.isFinite(stored) && stored > PAGE_ROWS ? stored : PAGE_ROWS;
  } catch {
    return PAGE_ROWS;
  }
}

/** module-level for S2004 */
function TxPartSoloRows({
  tx,
  parts,
  shownIdx,
  fmt,
  onOpen,
  highlight = '',
}: Readonly<{
  tx: SpaceTx;
  parts: readonly NonNullable<SpaceTx['splits']>[number][];
  shownIdx: readonly number[];
  fmt: ReturnType<typeof useDisplayMoney>['fmt'];
  onOpen: (partId: string | undefined) => void;
  highlight?: string;
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
          amountText={fmt(sign * partNetCents(parts[i]), tx.currency, { date: tx.date })}
          onClick={() => onOpen(parts[i].id)}
          highlight={highlight}
        />
      ))}
    </>
  );
}

/** a split's parts standing in the list (#126): header row plus an inset of parts; module-level for S2004 */
function TxPartGroupRows({
  tx,
  parts,
  fmt,
  onOpen,
}: Readonly<{
  tx: SpaceTx;
  parts: readonly NonNullable<SpaceTx['splits']>[number][];
  fmt: ReturnType<typeof useDisplayMoney>['fmt'];
  onOpen: (partId: string | undefined) => void;
}>) {
  const { t } = useLang();
  const cats = useCategories();
  const [collapsed, setCollapsed] = useState(false);
  const sign = tx.amountCents < 0 ? -1 : 1;
  // #228: the header shows what the whole is worth: part nets, so a reimbursed part shrinks the group
  const totalCents = sign * parts.reduce((sum, part) => sum + partNetCents(part), 0);
  const headCat = cats.byId(tx.catId);
  const headColor = headCat.color ?? cats.byId(headCat.parentId ?? '').color ?? 'var(--m-ink-3)';
  return (
    <div className="py-0.5" data-testid={`tx-parts-${tx.id}`}>
      <div className="flex items-center">
        <button
          data-testid={`tx-parts-head-${tx.id}`}
          onClick={() => onOpen(undefined)}
          className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent px-1 py-2.5 text-left"
        >
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
            style={{ background: `color-mix(in srgb, ${headColor} 14%, transparent)` }}
          >
            <Icon name={headCat.icon} size={20} color={headColor} />
          </span>
          <span className="min-w-0 truncate text-[14px] font-medium text-ink">{txTitle(tx)}</span>
          <Pill tone="accent">{t('tx.linkedParts', { n: parts.length })}</Pill>
          <span className={`m-num ml-auto shrink-0 pl-2 text-[14px] font-semibold ${sign > 0 ? 'text-accent-deep' : 'text-ink'}`}>
            {fmt(totalCents, tx.currency, { date: tx.date })}
          </span>
        </button>
        <button
          aria-label={t('split.title')}
          data-testid={`tx-parts-toggle-${tx.id}`}
          onClick={() => setCollapsed((v) => !v)}
          className="m-tap shrink-0 border-none bg-transparent py-2 pr-1 pl-1 text-ink-3"
        >
          <Icon name={collapsed ? 'chevron-down' : 'chevron-up'} size={15} />
        </button>
      </div>
      {/* #198: hairlines separate transactions, not the parts of one; the rounded inset is the wanted look */}
      {!collapsed && (
        <div className="mb-2 rounded-card bg-bg px-2">
          {parts.map((part, i) => {
            const partCat = cats.byId(part.catId);
            const partColor = partCat.color ?? cats.byId(partCat.parentId ?? '').color;
            return (
              <button
                key={part.id ?? i}
                data-testid={`tx-part-row-${tx.id}-${i}`}
                onClick={() => onOpen(part.id)}
                className="m-tap flex w-full min-w-0 items-center gap-2.5 border-none bg-transparent px-1 py-2 text-left"
              >
                <Icon name="subdirectory-arrow-right" size={15} color="var(--m-ink-4)" />
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                  style={{ background: `color-mix(in srgb, ${partColor ?? 'var(--m-ink-4)'} 14%, transparent)` }}
                >
                  <Icon name={partCat.icon} size={15} color={partColor ?? 'var(--m-ink-3)'} />
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
                {/* #139: the amount wears exactly TxRow's face (#228: net) */}
                <span className={`m-num text-[14px] font-semibold ${sign > 0 ? 'text-accent-deep' : 'text-ink'}`}>
                  {fmt(sign * partNetCents(part), tx.currency, { date: tx.date })}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** the collapsed pair's note: read from the surviving negative leg; a same-sign wallet pair's purchase reads the funding
 *  direction from its hidden transfer leg; a one-way pair reads through the reverse index (#237) */
function peerNoteFor(
  item: SpaceTx,
  byId: Map<string, SpaceTx>,
  reverse: Map<string, SpaceTx>,
  accountNames: Map<string, string>,
): string | undefined {
  const peer = (item.transferPeerId ? byId.get(item.transferPeerId) : undefined) ?? reverse.get(item.id);
  if (!peer) return undefined;
  const sameSign = Math.sign(peer.amountCents) === Math.sign(item.amountCents);
  if (!sameSign && item.amountCents > 0) return undefined;
  const from = accountNames.get(sameSign ? peer.accountId : item.accountId);
  const to = accountNames.get(sameSign ? item.accountId : peer.accountId);
  return from && to ? `${from} → ${to}` : undefined;
}

/** where a row sits against its group card's rounded frame; only the selected tint consumes it (#156) */
function edgeOf(index: number, count: number): TxRowEdge {
  if (count === 1) return 'both';
  if (index === 0) return 'first';
  if (index === count - 1) return 'last';
  return 'none';
}

function peerIndexes(matched: readonly SpaceTx[]) {
  const byId = new Map(matched.map((item) => [item.id, item]));
  // #237 r2: one-way pairs read their peer through the reverse index
  const reverse = new Map<string, SpaceTx>();
  for (const row of matched) {
    if (row.transferPeerId && byId.has(row.transferPeerId)) reverse.set(row.transferPeerId, row);
  }
  const peerOf = (item: SpaceTx) => (item.transferPeerId ? byId.get(item.transferPeerId) : undefined) ?? reverse.get(item.id);
  return { peerOf };
}

/** #237: a pair collapses to one row: the outgoing leg, or for a same-sign wallet pair the real purchase */
function collapseTransferPairs(matched: SpaceTx[]): SpaceTx[] {
  const { peerOf } = peerIndexes(matched);
  return matched.filter((item) => {
    const peer = peerOf(item);
    if (!peer) return true;
    if (Math.sign(peer.amountCents) === Math.sign(item.amountCents)) {
      return !(kindOf(item.txType) === 'transfer' && kindOf(peer.txType) !== 'transfer');
    }
    return item.amountCents <= 0;
  });
}

/** #352: same-day legs sit together, outgoing first */
function pairAdjacentLegs(matched: SpaceTx[]): SpaceTx[] {
  const { peerOf } = peerIndexes(matched);
  const placed = new Set<string>();
  const ordered: SpaceTx[] = [];
  for (const item of matched) {
    if (placed.has(item.id)) continue;
    const peer = peerOf(item);
    if (peer && !placed.has(peer.id) && peer.date === item.date) {
      const out = item.amountCents <= 0 ? item : peer;
      const back = out === item ? peer : item;
      ordered.push(out, back);
      placed.add(out.id);
      placed.add(back.id);
    } else {
      ordered.push(item);
      placed.add(item.id);
    }
  }
  return ordered;
}

function groupByDate(txs: SpaceTx[]): [string, SpaceTx[]][] {
  const groups = new Map<string, SpaceTx[]>();
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
  // #140: seeded from the module snapshot: the lens survives the detour into a transaction; a tab switch finds it empty
  const [query, setQuery] = useState(() => readTxFilters().query);
  const [uncatOnly, setUncatOnly] = useState(() => readTxFilters().uncatOnly);
  const [unsettledOnly, setUnsettledOnly] = useState(() => readTxFilters().unsettledOnly);
  // #243: see the linked legs on their own, pairs uncollapsed
  const [counterOnly, setCounterOnly] = useState(() => readTxFilters().counterOnly);
  const [newOnly, setNewOnly] = useState(() => readTxFilters().newOnly);
  const [filters, setFilters] = useState<SheetFilters>(() => readTxFilters().filters);
  const [filterOpen, setFilterOpen] = useState(false);
  const cats = useCategories();
  useEffect(() => {
    writeTxFilters({ query, uncatOnly, unsettledOnly, counterOnly, newOnly, filters });
  }, [query, uncatOnly, unsettledOnly, counterOnly, newOnly, filters]);
  // #492: a changed lens starts at one page again; the mount keeps the depth the detour remembered
  const [shownRows, setShownRows] = useState(readShownRows);
  const lens = useMemo(
    () => ({ query, uncatOnly, unsettledOnly, counterOnly, newOnly, filters }),
    [query, uncatOnly, unsettledOnly, counterOnly, newOnly, filters],
  );
  const lensRef = useRef(lens);
  useEffect(() => {
    if (lensRef.current === lens) return;
    lensRef.current = lens;
    setShownRows(PAGE_ROWS);
  }, [lens]);
  useEffect(() => {
    try {
      sessionStorage.setItem(ROWS_KEY, String(shownRows));
    } catch {
      // storage refused (private mode): the depth is simply not remembered
    }
  }, [shownRows]);
  const showMore = useCallback(() => setShownRows((n) => n + PAGE_ROWS), []);

  const allTxs = useSpaceTransactions();
  // #148 r2: NEW = first-seen on this device within 24h (the same set
  // home's block lists) — not the unreviewed badge
  const { newIds } = useNewTransactions(allTxs);
  // the account column needs names: one lookup for all rows
  const accounts = useSpaceAccounts();
  // #181 (user): the empty state leads to the SPACE's own accounts screen
  const { spaceId } = useData();
  const canEdit = useCanEdit(); // #505
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
  const openPartPage = (txId: string, partId: string | undefined) =>
    void navigate({ to: '/transactions/$txId', params: { txId }, search: { part: partId } });

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

  const catIds = useMemo(() => {
    const mains = [...filters.mainCatIds];
    if (mains.length === 0) return undefined;
    return new Set(mains.flatMap((id) => [id, ...cats.childrenOf(id).map((c) => c.id)]));
  }, [filters.mainCatIds, cats]);

  // filter first, then newest-first, over the whole history; the render pages through it
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
      minCents: filters.minCents,
      maxCents: filters.maxCents,
    });
    if (unsettledOnly) matched = matched.filter(hasUnsettledReimbursement);
    if (newOnly) matched = matched.filter((item) => newIds.has(item.id));
    // paired transfers are one event: the incoming leg hides when its outgoing peer is listed, unless an account filter is on
    // (a per-account view needs its own leg); the counter chip turns collapse off (#243)
    if (filters.accountIds.size === 0 && !counterOnly) matched = collapseTransferPairs(matched);
    matched.sort((a, b) => b.date.localeCompare(a.date));
    // #352: with legs standing separately a same-day pair sits together; the date sort alone scattered them
    if (counterOnly) matched = pairAdjacentLegs(matched);
    return matched;
  }, [allTxs, query, filters, uncatOnly, unsettledOnly, counterOnly, newOnly, newIds, catIds]);
  const shownTxs = useMemo(() => txs?.slice(0, shownRows), [txs, shownRows]);

  // the collapsed row says where the money went; a same-sign wallet pair's purchase reads the funding direction (#237)
  const peerNotes = useMemo(() => {
    if (filters.accountIds.size > 0) return new Map<string, string>();
    const byId = new Map((allTxs ?? []).map((item) => [item.id, item]));
    const reverse = new Map<string, SpaceTx>();
    for (const row of allTxs ?? []) {
      if (row.transferPeerId) reverse.set(row.transferPeerId, row);
    }
    const map = new Map<string, string>();
    for (const item of shownTxs ?? []) {
      const note = peerNoteFor(item, byId, reverse, accountNames);
      if (note) map.set(item.id, note);
    }
    return map;
  }, [shownTxs, allTxs, accountNames, filters.accountIds]);

  // rows convert at their own day's fixing: warm the rate cache for every date shown
  const { fmt, ensureDates } = useDisplayMoney();
  useEffect(() => {
    ensureDates([...new Set((shownTxs ?? []).map((tx) => tx.date))]);
  }, [shownTxs, ensureDates]);

  const groups = groupByDate(shownTxs ?? []);
  const remainingRows = (txs?.length ?? 0) - (shownTxs?.length ?? 0);
  const activeCount = countActive(filters);
  const filtering = !!query || uncatOnly || unsettledOnly || counterOnly || newOnly || !!catIds || activeCount > 0;

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-transactions">
      <AppBar
        large
        title={t('tab.transactions')}
        trailing={
          <>
            <HelpButton tourId="transactions" />
            {/* #348 (user): adding is a screen of its own; #505: not in a space this identity only reads */}
            {canEdit && (
              <IconButton label={t('txform.addTitle')} testId="tx-add" onClick={() => void navigate({ to: '/transactions/new' })}>
                <Icon name="plus" size={22} />
              </IconButton>
            )}
          </>
        }
      />
      <div className="shrink-0 px-5 pb-1">
        <SearchField testId="tx-search" value={query} onChange={setQuery} placeholder={t('tx.searchPlaceholder')} />
        <ScrollRow className="mt-2">
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
          <Chip testId="tx-filter-new" selected={newOnly} onClick={() => setNewOnly((v) => !v)}>
            {t('tx.newFilter')}
          </Chip>
          <Chip testId="tx-filter-uncat" tone="warning" selected={uncatOnly} onClick={() => setUncatOnly((v) => !v)}>
            {t('tx.uncategorizedFilter')}
          </Chip>
          <Chip testId="tx-filter-unsettled" selected={unsettledOnly} onClick={() => setUnsettledOnly((v) => !v)}>
            {t('tx.unsettledFilter')}
          </Chip>
          <Chip testId="tx-filter-counter" selected={counterOnly} onClick={() => setCounterOnly((v) => !v)}>
            <Icon name="swap-horizontal" size={14} />
            {t('tx.counterFilter')}
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
        </ScrollRow>
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
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="tx-empty-add-account"
                  onClick={() => void navigate({ to: '/spaces/$spaceId/accounts', params: { spaceId } })}
                >
                  <Icon name="bank-plus" size={16} />
                  {t('tx.emptyCta')}
                </Button>
              )
            }
          />
        )}
        {groups.map(([date, list]) => {
          // #352: adjacent mutually-linked same-day legs render as one unit (the reorder above guarantees adjacency)
          const pairTops = new Set<string>();
          for (let i = 0; i < list.length - 1; i += 1) {
            const row = list[i];
            const next = list[i + 1];
            if ((row.transferPeerId === next.id || next.transferPeerId === row.id) && row.date === next.date) {
              pairTops.add(row.id);
              i += 1;
            }
          }
          // S2004: the row renderer lives at this level, not inside the list map
          const renderRow = (item: SpaceTx, listIndex: number) => (
            <TxRow
              key={item.id}
              tx={item}
              highlight={query}
              selected={item.id === openTxId}
              edge={edgeOf(listIndex, list.length)}
              accountName={accountNames.get(item.accountId)}
              givenCents={givenByCredit.get(item.id) ?? 0}
              transferNote={peerNotes.get(item.id)}
              onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: item.id } })}
            />
          );
          return (
          <div key={date}>
            <div className="m-cap sticky top-0 z-10 -mx-1 mt-4 mb-1 bg-bg px-2 py-1">{fmtDay(date)}</div>
            <div className="divide-y divide-line-2 rounded-card border border-line bg-surface px-3 py-1">
              {list.map((tx, listIndex) => {
                if (listIndex > 0 && pairTops.has(list[listIndex - 1].id)) return null;
                const rowParts = (tx.splits ?? []).filter((s) => s.catId !== REIMBURSED_ID);
                // #149: every multi-part row branches: a flat category spread is a split to the user
                if (rowParts.length > 1) {
                  // a filter matching only some parts shows exactly those, aligned like normal rows; the band stays for full groups
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
                        highlight={query}
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
                if (pairTops.has(tx.id)) {
                  return (
                    <div key={tx.id} className="py-1.5" data-testid={`tx-pair-${tx.id}`}>
                      <div className="mb-0.5 flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-wide text-accent-deep uppercase">
                        <Icon name="swap-horizontal" size={12} color="var(--m-accent-deep)" />
                        {t('tx.linkedPair')}
                      </div>
                      <div className="rounded-card bg-bg px-2">
                        {renderRow(tx, listIndex)}
                        {renderRow(list[listIndex + 1], listIndex + 1)}
                      </div>
                    </div>
                  );
                }
                return renderRow(tx, listIndex);
              })}
            </div>
          </div>
          );
        })}
        {remainingRows > 0 && <MoreRows rootRef={scrollRef} remaining={remainingRows} onMore={showMore} testId="tx-list-more" />}
      </div>
    </div>
  );
}
