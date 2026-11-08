import type { SpacePeriodType } from '@/db/types';
import type { Insight, InsightInputs } from './insightModel';
import type { Period } from './periods';
import {
  EVERYDAY,
  PERIODS_PER_YEAR,
  coveredPastPeriods,
  dailySpend,
  dayDiff,
  firstKnownDay,
  inCurrency,
  mainOf,
  median,
  periodLength,
  spendParts,
  weekdayOf,
} from './insightModel';
import { addDays } from './recurring';

/**
 * #516: how the spending moves — the running period against the usual
 * curve, a category that creeps up period after period, the weekday that
 * costs the most, a record of days without a purchase. Day-to-day money
 * only: a recurring cost is an obligation and an event a one-off, so
 * neither makes a habit; sums read the space's own currency.
 */

const sumBetween = (days: ReadonlyMap<string, number>, from: string, to: string): number => {
  let sum = 0;
  for (const [day, cents] of days) if (day >= from && day <= to) sum += cents;
  return sum;
};

const unitOf = (inputs: InsightInputs): SpacePeriodType => inputs.space?.periodType ?? 'month';

/** spending this period running ahead of the usual curve for this day of the period */
export function spendingPace(inputs: InsightInputs): Insight[] {
  const current = inputs.periods.at(-1);
  const first = firstKnownDay(inputs.txs);
  if (!current || first === null || first > current.start) return [];
  const past = coveredPastPeriods(inputs);
  if (past.length < 3) return [];
  const day = dayDiff(current.start, inputs.today);
  const length = periodLength(current);
  // a quarter of the period, five days at least, before the curve means anything
  if (day < 0 || day >= length || day + 1 < Math.max(5, Math.ceil(length / 4))) return [];
  const days = dailySpend(inputs, EVERYDAY, past[0].start, inputs.today);
  const soFar = sumBetween(days, current.start, inputs.today);
  const sameDay = (p: { start: string; end: string }) => {
    const at = addDays(p.start, day);
    return at < p.end ? at : p.end;
  };
  const typicalBy = median(past.map((p) => sumBetween(days, p.start, sameDay(p))));
  const typicalTotal = median(past.map((p) => sumBetween(days, p.start, p.end)));
  if (typicalBy <= 0 || typicalTotal <= 0 || soFar < typicalBy * 1.2) return [];
  // "at this pace": the rest of the period keeps the ratio it has now
  const projected = Math.round((typicalTotal * soFar) / typicalBy);
  const extra = projected - typicalTotal;
  if (extra < 5_000) return [];
  const unit = unitOf(inputs);
  return [
    {
      id: `pace:${current.start}`,
      kind: 'pace',
      topic: 'spending',
      severity: 'pattern',
      impactCents: extra,
      icon: 'speedometer',
      titleKey: 'ins.pace.title',
      subKey: 'ins.pace.sub',
      detailKey: 'ins.pace.detail',
      params: {
        spent: { money: soFar },
        typical: { money: typicalBy },
        projected: { money: projected },
        usual: { money: typicalTotal },
        extra: { money: extra },
        unit: { unit },
      },
      chart: [...past.map((p) => sumBetween(days, p.start, p.end)), projected],
      actionTo: '/overview/expense',
    },
  ];
}

const DRIFT_PERIODS = 6;

/**
 * A category that has been creeping up (user: "grocery spending has been
 * creeping up — 18% over the last 6 months"): spent in every one of the
 * last six complete periods, the last three averaging well above the
 * three before — and every one of the last three above the old level, so
 * one big purchase never reads as a trend.
 */
/** day-to-day spending per category as filed, one value per period */
function categorySeries(inputs: InsightInputs, periods: readonly Period[]): Map<string, number[]> {
  const series = new Map<string, number[]>();
  for (const tx of inputs.txs) {
    const index = tx.deleted === 0 && inCurrency(tx, inputs.currency) ? periods.findIndex((p) => tx.date >= p.start && tx.date <= p.end) : -1;
    if (index < 0) continue;
    // uncategorized money says nothing about a category
    const filed = spendParts(tx, inputs.catalog, EVERYDAY).filter(
      (p): p is { catId: string; cents: number } => !!p.catId && mainOf(p.catId, inputs.catalog) !== 'general',
    );
    for (const part of filed) {
      const row = series.get(part.catId) ?? new Array<number>(periods.length).fill(0);
      row[index] += part.cents;
      series.set(part.catId, row);
    }
  }
  return series;
}

/** the old level and the new one of six periods, when they make a gradual rise of at least `floor` and 15% */
function riseOf(s: readonly number[], floor: number): { before: number; after: number } | null {
  if (s.some((cents) => cents <= 0)) return null;
  const before = (s[0] + s[1] + s[2]) / 3;
  const after = (s[3] + s[4] + s[5]) / 3;
  const rise = after - before;
  const recent = [s[3], s[4], s[5]];
  const gradual = Math.min(...recent) >= before && median(recent) >= before * 1.15;
  return rise >= floor && rise >= before * 0.15 && gradual ? { before, after } : null;
}

export function categoryDrift(inputs: InsightInputs): Insight[] {
  const past = coveredPastPeriods(inputs).slice(-DRIFT_PERIODS);
  if (past.length < DRIFT_PERIODS) return [];
  const unit = unitOf(inputs);
  // €15 a month, in proportion to the space's period
  const floor = Math.round((1_500 * periodLength(past.at(-1)!)) / 30);
  const out: Insight[] = [];
  for (const [catId, s] of categorySeries(inputs, past)) {
    const level = riseOf(s, floor);
    if (!level) continue;
    const { before, after } = level;
    const rise = after - before;
    out.push({
      id: `drift:${catId}:${past.at(-1)!.start}`,
      kind: 'drift',
      topic: 'spending',
      severity: 'pattern',
      impactCents: Math.round(rise * PERIODS_PER_YEAR[unit]),
      icon: 'chart-line-variant',
      titleKey: 'ins.drift.title',
      subKey: 'ins.drift.sub',
      detailKey: 'ins.drift.detail',
      lineKey: 'ins.drift.line',
      params: {
        cat: { cat: catId },
        pct: Math.round((rise / before) * 100),
        from: { money: Math.round(before) },
        to: { money: Math.round(after) },
        n: DRIFT_PERIODS,
        unit: { unit },
        units: { units: unit },
      },
      about: { cat: catId },
      chart: s,
      actionTo: `/overview/expense/${catId}`,
    });
  }
  return out;
}

const WEEKDAY_WEEKS = 12;

/**
 * The weekday that costs the most (user: "Saturdays are your most
 * expensive day — 38% more than your daily average"), over the last twelve
 * whole weeks. Each weekday drops its single biggest day first: one sofa
 * or one concert is no habit.
 */
export function expensiveWeekday(inputs: InsightInputs): Insight[] {
  const from = addDays(inputs.today, -7 * WEEKDAY_WEEKS);
  const to = addDays(inputs.today, -1);
  const first = firstKnownDay(inputs.txs);
  if (first === null || first > from) return [];
  const days = dailySpend(inputs, EVERYDAY, from, to);
  const byWeekday: number[][] = [[], [], [], [], [], [], []];
  for (let day = from; day <= to; day = addDays(day, 1)) byWeekday[weekdayOf(day)].push(days.get(day) ?? 0);
  const trimmed = byWeekday.map((values) => (values.reduce((sum, v) => sum + v, 0) - Math.max(...values)) / (values.length - 1));
  const average = trimmed.reduce((sum, v) => sum + v, 0) / 7;
  let top = 0;
  for (let weekday = 1; weekday < 7; weekday += 1) if (trimmed[weekday] > trimmed[top]) top = weekday;
  const above = trimmed[top] - average;
  // 30% over the daily average, and €5 a day at least
  if (average <= 0 || above < 500 || above < average * 0.3) return [];
  const order = inputs.space?.weekStart === 'sunday' ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0];
  return [
    {
      id: `weekday:${top}`,
      kind: 'weekday',
      topic: 'behaviour',
      severity: 'pattern',
      impactCents: Math.round(above * 52),
      icon: 'calendar-star',
      titleKey: 'ins.weekday.title',
      subKey: 'ins.weekday.sub',
      detailKey: 'ins.weekday.detail',
      params: {
        weekday: { weekday: top },
        pct: Math.round((above / average) * 100),
        day: { money: Math.round(trimmed[top]) },
        avg: { money: Math.round(average) },
        weeks: WEEKDAY_WEEKS,
      },
      chart: order.map((weekday) => Math.max(0, Math.round(trimmed[weekday]))),
      chartFocus: order.indexOf(top),
      actionTo: '/overview/expense',
    },
  ];
}

/**
 * A record of days without a purchase (user: "9 no-spend days this month
 * — your highest number in the last 6 months"). A purchase is any spending
 * but what a recurring cost takes by itself; days after the newest row the
 * space knows are not counted — a feed that has not synced is no calm.
 */
export function noSpendDays(inputs: InsightInputs): Insight[] {
  const current = inputs.periods.at(-1);
  const first = firstKnownDay(inputs.txs);
  if (!current || first === null || first > current.start) return [];
  const previous = coveredPastPeriods(inputs).slice(-(DRIFT_PERIODS - 1));
  if (previous.length < 3) return [];
  let newest = first;
  const purchaseDays = new Set<string>();
  const from = previous[0].start;
  for (const tx of inputs.txs) {
    if (tx.deleted !== 0) continue;
    if (tx.date > newest) newest = tx.date;
    if (tx.date >= from && spendParts(tx, inputs.catalog, { skipRecurring: true }).some((part) => part.cents > 0)) purchaseDays.add(tx.date);
  }
  const yesterday = addDays(inputs.today, -1);
  const end = newest < yesterday ? newest : yesterday;
  if (end < current.start) return [];
  const calmDays = (from: string, to: string): number => {
    let n = 0;
    for (let day = from; day <= to; day = addDays(day, 1)) if (!purchaseDays.has(day)) n += 1;
    return n;
  };
  const now = calmDays(current.start, end);
  const before = previous.map((p) => calmDays(p.start, p.end));
  const best = Math.max(...before);
  if (now < 5 || now <= best) return [];
  const spentBefore = sumBetween(dailySpend(inputs, EVERYDAY, previous[0].start, previous.at(-1)!.end), previous[0].start, previous.at(-1)!.end);
  const daysBefore = previous.reduce((sum, p) => sum + periodLength(p), 0);
  const unit = unitOf(inputs);
  return [
    {
      id: `nospend:${current.start}`,
      kind: 'nospend',
      topic: 'behaviour',
      severity: 'win',
      impactCents: Math.max(0, Math.round((now * spentBefore) / daysBefore)),
      icon: 'sprout-outline',
      titleKey: 'ins.nospend.title',
      subKey: 'ins.nospend.sub',
      detailKey: 'ins.nospend.detail',
      params: { n: now, best, k: before.length + 1, prev: before.length, unit: { unit }, units: { units: unit } },
      chart: [...before, now],
    },
  ];
}
