import { useMemo } from 'react';
import { useLang } from '@/i18n';
import type { TxView } from '@/db/types';
import type { Period } from '@/domain/periods';
import { cumulativeByDay, dayIndexOf, periodDays, sameDayComparison } from '@/domain/trends';
import { useCategories } from '@/features/categories/useCategories';
import { MultiLine } from '@/ui/charts/MultiLine';
import { fmtDay } from './format';

/** day-of-period axis: the first day and every seventh after it */
const dayLabels = (days: number): string[] => Array.from({ length: days }, (_, i) => (i === 0 || (i + 1) % 7 === 0 ? String(i + 1) : ''));

/**
 * "How am I doing against last period" (user 2026-10-08): the picked
 * period's cumulative spend solid up to today, the period before dashed
 * across its whole length, the difference at the same day called out, and
 * a compact list of what the last four periods had reached by that day.
 */
export function CompareView({
  graphId,
  periods,
  selected,
  txs,
  catIds,
  today,
  color,
  fmt,
}: Readonly<{
  graphId: string;
  periods: readonly Period[];
  selected: number;
  txs: readonly TxView[];
  catIds: string[] | null;
  today: string;
  color: string;
  fmt: (cents: number) => string;
}>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const period = periods[selected];
  const previous = periods[selected - 1];
  // a finished period is read at its last day, the running one at today
  const cut = period.end <= today ? periodDays(period) - 1 : dayIndexOf(today, period);

  const model = useMemo(() => {
    if (!previous) return null;
    const current = cumulativeByDay(txs, period, catIds, cats);
    const before = cumulativeByDay(txs, previous, catIds, cats);
    const days = Math.max(current.length, before.length);
    const at = Math.max(0, Math.min(cut, current.length - 1, before.length - 1));
    const window = periods.slice(Math.max(0, selected - 3), selected + 1);
    return {
      currentValues: Array.from({ length: days }, (_, i) => (i <= cut && i < current.length ? current[i] : null)),
      previousValues: Array.from({ length: days }, (_, i) => (i < before.length ? before[i] : null)),
      days,
      at,
      diff: current[at] - before[at],
      rows: sameDayComparison(txs, window, at, catIds, cats),
    };
  }, [previous, txs, period, catIds, cats, cut, periods, selected]);

  if (!model) {
    return (
      <p className="py-6 text-center text-[12px] text-ink-4" data-testid={`trends-compare-callout-${graphId}`}>
        {t('trends.compareNone')}
      </p>
    );
  }
  const { diff, at } = model;
  let callout = t('trends.levelWith', { day: at + 1 });
  if (diff < 0) callout = t('trends.aheadBy', { amount: fmt(-diff), day: at + 1 });
  else if (diff > 0) callout = t('trends.behindBy', { amount: fmt(diff), day: at + 1 });
  const max = Math.max(1, ...model.rows.map((row) => row.cents));

  return (
    <div>
      <MultiLine
        testId={`trends-compare-chart-${graphId}`}
        series={[
          { values: model.currentValues, color },
          { values: model.previousValues, color: 'var(--m-ink-4)', dashed: true },
        ]}
        labels={dayLabels(model.days)}
        height={130}
      />
      <div className="mt-1 flex items-center gap-4 text-[11px] text-ink-4">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded" style={{ background: color }} /> {t('overview.thisPeriod')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0 w-4 border-t-2 border-dashed border-ink-4" /> {t('trends.prevPeriod')}
        </span>
      </div>
      <p
        className={`mt-2 text-[13px] font-medium ${diff > 0 ? 'text-negative' : 'text-accent-deep'}`}
        data-testid={`trends-compare-callout-${graphId}`}
      >
        {callout}
      </p>
      <div className="mt-3" data-testid={`trends-compare-rows-${graphId}`}>
        <div className="m-cap mb-1.5">{t('trends.sameDay')}</div>
        <div className="flex flex-col gap-1.5">
          {model.rows.map((row, i) => {
            const current = i === model.rows.length - 1;
            return (
              <div key={row.period.start} className="flex items-center gap-2 text-[11px]" data-testid={`trends-compare-row-${graphId}-${i}`}>
                <span className={`w-14 shrink-0 ${current ? 'font-semibold text-ink' : 'text-ink-3'}`}>{fmtDay(row.period.start, lang)}</span>
                <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-2">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${(row.cents / max) * 100}%`, background: current ? color : 'var(--m-ink-4)' }}
                  />
                </span>
                <span className={`m-num w-20 shrink-0 text-right ${current ? 'font-semibold text-ink' : 'text-ink-3'}`}>{fmt(row.cents)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
