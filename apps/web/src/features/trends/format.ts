import { LOCALES } from '@/i18n';
import type { Lang } from '@/i18n';
import { localDate } from '@/domain/trends';
import type { Period } from '@/domain/periods';

/** the money locales (lib/money's choice: en-IE spells the euro the Irish way) */
const MONEY_LOCALE: Record<Lang, string> = { en: 'en-IE', nl: 'nl-NL', tr: 'tr-TR' };

/**
 * The number a bar can carry (user 2026-10-08: "actual numbers on top of
 * each bar"): "€808", "€1.9K", "€12K" — whole euros under a thousand,
 * one decimal up to ten thousand, none beyond. ICU places the symbol
 * and picks the thousands word per language.
 */
export function compactMoney(cents: number, currency: string, lang: Lang): string {
  const euros = cents / 100;
  const abs = Math.abs(euros);
  const noCurrency = !currency || currency === 'XXX'; // #254: a wallet without a bound currency
  return new Intl.NumberFormat(MONEY_LOCALE[lang], {
    ...(noCurrency ? {} : { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }),
    notation: 'compact',
    maximumFractionDigits: abs >= 10_000 || abs < 1_000 ? 0 : 1,
  }).format(euros);
}

/** "21 Sep" — a day on an axis or in a footer */
export const fmtDay = (iso: string, lang: Lang): string =>
  localDate(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });

/** "21 Sep – 20 Oct" */
export const periodRangeText = (period: Period, lang: Lang): string => `${fmtDay(period.start, lang)} – ${fmtDay(period.end, lang)}`;

/** a label that must fit above a line: "Demo Corp BV" → "Demo Corp…" */
export const truncateLabel = (text: string, max = 10): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export type GraphView = 'periods' | 'compare' | 'breakdown';
export const GRAPH_VIEWS: readonly GraphView[] = ['periods', 'compare', 'breakdown'];

/** user 2026-10-08: each card remembers its view on this device */
const viewKey = (spaceId: string, graphId: string) => `munni_trend_view_${spaceId}_${graphId}`;

export function recallGraphView(spaceId: string, graphId: string): GraphView {
  try {
    const stored = localStorage.getItem(viewKey(spaceId, graphId));
    return GRAPH_VIEWS.includes(stored as GraphView) ? (stored as GraphView) : 'periods';
  } catch {
    return 'periods'; // storage blocked (private mode) — the default view is fine
  }
}

export function rememberGraphView(spaceId: string, graphId: string, view: GraphView): void {
  try {
    localStorage.setItem(viewKey(spaceId, graphId), view);
  } catch {
    // storage blocked — the view simply does not persist
  }
}
