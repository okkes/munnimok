import type { WeekStart } from '@/db/types';

// #370: a device-wide preference every new space copies at creation; a space may override it,
// so ask `weekStartOf(space)`, never the preference directly
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

export const weekStartOf = (space: { weekStart?: WeekStart } | null | undefined): WeekStart => space?.weekStart ?? globalWeekStart();
