import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@/db/useQuery';
import { LOCALES, useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n/en';
import { useData } from '@/app/data';
import { useLoanStatuses } from '@/application/debts';
import type { LoanStatus } from '@/application/debts';
import { localToday } from '@/application/recurring';
import { logActivity } from '@/application/activity';
import {
  MONTH_TICKS_BELOW,
  STRATEGIES,
  STRESS_LEVELS,
  chartHorizon,
  compareStrategies,
  extraLadder,
  monthAfter,
  monthTicks,
  sampleMonths,
  sampleStep,
  simulateBaseline,
  simulatePlan,
  toPlanDebts,
  yearTicks,
} from '@/domain/debtPlan';
import type { ChartTick, DebtOutcome, DebtStress, PayoffStrategy, PlanDebt, PlanResult } from '@/domain/debtPlan';
import type { AccountRow } from '@/db/types';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { HelpButton } from '@/features/help/HelpButton';
import { LoanTile } from './DebtsScreen';
import { PayoffChart } from './PayoffChart';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { Chip, HeroCard, Tile } from '@/ui/primitives';

/** what the person tried last time, per space and device — a convenience, never the truth */
interface PlanInputs {
  strategy: PayoffStrategy;
  extraCents: number;
  lumpCents: number;
  /** the extra aimed at one debt, by its id (user 2026-10-08) */
  extraByDebt: Record<string, number>;
}
const DEFAULT_INPUTS: PlanInputs = { strategy: 'avalanche', extraCents: 0, lumpCents: 0, extraByDebt: {} };
const inputsKey = (spaceId: string) => `munni_debtplan_${spaceId}`;
const cents = (raw: unknown): number => (typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0);
/** the stored per-debt extras, each a finite amount of cents or dropped */
function readExtraByDebt(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const amount = cents(value);
    if (amount > 0) out[id] = amount;
  }
  return out;
}
function readInputs(spaceId: string): PlanInputs {
  try {
    const raw = localStorage.getItem(inputsKey(spaceId));
    if (!raw) return DEFAULT_INPUTS;
    const parsed = JSON.parse(raw) as Partial<PlanInputs>;
    return {
      strategy: STRATEGIES.includes(parsed.strategy as PayoffStrategy) ? (parsed.strategy as PayoffStrategy) : 'avalanche',
      extraCents: cents(parsed.extraCents),
      lumpCents: cents(parsed.lumpCents),
      extraByDebt: readExtraByDebt(parsed.extraByDebt),
    };
  } catch {
    return DEFAULT_INPUTS;
  }
}
function writeInputs(spaceId: string, inputs: PlanInputs) {
  try {
    localStorage.setItem(inputsKey(spaceId), JSON.stringify(inputs));
  } catch {
    // storage blocked: the inputs live for this visit only
  }
}

/** the quick extras under the slider, in cents */
const EXTRA_CHIPS = [2_500, 5_000, 10_000, 25_000];
/** the quick extras on one debt's card */
const DEBT_EXTRA_CHIPS = [2_500, 5_000, 10_000];
/** the ladder: a little more than now */
const LADDER = [2_500, 5_000, 10_000, 25_000];
const STRATEGY_COPY: Record<PayoffStrategy, { name: TranslationKey; sub: TranslationKey }> = {
  avalanche: { name: 'debtplan.avalanche', sub: 'debtplan.avalancheSub' },
  snowball: { name: 'debtplan.snowball', sub: 'debtplan.snowballSub' },
  tsunami: { name: 'debtplan.tsunami', sub: 'debtplan.tsunamiSub' },
};
const STRESS_COPY: Record<DebtStress, TranslationKey> = {
  1: 'debtplan.stress1',
  2: 'debtplan.stress2',
  3: 'debtplan.stress3',
  4: 'debtplan.stress4',
  5: 'debtplan.stress5',
};

const parseEuros = (text: string): number => {
  const n = Number.parseFloat(text.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
};
const eurosText = (amount: number): string => (amount ? String(Math.round(amount / 100)) : '');

/** the per-debt extras of the debts in the plan, summed — the budget line counts them */
const sumExtras = (extras: Record<string, number>, debts: readonly PlanDebt[]): number => debts.reduce((sum, d) => sum + (extras[d.id] ?? 0), 0);

/** the two walks of one chart on the same grid, with its labels */
interface ChartModel {
  plan: number[];
  base: number[];
  ticks: ChartTick[];
}

/**
 * one chart's grid: the horizon follows the plan's walk (chartHorizon —
 * never the thirty-year minimums-only walk), both walks are sampled onto
 * it, and the labels are years, or months when the horizon is short
 */
function chartModel(
  planWalk: readonly number[],
  planEnd: number | null,
  baseWalk: readonly number[],
  baseEnd: number | null,
  today: string,
  wordMonth: (yyyymm: string) => string,
): ChartModel {
  const horizon = chartHorizon(planEnd ?? planWalk.length - 1, baseEnd ?? baseWalk.length - 1);
  const step = sampleStep(horizon);
  const ticks =
    horizon < MONTH_TICKS_BELOW
      ? monthTicks(horizon, step, today).map((tick) => ({ ...tick, label: wordMonth(tick.label) }))
      : yearTicks(horizon, step, today);
  return { plan: sampleMonths(planWalk, step, horizon), base: sampleMonths(baseWalk, step, horizon), ticks };
}

/** the two lines named: solid is the plan, dashed the minimums alone */
function ChartLegend({ plan, base, testId }: Readonly<{ plan: string; base: string; testId?: string }>) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3" data-testid={testId}>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-4 rounded bg-accent" />
        {plan}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block w-4 border-t border-dashed border-ink-4" />
        {base}
      </span>
    </div>
  );
}

const INPUT_CLASS = 'mt-1 h-12 w-full rounded-input border border-line bg-surface px-4 font-mono text-[14px] text-ink outline-none placeholder:text-ink-4';

interface DebtCardProps {
  outcome: DebtOutcome;
  account: AccountRow;
  debt: PlanDebt;
  chart: ChartModel;
  /** "12% interest · paid off Dec 2026" */
  sub: string;
  legendPlan: string;
  legendBase: string;
  extraCents: number;
  onExtra: (cents: number) => void;
  money: (cents: number) => string;
  /** the tsunami weight chips, when that order is on */
  stress?: ReactNode;
}

/**
 * one debt on its own (user 2026-10-08: "one graph for each debt … if I
 * finetune the payment of a specific debt I want to see the impact"): its
 * walk under the plan against its minimum alone, when it ends and what it
 * costs, and the extra aimed at it — the chart and the total card above
 * both read the same simulation, so a change here moves both
 */
function DebtCard({ outcome, account, debt, chart, sub, legendPlan, legendBase, extraCents, onExtra, money, stress }: Readonly<DebtCardProps>) {
  const { t } = useLang();
  const [text, setText] = useState(() => eurosText(extraCents));
  const pick = (amount: number) => {
    setText(eurosText(amount));
    onExtra(amount);
  };
  return (
    <div className="rounded-card border border-line bg-surface p-3" data-testid={`debtplan-order-${outcome.id}`}>
      <div className="flex items-center gap-3">
        <span className="m-num w-5 shrink-0 text-center text-[12px] font-semibold text-ink-4">{outcome.order}</span>
        <LoanTile account={account} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[14px] font-semibold text-ink">{account.name}</span>
            <span className="m-num shrink-0 text-[13px] text-ink">{money(debt.balanceCents)}</span>
          </span>
          <span className="block text-[11px] text-ink-4" data-testid={`debtplan-debt-end-${outcome.id}`}>
            {sub}
          </span>
        </span>
      </div>
      <div className="mt-2">
        <PayoffChart
          testId={`debtplan-debt-chart-${outcome.id}`}
          height={90}
          ticks={chart.ticks}
          series={[
            { values: chart.base, color: 'var(--m-ink-4)', dashed: true },
            { values: chart.plan, color: 'var(--m-accent)' },
          ]}
        />
      </div>
      <ChartLegend plan={legendPlan} base={legendBase} testId={`debtplan-debt-legend-${outcome.id}`} />
      <label className="mt-3 block text-[12px] text-ink-3">
        {t('debtplan.extraFor')}
        <input
          data-testid={`debtplan-debt-extra-${outcome.id}`}
          type="number"
          inputMode="decimal"
          min="0"
          step="5"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onExtra(parseEuros(e.target.value));
          }}
          placeholder="0"
          className={INPUT_CLASS}
        />
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        {DEBT_EXTRA_CHIPS.map((amount) => (
          <Chip key={amount} selected={extraCents === amount} onClick={() => pick(amount)} testId={`debtplan-debt-extra-chip-${outcome.id}-${amount}`}>
            +{money(amount)}
          </Chip>
        ))}
      </div>
      {stress}
    </div>
  );
}

interface PayoffOrderProps {
  plan: PlanResult;
  baseline: PlanResult;
  debts: readonly PlanDebt[];
  statuses: readonly LoanStatus[];
  strategy: PayoffStrategy;
  extraByDebt: Record<string, number>;
  onExtra: (id: string, cents: number) => void;
  onStress: (id: string, level: DebtStress) => void;
  today: string;
  wordMonth: (yyyymm: string) => string;
  endLabel: (outcome: DebtOutcome) => string;
  baseLegend: (months: number | null) => string;
  money: (cents: number) => string;
}

/** the payoff order, debt by debt, each on its own card */
function PayoffOrder({ plan, baseline, debts, statuses, strategy, extraByDebt, onExtra, onStress, today, wordMonth, endLabel, baseLegend, money }: Readonly<PayoffOrderProps>) {
  const { t } = useLang();
  const stressChips = (account: AccountRow) => (
    <div className="mt-3 flex items-center gap-1.5">
      <span className="mr-1 text-[11px] text-ink-4">{t('debtplan.stress')}</span>
      {STRESS_LEVELS.map((level) => (
        <Chip
          key={level}
          selected={account.debtStress === level}
          onClick={() => onStress(account.id, level)}
          testId={`debtplan-stress-${account.id}-${level}`}
          className="px-2.5"
        >
          {level === 1 || level === 5 ? t(STRESS_COPY[level]) : String(level)}
        </Chip>
      ))}
    </div>
  );
  return (
    <div className="mt-3" data-testid="debtplan-order">
      <div className="m-cap mb-1">{t('debtplan.order')}</div>
      <p className="mb-2 text-[12px] text-ink-3">{strategy === 'tsunami' ? t('debtplan.stressHint') : t('debtplan.orderHint')}</p>
      <div className="flex flex-col gap-2">
        {plan.debts.map((outcome) => {
          const status = statuses.find((s) => s.account.id === outcome.id);
          const debt = debts.find((d) => d.id === outcome.id);
          if (!status || !debt) return null;
          const baseOutcome = baseline.debts.find((d) => d.id === outcome.id);
          const rate = debt.aprKnown ? `${debt.aprPct}% ${t('debts.aprShort')}` : t('debtplan.noRate');
          return (
            <DebtCard
              key={outcome.id}
              outcome={outcome}
              account={status.account}
              debt={debt}
              chart={chartModel(
                plan.balancesByDebt[outcome.id] ?? [],
                outcome.paidOffMonth,
                baseline.balancesByDebt[outcome.id] ?? [],
                baseOutcome?.paidOffMonth ?? null,
                today,
                wordMonth,
              )}
              sub={`${rate} · ${endLabel(outcome)}`}
              legendPlan={t('debtplan.planInterest', { amount: money(outcome.interestCents) })}
              legendBase={baseLegend(baseOutcome?.paidOffMonth ?? null)}
              extraCents={extraByDebt[outcome.id] ?? 0}
              onExtra={(amount) => onExtra(outcome.id, amount)}
              money={money}
              stress={strategy === 'tsunami' ? stressChips(status.account) : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

/** The payoff planner (#413): which order, how much extra, and what that buys — all from the loans as they stand. */
export function DebtPlanScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store, repo, spaceId } = useData();
  const statuses = useLoanStatuses();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const currency = space?.currency ?? 'EUR';
  const { fmt } = useDisplayMoney();
  const money = (amount: number) => fmt(amount, currency);
  const today = localToday();
  const [inputs, setInputs] = useState<PlanInputs>(() => readInputs(spaceId));
  const [extraText, setExtraText] = useState(() => eurosText(inputs.extraCents));
  const [lumpText, setLumpText] = useState(() => eurosText(inputs.lumpCents));
  const update = (patch: Partial<PlanInputs>) => {
    setInputs((prev) => {
      const next = { ...prev, ...patch };
      writeInputs(spaceId, next);
      return next;
    });
  };
  const setExtra = (amount: number) => {
    update({ extraCents: amount });
    setExtraText(eurosText(amount));
  };
  /** the extra aimed at one debt; nothing stays stored for a cleared one */
  const setDebtExtra = (id: string, amount: number) => {
    setInputs((prev) => {
      const kept = Object.entries(prev.extraByDebt).filter(([debtId]) => debtId !== id);
      const extraByDebt = Object.fromEntries(amount > 0 ? [...kept, [id, amount]] : kept);
      const next = { ...prev, extraByDebt };
      writeInputs(spaceId, next);
      return next;
    });
  };

  const debts: PlanDebt[] = useMemo(() => toPlanDebts(statuses ?? []), [statuses]);
  const plan = useMemo(
    () =>
      simulatePlan(debts, {
        strategy: inputs.strategy,
        extraMonthlyCents: inputs.extraCents,
        lumpSumCents: inputs.lumpCents,
        extraByDebtCents: inputs.extraByDebt,
      }),
    [debts, inputs],
  );
  const baseline = useMemo(() => simulateBaseline(debts), [debts]);
  const compared = useMemo(
    () => compareStrategies(debts, { extraMonthlyCents: inputs.extraCents, lumpSumCents: inputs.lumpCents, extraByDebtCents: inputs.extraByDebt }),
    [debts, inputs.extraCents, inputs.lumpCents, inputs.extraByDebt],
  );
  const ladder = useMemo(
    () =>
      extraLadder(
        debts,
        { strategy: inputs.strategy, extraMonthlyCents: inputs.extraCents, lumpSumCents: inputs.lumpCents, extraByDebtCents: inputs.extraByDebt },
        LADDER,
      ),
    [debts, inputs],
  );

  const fmtMonth = (months: number) =>
    new Date(`${monthAfter(today, months)}-01`).toLocaleDateString(LOCALES[lang], { month: 'short', year: 'numeric' });
  /** a month tick on a short chart: "Jan ’27" */
  const wordMonth = (yyyymm: string) => {
    const month = new Date(`${yyyymm}-01`).toLocaleDateString(LOCALES[lang], { month: 'short' });
    return `${month} ’${yyyymm.slice(2, 4)}`;
  };
  const freeLabel = (r: PlanResult) => (r.months === null ? t('debtplan.freeNever') : t('debtplan.freeIn', { date: fmtMonth(r.months) }));
  /** where the dashed line really ends — it is drawn to the chart's edge, which may be sooner */
  const baseLegend = (months: number | null) => (months === null ? t('debtplan.baselineNever') : t('debtplan.baselineFree', { date: fmtMonth(months) }));

  const monthsSaved = plan.months !== null && baseline.months !== null ? baseline.months - plan.months : null;
  const interestSaved = baseline.totalInterestCents - plan.totalInterestCents;
  let vsText: string;
  if (monthsSaved === null) vsText = t('debtplan.vsMinimumUnknown');
  else if (monthsSaved <= 0 && interestSaved <= 0) vsText = t('debtplan.vsMinimumSame');
  else vsText = t('debtplan.vsMinimum', { months: monthsSaved, interest: money(Math.max(0, interestSaved)) });
  /** what one ladder step buys against the plan as it stands */
  const ladderGain = (earlier: number | null, less: number, months: number | null): string => {
    if (earlier === null) return months === null ? t('debtplan.ladderNone') : t('debtplan.ladderUnstuck', { date: fmtMonth(months) });
    if (earlier <= 0 && less <= 0) return t('debtplan.ladderNone');
    return t('debtplan.ladderGain', { months: earlier, interest: money(Math.max(0, less)) });
  };
  /** when a debt ends in this plan, or why it does not */
  const endLabel = (outcome: DebtOutcome): string => {
    if (outcome.stuck) return t('debtplan.neverPaid');
    if (outcome.paidOffMonth === null) return t('debtplan.freeNever');
    return t('debtplan.paidOff', { date: fmtMonth(outcome.paidOffMonth) });
  };
  const sliderMax = Math.max(100_000, plan.minimumsCents * 2);
  const budget = plan.minimumsCents + inputs.extraCents + sumExtras(inputs.extraByDebt, debts);
  const overall = chartModel(plan.balances, plan.months, baseline.balances, baseline.months, today, wordMonth);

  const setStress = (debtId: string, value: DebtStress) => {
    const account = statuses?.find((s) => s.account.id === debtId)?.account;
    if (!account) return;
    void repo.upsert('account', account.spaceId, account.id, { debtStress: account.debtStress === value ? undefined : value });
    void logActivity(store, repo, account.spaceId, 'accountEdit', account.name);
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-debtplan">
      <AppBar
        title={t('debtplan.title')}
        leading={
          <IconButton label={t('action.back')} testId="debtplan-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
        trailing={<HelpButton tourId="debts" />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {statuses && debts.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center" data-testid="debtplan-empty">
            <Icon name="hand-coin-outline" size={34} color="var(--m-ink-4)" />
            <p className="text-[13px] text-ink-3">{t('debtplan.empty')}</p>
            <button className="m-tap text-[13px] font-semibold text-accent-deep" onClick={() => void navigate({ to: '/debts' })}>
              {t('debts.title')}
            </button>
          </div>
        )}
        {debts.length > 0 && (
          <>
            <HeroCard
              testId="debtplan-hero"
              tile={<Tile icon="chart-timeline-variant" tone="accent" size={48} />}
              number={<span data-testid="debtplan-free">{freeLabel(plan)}</span>}
              sub={
                plan.months === null
                  ? t('debtplan.stuckHint')
                  : t('debtplan.monthsInterest', { months: plan.months, interest: money(plan.totalInterestCents) })
              }
              meta={
                <span className="text-[12px] text-ink-3" data-testid="debtplan-vs">
                  {vsText}
                </span>
              }
            />

            {/* the order */}
            <div className="mt-3 rounded-card border border-line bg-surface p-4" data-testid="debtplan-strategies">
              <div className="m-cap">{t('debtplan.strategy')}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {STRATEGIES.map((s) => (
                  <Chip key={s} selected={inputs.strategy === s} onClick={() => update({ strategy: s })} testId={`debtplan-strategy-${s}`}>
                    {t(STRATEGY_COPY[s].name)}
                  </Chip>
                ))}
              </div>
              <p className="mt-2 text-[12px] text-ink-3">{t(STRATEGY_COPY[inputs.strategy].sub)}</p>
              <div className="mt-3 divide-y divide-line-2 border-t border-line-2 pt-1" data-testid="debtplan-compare">
                {STRATEGIES.map((s) => (
                  <div key={s} className="flex items-baseline justify-between gap-2 py-1.5 text-[12px]" data-testid={`debtplan-compare-${s}`}>
                    <span className={inputs.strategy === s ? 'font-semibold text-ink' : 'text-ink-2'}>{t(STRATEGY_COPY[s].name)}</span>
                    <span className="m-num text-ink-3">
                      {compared[s].months === null ? t('debtplan.freeNever') : t('debtplan.compareFree', { date: fmtMonth(compared[s].months as number) })}
                      {' · '}
                      {money(compared[s].totalInterestCents)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* the extra */}
            <div className="mt-3 rounded-card border border-line bg-surface p-4" data-testid="debtplan-extra-card">
              <div className="flex items-end gap-3">
                <label className="min-w-0 flex-1 text-[12px] text-ink-3">
                  {t('debtplan.extra')}
                  <input
                    data-testid="debtplan-extra"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="5"
                    value={extraText}
                    onChange={(e) => {
                      setExtraText(e.target.value);
                      update({ extraCents: parseEuros(e.target.value) });
                    }}
                    placeholder="0"
                    className={INPUT_CLASS}
                  />
                </label>
                <label className="min-w-0 flex-1 text-[12px] text-ink-3">
                  {t('debtplan.lump')}
                  <input
                    data-testid="debtplan-lump"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="50"
                    value={lumpText}
                    onChange={(e) => {
                      setLumpText(e.target.value);
                      update({ lumpCents: parseEuros(e.target.value) });
                    }}
                    placeholder="0"
                    className={INPUT_CLASS}
                  />
                </label>
              </div>
              <input
                data-testid="debtplan-extra-slider"
                type="range"
                min={0}
                max={sliderMax}
                step={500}
                value={Math.min(inputs.extraCents, sliderMax)}
                onChange={(e) => setExtra(Number(e.target.value))}
                aria-label={t('debtplan.extra')}
                className="mt-3 w-full accent-[var(--m-accent)]"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {EXTRA_CHIPS.map((amount) => (
                  <Chip key={amount} selected={inputs.extraCents === amount} onClick={() => setExtra(amount)} testId={`debtplan-extra-chip-${amount}`}>
                    +{money(amount)}
                  </Chip>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-ink-4" data-testid="debtplan-budget">
                {t('debtplan.minimums', { amount: money(plan.minimumsCents) })} · {t('debtplan.budget', { amount: money(budget) })}
              </p>
            </div>

            {/* all debts together (user 2026-10-08: one overall chart, one per debt below) */}
            <div className="mt-3 rounded-card border border-line bg-surface p-4" data-testid="debtplan-overall">
              <div className="m-cap">{t('debtplan.overall')}</div>
              <div className="mt-2">
                <PayoffChart
                  testId="debtplan-chart"
                  height={150}
                  ticks={overall.ticks}
                  series={[
                    { values: overall.base, color: 'var(--m-ink-4)', dashed: true, testId: 'debtplan-chart-baseline' },
                    { values: overall.plan, color: 'var(--m-accent)', testId: 'debtplan-chart-plan' },
                  ]}
                />
              </div>
              <ChartLegend plan={t('debtplan.chartPlan')} base={baseLegend(baseline.months)} testId="debtplan-chart-legend" />
            </div>

            {/* what more buys */}
            <div className="mt-3 rounded-card border border-line bg-surface p-4" data-testid="debtplan-ladder">
              <div className="m-cap">{t('debtplan.ladder')}</div>
              <div className="mt-1 divide-y divide-line-2">
                {ladder.map((row) => {
                  const earlier = plan.months !== null && row.months !== null ? plan.months - row.months : null;
                  const less = plan.totalInterestCents - row.totalInterestCents;
                  const gain = ladderGain(earlier, less, row.months);
                  return (
                    <button
                      key={row.moreCents}
                      data-testid={`debtplan-ladder-${row.moreCents}`}
                      onClick={() => setExtra(inputs.extraCents + row.moreCents)}
                      className="m-tap flex w-full items-baseline justify-between gap-3 bg-transparent py-2 text-left"
                    >
                      <span className="m-num text-[13px] font-semibold text-ink">{t('debtplan.ladderRow', { amount: money(row.moreCents) })}</span>
                      <span className="text-right text-[12px] text-ink-3">{gain}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <PayoffOrder
              plan={plan}
              baseline={baseline}
              debts={debts}
              statuses={statuses ?? []}
              strategy={inputs.strategy}
              extraByDebt={inputs.extraByDebt}
              onExtra={setDebtExtra}
              onStress={setStress}
              today={today}
              wordMonth={wordMonth}
              endLabel={endLabel}
              baseLegend={baseLegend}
              money={money}
            />
          </>
        )}
      </div>
    </div>
  );
}
