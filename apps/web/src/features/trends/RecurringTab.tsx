import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useLang } from '@/i18n';
import type { Lang, TFunc } from '@/i18n';
import { useCanEdit } from '@/app/useCanEdit';
import type { SpaceTx } from '@/application/transactions';
import type { RecurringRow, SpaceRow } from '@/db/types';
import { recurringsInScope } from '@/domain/recurring';
import type { RecurringScope } from '@/domain/recurring';
import { catName, useCategories } from '@/features/categories/useCategories';
import type { Catalog } from '@/features/categories/useCategories';
import { RecurringYearChart, linkedPayments } from '@/features/recurring/RecurringYearChart';
import type { ChartTx } from '@/features/recurring/RecurringYearChart';
import { Icon } from '@/ui/Icon';
import { SlideSwitch } from '@/ui/SlideSwitch';
import { compactMoney } from './format';
import { RecurringGraphSheet } from './RecurringGraphSheet';
import { useRecurringGraphOps } from './useTrendGraphs';
import type { RecurringGraph } from './useTrendGraphs';

const NO_SCOPE: RecurringScope = {};

/** a cost's main category; '' stands for a cost that has none */
export const mainCatOf = (cats: Catalog, catId: string | undefined): string => (catId ? (cats.byId(catId).parentId ?? catId) : '');

export interface RecurringCatOption {
  id: string;
  name: string;
  icon: string;
  color?: string;
  count: number;
}

/** the main categories the space's recurring costs carry, by name — what a graph can be narrowed to */
export function recurringCatOptions(recs: readonly RecurringRow[], cats: Catalog, t: TFunc): RecurringCatOption[] {
  const counts = new Map<string, number>();
  for (const rec of recs) {
    const id = mainCatOf(cats, rec.catId);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts]
    .map(([id, count]) => {
      if (!id) return { id, name: t('trends.recNoCat'), icon: 'help-circle-outline', count };
      const cat = cats.byId(id);
      return { id, name: catName(cat, t), icon: cat.icon, color: cat.color, count };
    })
    .sort((a, b) => (a.id === '' ? 1 : 0) - (b.id === '' ? 1 : 0) || a.name.localeCompare(b.name));
}

/** what a graph leaves in, in a line: its kinds, its word on luxury, its categories — nothing where it reads everything */
export function scopeText(scope: RecurringScope, options: readonly RecurringCatOption[], t: TFunc): string {
  const parts: string[] = [];
  if (scope.kinds?.length === 1) parts.push(t(scope.kinds[0] === 'fixed' ? 'recurring.fixed' : 'recurring.subs'));
  if (scope.luxury) parts.push(t(scope.luxury === 'only' ? 'trends.recLuxuryOnly' : 'trends.recLuxuryWithout'));
  if (scope.catIds) {
    const names = scope.catIds.map((id) => options.find((option) => option.id === id)?.name).filter((name): name is string => !!name);
    parts.push(names.length > 0 && names.length <= 2 ? names.join(', ') : t('trends.recCatCount', { n: scope.catIds.length }));
  }
  return parts.join(' · ');
}

interface CardShared {
  linkedByRec: ReadonlyMap<string, readonly ChartTx[]>;
  today: string;
  floor?: string;
  currency: string;
  lang: Lang;
  fmt: (cents: number) => string;
}

/** one graph: this year and the next, the Recurring screen's own chart over the costs the graph reads */
function RecurringCard({ graphId, recs, header, linkedByRec, today, floor, currency, lang, fmt }: Readonly<CardShared & { graphId: string; recs: readonly RecurringRow[]; header: ReactNode }>) {
  const { t } = useLang();
  const thisYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const tid = (base: string) => `${base}-${graphId}`;
  return (
    <section className="mt-4 rounded-card border border-line bg-surface p-4" data-testid={`trends-rec-graph-${graphId}`}>
      {header}
      <div className="mt-3 flex rounded-xl bg-bg-2 p-0.5">
        {[thisYear, thisYear + 1].map((candidate) => (
          <button
            key={candidate}
            data-testid={`trends-rec-year-${candidate === thisYear ? 'this' : 'next'}-${graphId}`}
            onClick={() => setYear(candidate)}
            className={`m-tap flex-1 rounded-[10px] border-none py-1.5 text-[11px] whitespace-nowrap ${
              year === candidate ? 'bg-surface font-semibold text-ink shadow-sm' : 'bg-transparent text-ink-3'
            }`}
          >
            {candidate}
          </button>
        ))}
      </div>
      <SlideSwitch viewKey={String(year)} index={year - thisYear} className="mt-3">
        {recs.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-ink-4" data-testid={`trends-rec-empty-${graphId}`}>
            {t('trends.recEmpty')}
          </p>
        ) : (
          <RecurringYearChart
            recs={recs}
            linkedByRec={linkedByRec}
            year={year}
            today={today}
            floor={floor}
            money={fmt}
            scale={(cents) => compactMoney(cents, currency, lang)}
            tid={tid}
            txRoute="/transactions/$txId"
          />
        )}
      </SlideSwitch>
    </section>
  );
}

// #690: the Recurring screen's year chart, in Trends — over every cost, and over the costs a graph of your own leaves in
// (fixed costs or subscriptions, luxury or not, the categories ticked)
export function RecurringTab({
  space,
  txs,
  recurrings,
  today,
  currency,
  fmt,
}: Readonly<{
  space: SpaceRow | undefined;
  txs: readonly SpaceTx[];
  recurrings: readonly RecurringRow[];
  today: string;
  currency: string;
  fmt: (cents: number) => string;
}>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const canEdit = useCanEdit(); // #505: the graphs are the space's
  const ops = useRecurringGraphOps(space);
  const [editor, setEditor] = useState<{ open: boolean; graph: RecurringGraph | null }>({ open: false, graph: null });
  const linkedByRec = useMemo(() => linkedPayments(txs), [txs]);
  const options = useMemo(() => recurringCatOptions(recurrings, cats, t), [recurrings, cats, t]);
  const mainOf = (catId: string | undefined) => mainCatOf(cats, catId);
  const shared: CardShared = { linkedByRec, today, floor: space?.historyStartDate, currency, lang, fmt };

  return (
    <>
      <RecurringCard
        graphId="all"
        recs={recurringsInScope(recurrings, NO_SCOPE, mainOf)}
        {...shared}
        header={
          <div className="flex items-center gap-3">
            <Icon name="autorenew" size={19} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold text-ink">{t('trends.recAll')}</span>
              <span className="block truncate text-[11px] text-ink-4">{t('trends.recAllSub')}</span>
            </span>
          </div>
        }
      />
      {(space?.recurringGraphs ?? []).map((graph) => {
        const sub = scopeText(graph, options, t);
        return (
          <RecurringCard
            key={graph.id}
            graphId={graph.id}
            recs={recurringsInScope(recurrings, graph, mainOf)}
            {...shared}
            header={
              <div className="flex items-center gap-3">
                <Icon name="chart-line" size={19} color="var(--m-accent)" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold text-ink">{graph.name}</span>
                  {sub && (
                    <span className="block truncate text-[11px] text-ink-4" data-testid={`trends-rec-scope-${graph.id}`}>
                      {sub}
                    </span>
                  )}
                </span>
                {canEdit && (
                  <button
                    data-testid={`trends-rec-edit-${graph.id}`}
                    aria-label={t('action.edit')}
                    onClick={() => setEditor({ open: true, graph })}
                    className="m-tap flex h-8 w-8 items-center justify-center border-none bg-transparent text-ink-3"
                  >
                    <Icon name="pencil-outline" size={17} />
                  </button>
                )}
              </div>
            }
          />
        );
      })}
      {canEdit && (
        <button
          data-testid="trends-rec-new"
          onClick={() => setEditor({ open: true, graph: null })}
          className="m-tap mt-4 flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-line bg-transparent py-3 text-[13px] font-semibold text-accent-deep"
        >
          <Icon name="plus" size={16} />
          {t('trends.newGraph')}
        </button>
      )}
      <RecurringGraphSheet
        open={editor.open}
        onOpenChange={(open) => setEditor((prev) => ({ ...prev, open }))}
        initial={editor.graph}
        options={options}
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
