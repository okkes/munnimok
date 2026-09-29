import type { useLang } from '@/i18n';

/** #347: "today" / "tomorrow" / "in N days" — the reader never does the date math */
export function dueInWords(days: number, t: ReturnType<typeof useLang>['t']): string {
  if (days === 0) return t('upcoming.dueToday');
  if (days === 1) return t('upcoming.dueTomorrow');
  return t('upcoming.dueInDays', { n: days });
}
