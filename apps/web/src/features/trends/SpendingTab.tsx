import { useState } from 'react';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import type { SpaceTx } from '@/application/transactions';
import type { SpaceRow } from '@/db/types';
import type { Period } from '@/domain/periods';
import { catName, useCategories } from '@/features/categories/useCategories';
import type { Catalog } from '@/features/categories/useCategories';
import { Icon } from '@/ui/Icon';
import { CatPickerSheet } from './CatPickerSheet';
import { GraphEditorSheet } from './GraphEditorSheet';
import { SpendingCard } from './SpendingCard';
import type { GraphDef } from './SpendingCard';
import { useTrendGraphOps } from './useTrendGraphs';
import type { TrendGraph } from './useTrendGraphs';

const ACCENT = 'var(--m-accent)';

/** a category's own colour, or its parent's for a sub */
function colorOf(cats: Catalog, catId: string): string {
  const cat = cats.byId(catId);
  return cat.color ?? (cat.parentId ? cats.byId(cat.parentId).color : undefined) ?? ACCENT;
}

/** a custom graph wears its one category's face; several share the chart glyph */
function graphDef(cats: Catalog, graph: TrendGraph): GraphDef {
  const face = graph.catIds.length === 1 ? { icon: cats.byId(graph.catIds[0]).icon, color: colorOf(cats, graph.catIds[0]) } : { icon: 'chart-bar', color: ACCENT };
  return { id: graph.id, name: graph.name, catIds: graph.catIds, ...face };
}

/**
 * The Spending tab (user 2026-10-08): the built-in "All expenses" card
 * with its one-pick scope, one card per custom graph, and the door to
 * make another. Graphs live on the space row.
 */
export function SpendingTab({
  space,
  periods,
  labels,
  txs,
  today,
  currency,
  catId,
  onCatId,
  fmt,
}: Readonly<{
  space: SpaceRow | undefined;
  periods: readonly Period[];
  labels: readonly string[];
  txs: readonly SpaceTx[];
  today: string;
  currency: string;
  /** the built-in card's scope (kept by the screen so a tab switch does not drop it) */
  catId: string | undefined;
  onCatId: (catId: string | undefined) => void;
  fmt: (cents: number) => string;
}>) {
  const { t } = useLang();
  const { spaceId } = useData();
  const cats = useCategories();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editor, setEditor] = useState<{ open: boolean; graph: TrendGraph | null }>({ open: false, graph: null });
  const ops = useTrendGraphOps(space);

  const selected = catId ? cats.byId(catId) : undefined;
  const builtIn: GraphDef = {
    id: 'all',
    name: selected ? catName(selected, t) : t('trends.allExpenses'),
    catIds: catId ? [catId] : null,
    icon: selected?.icon ?? 'shape-outline',
    color: catId ? colorOf(cats, catId) : ACCENT,
  };
  const shared = { periods, labels, txs, today, currency, spaceId, fmt };

  return (
    <>
      <SpendingCard
        graph={builtIn}
        {...shared}
        chartTestId="trends-cat-chart"
        currentTestId="trends-cat-current"
        header={
          <button
            data-testid="trends-cat-picker"
            onClick={() => setPickerOpen(true)}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent p-0 text-left"
          >
            <Icon name={builtIn.icon} size={19} color={selected ? builtIn.color : 'var(--m-ink-3)'} />
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{builtIn.name}</span>
            <Icon name="chevron-down" size={17} color="var(--m-ink-4)" />
          </button>
        }
      />
      {(space?.trendGraphs ?? []).map((graph) => {
        const def = graphDef(cats, graph);
        return (
          <SpendingCard
            key={graph.id}
            graph={def}
            {...shared}
            testId={`trends-graph-${graph.id}`}
            header={
              <div className="flex items-center gap-3">
                <Icon name={def.icon} size={19} color={def.color} />
                <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{graph.name}</span>
                <button
                  data-testid={`trends-graph-edit-${graph.id}`}
                  aria-label={t('action.edit')}
                  onClick={() => setEditor({ open: true, graph })}
                  className="m-tap flex h-8 w-8 items-center justify-center border-none bg-transparent text-ink-3"
                >
                  <Icon name="pencil-outline" size={17} />
                </button>
              </div>
            }
          />
        );
      })}
      <button
        data-testid="trends-graph-new"
        onClick={() => setEditor({ open: true, graph: null })}
        className="m-tap mt-4 flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-line bg-transparent py-3 text-[13px] font-semibold text-accent-deep"
      >
        <Icon name="plus" size={16} />
        {t('trends.newGraph')}
      </button>

      <CatPickerSheet open={pickerOpen} onOpenChange={setPickerOpen} catId={catId} onPick={onCatId} />
      <GraphEditorSheet
        open={editor.open}
        onOpenChange={(open) => setEditor((prev) => ({ ...prev, open }))}
        initial={editor.graph}
        onSave={(draft) => {
          setEditor({ open: false, graph: null });
          void ops.save(draft);
        }}
        onDelete={(id) => {
          setEditor({ open: false, graph: null });
          void ops.remove(id);
        }}
      />
    </>
  );
}
