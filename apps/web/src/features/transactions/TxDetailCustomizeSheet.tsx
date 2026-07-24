import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { useData } from '@/app/data';
import type { SpaceRow } from '@/db/types';
import { useDragReorder } from '@/ui/dragReorder';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

/** the movable sections under the details block, in default order — the
 *  details/actions card itself is fixed (user ruling) */
export const TX_DETAIL_BLOCK_IDS = ['reimburse', 'receipts', 'notes'] as const;
export type TxDetailBlockId = (typeof TX_DETAIL_BLOCK_IDS)[number];

export const TX_DETAIL_BLOCK_LABELS: Record<TxDetailBlockId, TranslationKey> = {
  reimburse: 'reimb.section',
  receipts: 'receipt.title',
  notes: 'tx.notes',
};

/** icons matching the sections they stand for (user feedback 2026-07-24) */
export const TX_DETAIL_BLOCK_ICONS: Record<TxDetailBlockId, string> = {
  reimburse: 'cash-refund',
  receipts: 'receipt-text-outline',
  notes: 'note-edit-outline',
};

export interface TxDetailBlockConfig {
  id: TxDetailBlockId;
  hidden: boolean;
}

/** the space's saved layout merged with defaults (new sections append) */
export function resolveTxDetailBlocks(space: SpaceRow | undefined): TxDetailBlockConfig[] {
  const saved = space?.txDetailBlocks ?? [];
  const known = new Set<string>(TX_DETAIL_BLOCK_IDS);
  const ordered = saved
    .filter((entry) => known.has(entry.id))
    .map((entry) => ({ id: entry.id as TxDetailBlockId, hidden: entry.hidden === 1 }));
  const present = new Set(ordered.map((entry) => entry.id));
  for (const id of TX_DETAIL_BLOCK_IDS) if (!present.has(id)) ordered.push({ id, hidden: false });
  return ordered;
}

/**
 * "Customize this view" for the transaction detail: reorder the sections
 * with the arrows, hide/show with the eye — same mechanics as Customize
 * Home. Saved on the space row, so it syncs to every member/device.
 */
export function TxDetailCustomizeSheet({
  open,
  onOpenChange,
  space,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; space: SpaceRow | undefined }>) {
  const { t } = useLang();
  const { repo, spaceId } = useData();
  const blocks = resolveTxDetailBlocks(space);

  const persist = (next: TxDetailBlockConfig[]) =>
    void repo.upsert('space', spaceId, spaceId, {
      txDetailBlocks: next.map((entry) => ({ id: entry.id, hidden: entry.hidden ? (1 as const) : (0 as const) })),
    });

  const toggle = (index: number) => {
    persist(blocks.map((entry, i) => (i === index ? { ...entry, hidden: !entry.hidden } : entry)));
  };

  // drag-to-reorder with ghost + slide, same mechanics as Customize Home
  const reorder = (from: number, to: number) => {
    const next = [...blocks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    persist(next);
  };
  const { drag, ghost, setRowRef, rowStyle, handleProps } = useDragReorder(blocks.length, reorder);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('tx.customize')} size="form">
      <p className="pb-2 text-[12px] text-ink-3">{t('tx.customizeSub')}</p>
      <div className="flex flex-col" data-testid="tx-customize-list">
        {blocks.map((entry, index) => (
          <div
            key={entry.id}
            ref={setRowRef(index)}
            data-testid={`tx-block-row-${entry.id}`}
            style={rowStyle(index)}
            className="flex items-center gap-2.5 border-b border-line-2 py-2 last:border-0"
          >
            <Icon name={TX_DETAIL_BLOCK_ICONS[entry.id]} size={19} color={entry.hidden ? 'var(--m-ink-4)' : 'var(--m-accent-deep)'} />
            <span className={`min-w-0 flex-1 truncate text-[14px] ${entry.hidden ? 'text-ink-4' : 'text-ink'}`}>
              {t(TX_DETAIL_BLOCK_LABELS[entry.id])}
            </span>
            <button
              aria-label={t('home.blockToggle')}
              data-testid={`tx-block-toggle-${entry.id}`}
              onClick={() => toggle(index)}
              className="m-tap flex h-9 w-9 items-center justify-center rounded-full border-none bg-transparent"
            >
              <Icon
                name={entry.hidden ? 'eye-off-outline' : 'eye-outline'}
                size={18}
                color={entry.hidden ? 'var(--m-ink-4)' : 'var(--m-accent-deep)'}
              />
            </button>
            {/* handle on the RIGHT, matching the category manager (user request) */}
            <button
              aria-label={t('home.dragHandle')}
              data-testid={`tx-block-drag-${entry.id}`}
              {...handleProps(index)}
              className="m-tap flex h-9 w-9 shrink-0 cursor-grab touch-none items-center justify-center border-none bg-transparent text-ink-4 select-none"
            >
              <Icon name="drag-horizontal-variant" size={18} />
            </button>
          </div>
        ))}
      </div>
      {/* the floating clone that follows the finger */}
      {drag && ghost && (
        <div
          data-testid="tx-block-ghost"
          className="pointer-events-none fixed z-50 flex items-center gap-2.5 rounded-input border border-accent bg-surface px-3 shadow-2xl"
          style={{ top: ghost.top, left: ghost.left, width: ghost.width, height: ghost.height }}
        >
          <Icon name={TX_DETAIL_BLOCK_ICONS[blocks[drag.from].id]} size={19} color="var(--m-accent-deep)" />
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{t(TX_DETAIL_BLOCK_LABELS[blocks[drag.from].id])}</span>
          <Icon name="drag-horizontal-variant" size={18} color="var(--m-ink-4)" />
        </div>
      )}
    </Sheet>
  );
}
