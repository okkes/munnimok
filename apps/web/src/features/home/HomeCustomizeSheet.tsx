import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { useData } from '@/app/data';
import type { SpaceRow } from '@/db/types';
import { useDragReorder } from '@/ui/dragReorder';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

/** every block the landing zone can show, in default order (user ruling:
 *  review → this period → transactions → budgets → coming up → goals →
 *  debts → events → insights; portfolio left Home for its own tab) */
export const HOME_BLOCK_IDS = ['review', 'cashflow', 'overview', 'transactions', 'budgets', 'allocation', 'upcoming', 'goals', 'debts', 'events', 'splits', 'insights', 'networth'] as const;
export type HomeBlockId = (typeof HOME_BLOCK_IDS)[number];

/** blocks that arrive switched OFF (opt-in via Customize Home) */
const DEFAULT_HIDDEN: ReadonlySet<HomeBlockId> = new Set(['networth']);

export const HOME_BLOCK_LABELS: Record<HomeBlockId, TranslationKey> = {
  review: 'review.title',
  cashflow: 'cashflow.title',
  overview: 'overview.thisPeriod',
  transactions: 'tab.transactions',
  budgets: 'budgets.title',
  allocation: 'alloc.title',
  upcoming: 'recurring.upcoming',
  goals: 'goals.title',
  debts: 'debts.title',
  events: 'events.title',
  splits: 'splits.title',
  insights: 'ins.title',
  networth: 'trends.viewNetworth',
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
  for (const id of HOME_BLOCK_IDS) if (!present.has(id)) ordered.push({ id, hidden: DEFAULT_HIDDEN.has(id) });
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

  // drag anywhere in the list (user request: ghost + slide animation,
  // arrows retired) — splice, not swap: a long drag lands in one write
  const reorder = (from: number, to: number) => {
    const next = [...blocks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    persist(next);
  };
  const { drag, ghost, setRowRef, rowStyle, handleProps } = useDragReorder(blocks.length, reorder);

  const toggle = (index: number) => {
    const next = blocks.map((entry, i) => (i === index ? { ...entry, hidden: !entry.hidden } : entry));
    persist(next);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('home.customize')} size="form">
      <p className="pb-2 text-[12px] text-ink-3">{t('home.customizeSub')}</p>
      <div className="flex flex-col" data-testid="home-customize-list">
        {blocks.map((entry, index) => (
          <div
            key={entry.id}
            ref={setRowRef(index)}
            data-testid={`home-block-row-${entry.id}`}
            style={rowStyle(index)}
            className="flex items-center gap-2 border-b border-line-2 py-2 last:border-0"
          >
            <button
              aria-label={t('home.dragHandle')}
              data-testid={`home-block-drag-${entry.id}`}
              {...handleProps(index)}
              className="m-tap flex h-9 w-7 cursor-grab items-center justify-center border-none bg-transparent text-ink-4"
            >
              <Icon name="drag-horizontal-variant" size={17} />
            </button>
            <span className={`min-w-0 flex-1 truncate text-[14px] ${entry.hidden ? 'text-ink-4' : 'text-ink'}`}>
              {t(HOME_BLOCK_LABELS[entry.id])}
            </span>
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
      {/* the floating clone that follows the finger */}
      {drag && ghost && (
        <div
          data-testid="home-block-ghost"
          className="pointer-events-none fixed z-50 flex items-center gap-2 rounded-input border border-line bg-surface px-2 shadow-2xl"
          style={{ top: ghost.top, left: ghost.left, width: ghost.width, height: ghost.height }}
        >
          <Icon name="drag-horizontal-variant" size={17} color="var(--m-ink-4)" />
          <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{t(HOME_BLOCK_LABELS[blocks[drag.from].id])}</span>
        </div>
      )}
    </Sheet>
  );
}
