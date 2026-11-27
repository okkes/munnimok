import type { WeekStart } from '@/db/types';
import { settingChanged } from './settingsBus';

// #370: the person's preference every new space copies at creation; a space may override it,
// so ask `weekStartOf(space)`, never the preference directly. #700: it follows the account
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
    settingChanged();
  } catch {
    // storage refused (private mode) — the default stays
  }
};

export const weekStartOf = (space: { weekStart?: WeekStart } | null | undefined): WeekStart => space?.weekStart ?? globalWeekStart();
