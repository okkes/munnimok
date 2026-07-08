import type { SpacePeriodType } from '@/db/types';

/**
 * Budget periods, per the space's settings (ported from the legacy
 * computePeriodHistory): monthly periods start on `periodDay` (1-28);
 * weekly and bi-weekly periods are Monday-anchored (bi-weekly on a
 * fixed 2020 anchor so the cycle never drifts).
 */
export interface Period {
  /** inclusive yyyy-mm-dd bounds (local time) */
  start: string;
  end: string;
}

const localIso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const shift = (d: Date, days: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);

function weeklyStart(today: Date, lengthDays: number): Date {
  // Monday-anchored; 6 Jan 2020 is a Monday
  const anchor = new Date(2020, 0, 6);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const daysSince = Math.floor((midnight.getTime() - anchor.getTime()) / 86_400_000);
  const periods = Math.floor(daysSince / lengthDays);
  return shift(anchor, periods * lengthDays);
}

/** newest last: the `count` most recent periods including the current one */
export function periodHistory(periodType: SpacePeriodType, periodDay: number, count: number, now = new Date()): Period[] {
  const result: Period[] = [];
  if (periodType === 'week' || periodType === 'biweekly') {
    const length = periodType === 'week' ? 7 : 14;
    const current = weeklyStart(now, length);
    for (let i = count - 1; i >= 0; i--) {
      const start = shift(current, -i * length);
      result.push({ start: localIso(start), end: localIso(shift(start, length - 1)) });
    }
    return result;
  }
  // monthly (and legacy 'custom' rows fall back to monthly)
  const day = Math.min(Math.max(periodDay || 1, 1), 28);
  const offset = now.getDate() < day ? 1 : 0;
  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - offset - i, day);
    const end = shift(new Date(start.getFullYear(), start.getMonth() + 1, day), -1);
    result.push({ start: localIso(start), end: localIso(end) });
  }
  return result;
}

export const inPeriod = (date: string, period: Period): boolean => date >= period.start && date <= period.end;
