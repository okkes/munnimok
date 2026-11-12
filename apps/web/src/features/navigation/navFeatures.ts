import type { TranslationKey } from '@/i18n';

/**
 * The navigation's one feature catalogue (#523, #577): the desktop side
 * panel lists every entry, the mobile bar shows Home plus the space's picks
 * (SpaceRow.navTabs), Home shortcuts and the editor read the same table.
 */

export const NAV_FEATURE_IDS = [
  'transactions',
  'planning',
  'portfolio',
  'budgets',
  'goals',
  'debts',
  'events',
  'splits',
  'recurring',
  'upcoming',
  'insights',
  'trends',
  'receipts',
  'settings',
] as const;
export type NavFeatureId = (typeof NAV_FEATURE_IDS)[number];

export interface NavItem {
  /** 'home' or a feature id — testids are `tab-<id>` and `side-tab-<id>` */
  id: 'home' | NavFeatureId;
  to: string;
  labelKey: TranslationKey;
  icon: string;
  iconActive: string;
  /** signed-in identities only (splits are a server feature) */
  userOnly?: boolean;
  /** #538 (user): … and the demo, which shows seeded examples so the feature can be understood without an account */
  demoToo?: boolean;
  /** wears the planning dot (a subject in the red) */
  dot?: boolean;
}

export const HOME_NAV: NavItem = { id: 'home', to: '/home', labelKey: 'tab.home', icon: 'home-variant-outline', iconActive: 'home-variant' };

export const NAV_FEATURES: Record<NavFeatureId, NavItem> = {
  transactions: { id: 'transactions', to: '/transactions', labelKey: 'tab.transactions', icon: 'format-list-bulleted', iconActive: 'format-list-bulleted' },
  planning: { id: 'planning', to: '/planning', labelKey: 'tab.planning', icon: 'clipboard-text-outline', iconActive: 'clipboard-text', dot: true },
  portfolio: { id: 'portfolio', to: '/portfolio', labelKey: 'tab.portfolio', icon: 'chart-timeline-variant', iconActive: 'chart-timeline-variant' },
  budgets: { id: 'budgets', to: '/budgets', labelKey: 'budgets.title', icon: 'wallet-outline', iconActive: 'wallet' },
  goals: { id: 'goals', to: '/goals', labelKey: 'goals.title', icon: 'flag-outline', iconActive: 'flag' },
  debts: { id: 'debts', to: '/debts', labelKey: 'debts.title', icon: 'hand-coin-outline', iconActive: 'hand-coin' },
  events: { id: 'events', to: '/events', labelKey: 'tab.events', icon: 'party-popper', iconActive: 'party-popper' },
  splits: { id: 'splits', to: '/splits', labelKey: 'splits.title', icon: 'account-cash-outline', iconActive: 'account-cash', userOnly: true, demoToo: true },
  recurring: { id: 'recurring', to: '/recurring', labelKey: 'screen.recurring', icon: 'autorenew', iconActive: 'autorenew' },
  upcoming: { id: 'upcoming', to: '/upcoming', labelKey: 'recurring.upcoming', icon: 'calendar-clock-outline', iconActive: 'calendar-clock' },
  insights: { id: 'insights', to: '/insights', labelKey: 'tab.insights', icon: 'lightbulb-outline', iconActive: 'lightbulb' },
  trends: { id: 'trends', to: '/trends', labelKey: 'trends.title', icon: 'chart-bar', iconActive: 'chart-bar' },
  receipts: { id: 'receipts', to: '/receipts', labelKey: 'receipts.title', icon: 'receipt-text-outline', iconActive: 'receipt-text' },
  settings: { id: 'settings', to: '/settings', labelKey: 'tab.settings', icon: 'cog-outline', iconActive: 'cog' },
};

/** a space without its own pick (every space from before #577) */
export const DEFAULT_NAV_TABS: readonly NavFeatureId[] = ['transactions', 'planning', 'portfolio', 'settings'];

/** the whole bar, Home included — past eight a phone's tap targets get too narrow */
export const MAX_NAV_ITEMS = 8;
export const MAX_NAV_PICKS = MAX_NAV_ITEMS - 1;

/** the features whose only door was the bar: Home carries them while they are out of it */
export const SHORTCUT_FEATURES: readonly NavFeatureId[] = ['transactions', 'planning', 'portfolio'];

/** the desktop side panel: the default bar first, then every other feature by intent; Settings sits at its foot */
export const SIDE_NAV_GROUPS: readonly { capKey?: TranslationKey; ids: readonly NavFeatureId[] }[] = [
  { ids: ['transactions', 'planning', 'portfolio'] },
  { capKey: 'settings.groupPlan', ids: ['budgets', 'goals', 'debts'] },
  { capKey: 'settings.groupTrack', ids: ['upcoming', 'recurring', 'events', 'splits', 'receipts'] },
  { capKey: 'settings.groupLearn', ids: ['insights', 'trends'] },
];

const KNOWN = new Set<string>(NAV_FEATURE_IDS);
export const isNavFeatureId = (id: unknown): id is NavFeatureId => typeof id === 'string' && KNOWN.has(id);

/** whether this identity can open the feature at all */
export const navUsableFor =
  (identityKind: string | undefined) =>
  (id: NavFeatureId): boolean =>
    !NAV_FEATURES[id].userOnly || identityKind === 'user' || (identityKind === 'demo' && NAV_FEATURES[id].demoToo === true);

/**
 * The bar's features after Home, as the space stores them: absent or null =
 * the default bar. Ids this build does not know (a newer build's), doubles
 * and features the identity cannot open drop out; past the cap is cut.
 */
export function resolveNavTabs(saved: unknown, usable: (id: NavFeatureId) => boolean): NavFeatureId[] {
  const source: readonly unknown[] = Array.isArray(saved) ? saved : DEFAULT_NAV_TABS;
  const out: NavFeatureId[] = [];
  for (const id of source) {
    if (!isNavFeatureId(id) || out.includes(id) || !usable(id)) continue;
    out.push(id);
    if (out.length === MAX_NAV_PICKS) break;
  }
  return out;
}

/**
 * The list to store after an edit of the visible picks: what this build
 * cannot show (a newer build's ids, a feature this identity cannot open)
 * stays stored behind them, so another device keeps its choice.
 */
export function storedNavTabs(saved: unknown, next: readonly NavFeatureId[], usable: (id: NavFeatureId) => boolean): string[] {
  const hidden = (Array.isArray(saved) ? saved : []).filter(
    (id): id is string => typeof id === 'string' && (!isNavFeatureId(id) || !usable(id)),
  );
  return [...next, ...hidden.filter((id, i) => hidden.indexOf(id) === i)];
}

/** the shortcut features that are not in the bar (Home lists them) */
export const homeShortcuts = (tabs: readonly NavFeatureId[]): NavFeatureId[] => SHORTCUT_FEATURES.filter((id) => !tabs.includes(id));

/** labels stay while the widest fits its slot with room to breathe; one that does not turns the whole bar into icons */
export function labelsFit(slotWidth: number, labelWidths: readonly number[], gutter: number): boolean {
  return labelWidths.every((width) => width + gutter * 2 <= slotWidth);
}
