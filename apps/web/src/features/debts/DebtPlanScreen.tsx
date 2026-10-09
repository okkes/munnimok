import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@/db/useQuery';
import { LOCALES, useLang } from '@/i18n';
import type { Lang } from '@/i18n';
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
  raisedPayment,
  sampleMonths,
  sampleStep,
  simulateBaseline,
  simulateDebtAlone,
  simulatePlan,
  toPlanDebts,
  yearTicks,
} from '@/domain/debtPlan';
import type { AloneResult, ChartTick, DebtOutcome, DebtStress, PayoffStrategy, PlanDebt, PlanResult, RaisedPayment } from '@/domain/debtPlan';
import type { AccountRow, RecurringEvery } from '@/db/types';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { HelpButton } from '@/features/help/HelpButton';
import { LoanTile } from './DebtsScreen';
import { PayoffChart } from './PayoffChart';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { Icon } from '@/ui/Icon';
import { Chip, HeroCard, Tile } from '@/ui/primitives';

type Translate = ReturnType<typeof useLang>['t'];
type Money = (cents: number) => string;
/** "Mar 2030" for the month `n` months from today */
type MonthName = (months: number) => string;

/** what the person tried last time, per space and device — a convenience, never the truth */
interface PlanInputs {
  strategy: PayoffStrategy;
  extraCents: number;
  lumpCents: number;
  /** the extra aimed at one debt, by its id (user 2026-10-08) */
  extraByDebt: Record<string, number>;
  /** a paid-off loan's payment keeps flowing to the next loan — the planner's premise, now a switch (user 2026-10-09) */
  rollover: boolean;
}
const DEFAULT_INPUTS: PlanInputs = { strategy: 'avalanche', extraCents: 0, lumpCents: 0, extraByDebt: {}, rollover: true };
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
      // inputs stored before the switch existed keep the premise
      rollover: parsed.rollover !== false,
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
/** a slider's step: whole fives, like the number input */
const SLIDER_STEP = 500;
/** one debt's slider runs to at least this, or twice its minimum (user 2026-10-09: "drag a bar") */
const DEBT_SLIDER_REACH = 50_000;
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
/** the loan's payment rhythm in words, for the apply confirm of a loan that does not pay monthly */
const CADENCE_COPY: Record<RecurringEvery, { one: TranslationKey; many: TranslationKey }> = {
  week: { one: 'recurring.everyWeek', many: 'recurring.everyNWeeks' },
  month: { one: 'recurring.everyMonth', many: 'recurring.everyNMonths' },
  year: { one: 'recurring.everyYear', many: 'recurring.everyNYears' },
};

const parseEuros = (text: string): number => {
  const n = Number.parseFloat(text.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
};
const eurosText = (amount: number): string => (amount ? String(Math.round(amount / 100)) : '');

/** the per-debt extras of the debts in the plan, summed — the budget line counts them */
const sumExtras = (extras: Record<string, number>, debts: readonly PlanDebt[]): number => debts.reduce((sum, d) => sum + (extras[d.id] ?? 0), 0);

/** "Mar 2030": the month `months` months after today, in the person's language */
const monthName = (lang: Lang, today: string, months: number): string =>
  new Date(`${monthAfter(today, months)}-01`).toLocaleDateString(LOCALES[lang], { month: 'short', year: 'numeric' });
/** a month tick on a short chart: "Jan ’27" */
const wordMonth = (lang: Lang, yyyymm: string): string => {
  const month = new Date(`${yyyymm}-01`).toLocaleDateString(LOCALES[lang], { month: 'short' });
  return `${month} ’${yyyymm.slice(2, 4)}`;
};

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
function chartModel(planWalk: readonly number[], planEnd: number | null, baseWalk: readonly number[], baseEnd: number | null, today: string, lang: Lang): ChartModel {
  const horizon = chartHorizon(planEnd ?? planWalk.length - 1, baseEnd ?? baseWalk.length - 1);
  const step = sampleStep(horizon);
  const ticks =
    horizon < MONTH_TICKS_BELOW
      ? monthTicks(horizon, step, today).map((tick) => ({ ...tick, label: wordMonth(lang, tick.label) }))
      : yearTicks(horizon, step, today);
  return { plan: sampleMonths(planWalk, step, horizon), base: sampleMonths(baseWalk, step, horizon), ticks };
}

/**
 * the plan against the minimums only — the months and the interest it
 * saves, or why there is no such number; the hero words the gain at
 * length, the overall card briefly
 */
function savings(t: Translate, plan: PlanResult, baseline: PlanResult, money: Money, gainKey: 'debtplan.vsMinimum' | 'debtplan.ladderGain'): string {
  const months = plan.months !== null && baseline.months !== null ? baseline.months - plan.months : null;
  const interest = baseline.totalInterestCents - plan.totalInterestCents;
  if (months === null) return t('debtplan.vsMinimumUnknown');
  if (months <= 0 && interest <= 0) return t('debtplan.vsMinimumSame');
  return t(gainKey, { months, interest: money(Math.max(0, interest)) });
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

/** one number with its small label — the planner's facts (user 2026-10-09: "I want to see actual numbers") */
function Fact({ label, value, sub, testId }: Readonly<{ label: string; value: string; sub?: string; testId?: string }>) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <div className="m-cap">{label}</div>
      <div className="m-num text-[13px] font-semibold text-ink">{value}</div>
      {sub && <div className="m-num text-[11px] text-ink-4">{sub}</div>}
    </div>
  );
}

/** the house switch at row density (the deduct switch of the match sheet) */
function Switch({ on, label, testId, onToggle }: Readonly<{ on: boolean; label: string; testId: string; onToggle: () => void }>) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-testid={testId}
      onClick={onToggle}
      className={`flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-none p-0.5 transition-colors ${on ? 'justify-end bg-accent' : 'justify-start bg-bg-2'}`}
    >
      <span className="h-4 w-4 rounded-full bg-surface shadow" />
    </button>
  );
}

const INPUT_CLASS = 'mt-1 h-12 w-full rounded-input border border-line bg-surface px-4 font-mono text-[14px] text-ink outline-none placeholder:text-ink-4';

/** when a debt walked alone ends, or why it does not */
function aloneEnd(t: Translate, r: AloneResult, date: MonthName): string {
  if (r.stuck) return t('debtplan.neverPaid');
  if (r.months === null) return t('debtplan.freeNever');
  return t('debtplan.paidOff', { date: date(r.months) });
}

/** what the extra buys this debt against its minimum alone */
function vsMinimum(t: Translate, alone: AloneResult, minimum: AloneResult, extraCents: number, money: Money, date: MonthName): string {
  if (extraCents <= 0) return t('debtplan.numbers.noExtra');
  if (alone.months === null) return t('debtplan.freeNever');
  if (minimum.months === null) return t('debtplan.ladderUnstuck', { date: date(alone.months) });
  return t('debtplan.ladderGain', { months: minimum.months - alone.months, interest: money(Math.max(0, minimum.interestCents - alone.interestCents)) });
}

interface DebtNumbersProps {
  debt: PlanDebt;
  alone: AloneResult;
  minimum: AloneResult;
  extraCents: number;
  money: Money;
  date: MonthName;
  testId: string;
}

/** one debt's facts under its chart: what it owes, pays and costs, when it ends, and what the extra buys */
function DebtNumbers({ debt, alone, minimum, extraCents, money, date, testId }: Readonly<DebtNumbersProps>) {
  const { t } = useLang();
  const perMonthSub = extraCents > 0 ? `${money(debt.minMonthlyCents)} + ${money(extraCents)}` : undefined;
  const paidOff = alone.months === null ? t('debtplan.numbers.never') : date(alone.months);
  const paidOffSub = alone.months === null ? undefined : t('debtplan.numbers.months', { months: alone.months });
  return (
    <div className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2" data-testid={testId}>
      <Fact label={t('debtplan.numbers.owed')} value={money(debt.balanceCents)} />
      <Fact label={t('debtplan.numbers.perMonth')} value={money(alone.monthlyCents)} sub={perMonthSub} />
      <Fact label={t('debtplan.numbers.rate')} value={debt.aprKnown ? `${debt.aprPct}%` : t('debtplan.numbers.noRate')} />
      <Fact label={t('debtplan.numbers.interest')} value={money(alone.interestCents)} />
      <Fact label={t('debtplan.numbers.paidOff')} value={paidOff} sub={paidOffSub} />
      <Fact label={t('debtplan.numbers.vsMin')} value={vsMinimum(t, alone, minimum, extraCents, money, date)} />
    </div>
  );
}

/** the confirm's body: the payment the loan gets, converted to its own rhythm when that is not monthly */
function applyBody(t: Translate, account: AccountRow, extraCents: number, raised: RaisedPayment, money: Money): string {
  const now = money(account.paymentCents ?? 0);
  const amount = money(raised.paymentCents);
  if (raised.perYear === 12) return t('debtplan.applyBody', { amount, now, extra: money(extraCents) });
  const keys = CADENCE_COPY[account.paymentEvery ?? 'month'];
  const n = account.paymentEveryN ?? 1;
  const cadence = n > 1 ? t(keys.many, { n }) : t(keys.one);
  return t('debtplan.applyBodyEvery', { cadence, monthly: money(extraCents), extra: money(raised.extraCents), amount, now });
}

interface DebtCardProps {
  outcome: DebtOutcome;
  account: AccountRow;
  debt: PlanDebt;
  extraCents: number;
  onExtra: (cents: number) => void;
  /** write the raised payment to the loan */
  onApply: (paymentCents: number) => void;
  today: string;
  money: Money;
  /** the tsunami weight chips, when that order is on */
  stress?: ReactNode;
}

/**
 * one debt on its own (user 2026-10-09: "it should only focus on itself
 * … when I change one, it impacts the other graphs — that should not
 * happen"): the loan walked ALONE — its minimum plus the extra aimed at
 * it, solid, against its minimum alone, dashed — so nothing another
 * card does moves this one; the combined plan (the strategy order, the
 * rollover, every extra feeding the pool) lives on the overall card
 * above. The extra is a slider, a number and chips; Apply writes the
 * raised payment to the loan itself. Both walks are memoised per card:
 * the slider re-walks one loan, nothing else.
 */
function DebtCard({ outcome, account, debt, extraCents, onExtra, onApply, today, money, stress }: Readonly<DebtCardProps>) {
  const { t, lang } = useLang();
  const [text, setText] = useState(() => eurosText(extraCents));
  const [confirming, setConfirming] = useState(false);
  const alone = useMemo(() => simulateDebtAlone(debt, extraCents), [debt, extraCents]);
  const minimum = useMemo(() => simulateDebtAlone(debt, 0), [debt]);
  const chart = useMemo(() => chartModel(alone.balances, alone.months, minimum.balances, minimum.months, today, lang), [alone, minimum, today, lang]);
  const date: MonthName = (months) => monthName(lang, today, months);
  const sliderMax = Math.max(DEBT_SLIDER_REACH, debt.minMonthlyCents * 2);
  const pick = (amount: number) => {
    setText(eurosText(amount));
    onExtra(amount);
  };
  const raised = raisedPayment(account, extraCents);
  const apply = () => {
    onApply(raised.paymentCents);
    setConfirming(false);
    // the extra IS the payment now: the card starts over from the raised minimum
    pick(0);
  };
  const rate = debt.aprKnown ? `${debt.aprPct}% ${t('debts.aprShort')}` : t('debtplan.noRate');
  const minimumLegend = minimum.months === null ? t('debtplan.minAloneNever') : t('debtplan.minAloneFree', { date: date(minimum.months) });
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
            {rate} · {aloneEnd(t, alone, date)}
          </span>
        </span>
      </div>
      <div className="mt-2">
        <PayoffChart
          testId={`debtplan-debt-chart-${outcome.id}`}
          height={90}
          ticks={chart.ticks}
          amount={money}
          series={[
            { values: chart.base, color: 'var(--m-ink-4)', dashed: true },
            { values: chart.plan, color: 'var(--m-accent)', testId: `debtplan-debt-chart-plan-${outcome.id}` },
          ]}
        />
      </div>
      <ChartLegend plan={t('debtplan.legendOwn')} base={minimumLegend} testId={`debtplan-debt-legend-${outcome.id}`} />
      <p className="mt-1 text-[11px] text-ink-4" data-testid={`debtplan-debt-alone-${outcome.id}`}>
        {t('debtplan.alone')}
      </p>
      <DebtNumbers debt={debt} alone={alone} minimum={minimum} extraCents={extraCents} money={money} date={date} testId={`debtplan-debt-numbers-${outcome.id}`} />
      <input
        data-testid={`debtplan-debt-slider-${outcome.id}`}
        type="range"
        min={0}
        max={sliderMax}
        step={SLIDER_STEP}
        value={Math.min(extraCents, sliderMax)}
        onChange={(e) => pick(Number(e.target.value))}
        aria-label={t('debtplan.slider')}
        className="mt-3 w-full accent-[var(--m-accent)]"
      />
      <label className="mt-2 block text-[12px] text-ink-3">
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
      <Button variant="outline" size="sm" className="mt-3 w-full" disabled={extraCents <= 0} data-testid={`debtplan-debt-apply-${outcome.id}`} onClick={() => setConfirming(true)}>
        {t('debtplan.apply')}
      </Button>
      {stress}
      {/* a raised payment is undone on the loan's edit sheet: no cooldown, the sheet is the pause */}
      <DangerConfirmSheet
        open={confirming}
        onOpenChange={setConfirming}
        title={t('debtplan.applyTitle', { name: account.name })}
        body={applyBody(t, account, extraCents, raised, money)}
        confirmLabel={t('debtplan.applyConfirm')}
        onConfirm={apply}
        testId={`debtplan-apply-${outcome.id}`}
        cooldown={0}
      />
    </div>
  );
}

interface PayoffOrderProps {
  plan: PlanResult;
  debts: readonly PlanDebt[];
  statuses: readonly LoanStatus[];
  strategy: PayoffStrategy;
  extraByDebt: Record<string, number>;
  onExtra: (id: string, cents: number) => void;
  onApply: (id: string, paymentCents: number) => void;
  onStress: (id: string, level: DebtStress) => void;
  today: string;
  money: Money;
}

/** the payoff order, debt by debt, each on its own card */
function PayoffOrder({ plan, debts, statuses, strategy, extraByDebt, onExtra, onApply, onStress, today, money }: Readonly<PayoffOrderProps>) {
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
          return (
            <DebtCard
              key={outcome.id}
              outcome={outcome}
              account={status.account}
              debt={debt}
              extraCents={extraByDebt[outcome.id] ?? 0}
              onExtra={(amount) => onExtra(outcome.id, amount)}
              onApply={(paymentCents) => onApply(outcome.id, paymentCents)}
              today={today}
              money={money}
              stress={strategy === 'tsunami' ? stressChips(status.account) : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

interface OverallCardProps {
  chart: ChartModel;
  plan: PlanResult;
  baseline: PlanResult;
  /** minimums and every extra, per month */
  budget: number;
  rollover: boolean;
  onRollover: () => void;
  money: Money;
  date: MonthName;
}

/**
 * all debts together (user 2026-10-08: one overall chart): the combined
 * plan against the minimums only, its numbers side by side, and the
 * rollover switch (user 2026-10-09: "I haven't made any change and yet
 * somehow it differs from minimums") with the line that says why
 */
function OverallCard({ chart, plan, baseline, budget, rollover, onRollover, money, date }: Readonly<OverallCardProps>) {
  const { t } = useLang();
  const free = (r: PlanResult) => (r.months === null ? t('debtplan.numbers.never') : date(r.months));
  const baseLegend = baseline.months === null ? t('debtplan.baselineNever') : t('debtplan.baselineFree', { date: date(baseline.months) });
  return (
    <div className="mt-3 rounded-card border border-line bg-surface p-4" data-testid="debtplan-overall">
      <div className="m-cap">{t('debtplan.overall')}</div>
      <div className="mt-2">
        <PayoffChart
          testId="debtplan-chart"
          height={150}
          ticks={chart.ticks}
          amount={money}
          series={[
            { values: chart.base, color: 'var(--m-ink-4)', dashed: true, testId: 'debtplan-chart-baseline' },
            { values: chart.plan, color: 'var(--m-accent)', testId: 'debtplan-chart-plan' },
          ]}
        />
      </div>
      <ChartLegend plan={t('debtplan.chartPlan')} base={baseLegend} testId="debtplan-chart-legend" />
      <div className="mt-3 border-t border-line-2 pt-3" data-testid="debtplan-overall-numbers">
        <div className="flex items-baseline justify-between">
          <span className="m-cap">{t('debtplan.numbers.owed')}</span>
          <span className="m-num text-[13px] font-semibold text-ink">{money(plan.balances[0] ?? 0)}</span>
        </div>
        <div className="mt-2 grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1 text-[12px]">
          <span />
          <span className="m-cap text-right">{t('debtplan.chartPlan')}</span>
          <span className="m-cap text-right">{t('debtplan.numbers.minOnly')}</span>
          <span className="text-ink-3">{t('debtplan.numbers.perMonth')}</span>
          <span className="m-num text-right font-semibold text-ink">{money(budget)}</span>
          <span className="m-num text-right text-ink-3">{money(plan.minimumsCents)}</span>
          <span className="text-ink-3">{t('debtplan.numbers.debtFree')}</span>
          <span className="m-num text-right font-semibold text-ink" data-testid="debtplan-overall-free">
            {free(plan)}
          </span>
          <span className="m-num text-right text-ink-3">{free(baseline)}</span>
          <span className="text-ink-3">{t('debtplan.numbers.interest')}</span>
          <span className="m-num text-right font-semibold text-ink">{money(plan.totalInterestCents)}</span>
          <span className="m-num text-right text-ink-3">{money(baseline.totalInterestCents)}</span>
        </div>
        <p className="mt-2 text-[12px] text-ink-3" data-testid="debtplan-overall-saved">
          {savings(t, plan, baseline, money, 'debtplan.ladderGain')}
        </p>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-line-2 pt-3">
        <span className="text-[12px] text-ink-2">{t('debtplan.rollover')}</span>
        <Switch on={rollover} label={t('debtplan.rollover')} testId="debtplan-rollover" onToggle={onRollover} />
      </div>
      <p className="mt-2 text-[11px] text-ink-4" data-testid="debtplan-rollover-hint">
        {rollover ? t('debtplan.rolloverHint', { amount: money(budget) }) : t('debtplan.rolloverOff')}
      </p>
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
  const money: Money = (amount) => fmt(amount, currency);
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
  const options = useMemo(
    () => ({ extraMonthlyCents: inputs.extraCents, lumpSumCents: inputs.lumpCents, extraByDebtCents: inputs.extraByDebt, rollover: inputs.rollover }),
    [inputs.extraCents, inputs.lumpCents, inputs.extraByDebt, inputs.rollover],
  );
  const plan = useMemo(() => simulatePlan(debts, { ...options, strategy: inputs.strategy }), [debts, options, inputs.strategy]);
  const baseline = useMemo(() => simulateBaseline(debts), [debts]);
  const compared = useMemo(() => compareStrategies(debts, options), [debts, options]);
  const ladder = useMemo(() => extraLadder(debts, { ...options, strategy: inputs.strategy }, LADDER), [debts, options, inputs.strategy]);

  const date: MonthName = (months) => monthName(lang, today, months);
  const freeLabel = (r: PlanResult) => (r.months === null ? t('debtplan.freeNever') : t('debtplan.freeIn', { date: date(r.months) }));
  /** what one ladder step buys against the plan as it stands */
  const ladderGain = (earlier: number | null, less: number, months: number | null): string => {
    if (earlier === null) return months === null ? t('debtplan.ladderNone') : t('debtplan.ladderUnstuck', { date: date(months) });
    if (earlier <= 0 && less <= 0) return t('debtplan.ladderNone');
    return t('debtplan.ladderGain', { months: earlier, interest: money(Math.max(0, less)) });
  };
  const sliderMax = Math.max(100_000, plan.minimumsCents * 2);
  const budget = plan.minimumsCents + inputs.extraCents + sumExtras(inputs.extraByDebt, debts);
  const overall = chartModel(plan.balances, plan.months, baseline.balances, baseline.months, today, lang);

  const accountOf = (debtId: string) => statuses?.find((s) => s.account.id === debtId)?.account;
  const setStress = (debtId: string, value: DebtStress) => {
    const account = accountOf(debtId);
    if (!account) return;
    void repo.upsert('account', account.spaceId, account.id, { debtStress: account.debtStress === value ? undefined : value });
    void logActivity(store, repo, account.spaceId, 'accountEdit', account.name);
  };
  /** Apply on a card: the raised payment becomes the loan's own (user 2026-10-09) */
  const applyPayment = (debtId: string, paymentCents: number) => {
    const account = accountOf(debtId);
    if (!account) return;
    void repo.upsert('account', account.spaceId, account.id, { paymentCents });
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
                  {savings(t, plan, baseline, money, 'debtplan.vsMinimum')}
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
                      {compared[s].months === null ? t('debtplan.freeNever') : t('debtplan.compareFree', { date: date(compared[s].months as number) })}
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
                step={SLIDER_STEP}
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

            <OverallCard
              chart={overall}
              plan={plan}
              baseline={baseline}
              budget={budget}
              rollover={inputs.rollover}
              onRollover={() => update({ rollover: !inputs.rollover })}
              money={money}
              date={date}
            />

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
              debts={debts}
              statuses={statuses ?? []}
              strategy={inputs.strategy}
              extraByDebt={inputs.extraByDebt}
              onExtra={setDebtExtra}
              onApply={applyPayment}
              onStress={setStress}
              today={today}
              money={money}
            />
          </>
        )}
      </div>
    </div>
  );
}
