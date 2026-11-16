import type { useLang } from '@/i18n';

export function dueInWords(days: number, t: ReturnType<typeof useLang>['t']): string {
  if (days === 0) return t('upcoming.dueToday');
  if (days === 1) return t('upcoming.dueTomorrow');
  return t('upcoming.dueInDays', { n: days });
}
