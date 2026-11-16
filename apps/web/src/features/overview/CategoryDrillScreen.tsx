import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useSpaceAccounts, useSpaceTransactions } from '@/application/transactions';
import { useCashOutSet } from '@/application/goals';
import { useData } from '@/app/data';
import { categoryContributionCents, txsForCategory } from '@/domain/overview';
import type { OverviewKind } from '@/domain/overview';
import { periodHistory, periodMonthsLabel } from '@/domain/periods';
import { catName, useCategories } from '@/features/categories/useCategories';
import { recallDrillLinked, recallDrillPeriod, rememberDrillLinked, rememberDrillPeriod } from './periodMemory';
import { LOCALES, useLang } from '@/i18n';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { SENSITIVE_KINDS } from '@/features/privacy/sensitive';
import { AppBar, IconButton } from '@/ui/AppBar';
import { BarChart } from '@/ui/charts';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { TxRow } from '@/ui/TxRow';
import { TxPartRow } from '@/ui/TxPartRow';
import { matchingPartIndexes } from '@/domain/txFilter';
import type { TxSplit } from '@/db/types';

const PERIOD_COUNT = 6;

/** the part's cents belonging to the drilled category (spread-aware) */
const partCatShare = (part: TxSplit, catSet: ReadonlySet<string>): number => {
  if (part.cats?.length) {
    return part.cats.filter((entry) => catSet.has(entry.catId)).reduce((sum, entry) => sum + entry.amountCents, 0);
  }
  return Math.abs(part.amountCents);
};

const KIND_ACCENT: Record<OverviewKind, string> = {
  income: 'var(--m-accent)',
  expense: 'var(--m-negative)',
  saving: 'var(--m-warning)',
  investment: 'var(--m-special)',
  funding: '#16A085',
  debt: 'var(--m-special)',
};

export function CategoryDrillScreen() {
  const { t, lang } = useLang();
  const { store, spaceId } = useData();
  const { kind, catId } = useParams({ strict: false }) as { kind: OverviewKind; catId: string };
  const { from } = useSearch({ strict: false }) as { from?: string };
  const cats = useCategories();
  const navigate = useNavigate();
  // the transaction opens UNDER the overview tree: at lg this drill stays the master pane beside the detail (#351)
  const openTx = (txId: string) =>
    void navigate({ to: '/overview/$kind/$catId/tx/$txId', params: { kind, catId, txId }, search: { from } });

  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const accounts = useSpaceAccounts();
  const txs = useSpaceTransactions();

  const periods = useMemo(
    () => periodHistory(space?.periodType ?? 'month', space?.periodDay ?? 1, PERIOD_COUNT),
    [space?.periodType, space?.periodDay],
  );
  // without ?from (back from a transaction page, #351) the drill's own memory wins over snapping to the current period
  const memoKey = `${kind}:${catId}`;
  const initialIndex = useMemo(() => {
    const found = from ? periods.findIndex((p) => p.start === from) : -1;
    return found >= 0 ? found : (recallDrillPeriod(memoKey) ?? PERIOD_COUNT - 1);
  }, [periods, from, memoKey]);
  const [periodIndex, setPeriodIndex] = useState(initialIndex);
  useEffect(() => {
    rememberDrillPeriod(memoKey, periodIndex);
  }, [memoKey, periodIndex]);
  // counterpart legs of linked pairs are out of the total, so they hide by default; the toggle is remembered like the period
  const [showLinked, setShowLinked] = useState(() => recallDrillLinked(memoKey) ?? false);
  useEffect(() => {
    rememberDrillLinked(memoKey, showLinked);
  }, [memoKey, showLinked]);
  // the space row loads async: default month boundaries on first render make a custom period `from` unmatchable
  // (the drill snapped to the CURRENT period); re-anchor when the real config lands unless a bar was already picked
  const touched = useRef(false);
  const lastInitial = useRef(initialIndex);
  if (lastInitial.current !== initialIndex) {
    lastInitial.current = initialIndex;
    if (!touched.current) setPeriodIndex(initialIndex);
  }
  const selectPeriod = (index: number) => {
    touched.current = true;
    setPeriodIndex(index);
  };

  const accountsById = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a])), [accounts]);
  // #455: the drill sums like its overview — a reached goal's cash-out is not in the saving
  const cashedOut = useCashOutSet(txs);
  const perPeriod = useMemo(
    () => periods.map((period) => txsForCategory(kind, txs ?? [], accountsById, period, catId, cats, cashedOut)),
    [periods, kind, txs, accountsById, catId, cats, cashedOut],
  );
  const barLabels = useMemo(() => periods.map((period) => periodMonthsLabel(period, LOCALES[lang])), [periods, lang]);

  const selected = perPeriod[periodIndex];
  const period = periods[periodIndex];
  const currency = space?.currency ?? 'EUR';
  const { fmt, fmtSensitive } = useDisplayMoney();
  const cat = cats.byId(catId);
  const color = cat.color ?? cats.byId(cat.parentId)?.color ?? KIND_ACCENT[kind];
  const periodLabel = `${new Date(period.start).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' })} – ${new Date(period.end).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' })}`;

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-category-drill">
      <AppBar
        title={catName(cat, t)}
        leading={
          <IconButton label={t('action.back')} testId="catdrill-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="flex flex-col items-center py-2 text-center">
          <span
            className="flex h-11 w-11 items-center justify-center rounded-2xl"
            style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
          >
            <Icon name={cat.icon} size={22} />
          </span>
          <div className="m-num mt-2 text-4xl text-ink" data-testid="catdrill-total">
            {/* #530: the total one level under a hidden tile stays hidden; the rows are the transactions themselves */}
            {(SENSITIVE_KINDS.has(kind) ? fmtSensitive : fmt)(selected.totalCents, currency)}
          </div>
          <div className="mt-1 text-xs font-medium text-ink-3" data-testid="catdrill-period">
            {periodLabel}
          </div>
        </div>

        <div className="mt-2 rounded-card border border-line bg-surface px-4 pt-3 pb-2">
          <BarChart
            values={perPeriod.map((entry) => entry.totalCents)}
            labels={barLabels}
            selected={periodIndex}
            onSelect={selectPeriod}
            accent={color}
          />
        </div>

        <div className="mt-5 mb-1 flex items-center justify-between gap-2 px-1">
          <span className="m-cap">
            {t('overview.payments')} · {selected.txs.length}
          </span>
          {selected.counterparts.size > 0 && (
            <Chip testId="catdrill-linked" selected={showLinked} onClick={() => setShowLinked((v) => !v)}>
              <Icon name="swap-horizontal" size={14} />
              {t('overview.showLinked')}
            </Chip>
          )}
        </div>
        {selected.txs.length > 0 ? (
          <div className="divide-y divide-line-2 rounded-card border border-line bg-surface px-3 py-1" data-testid="catdrill-list">
            {selected.txs.map((tx) => {
              // the headline is what THIS category got (splits partition);
              // the full net amount stays visible small when they differ
              const slice = categoryContributionCents(kind, tx, catId, cats);
              const signed = tx.amountCents < 0 ? -slice : slice;
              // a split shows only ITS matching parts here (#126); they open the parent transaction's page (#168)
              const rowParts = (tx.splits ?? []).filter((s) => s.catId !== 'reimbursed');
              // #149: every multi-part row branches, labels or not
              if (rowParts.length > 1) {
                const drillCats = new Set([catId, ...cats.childrenOf(catId).map((c) => c.id)]);
                const shown = matchingPartIndexes(tx, { catIds: drillCats });
                return shown.map((i) => (
                  <TxPartRow
                    key={rowParts[i].id ?? `${tx.id}-${i}`}
                    tx={tx}
                    part={rowParts[i]}
                    index={i}
                    amountText={fmt(
                      (tx.amountCents < 0 ? -1 : 1) * partCatShare(rowParts[i], drillCats),
                      currency,
                    )}
                    onClick={() => openTx(tx.id)}
                    showDate
                  />
                ));
              }
              const row = (
                <TxRow
                  key={tx.id}
                  tx={tx}
                  showDate
                  // a sub-category drill repeats its own name on every row
                  hideCategory={!!cat.parentId}
                  amountOverrideCents={signed}
                  onClick={() => openTx(tx.id)}
                />
              );
              const counterpart = showLinked ? selected.counterparts.get(tx.id) : undefined;
              if (!counterpart) return row;
              return (
                <div key={tx.id} className="py-1.5" data-testid={`catdrill-pair-${tx.id}`}>
                  <div className="mb-0.5 flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-wide text-accent-deep uppercase">
                    <Icon name="swap-horizontal" size={12} color="var(--m-accent-deep)" />
                    {t('tx.linkedPair')}
                  </div>
                  <div className="rounded-card bg-bg px-2">
                    {row}
                    <TxRow tx={counterpart} showDate hideCategory={!!cat.parentId} onClick={() => openTx(counterpart.id)} />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="px-1 text-[12px] text-ink-4" data-testid="catdrill-empty">
            {t('overview.noPayments')}
          </p>
        )}
      </div>
    </div>
  );
}
