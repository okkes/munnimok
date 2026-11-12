import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { useGoals } from '@/application/goals';
import type { SpaceTx } from '@/application/transactions';
import { goalPaidTxs } from '@/domain/goals';
import type { Period } from '@/domain/periods';
import { netAmountCents } from '@/domain/reimbursement';
import { expenseSeries, finishedAverage, localDate, scopeIds, scopedContribution } from '@/domain/trends';
import type { InSpaceCurrency } from '@/domain/trends';
import { catName, useCategories } from '@/features/categories/useCategories';
import { AutoHeight } from '@/ui/AutoHeight';
import { Bars } from '@/ui/charts/Bars';
import { Icon } from '@/ui/Icon';
import { BreakdownView } from './BreakdownView';
import { CompareView } from './CompareView';
import { GraphTxSheet } from './GraphTxSheet';
import type { ScopedTx } from './GraphTxSheet';
import { GRAPH_VIEWS, compactMoney, periodRangeText, recallGraphView, rememberGraphView } from './format';
import type { GraphView } from './format';

/** what a card charts: the built-in scope or a custom graph, with its face */
export interface GraphDef {
  id: string;
  name: string;
  /** null = every expense */
  catIds: string[] | null;
  /** #531: the financial accounts it reads; null = every account */
  accountIds: string[] | null;
  /** #455: what cashed-out goals bought stays out */
  skipGoalSpending?: boolean;
  icon: string;
  color: string;
}

const VIEW_KEY: Record<GraphView, TranslationKey> = {
  periods: 'trends.viewPeriods',
  compare: 'trends.viewCompare',
  breakdown: 'trends.viewBreakdown',
};

/** the compare and breakdown views walk the periods with arrows; the bars pick directly */
function PeriodNav({
  graphId,
  text,
  canPrev,
  canNext,
  onStep,
}: Readonly<{ graphId: string; text: string; canPrev: boolean; canNext: boolean; onStep: (delta: number) => void }>) {
  const { t } = useLang();
  return (
    <div className="mt-2 flex items-center justify-between text-[11px] text-ink-4">
      <button
        data-testid={`trends-graph-prev-${graphId}`}
        aria-label={t('action.back')}
        disabled={!canPrev}
        onClick={() => onStep(-1)}
        className="m-tap flex h-7 w-7 items-center justify-center border-none bg-transparent text-ink-3 disabled:opacity-30"
      >
        <Icon name="chevron-left" size={18} />
      </button>
      <span data-testid={`trends-graph-period-${graphId}`}>{text}</span>
      <button
        data-testid={`trends-graph-next-${graphId}`}
        aria-label={t('help.next')}
        disabled={!canNext}
        onClick={() => onStep(1)}
        className="m-tap flex h-7 w-7 items-center justify-center border-none bg-transparent text-ink-3 disabled:opacity-30"
      >
        <Icon name="chevron-right" size={18} />
      </button>
    </div>
  );
}

/**
 * One spending card (user 2026-10-08): a scope, three views — the bars
 * per period with their numbers, today against the same day last period,
 * the period by subcategory — and the transactions behind the number.
 */
export function SpendingCard({
  graph,
  header,
  periods,
  labels,
  txs: allTxs,
  today,
  currency,
  spaceId,
  fmt,
  inSpace,
  testId,
  chartTestId,
  currentTestId,
}: Readonly<{
  graph: GraphDef;
  /** the card's title row (the built-in's scope picker, a custom graph's name and pencil) */
  header: ReactNode;
  periods: readonly Period[];
  labels: readonly string[];
  txs: readonly SpaceTx[];
  today: string;
  currency: string;
  spaceId: string;
  fmt: (cents: number) => string;
  /** the sums restate another currency; the rows behind the door stay as recorded */
  inSpace: InSpaceCurrency;
  testId?: string;
  chartTestId?: string;
  currentTestId?: string;
}>) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const cats = useCategories();
  const [view, setView] = useState<GraphView>(() => recallGraphView(spaceId, graph.id));
  const [selected, setSelected] = useState(periods.length - 1);
  const [sheet, setSheet] = useState<{ open: boolean; subId: string | null }>({ open: false, subId: null });

  // #531: a graph narrowed to some accounts reads only their rows — every view and the door alike;
  // #455: one that leaves out what goals bought drops those rows the same way
  const goals = useGoals();
  const goalPaid = useMemo(() => (graph.skipGoalSpending ? goalPaidTxs(goals ?? []) : null), [graph.skipGoalSpending, goals]);
  const txs = useMemo(() => {
    const picked = graph.accountIds ? new Set(graph.accountIds) : null;
    if (!picked && !goalPaid) return allTxs;
    return allTxs.filter((tx) => (!picked || picked.has(tx.accountId)) && !goalPaid?.has(tx.id));
  }, [allTxs, graph.accountIds, goalPaid]);
  const ids = useMemo(() => scopeIds(cats, graph.catIds), [cats, graph.catIds]);
  const values = useMemo(() => expenseSeries(txs, periods, ids, inSpace), [txs, periods, ids, inSpace]);
  const average = useMemo(() => finishedAverage(values), [values]);
  const index = Math.min(selected, periods.length - 1);
  const period = periods[index];
  const isCurrent = index === periods.length - 1;

  // the door counts the period's rows in the card's scope; the sheet may
  // narrow to one subcategory picked in the breakdown
  const sheetIds = useMemo(() => (sheet.subId === null ? ids : scopeIds(cats, [sheet.subId])), [sheet.subId, ids, cats]);
  const periodTxs = useMemo(() => txs.filter((tx) => tx.date >= period.start && tx.date <= period.end), [txs, period]);
  const doorCount = useMemo(() => periodTxs.filter((tx) => scopedContribution(tx, ids) > 0).length, [periodTxs, ids]);
  const rows = useMemo<ScopedTx[]>(
    () =>
      periodTxs
        .map((tx) => ({ tx, cents: scopedContribution(tx, sheetIds), netCents: netAmountCents(tx) }))
        .filter((row) => row.cents > 0)
        .sort((a, b) => b.tx.date.localeCompare(a.tx.date)),
    [periodTxs, sheetIds],
  );

  const pickView = (next: GraphView) => {
    setView(next);
    rememberGraphView(spaceId, graph.id, next);
  };
  const periodText = isCurrent ? t('overview.thisPeriod') : periodRangeText(period, lang);
  const periodAria = (i: number, cents: number) =>
    `${localDate(periods[i].start).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' })}: ${fmt(cents)}`;
  const subName = sheet.subId === null ? '' : ` · ${catName(cats.byId(sheet.subId || undefined), t)}`;

  return (
    <section className="mt-4 rounded-card border border-line bg-surface p-4" data-testid={testId}>
      {header}
      <div className="mt-3 flex rounded-xl bg-bg-2 p-0.5">
        {GRAPH_VIEWS.map((candidate) => (
          <button
            key={candidate}
            data-testid={`trends-graph-view-${candidate}-${graph.id}`}
            onClick={() => pickView(candidate)}
            className={`m-tap flex-1 rounded-[10px] border-none py-1.5 text-[11px] whitespace-nowrap ${
              view === candidate ? 'bg-surface font-semibold text-ink shadow-sm' : 'bg-transparent text-ink-3'
            }`}
          >
            {t(VIEW_KEY[candidate])}
          </button>
        ))}
      </div>
      {/* #540: switching views grows or shrinks the card smoothly — the next card never jumps */}
      <AutoHeight className="mt-3">
        {view === 'periods' && (
          <>
            <Bars
              testId={chartTestId}
              values={values}
              labels={[...labels]}
              // an empty period says nothing — a row of "€0" under the bars read as noise (gallery 2026-10-08)
              valueLabels={values.map((cents) => (cents > 0 ? compactMoney(cents, currency, lang) : ''))}
              ariaLabels={values.map((cents, i) => periodAria(i, cents))}
              color={graph.color}
              hollowLast
              average={average}
              selectedIndex={index}
              onSelect={setSelected}
            />
            <div className="mt-2 flex items-baseline justify-between gap-3 text-[11px] text-ink-4">
              <span>{t('trends.avgLine', { amount: fmt(average) })}</span>
              <span className="text-right" data-testid={currentTestId}>
                {periodText} · <span className="m-num font-semibold text-ink">{fmt(values[index] ?? 0)}</span>
              </span>
            </div>
          </>
        )}
        {view === 'compare' && (
          <CompareView graphId={graph.id} periods={periods} selected={index} txs={txs} catIds={graph.catIds} today={today} color={graph.color} fmt={fmt} inSpace={inSpace} />
        )}
        {view === 'breakdown' && (
          <BreakdownView graphId={graph.id} period={period} txs={txs} ids={ids} fmt={fmt} inSpace={inSpace} onPickSub={(catId) => setSheet({ open: true, subId: catId })} />
        )}
        {view !== 'periods' && (
          <PeriodNav
            graphId={graph.id}
            text={`${periodText} · ${fmt(values[index] ?? 0)}`}
            canPrev={index > 0}
            canNext={!isCurrent}
            onStep={(delta) => setSelected(Math.min(periods.length - 1, Math.max(0, index + delta)))}
          />
        )}
      </AutoHeight>
      <button
        data-testid={`trends-graph-txs-${graph.id}`}
        onClick={() => setSheet({ open: true, subId: null })}
        className="m-tap mt-3 flex w-full items-center gap-2 border-t border-line-2 bg-transparent px-0 pt-3 text-left text-[12px] font-semibold text-accent-deep"
      >
        <Icon name="format-list-bulleted" size={16} />
        <span className="flex-1">
          {t('tab.transactions')} · {doorCount}
        </span>
        <span className="font-normal text-ink-4">{periodRangeText(period, lang)}</span>
        <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
      </button>
      <GraphTxSheet
        open={sheet.open}
        onOpenChange={(open) => setSheet((prev) => ({ ...prev, open }))}
        title={`${graph.name}${subName} · ${periodRangeText(period, lang)}`}
        rows={rows}
        testId={`trends-graph-txlist-${graph.id}`}
        onOpenTx={(txId) => {
          // close first (the sheet owns a history entry), then travel
          setSheet({ open: false, subId: null });
          void navigate({ to: '/transactions/$txId', params: { txId } });
        }}
      />
    </section>
  );
}
