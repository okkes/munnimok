import { LOCALES } from '@/i18n';
import type { Lang } from '@/i18n';

export const uncoveredDateText = (since: string, lang: Lang): string =>
  since ? new Date(since).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
