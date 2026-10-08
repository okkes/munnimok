import { useMemo, useState } from 'react';
import { LOCALES, useLang } from '@/i18n';
import type { SpaceAccount, SpaceTx } from '@/application/transactions';
import type { RecurringRow, SpacePeriodType } from '@/db/types';
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
} from '@/domain/trends';
import type { BalanceRange } from '@/domain/trends';
import { AreaLine } from '@/ui/charts/AreaLine';
import type { AreaScrub } from '@/ui/charts/AreaLine';
import { MultiLine } from '@/ui/charts/MultiLine';
import { fmtDay, truncateLabel } from './format';

type Mode = 'balance' | 'range';
/** the window: the last four periods, the current one included */
const WINDOW = 4;
const MODE_KEY: Record<Mode, 'trends.flowBalance' | 'trends.flowRange'> = { balance: 'trends.flowBalance', range: 'trends.flowRange' };

/** the footer's right-hand word: the scrubbed day, marked when it lies on the expectation */
function scrubText(scrub: AreaScrub, expected: string, day: string, value: string): string {
  const suffix = scrub.projected ? ` · ${expected}` : '';
  return `${day}${suffix}: ${value}`;
}

/**
 * The Cash flow tab (user 2026-10-08): Balance draws the money in hand day
 * by day — filled, solid to today, dashed for what is due until the period
 * ends — and a finger reads any day; Range draws each period's highest and
 * lowest balance as two lines with the band between them.
 */
export function CashflowTab({
  periods,
  periodType,
  periodDay,
  txs,
  accounts,
  recurrings,
  today,
  fmt,
}: Readonly<{
  periods: readonly Period[];
  periodType: SpacePeriodType;
  periodDay: number;
  txs: readonly SpaceTx[];
  accounts: readonly SpaceAccount[];
  recurrings: readonly RecurringRow[];
  today: string;
  fmt: (cents: number, opts?: { sign?: boolean }) => string;
}>) {
  const { t, lang } = useLang();
  const [mode, setMode] = useState<Mode>('balance');
  const [scrub, setScrub] = useState<AreaScrub | null>(null);
  const window = useMemo(() => periods.slice(-WINDOW), [periods]);
  const current = window[window.length - 1];
  const [rangeIndex, setRangeIndex] = useState(window.length - 1);
  const from = window[0].start;
  const to = minIso(current.end, today);

  const daily = useMemo(() => dailyBalanceSeries(accounts, txs, from, to), [accounts, txs, from, to]);
  const spikes = useMemo(() => incomeSpikes(txs, from, to), [txs, from, to]);
  const projection = useMemo(() => {
    const last = daily.at(-1);
    return last ? balanceProjection(last.cents, to, current.end, recurrings, nextPayday(txs, today)) : [];
  }, [daily, to, current.end, recurrings, txs, today]);
  const ranges = useMemo(() => periodBalanceRange(daily, window), [daily, window]);
  const net = useMemo(() => cashflowSeries(txs, [current])[0]?.netCents ?? 0, [txs, current]);
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
    <div className="mt-4 rounded-card border border-line bg-surface p-4">
      <div className="flex rounded-xl bg-bg-2 p-0.5">
        {(['balance', 'range'] as const).map((candidate) => (
          <button
            key={candidate}
            data-testid={`trends-flow-mode-${candidate}`}
            onClick={() => setMode(candidate)}
            className={`m-tap flex-1 rounded-[10px] border-none py-1.5 text-[11px] ${
              mode === candidate ? 'bg-surface font-semibold text-ink shadow-sm' : 'bg-transparent text-ink-3'
            }`}
          >
            {t(MODE_KEY[candidate])}
          </button>
        ))}
      </div>

      {mode === 'balance' && (
        <div className="mt-3">
          <AreaLine
            testId="trends-flow-chart"
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
            <span data-testid="trends-flow-net">{t('trends.netThisPeriod', { amount: fmt(net, { sign: true }) })}</span>
            <span className="m-num text-right font-semibold text-ink" data-testid="trends-flow-scrub">
              {nowText}
            </span>
          </div>
        </div>
      )}

      {mode === 'range' && (
        <div className="mt-3">
          <MultiLine
            testId="trends-flow-range-chart"
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
            <p className="mt-2 text-[12px] text-ink-2" data-testid="trends-flow-typical">
              {t('trends.peakTypical', { amount: fmt(typicalHigh) })} · {t('trends.lowTypical', { amount: fmt(typicalLow) })}
            </p>
          )}
          {picked && (
            <p className="mt-1 text-[11px] text-ink-4" data-testid="trends-flow-range-sel">
              {labelOf(window[Math.min(rangeIndex, window.length - 1)])}: {t('trends.rangeLow', { amount: fmt(picked.low), date: fmtDay(picked.lowDate, lang) })} ·{' '}
              {t('trends.rangeHigh', { amount: fmt(picked.high), date: fmtDay(picked.highDate, lang) })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
