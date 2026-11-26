import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import { useSpaceTransactions } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import type { RecurringRow } from '@/db/types';
import { computeRange, monthlyRecurringSeries } from '@/domain/recurring';
import { Button } from '@/ui/Button';
import { MultiLine } from '@/ui/charts/MultiLine';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { TxRow } from '@/ui/TxRow';
import { RecurringVisual } from './RecurringVisual';

export interface ChartTx {
  id: string;
  date: string;
  amountCents: number;
}

interface Dot {
  seriesIndex: number;
  pointIndex: number;
}

/** every payment that names a recurring cost, by the cost — what the year chart and its month sheet read */
export function linkedPayments(txs: readonly Pick<SpaceTx, 'id' | 'date' | 'amountCents' | 'recurringId'>[]): Map<string, ChartTx[]> {
  const map = new Map<string, ChartTx[]>();
  for (const tx of txs) {
    if (!tx.recurringId) continue;
    const list = map.get(tx.recurringId) ?? [];
    list.push({ id: tx.id, date: tx.date, amountCents: tx.amountCents });
    map.set(tx.recurringId, list);
  }
  return map;
}

const monthKeyOf = (year: number, monthIdx: number): string => `${year}-${String(monthIdx + 1).padStart(2, '0')}`;

const isEstimateMonth = (seriesIndex: number, monthIdx: number, year: number, today: string): boolean =>
  seriesIndex === 0 && monthKeyOf(year, monthIdx) > today.slice(0, 7);

// a year of recurring costs month by month — what was paid up to now, the estimate from now on — with the month a dot
// names and the door to what is behind it. The Recurring screen draws it over every cost, a Trends graph (#690) over the
// costs it picked: `recs` is that set, and `tid` keeps the test ids of two charts on one screen apart
export function RecurringYearChart({
  recs,
  linkedByRec,
  year,
  today,
  floor,
  money,
  scale,
  tid = (base) => base,
  txRoute = '/recurring/tx/$txId',
}: Readonly<{
  recs: readonly RecurringRow[];
  linkedByRec: ReadonlyMap<string, readonly ChartTx[]>;
  year: number;
  today: string;
  /** #189: the space's start — what lies before it is unknowable */
  floor?: string;
  money: (cents: number) => string;
  /** #500: the chart's scale, in the short form its gutter has room for */
  scale: (cents: number) => string;
  tid?: (base: string) => string;
  /** where a payment opens: under the Recurring tree (its list stays beside it on desktop) or as a plain transaction */
  txRoute?: '/recurring/tx/$txId' | '/transactions/$txId';
}>) {
  const { t, lang } = useLang();
  const [selected, setSelected] = useState<Dot | null>(null);
  const [sheet, setSheet] = useState<{ seriesIndex: number; monthIdx: number } | null>(null);
  const monthly = useMemo(() => monthlyRecurringSeries(recs, linkedByRec, year, today, floor), [recs, linkedByRec, year, today, floor]);
  const thisYear = Number(today.slice(0, 4));
  // the current month splits paid from estimate; a future year is estimate throughout
  const nowIndex = year === thisYear ? Number(today.slice(5, 7)) - 1 : undefined;
  // #168: the vertical marker means the SPACE'S START (months left of it are untracked); no marker outside the charted year
  const markerIndex = floor && Number(floor.slice(0, 4)) === year ? Number(floor.slice(5, 7)) - 1 : undefined;
  const labels = useMemo(
    () => Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? new Date(year, i, 1).toLocaleDateString(LOCALES[lang], { month: 'short' }) : '')),
    [year, lang],
  );
  // estimate runs from now on, paid up to now; at now the estimate BORROWS paid's value so it rises out of the paid
  // endpoint instead of shelving, and paid owns that shared point's dot (#168)
  const series = useMemo(
    () => [
      {
        values: monthly.expected.map((c, i) => {
          if (nowIndex === undefined) return c / 100;
          if (i < nowIndex) return null;
          return (i === nowIndex ? monthly.paid[i] : c) / 100;
        }),
        color: 'var(--m-ink-4)',
        dashed: true,
        skipDotAt: nowIndex,
      },
      {
        values: monthly.paid.map((c, i) => (nowIndex === undefined || i > nowIndex ? null : c / 100)),
        color: 'var(--m-accent)',
      },
    ],
    [monthly, nowIndex],
  );
  const toggle = (seriesIndex: number, pointIndex: number) =>
    setSelected((prev) => (prev?.seriesIndex === seriesIndex && prev?.pointIndex === pointIndex ? null : { seriesIndex, pointIndex }));
  const selectedSeries = selected?.seriesIndex === 0 ? monthly.expected : monthly.paid;
  const selectedCents = selected ? selectedSeries[selected.pointIndex] : null;
  const estimateSelected = !!selected && isEstimateMonth(selected.seriesIndex, selected.pointIndex, year, today);
  const active = useMemo(() => recs.filter((r) => r.active === 1), [recs]);
  // #357: a month with nothing behind the door disables it; an estimate month lists the costs expected, so any live cost keeps it open
  const paidInSelected = !!selected && active.some((r) => (linkedByRec.get(r.id) ?? []).some((l) => l.date.startsWith(monthKeyOf(year, selected.pointIndex))));
  const doorOpen = !!selected && (estimateSelected ? active.length > 0 : paidInSelected);
  return (
    <>
      <div className="mb-2 flex items-center gap-4 text-[11px] text-ink-3">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-[2px] w-[14px] rounded opacity-70"
            style={{ backgroundImage: 'repeating-linear-gradient(90deg, var(--m-ink-4) 0 4px, transparent 4px 7px)' }}
          />
          {t('recurring.chartEstimate')}
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-[2px] w-[14px] rounded" style={{ background: 'var(--m-accent)' }} />
          {t('recurring.chartActual')}
        </span>
      </div>
      <MultiLine
        series={series}
        labels={labels}
        height={120}
        testId={tid('recurring-chart')}
        markerIndex={markerIndex}
        onPointClick={toggle}
        selected={selected}
        scale={(value) => scale(Math.round(value * 100))}
      />
      {selected !== null && selectedCents !== null && (
        <div className="mt-2 flex items-center justify-between gap-2" data-testid={tid('recurring-chart-value')}>
          <span className="text-[12px] text-ink-2">
            {new Date(year, selected.pointIndex, 1).toLocaleDateString(LOCALES[lang], { month: 'long' })}
            <span className="ml-2 font-mono text-[13px] font-semibold" style={{ color: selected.seriesIndex === 0 ? 'var(--m-ink-2)' : 'var(--m-accent-deep)' }}>
              {money(selectedCents)}
            </span>
          </span>
          <Button
            size="sm"
            variant="outline"
            data-testid={tid('recurring-chart-txs')}
            onClick={() => setSheet({ seriesIndex: selected.seriesIndex, monthIdx: selected.pointIndex })}
            disabled={!doorOpen}
          >
            {t(estimateSelected ? 'recurring.showRecs' : 'recurring.showTxs')}
            <Icon name="chevron-right" size={14} color="var(--m-ink-4)" />
          </Button>
        </div>
      )}
      <MonthSheet sel={sheet} year={year} active={active} linkedByRec={linkedByRec} today={today} floor={floor} money={money} tid={tid} txRoute={txRoute} onClose={() => setSheet(null)} />
    </>
  );
}

// the tapped month's story: the payments behind a paid number, or what an estimate expects
function MonthSheet({
  sel,
  year,
  active,
  linkedByRec,
  today,
  floor,
  money,
  tid,
  txRoute,
  onClose,
}: Readonly<{
  sel: { seriesIndex: number; monthIdx: number } | null;
  year: number;
  active: readonly RecurringRow[];
  linkedByRec: ReadonlyMap<string, readonly ChartTx[]>;
  today: string;
  floor?: string;
  money: (cents: number) => string;
  tid: (base: string) => string;
  txRoute: '/recurring/tx/$txId' | '/transactions/$txId';
  onClose: () => void;
}>) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const txs = useSpaceTransactions();
  const monthIdx = sel?.monthIdx ?? 0;
  const monthKey = monthKeyOf(year, monthIdx);

  const txById = useMemo(() => new Map((txs ?? []).map((tx) => [tx.id, tx] as const)), [txs]);
  const txRows = useMemo(() => {
    if (!sel) return [];
    const rows: SpaceTx[] = [];
    for (const rec of active) {
      for (const link of linkedByRec.get(rec.id) ?? []) {
        const row = link.date.startsWith(monthKey) ? txById.get(link.id) : undefined;
        if (row) rows.push(row);
      }
    }
    return rows.sort((a, b) => a.date.localeCompare(b.date));
  }, [sel, active, linkedByRec, monthKey, txById]);

  const openRec = (recId: string) => {
    onClose();
    void navigate({ to: '/recurring/$recId', params: { recId } });
  };
  // pushed, never replaced: back returns to the list the payment was opened from
  const openTx = (txId: string) => {
    onClose();
    void navigate({ to: txRoute, params: { txId } });
  };

  const futureEstimate = sel !== null && isEstimateMonth(sel.seriesIndex, monthIdx, year, today);
  const expectedRows = useMemo(() => {
    if (!futureEstimate) return [];
    const lastDay = String(new Date(year, monthIdx + 1, 0).getDate()).padStart(2, '0');
    return computeRange(active, linkedByRec, `${monthKey}-01`, `${monthKey}-${lastDay}`, today, floor).filter((c) => c.occurrences > 0);
  }, [futureEstimate, active, linkedByRec, monthKey, year, monthIdx, today, floor]);

  return (
    <Sheet
      open={sel !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`${new Date(year, monthIdx, 1).toLocaleDateString(LOCALES[lang], { month: 'long' })} ${year}`}
      size="form"
    >
      <div data-testid={tid('recurring-period-sheet')} className="pt-1">
        {futureEstimate ? (
          expectedRows.map((c) => (
            <button
              key={c.rec.id}
              data-testid={`recurring-period-exp-${c.rec.id}`}
              onClick={() => openRec(c.rec.id)}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 py-2.5 text-left last:border-0"
            >
              <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-bg-2">
                <RecurringVisual rec={c.rec} active={false} fill />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">{c.rec.name}</span>
                <span className="block text-[11px] text-ink-4">{t('recurring.chartEstimate')}</span>
              </span>
              <span className="font-mono text-[13px] font-semibold text-ink">
                {c.occurrences > 1 ? `${c.occurrences}× ` : ''}
                {money(c.expectedCents)}
              </span>
              <Icon name="chevron-right" size={14} color="var(--m-ink-4)" />
            </button>
          ))
        ) : (
          <div className="divide-y divide-line-2">
            {txRows.map((tx) => (
              <div key={tx.id} data-testid={`recurring-period-tx-${tx.id}`} className="flex items-center">
                <div className="min-w-0 flex-1">
                  <TxRow tx={tx} showDate onClick={() => openTx(tx.id)} />
                </div>
                <Icon name="chevron-right" size={14} color="var(--m-ink-4)" />
              </div>
            ))}
          </div>
        )}
        {(futureEstimate ? expectedRows : txRows).length === 0 && (
          <p className="py-6 text-center text-[12px] text-ink-4" data-testid="recurring-period-empty">
            {t('recurring.periodNoTxs')}
          </p>
        )}
      </div>
    </Sheet>
  );
}
