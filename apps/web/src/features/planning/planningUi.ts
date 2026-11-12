import type { PlanSegmentKind } from '@/db/types';
import type { SubjectStatus } from '@/domain/planning';
import type { TranslationKey } from '@/i18n';
import type { Tone } from '@/ui/primitives';

/** each segment's face and name */
export const SEGMENT_META: Record<PlanSegmentKind, { icon: string; labelKey: TranslationKey; addKey: TranslationKey }> = {
  recurring: { icon: 'autorenew', labelKey: 'plan.segment.recurring', addKey: 'plan.addSourceTitle.recurring' },
  debts: { icon: 'scale-balance', labelKey: 'plan.segment.debts', addKey: 'plan.addSourceTitle.debts' },
  expenses: { icon: 'cart-outline', labelKey: 'plan.segment.expenses', addKey: 'plan.addExpense' },
  budgets: { icon: 'wallet-outline', labelKey: 'plan.segment.budgets', addKey: 'plan.addSourceTitle.budgets' },
  events: { icon: 'party-popper', labelKey: 'plan.segment.events', addKey: 'plan.addSourceTitle.events' },
  goals: { icon: 'flag-outline', labelKey: 'plan.segment.goals', addKey: 'plan.addSourceTitle.goals' },
};

/**
 * A status reads in one tone everywhere (user 2026-10-21, #517: "all these
 * colours are confusing"): green funded, orange short of the target, red
 * overspent; spent past the target but covered is green with orange stripes.
 */
export const STATUS_TONE: Record<SubjectStatus, Tone> = {
  neutral: 'neutral',
  underfunded: 'warning',
  funded: 'accent',
  overTarget: 'accent',
  overspent: 'negative',
  snoozed: 'accent',
  settled: 'neutral',
};

/** the bar's fill per status — the subject's own colour stays on its tile only */
export const STATUS_BAR: Record<SubjectStatus, string> = {
  neutral: 'var(--m-ink-4)',
  underfunded: 'var(--m-warning)',
  funded: 'var(--m-accent)',
  overTarget: 'var(--m-accent)',
  overspent: 'var(--m-negative)',
  snoozed: 'var(--m-accent)',
  settled: 'var(--m-ink-4)',
};

/** the orange stripes over a bar whose spending went past the target while the funding covers it */
export const OVER_TARGET_STRIPES = 'repeating-linear-gradient(135deg, var(--m-warning) 0 4px, transparent 4px 8px)';

export const STATUS_KEY: Record<SubjectStatus, TranslationKey> = {
  neutral: 'plan.status.neutral',
  underfunded: 'plan.status.underfunded',
  funded: 'plan.status.funded',
  overTarget: 'plan.status.overTarget',
  overspent: 'plan.status.overspent',
  snoozed: 'plan.status.snoozed',
  settled: 'plan.status.settled',
};

/** the colours of the circle as it fills (domain/planning aheadColor) */
export const AHEAD_COLOR: Record<'grey' | 'green' | 'orange' | 'red', string> = {
  grey: 'var(--m-ink-4)',
  green: 'var(--m-accent)',
  orange: 'var(--m-warning)',
  red: 'var(--m-negative)',
};

/** the expense subject's own face: a first pick of icons and colours (the editor searches the whole icon font too) */
export const SUBJECT_ICONS = [
  'cart-outline',
  'food-fork-drink',
  'silverware-fork-knife',
  'coffee-outline',
  'car-outline',
  'bus',
  'home-outline',
  'tshirt-crew-outline',
  'movie-open-outline',
  'gamepad-variant-outline',
  'heart-pulse',
  'paw',
  'gift-outline',
  'school-outline',
  'airplane',
  'dumbbell',
] as const;

export const SUBJECT_COLORS = ['#16A085', '#2980B9', '#9B59B6', '#E91E63', '#E67E22', '#27AE60', '#C0392B', '#F39C12', '#34495E', '#1ABC9C'] as const;

/** an Unplanned source row's kind (user 2026-10-09): the segment "Plan it" adds it to, and the label under its name */
export type UnplannedSourceKind = 'recurring' | 'debt' | 'event' | 'goal';
export const UNPLANNED_SEGMENT: Record<UnplannedSourceKind, PlanSegmentKind> = { recurring: 'recurring', debt: 'debts', event: 'events', goal: 'goals' };
export const UNPLANNED_KIND_KEY: Record<UnplannedSourceKind, TranslationKey> = {
  recurring: 'plan.unplannedKind.recurring',
  debt: 'plan.unplannedKind.debt',
  event: 'plan.unplannedKind.event',
  goal: 'plan.unplannedKind.goal',
};

/** the mirrored sources' colours when the source row has none of its own */
export const SEGMENT_COLOR: Record<PlanSegmentKind, string> = {
  recurring: '#2980B9',
  debts: '#C0392B',
  expenses: '#16A085',
  budgets: '#8E44AD',
  events: '#E91E63',
  goals: '#27AE60',
};

export const softOf = (color: string): string => `color-mix(in srgb, ${color} 14%, transparent)`;
