import type { TranslationKey } from '@/i18n';

/**
 * Tutorials are data (approved tutorial design): the slides sheet and
 * the spotlight walkthrough are generic renderers over this registry.
 * Adding a feature's tour = one entry here + i18n strings ×3.
 */

export type TourId = 'home' | 'review' | 'budgets' | 'events' | 'goals' | 'debts' | 'allocation';

export interface TourStep {
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  /** emoji-scale art: shown on slides and as the missing-anchor sample */
  illustration: string;
  /** data-testid to spotlight in the interactive walkthrough */
  anchor?: string;
  /** 'tap' forwards the tap to the real element and advances */
  advanceOn?: 'tap' | 'next';
}

export interface Tour {
  id: TourId;
  titleKey: TranslationKey;
  icon: string;
  /** where the interactive walkthrough runs; null = slides only */
  screen: string | null;
  steps: TourStep[];
}

export const TOURS: Tour[] = [
  {
    id: 'home',
    titleKey: 'tab.home',
    icon: 'home-variant-outline',
    screen: '/home',
    steps: [
      { titleKey: 'tour.home.1t', bodyKey: 'tour.home.1b', illustration: '🏠' },
      { titleKey: 'tour.home.2t', bodyKey: 'tour.home.2b', illustration: '💰', anchor: 'home-balance-band' },
      { titleKey: 'tour.home.3t', bodyKey: 'tour.home.3b', illustration: '📊', anchor: 'home-overview-income' },
      { titleKey: 'tour.home.4t', bodyKey: 'tour.home.4b', illustration: '🎛️', anchor: 'home-customize', advanceOn: 'tap' },
    ],
  },
  {
    id: 'review',
    titleKey: 'review.title',
    icon: 'progress-check',
    screen: '/review',
    steps: [
      { titleKey: 'tour.review.1t', bodyKey: 'tour.review.1b', illustration: '🎯' },
      { titleKey: 'tour.review.2t', bodyKey: 'tour.review.2b', illustration: '🃏', anchor: 'review-card' },
      { titleKey: 'tour.review.3t', bodyKey: 'tour.review.3b', illustration: '✅', anchor: 'review-confirm-btn', advanceOn: 'tap' },
      { titleKey: 'tour.review.4t', bodyKey: 'tour.review.4b', illustration: '⏭️', anchor: 'review-skip-btn' },
    ],
  },
  {
    id: 'budgets',
    titleKey: 'budgets.title',
    icon: 'wallet-outline',
    screen: null,
    steps: [
      { titleKey: 'tour.budgets.1t', bodyKey: 'tour.budgets.1b', illustration: '💡' },
      { titleKey: 'tour.budgets.2t', bodyKey: 'tour.budgets.2b', illustration: '➕', anchor: 'budgets-add' },
      { titleKey: 'tour.budgets.3t', bodyKey: 'tour.budgets.3b', illustration: '🚦' },
      { titleKey: 'tour.budgets.4t', bodyKey: 'tour.budgets.4b', illustration: '♻️' },
    ],
  },
  {
    id: 'events',
    titleKey: 'events.title',
    icon: 'party-popper',
    screen: '/events',
    steps: [
      { titleKey: 'tour.events.1t', bodyKey: 'tour.events.1b', illustration: '🎉' },
      { titleKey: 'tour.events.2t', bodyKey: 'tour.events.2b', illustration: '➕', anchor: 'events-add' },
      { titleKey: 'tour.events.3t', bodyKey: 'tour.events.3b', illustration: '🧲' },
    ],
  },
  {
    id: 'goals',
    titleKey: 'goals.title',
    icon: 'flag-outline',
    screen: '/goals',
    steps: [
      { titleKey: 'tour.goals.1t', bodyKey: 'tour.goals.1b', illustration: '🚩' },
      { titleKey: 'tour.goals.2t', bodyKey: 'tour.goals.2b', illustration: '➕', anchor: 'goals-add' },
      { titleKey: 'tour.goals.3t', bodyKey: 'tour.goals.3b', illustration: '⚖️' },
    ],
  },
  {
    id: 'debts',
    titleKey: 'debts.title',
    icon: 'hand-coin-outline',
    screen: '/debts',
    steps: [
      { titleKey: 'tour.debts.1t', bodyKey: 'tour.debts.1b', illustration: '⛰️' },
      { titleKey: 'tour.debts.2t', bodyKey: 'tour.debts.2b', illustration: '➕', anchor: 'debts-add' },
      { titleKey: 'tour.debts.3t', bodyKey: 'tour.debts.3b', illustration: '📉' },
    ],
  },
  {
    id: 'allocation',
    titleKey: 'alloc.title',
    icon: 'cash-multiple',
    screen: '/allocate',
    steps: [
      { titleKey: 'tour.alloc.1t', bodyKey: 'tour.alloc.1b', illustration: '✉️' },
      { titleKey: 'tour.alloc.2t', bodyKey: 'tour.alloc.2b', illustration: '🧮', anchor: 'alloc-toallocate' },
      { titleKey: 'tour.alloc.3t', bodyKey: 'tour.alloc.3b', illustration: '🤝' },
      { titleKey: 'tour.alloc.4t', bodyKey: 'tour.alloc.4b', illustration: '♻️', anchor: 'alloc-rollover' },
    ],
  },
];

export const tourById = (id: TourId): Tour => TOURS.find((tour) => tour.id === id)!;
