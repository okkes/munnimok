import type { WeekStart } from '@/db/types';

/**
 * #370: the calendar's first weekday. A device-wide preference (Global
 * settings) that every new space copies at creation; a space may then
 * override it (its period settings). Weekly budgets and week views ask
 * `weekStartOf(space)`, never the preference directly.
 */
const KEY = 'munni_week_start';

export const globalWeekStart = (): WeekStart => {
  try {
    return localStorage.getItem(KEY) === 'sunday' ? 'sunday' : 'monday';
  } catch {
    return 'monday';
  }
};

export const setGlobalWeekStart = (value: WeekStart): void => {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // storage refused (private mode) — the default stays
  }
};

/** the space's own choice, else the device preference */
export const weekStartOf = (space: { weekStart?: WeekStart } | null | undefined): WeekStart => space?.weekStart ?? globalWeekStart();
