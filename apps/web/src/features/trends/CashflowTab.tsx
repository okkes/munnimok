import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { LOCALES, useLang } from '@/i18n';
import type { SpaceAccount, SpaceTx } from '@/application/transactions';
import type { RecurringRow, SpacePeriodType, SpaceRow } from '@/db/types';
import { nextPayday } from '@/domain/cashflow';
import type { Period } from '@/domain/periods';
import {
  balanceProjection,
  cashflowSeries,
  dailyBalanceSeries,
  incomeSpikes,
  median,
  minIso,
  periodBalanceRange,
  periodLabel,
  recurringsOnAccounts,
} from '@/domain/trends';
import type { BalanceRange, InSpaceCurrency } from '@/domain/trends';
import { AutoHeight } from '@/ui/AutoHeight';
import { AreaLine } from '@/ui/charts/AreaLine';
import type { AreaScrub } from '@/ui/charts/AreaLine';
import { MultiLine } from '@/ui/charts/MultiLine';
import { Icon } from '@/ui/Icon';
import { accountsText } from './AccountTicks';
import { fmtDay, truncateLabel } from './format';
import { GraphEditorSheet } from './GraphEditorSheet';
import { useCanEdit } from '@/app/useCanEdit';
import { useCashflowGraphOps } from './useTrendGraphs';
import type { CashflowGraph } from './useTrendGraphs';

type Mode = 'balance' | 'range';
/** the window: the last four periods, the current one included */
const WINDOW = 4;
const MODE_KEY: Record<Mode, 'trends.flowBalance' | 'trends.flowRange'> = { balance: 'trends.flowBalance', range: 'trends.flowRange' };

/** the footer's right-hand word: the scrubbed day, marked when it lies on the expectation */
function scrubText(scrub: AreaScrub, expected: string, day: string, value: string): string {
  const suffix = scrub.projected ? ` · ${expected}` : '';
  return `${day}${suffix}: ${value}`;
}

interface CardShared {
  periods: readonly Period[];
  periodType: SpacePeriodType;
  periodDay: number;
  txs: readonly SpaceTx[];
  accounts: readonly SpaceAccount[];
  recurrings: readonly RecurringRow[];
  today: string;
  fmt: (cents: number, opts?: { sign?: boolean }) => string;
  inSpace: InSpaceCurrency;
}

/**
 * One balance card (user 2026-10-08): Balance draws the money in hand day
 * by day — filled, solid to today, dashed for what is due until the period
 * ends — and a finger reads any day; Range draws each period's highest and
 * lowest balance as two lines with the band between them. The built-in
 * card reads checking, savings and cash; a custom one (#531) the accounts
 * it names — their rows, and the recurring costs paid from them.
 */
function CashflowCard({
  graphId,
  accountIds,
  header,
  periods,
  periodType,
  periodDay,
  txs: allTxs,
  accounts,
  recurrings: allRecurrings,
  today,
  fmt,
  inSpace,
}: Readonly<CardShared & { graphId: string; accountIds: string[] | null; header: ReactNode }>) {
  const { t, lang } = useLang();
  const [mode, setMode] = useState<Mode>('balance');
  const [scrub, setScrub] = useState<AreaScrub | null>(null);
  const window = useMemo(() => periods.slice(-WINDOW), [periods]);
  const current = window[window.length - 1];
  const [rangeIndex, setRangeIndex] = useState(window.length - 1);
  const from = window[0].start;
  const to = minIso(current.end, today);
  // the built-in keeps its testids (tour, tests); a custom card suffixes its id
  const tid = (base: string) => (accountIds ? `${base}-${graphId}` : base);

  const txs = useMemo(() => {
    if (!accountIds) return allTxs;
    const picked = new Set(accountIds);
    return allTxs.filter((tx) => picked.has(tx.accountId));
  }, [allTxs, accountIds]);
  const recurrings = useMemo(() => (accountIds ? recurringsOnAccounts(allRecurrings, allTxs, accountIds) : allRecurrings), [allRecurrings, allTxs, accountIds]);
  const daily = useMemo(() => dailyBalanceSeries(accounts, txs, from, to, accountIds, inSpace), [accounts, txs, from, to, accountIds, inSpace]);
  const spikes = useMemo(() => incomeSpikes(txs, from, to, undefined, inSpace), [txs, from, to, inSpace]);
  const projection = useMemo(() => {
    const last = daily.at(-1);
    if (!last) return [];
    // the pay day reads a row's whole amount only, so restating that is enough for it
    const rows = txs.map((tx) => {
      const cents = inSpace(tx.amountCents, tx.currency);
      return cents === tx.amountCents ? tx : { ...tx, amountCents: cents };
    });
    return balanceProjection(last.cents, to, current.end, recurrings, nextPayday(rows, today));
  }, [daily, to, current.end, recurrings, txs, today, inSpace]);
  const ranges = useMemo(() => periodBalanceRange(daily, window), [daily, window]);
  const net = useMemo(() => cashflowSeries(txs, [current], inSpace)[0]?.netCents ?? 0, [txs, current, inSpace]);
  const labelOf = (period: Period) => periodLabel(period, periodType, periodDay, LOCALES[lang]);

  // the typical shape: medians over the FINISHED periods — the running one is still moving
  const finished = ranges.slice(0, -1).filter((range): range is BalanceRange => range !== null);
  const typicalHigh = median(finished.map((range) => range.high));
  const typicalLow = median(finished.map((range) => range.low));
  const picked = ranges[Math.min(rangeIndex, ranges.length - 1)];

  const nowText = scrub
    ? scrubText(scrub, t('trends.expected'), fmtDay(scrub.date, lang), fmt(scrub.cents))
    : t('trends.balanceNow', { amount: fmt(daily.at(-1)?.cents ?? 0) });

  return (
    <section className="mt-4 rounded-card border border-line bg-surface p-4" data-testid={accountIds ? `trends-flow-graph-${graphId}` : 'trends-flow-card'}>
      {header}
      <div className="mt-3 flex rounded-xl bg-bg-2 p-0.5">
        {(['balance', 'range'] as const).map((candidate) => (
          <button
            key={candidate}
            data-testid={tid(`trends-flow-mode-${candidate}`)}
            onClick={() => setMode(candidate)}
            className={`m-tap flex-1 rounded-[10px] border-none py-1.5 text-[11px] ${
              mode === candidate ? 'bg-surface font-semibold text-ink shadow-sm' : 'bg-transparent text-ink-3'
            }`}
          >
            {t(MODE_KEY[candidate])}
          </button>
        ))}
      </div>

      {/* #540: the two modes differ in height — the card eases between them */}
      <AutoHeight>
      {mode === 'balance' && (
        <div className="mt-3">
          <AreaLine
            testId={tid('trends-flow-chart')}
            points={daily}
            projection={projection}
            color="var(--m-accent)"
            height={170}
            labels={window.map((period) => ({ date: period.start, text: labelOf(period) }))}
            markers={spikes.map((spike) => ({ date: spike.date, text: truncateLabel(spike.merchant) }))}
            todayLabel={t('trends.today')}
            projectedLabel={t('trends.expected')}
            formatValue={(cents) => fmt(cents)}
            formatDate={(date) => fmtDay(date, lang)}
            onScrub={setScrub}
            ariaLabel={t('trends.flowBalance')}
          />
          <div className="mt-2 flex items-baseline justify-between gap-3 text-[11px] text-ink-4">
            <span data-testid={tid('trends-flow-net')}>{t('trends.netThisPeriod', { amount: fmt(net, { sign: true }) })}</span>
            <span className="m-num text-right font-semibold text-ink" data-testid={tid('trends-flow-scrub')}>
              {nowText}
            </span>
          </div>
        </div>
      )}

      {mode === 'range' && (
        <div className="mt-3">
          <MultiLine
            testId={tid('trends-flow-range-chart')}
            series={[
              { values: ranges.map((range) => range?.high ?? null), color: 'var(--m-accent)' },
              { values: ranges.map((range) => range?.low ?? null), color: 'var(--m-ink-3)' },
            ]}
            labels={window.map(labelOf)}
            height={150}
            bandBetween={[0, 1]}
            onPointClick={(_series, index) => setRangeIndex(index)}
            selected={{ seriesIndex: 0, pointIndex: rangeIndex }}
          />
          <div className="mt-1 flex items-center gap-4 text-[11px] text-ink-4">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-accent" /> {t('trends.high')}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-ink-3" /> {t('trends.low')}
            </span>
          </div>
          {typicalHigh !== null && typicalLow !== null && (
            <p className="mt-2 text-[12px] text-ink-2" data-testid={tid('trends-flow-typical')}>
              {t('trends.peakTypical', { amount: fmt(typicalHigh) })} · {t('trends.lowTypical', { amount: fmt(typicalLow) })}
            </p>
          )}
          {picked && (
            <p className="mt-1 text-[11px] text-ink-4" data-testid={tid('trends-flow-range-sel')}>
              {labelOf(window[Math.min(rangeIndex, window.length - 1)])}: {t('trends.rangeLow', { amount: fmt(picked.low), date: fmtDay(picked.lowDate, lang) })} ·{' '}
              {t('trends.rangeHigh', { amount: fmt(picked.high), date: fmtDay(picked.highDate, lang) })}
            </p>
          )}
        </div>
      )}
      </AutoHeight>
    </section>
  );
}

/**
 * The Cash flow tab: the built-in card over the money in hand, one card per
 * balance line the space composed (#531, user: "just like in spending …
 * custom graphs, and then specify the financial accounts"), and the door
 * to make another. The lines live on the space row.
 */
export function CashflowTab({ space, ...shared }: Readonly<CardShared & { space: SpaceRow | undefined }>) {
  const { t } = useLang();
  const [editor, setEditor] = useState<{ open: boolean; graph: CashflowGraph | null }>({ open: false, graph: null });
  const canEdit = useCanEdit(); // #505: the graphs are the space's
  const ops = useCashflowGraphOps(space);
  return (
    <>
      <CashflowCard
        graphId="all"
        accountIds={null}
        {...shared}
        header={
          <div className="flex items-center gap-3">
            <Icon name="cash-multiple" size={19} color="var(--m-accent)" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold text-ink">{t('trends.flowAll')}</span>
              <span className="block truncate text-[11px] text-ink-4">{t('trends.flowAllSub')}</span>
            </span>
          </div>
        }
      />
      {(space?.cashflowGraphs ?? []).map((graph) => (
        <CashflowCard
          key={graph.id}
          graphId={graph.id}
          accountIds={graph.accountIds}
          {...shared}
          header={
            <div className="flex items-center gap-3">
              <Icon name="chart-areaspline" size={19} color="var(--m-accent)" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold text-ink">{graph.name}</span>
                <span className="block truncate text-[11px] text-ink-4" data-testid={`trends-flow-accounts-${graph.id}`}>
                  {accountsText(shared.accounts, graph.accountIds)}
                </span>
              </span>
              {canEdit && (
                <button
                  data-testid={`trends-flow-edit-${graph.id}`}
                  aria-label={t('action.edit')}
                  onClick={() => setEditor({ open: true, graph })}
                  className="m-tap flex h-8 w-8 items-center justify-center border-none bg-transparent text-ink-3"
                >
                  <Icon name="pencil-outline" size={17} />
                </button>
              )}
            </div>
          }
        />
      ))}
      {canEdit && (
        <button
          data-testid="trends-flow-new"
          onClick={() => setEditor({ open: true, graph: null })}
          className="m-tap mt-4 flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-line bg-transparent py-3 text-[13px] font-semibold text-accent-deep"
        >
          <Icon name="plus" size={16} />
          {t('trends.newGraph')}
        </button>
      )}
      <GraphEditorSheet
        kind="cashflow"
        open={editor.open}
        onOpenChange={(open) => setEditor((prev) => ({ ...prev, open }))}
        initial={editor.graph}
        onSave={(draft) => {
          setEditor({ open: false, graph: null });
          void ops.save({ id: draft.id, name: draft.name, accountIds: draft.accountIds ?? [] });
        }}
        onDelete={(id) => {
          setEditor({ open: false, graph: null });
          void ops.remove(id);
        }}
      />
    </>
  );
}
