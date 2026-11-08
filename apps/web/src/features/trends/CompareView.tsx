import { useMemo, useState } from 'react';
import { useLang } from '@/i18n';
import type { TxView } from '@/db/types';
import type { Period } from '@/domain/periods';
import { addDays } from '@/domain/recurring';
import { cumulativeByDay, dayIndexOf, periodDays, reachedBy } from '@/domain/trends';
import { useCategories } from '@/features/categories/useCategories';
import { MultiLine } from '@/ui/charts/MultiLine';
import type { ChartScrubTip } from '@/ui/charts/MultiLine';
import { fmtDay } from './format';

/** day-of-period axis: the first day and every seventh after it */
const dayLabels = (days: number): string[] => Array.from({ length: days }, (_, i) => (i === 0 || (i + 1) % 7 === 0 ? String(i + 1) : ''));

type Translate = ReturnType<typeof useLang>['t'];

/** the line under the chart: the two periods at one day, or the one that has that day */
function calloutText(t: Translate, fmt: (cents: number) => string, now: number | null, before: number | null, day: number): string {
  if (now === null) return before === null ? '' : t('trends.prevOnly', { amount: fmt(before), day });
  if (before === null) return t('trends.thisOnly', { amount: fmt(now), day });
  const diff = now - before;
  if (diff < 0) return t('trends.aheadBy', { amount: fmt(-diff), day });
  if (diff > 0) return t('trends.behindBy', { amount: fmt(diff), day });
  return t('trends.levelWith', { day });
}

/**
 * "How am I doing against last period" (user 2026-10-08): the picked
 * period's cumulative spend solid up to today, the period before dashed
 * across its whole length, the difference at the same day called out, and
 * a compact list of what the last four periods had reached by that day.
 * #510 (user: "look through each day … the old vs new values"): a finger,
 * a mouse or the arrow keys read any day — the tip names both periods'
 * amounts, and the callout and the list follow the day under the guide.
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
  const [scrubDay, setScrubDay] = useState<number | null>(null);
  const period = periods[selected];
  const previous = periods[selected - 1];
  // a finished period is read at its last day, the running one at today
  const cut = period.end <= today ? periodDays(period) - 1 : dayIndexOf(today, period);

  const model = useMemo(() => {
    if (!previous) return null;
    const window = periods.slice(Math.max(0, selected - 3), selected + 1);
    // every period of the list walked once — a scrub only looks values up
    const cumulatives = window.map((p) => cumulativeByDay(txs, p, catIds, cats));
    const current = cumulatives.at(-1) ?? [];
    const before = cumulatives.at(-2) ?? [];
    const days = Math.max(current.length, before.length);
    return {
      window,
      cumulatives,
      currentValues: Array.from({ length: days }, (_, i) => (i <= cut && i < current.length ? current[i] : null)),
      previousValues: Array.from({ length: days }, (_, i) => (i < before.length ? before[i] : null)),
      days,
      at: Math.max(0, Math.min(cut, current.length - 1, before.length - 1)),
    };
  }, [previous, txs, period, catIds, cats, cut, periods, selected]);

  if (!model) {
    return (
      <p className="py-6 text-center text-[12px] text-ink-4" data-testid={`trends-compare-callout-${graphId}`}>
        {t('trends.compareNone')}
      </p>
    );
  }
  const day = scrubDay ?? model.at;
  const now = model.currentValues[day] ?? null;
  const before = model.previousValues[day] ?? null;
  const callout = calloutText(t, fmt, now, before, day + 1);
  // the running period has not reached a later day yet: its row stands at today
  const rows = model.window.map((p, i) => ({
    period: p,
    cents: reachedBy(model.cumulatives[i], i === model.window.length - 1 ? Math.min(day, cut) : day),
  }));
  const max = Math.max(1, ...rows.map((row) => row.cents));
  const tip = (index: number): ChartScrubTip => {
    const rowsAt = [
      { values: model.currentValues, start: period.start, color, dashed: false },
      { values: model.previousValues, start: previous.start, color: 'var(--m-ink-4)', dashed: true },
    ].flatMap((line) => {
      const cents = line.values[index];
      return cents === null || cents === undefined ? [] : [{ color: line.color, dashed: line.dashed, text: `${fmtDay(addDays(line.start, index), lang)} · ${fmt(cents)}` }];
    });
    return { title: t('trends.dayN', { day: index + 1 }), rows: rowsAt };
  };

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
        scrub={{ origin: model.at, tip, onScrub: setScrubDay, ariaLabel: t('trends.viewCompare') }}
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
        className={`mt-2 text-[13px] font-medium ${now !== null && before !== null && now > before ? 'text-negative' : 'text-accent-deep'}`}
        data-testid={`trends-compare-callout-${graphId}`}
      >
        {callout}
      </p>
      <div className="mt-3" data-testid={`trends-compare-rows-${graphId}`}>
        <div className="m-cap mb-1.5">{t('trends.sameDay')}</div>
        <div className="flex flex-col gap-1.5">
          {rows.map((row, i) => {
            const current = i === rows.length - 1;
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
