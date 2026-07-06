import type { Lang } from '@/i18n';

const LOCALE: Record<Lang, string> = { en: 'en-IE', nl: 'nl-NL', tr: 'tr-TR' };

/** Format integer minor units as a localized currency string. */
export function fmtCents(cents: number, currency: string, lang: Lang, opts?: { sign?: boolean }): string {
  const formatted = new Intl.NumberFormat(LOCALE[lang], {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
  if (opts?.sign && cents > 0) return `+${formatted}`;
  return formatted;
}
