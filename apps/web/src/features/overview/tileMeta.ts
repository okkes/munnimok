import type { OverviewKind, OverviewSummary } from '@/domain/overview';

/**
 * The six period tiles — icon, colour and the summary field each one reads.
 * Home's "This period" card and the Periods screen draw the same tiles, so
 * the table lives here rather than in either screen.
 */
export const TILE_META: Record<OverviewKind, { icon: string; color: string; field: keyof OverviewSummary; signed?: boolean }> = {
  income: { icon: 'cash-plus', color: 'var(--m-accent)', field: 'incomeCents' },
  expense: { icon: 'cash-remove', color: 'var(--m-negative)', field: 'expenseCents' },
  saving: { icon: 'piggy-bank-outline', color: 'var(--m-warning)', field: 'savingCents' },
  investment: { icon: 'chart-timeline-variant', color: 'var(--m-special)', field: 'investmentCents' },
  // signed: contributing to a pot is green, drawing from it is red; a
  // borrowing-heavy period flips Repaid the same way (user rule 2026-08-01)
  funding: { icon: 'hand-coin', color: 'var(--m-accent-deep)', field: 'fundingCents', signed: true },
  debt: { icon: 'hand-coin-outline', color: 'var(--m-special)', field: 'debtCents', signed: true },
};

/** signed tiles color their VALUE by direction; the rest stay plain ink */
export const tileValueClass = (kind: OverviewKind, cents: number): string => {
  if (!TILE_META[kind].signed) return 'text-ink';
  return cents < 0 ? 'text-negative' : 'text-accent-deep';
};

export type DeltaTone = 'good' | 'bad' | 'flat';

/** which way is good news: spending less is, earning / saving / investing /
 *  repaying more is; funding is neither — borrowing more is just a fact */
const BETTER_WHEN_UP: Record<OverviewKind, boolean | null> = {
  income: true,
  expense: false,
  saving: true,
  investment: true,
  funding: null,
  debt: true,
};

/** the tone of a change against the period before */
export function deltaTone(kind: OverviewKind, deltaCents: number): DeltaTone {
  const up = BETTER_WHEN_UP[kind];
  if (deltaCents === 0 || up === null) return 'flat';
  return deltaCents > 0 === up ? 'good' : 'bad';
}

export const TONE_CLASS: Record<DeltaTone, string> = {
  good: 'text-accent-deep',
  bad: 'text-negative',
  flat: 'text-ink-3',
};
