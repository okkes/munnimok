import { useQuery } from '@/db/useQuery';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { useData } from '@/app/data';
import { useCanEdit } from '@/app/useCanEdit';
import { ReadOnlyNote } from '@/features/spaces/ReadOnlyNote';
import type { SpaceRow } from '@/db/types';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { BlockListEditor } from '@/features/customize/BlockListEditor';

/** every block the landing zone can show, in default order; portfolio has its own tab, net worth left for Trends (#512) */
export const HOME_BLOCK_IDS = ['review', 'receipts', 'cashflow', 'overview', 'shortcuts', 'transactions', 'explore', 'budgets', 'planning', 'upcoming', 'recurring', 'goals', 'debts', 'events', 'splits', 'insights', 'trends'] as const;
export type HomeBlockId = (typeof HOME_BLOCK_IDS)[number];

export const HOME_BLOCK_LABELS: Record<HomeBlockId, TranslationKey> = {
  review: 'review.title',
  receipts: 'receipts.toCheckTitle',
  cashflow: 'cashflow.title',
  overview: 'overview.thisPeriod',
  shortcuts: 'home.shortcutsTitle',
  transactions: 'tab.transactions',
  explore: 'home.exploreTitle',
  budgets: 'budgets.title',
  planning: 'plan.title',
  upcoming: 'recurring.upcoming',
  recurring: 'screen.recurring',
  goals: 'goals.title',
  debts: 'debts.title',
  events: 'events.title',
  splits: 'splits.title',
  insights: 'ins.title',
  trends: 'trends.title',
};

export const HOME_BLOCK_ICONS: Record<HomeBlockId, string> = {
  review: 'check-decagram-outline',
  receipts: 'receipt-text-outline',
  cashflow: 'swap-vertical',
  overview: 'chart-donut',
  shortcuts: 'apps',
  transactions: 'format-list-bulleted',
  explore: 'compass-outline',
  budgets: 'wallet-outline',
  planning: 'clipboard-text-outline',
  upcoming: 'calendar-clock',
  recurring: 'autorenew',
  goals: 'flag-outline',
  debts: 'scale-balance',
  events: 'calendar-star',
  splits: 'account-group-outline',
  insights: 'lightbulb-outline',
  trends: 'chart-bar',
};

export interface HomeBlockConfig {
  id: HomeBlockId;
  hidden: boolean;
}

// the saved layout merged with defaults: new blocks append switched on; ids no longer a block (#512 networth) are dropped
export function resolveHomeBlocks(space: SpaceRow | undefined): HomeBlockConfig[] {
  const saved = space?.homeBlocks ?? [];
  const known = new Set<string>(HOME_BLOCK_IDS);
  const ordered = saved
    .filter((entry) => known.has(entry.id))
    .map((entry) => ({ id: entry.id as HomeBlockId, hidden: entry.hidden === 1 }));
  const present = new Set(ordered.map((entry) => entry.id));
  for (const id of HOME_BLOCK_IDS) if (!present.has(id)) ordered.push({ id, hidden: false });
  return ordered;
}

// a full screen, not a sheet: the sheet's transform sent the drag ghost drifting;
// saved on the space row, so per-space and synced
export function HomeCustomizeScreen() {
  const { t } = useLang();
  const { store, repo, spaceId } = useData();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const blocks = resolveHomeBlocks(space);
  const canEdit = useCanEdit(); // #505

  const persist = (next: HomeBlockConfig[]) => {
    if (!canEdit) return;
    void repo.upsert('space', spaceId, spaceId, {
      homeBlocks: next.map((entry) => ({ id: entry.id, hidden: entry.hidden ? (1 as const) : (0 as const) })),
    });
  };

  // splice, not swap: a long drag lands in one write
  const reorder = (from: number, to: number) => {
    const next = [...blocks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    persist(next);
  };

  const toggle = (index: number) => {
    persist(blocks.map((entry, i) => (i === index ? { ...entry, hidden: !entry.hidden } : entry)));
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-home-customize">
      <AppBar
        title={t('home.customize')}
        leading={
          <IconButton label={t('action.back')} testId="home-customize-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <p className="pb-2 text-[12px] text-ink-3">{t('home.customizeSub')}</p>
        <ReadOnlyNote className="mb-3" testId="home-customize-readonly-note" />
        {/* render only once the SAVED layout arrived: acting on the defaults mid-load overwrote the real order */}
        {space && (
        <div className="flex flex-col" data-testid="home-customize-list" inert={canEdit ? undefined : true}>
          <BlockListEditor
            rows={blocks.map((entry) => ({
              id: entry.id,
              label: t(HOME_BLOCK_LABELS[entry.id]),
              icon: HOME_BLOCK_ICONS[entry.id],
              hidden: entry.hidden,
            }))}
            testPrefix="home-block"
            onToggle={toggle}
            onReorder={reorder}
          />
        </div>
        )}
      </div>
    </div>
  );
}
