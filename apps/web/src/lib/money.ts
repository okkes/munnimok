import type { Lang } from '@/i18n';

const LOCALE: Record<Lang, string> = { en: 'en-IE', nl: 'nl-NL', tr: 'tr-TR' };

/** Parse a user-entered amount ('1.234,56' / '1234.56') to cents. */
export function parseCents(input: string): number | null {
  let s = input.trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); // EU format
  const value = Number(s);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

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
