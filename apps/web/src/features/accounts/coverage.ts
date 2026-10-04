import { LOCALES } from '@/i18n';
import type { Lang } from '@/i18n';

/** #445: the day an account stopped being fetched, for the "not fetched any more since …" line; a dash when it never was */
export const uncoveredDateText = (since: string, lang: Lang): string =>
  since ? new Date(since).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
