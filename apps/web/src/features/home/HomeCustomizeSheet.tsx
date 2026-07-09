import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { useData } from '@/app/data';
import type { SpaceRow } from '@/db/types';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

/** every block the landing zone can show, in default order */
export const HOME_BLOCK_IDS = ['overview', 'review', 'budgets', 'allocation', 'upcoming', 'events', 'goals', 'debts', 'transactions'] as const;
export type HomeBlockId = (typeof HOME_BLOCK_IDS)[number];

export const HOME_BLOCK_LABELS: Record<HomeBlockId, TranslationKey> = {
  overview: 'overview.thisPeriod',
  review: 'review.title',
  budgets: 'budgets.title',
  allocation: 'alloc.title',
  upcoming: 'recurring.upcoming',
  events: 'events.title',
  goals: 'goals.title',
  debts: 'debts.title',
  transactions: 'tab.transactions',
};

export interface HomeBlockConfig {
  id: HomeBlockId;
  hidden: boolean;
}

/** the space's saved layout merged with defaults (new blocks append) */
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

/**
 * "Customize Home": reorder the landing-zone blocks with the arrows,
 * hide/show with the eye. Saved on the space row, so the layout is a
 * per-space decision and syncs to every member/device.
 */
export function HomeCustomizeSheet({ open, onOpenChange, space }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; space: SpaceRow | undefined }>) {
  const { t } = useLang();
  const { repo, spaceId } = useData();
  const blocks = resolveHomeBlocks(space);

  const persist = (next: HomeBlockConfig[]) =>
    void repo.upsert('space', spaceId, spaceId, {
      homeBlocks: next.map((entry) => ({ id: entry.id, hidden: entry.hidden ? (1 as const) : (0 as const) })),
    });

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[target]] = [next[target], next[index]];
    persist(next);
  };

  const toggle = (index: number) => {
    const next = blocks.map((entry, i) => (i === index ? { ...entry, hidden: !entry.hidden } : entry));
    persist(next);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('home.customize')} size="form">
      <p className="pb-2 text-[12px] text-ink-3">{t('home.customizeSub')}</p>
      <div className="flex flex-col" data-testid="home-customize-list">
        {blocks.map((entry, index) => (
          <div key={entry.id} className="flex items-center gap-2 border-b border-line-2 py-2 last:border-0">
            <span className={`min-w-0 flex-1 truncate text-[14px] ${entry.hidden ? 'text-ink-4' : 'text-ink'}`}>
              {t(HOME_BLOCK_LABELS[entry.id])}
            </span>
            <button
              aria-label="↑"
              data-testid={`home-block-up-${entry.id}`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
              className="m-tap flex h-9 w-9 items-center justify-center rounded-full border-none bg-transparent text-ink-3 disabled:opacity-30"
            >
              <Icon name="arrow-up" size={17} />
            </button>
            <button
              aria-label="↓"
              data-testid={`home-block-down-${entry.id}`}
              disabled={index === blocks.length - 1}
              onClick={() => move(index, 1)}
              className="m-tap flex h-9 w-9 items-center justify-center rounded-full border-none bg-transparent text-ink-3 disabled:opacity-30"
            >
              <Icon name="arrow-down" size={17} />
            </button>
            <button
              aria-label={t('home.blockToggle')}
              data-testid={`home-block-toggle-${entry.id}`}
              onClick={() => toggle(index)}
              className="m-tap flex h-9 w-9 items-center justify-center rounded-full border-none bg-transparent"
            >
              <Icon name={entry.hidden ? 'eye-off-outline' : 'eye-outline'} size={18} color={entry.hidden ? 'var(--m-ink-4)' : 'var(--m-accent-deep)'} />
            </button>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
