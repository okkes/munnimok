import type { AccountRow, BudgetRow, RecurringRow } from '@/db/types';
import { budgetFamily, budgetOptsFor, budgetPeriodAt, budgetSpentCents, cycleIndex } from './budgets';
import { simulateDebtAlone, toPlanDebts } from './debtPlan';
import { loanRemainingCents, monthlyPaymentCents } from './debts';
import { billChanged, duplicateCharge, isFundingRec, missedCharge, salaryLate } from './insightCharges';
import type { Insight, InsightInputs, InsightKind, InsightSeverity } from './insightModel';
import { PERIODS_PER_YEAR, inCurrency, mainOf, spentCents } from './insightModel';
import { categoryDrift, expensiveWeekday, noSpendDays, spendingPace } from './insightSpending';
import { cycleMonths } from './recurring';
import { detectPriceChange } from './recurringPrice';
import { merchantKey } from './merchantKey';
import { txTitle } from '@/lib/text';

export type { Insight, InsightInputs, InsightKind, InsightParam, InsightSeverity, InsightTopic } from './insightModel';

/**
 * Insights engine (approved insights design N1, #516) — pure detectors
 * over local data. Quality bar: computable from what we have, a concrete
 * number, one obvious action. A detector below its threshold stays
 * silent; ids encode the subject so a dismissed insight only resurfaces
 * when the situation actually changes. Findings of one kind give the same
 * advice, so they share one card (groupInsights).
 */

// ── leaks ───────────────────────────────────────────────────────────────

/** a subscription that SUSTAINABLY charges more than it used to (min €0.50/mo); fixed costs answer to billChanged */
export function priceCreep(inputs: InsightInputs): Insight[] {
  const out: Insight[] = [];
  for (const rec of inputs.recurrings) {
    if (rec.deleted !== 0 || rec.active !== 1 || rec.kind !== 'subscription' || isFundingRec(rec, inputs.catalog)) continue;
    const charges = inputs.txs
      .filter((tx) => tx.deleted === 0 && tx.recurringId === rec.id && tx.amountCents < 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    // two consecutive charges at the new amount — one-off prorations stay silent
    const change = detectPriceChange(charges);
    if (!change || change.toCents <= change.fromCents) continue;
    const deltaMonthly = Math.round((change.toCents - change.fromCents) / cycleMonths(rec));
    if (deltaMonthly < 50) continue;
    const currency = charges.at(-1)?.currency;
    const money = (cents: number) => ({ money: cents, ...(currency ? { currency } : {}) });
    out.push({
      id: `creep:${rec.id}:${change.toCents}`,
      kind: 'creep',
      topic: 'subscriptions',
      severity: 'leak',
      impactCents: deltaMonthly * 12,
      icon: 'trending-up',
      titleKey: 'ins.creep.title',
      detailKey: 'ins.creep.detail',
      lineKey: 'ins.creep.line',
      params: { name: rec.name, from: money(change.fromCents), to: money(change.toCents), year: money(deltaMonthly * 12) },
      about: rec.name,
      chart: charges.slice(-8).map((tx) => -tx.amountCents),
      actionTo: `/recurring/${rec.id}`,
    });
  }
  return out;
}

/** two or more active subscriptions filed under the same category (two streaming services, two gyms) */
export function subscriptionOverlap(inputs: InsightInputs): Insight[] {
  const groups = new Map<string, RecurringRow[]>();
  for (const rec of inputs.recurrings) {
    if (rec.deleted !== 0 || rec.active !== 1 || rec.kind !== 'subscription' || isFundingRec(rec, inputs.catalog)) continue;
    // the category as filed: a main holds services that do different jobs (internet and energy are both Housing)
    if (!rec.catId || mainOf(rec.catId, inputs.catalog) === 'general') continue;
    const list = groups.get(rec.catId) ?? [];
    list.push(rec);
    groups.set(rec.catId, list);
  }
  const out: Insight[] = [];
  for (const [catId, group] of groups) {
    if (group.length < 2) continue;
    const monthly = group.reduce((sum, rec) => sum + Math.round(rec.amountCents / cycleMonths(rec)), 0);
    out.push({
      id: `overlap:${catId}:${group.length}`,
      kind: 'overlap',
      topic: 'subscriptions',
      severity: 'leak',
      impactCents: monthly * 12,
      icon: 'content-copy',
      titleKey: 'ins.overlap.title',
      detailKey: 'ins.overlap.detail',
      lineKey: 'ins.overlap.line',
      params: { n: group.length, cat: { cat: catId }, names: group.map((r) => r.name).join(' + '), month: { money: monthly }, year: { money: monthly * 12 } },
      about: { cat: catId },
      actionTo: '/recurring',
    });
  }
  return out;
}

/** a repeated small purchase at the same merchant (≥8× in the period) */
export function smallHabit(inputs: InsightInputs): Insight[] {
  const period = inputs.periods.at(-1);
  if (!period) return [];
  const groups = new Map<string, { name: string; count: number; totalCents: number }>();
  for (const tx of inputs.txs) {
    if (tx.deleted !== 0 || !inCurrency(tx, inputs.currency)) continue;
    if (tx.date < period.start || tx.date > period.end) continue;
    const spent = spentCents(tx, inputs.catalog, { skipRecurring: true });
    if (spent <= 0 || spent > 1000) continue;
    const key = merchantKey(tx.merchant);
    if (!key) continue;
    const group = groups.get(key) ?? { name: txTitle(tx), count: 0, totalCents: 0 };
    group.count += 1;
    group.totalCents += spent;
    groups.set(key, group);
  }
  const perYear = PERIODS_PER_YEAR[inputs.space?.periodType ?? 'month'];
  const out: Insight[] = [];
  for (const [key, group] of groups) {
    if (group.count < 8 || group.totalCents < 2000) continue;
    out.push({
      id: `habit:${key}:${period.start}`,
      kind: 'habit',
      topic: 'behaviour',
      severity: 'pattern',
      impactCents: group.totalCents * perYear,
      icon: 'coffee-outline',
      titleKey: 'ins.habit.title',
      detailKey: 'ins.habit.detail',
      lineKey: 'ins.habit.line',
      params: { name: group.name, n: group.count, period: { money: group.totalCents }, year: { money: group.totalCents * perYear } },
      about: group.name,
      actionTo: '/transactions',
    });
  }
  return out;
}

// ── patterns ────────────────────────────────────────────────────────────

/** a budget's cycles in a year — a weekly budget overshoots 52 times */
const budgetCyclesPerYear = (budget: BudgetRow, inputs: InsightInputs): number => {
  if (budget.every === 'week') return 52;
  if (budget.every === '2weeks') return 26;
  return budget.every === 'period' ? PERIODS_PER_YEAR[inputs.space?.periodType ?? 'month'] : 12;
};

/** a budget that overshot three periods in a row wants a realistic limit */
export function budgetRealityCheck(inputs: InsightInputs): Insight[] {
  const out: Insight[] = [];
  for (const budget of inputs.budgets) {
    if (budget.deleted !== 0) continue;
    const opts = budgetOptsFor(inputs.space);
    const current = cycleIndex(budget, inputs.today, opts);
    if (current < 3) continue;
    const family = budgetFamily(budget.catIds, inputs.catalog);
    const spends = [1, 2, 3].map((back) => budgetSpentCents(inputs.txs, family, budgetPeriodAt(budget, current - back, opts)));
    if (!spends.every((spent) => spent > budget.amountCents)) continue;
    const suggested = Math.round(spends.reduce((sum, s) => sum + s, 0) / spends.length / 100) * 100;
    out.push({
      id: `budget:${budget.id}:${suggested}`,
      kind: 'budget',
      topic: 'budgets',
      severity: 'pattern',
      impactCents: (suggested - budget.amountCents) * budgetCyclesPerYear(budget, inputs),
      icon: 'wallet-outline',
      titleKey: 'ins.budget.title',
      detailKey: 'ins.budget.detail',
      lineKey: 'ins.budget.line',
      params: { name: budget.name, limit: { money: budget.amountCents }, suggested: { money: suggested } },
      about: budget.name,
      chart: spends.slice().reverse(),
      actionTo: `/budgets/${budget.id}/edit`,
    });
  }
  return out;
}

// ── debts ───────────────────────────────────────────────────────────────

/** the tracked debts that still owe, as the payoff planner reads them */
const owingDebts = (inputs: InsightInputs) =>
  inputs.loans
    .filter((a) => a.deleted === 0 && a.archived !== 1)
    .map((account) => ({ account, remainingCents: loanRemainingCents(account) }))
    .filter((d) => d.remainingCents > 0);

const EXTRA_STEPS = [2_500, 5_000, 10_000, 25_000, 50_000];

/** a round extra in proportion to the debt's own monthly payment: about a fifth of it, never under €25 */
export const extraFor = (minMonthlyCents: number): number => Math.max(EXTRA_STEPS[0], ...EXTRA_STEPS.filter((step) => step <= minMonthlyCents / 5));

const moneyOf = (cents: number, account: AccountRow) => ({ money: cents, ...(account.currency ? { currency: account.currency } : {}) });

/**
 * What a round extra per month buys (user: "€50 extra could save €2,581 —
 * your DUO debt would be repaid ~14 months earlier"): each debt with a
 * known rate walked alone by the payoff planner's engine, with and without
 * the extra; the debt where it saves the most interest speaks. Any cadence
 * — the planner counts the payment per month.
 */
export function debtAcceleration(inputs: InsightInputs): Insight[] {
  let best: Insight | null = null;
  for (const entry of owingDebts(inputs)) {
    const [debt] = toPlanDebts([entry]);
    if (!debt?.aprKnown || debt.aprPct <= 0 || debt.minMonthlyCents <= 0) continue;
    const extra = extraFor(debt.minMonthlyCents);
    const base = simulateDebtAlone(debt, 0);
    const boosted = simulateDebtAlone(debt, extra);
    if (base.months === null || boosted.months === null) continue;
    const months = base.months - boosted.months;
    const interest = base.interestCents - boosted.interestCents;
    if (months < 2 || interest < 2_000) continue;
    if (best && (interest < best.impactCents || (interest === best.impactCents && best.id < `debtacc:${entry.account.id}`))) continue;
    best = {
      id: `debtacc:${entry.account.id}:${entry.remainingCents}`,
      kind: 'debtacc',
      topic: 'debt',
      severity: 'win',
      impactCents: interest,
      icon: 'rocket-launch-outline',
      titleKey: 'ins.debtacc.title',
      subKey: 'ins.debtacc.sub',
      detailKey: 'ins.debtacc.detail',
      params: { name: entry.account.name, extra: moneyOf(extra, entry.account), months, interest: moneyOf(interest, entry.account) },
      about: entry.account.name,
      actionTo: '/debts/plan',
    };
  }
  return best ? [best] : [];
}

/**
 * The quick win (user: "one of your smaller debts could disappear quickly —
 * €340 would fully clear X"): among two debts or more, the smallest when it
 * is small — €500 or three of its own payments — and a minor part of the
 * whole; one that its next payment ends anyway needs no nudge.
 */
export function debtClear(inputs: InsightInputs): Insight[] {
  const debts = owingDebts(inputs);
  if (debts.length < 2) return [];
  const total = debts.reduce((sum, d) => sum + d.remainingCents, 0);
  const small = [...debts].sort((a, b) => a.remainingCents - b.remainingCents || a.account.name.localeCompare(b.account.name))[0];
  const monthly = monthlyPaymentCents(small.account);
  if (small.remainingCents > Math.max(50_000, 3 * monthly) || small.remainingCents > total * 0.25) return [];
  const [debt] = toPlanDebts([small]);
  const months = debt && monthly > 0 ? simulateDebtAlone(debt, 0).months : null;
  if (months !== null && months < 2) return [];
  const withPlan = months !== null;
  return [
    {
      id: `debtclear:${small.account.id}`,
      kind: 'debtclear',
      topic: 'debt',
      severity: 'win',
      impactCents: monthly > 0 ? monthly * 12 : small.remainingCents,
      icon: 'flag-checkered',
      titleKey: 'ins.debtclear.title',
      subKey: 'ins.debtclear.sub',
      detailKey: withPlan ? 'ins.debtclear.detail' : 'ins.debtclear.detailPlain',
      params: {
        name: small.account.name,
        amount: moneyOf(small.remainingCents, small.account),
        ...(withPlan ? { months, freed: moneyOf(monthly, small.account) } : {}),
      },
      about: small.account.name,
      actionTo: `/debts/${small.account.id}`,
    },
  ];
}

// ── the engine ──────────────────────────────────────────────────────────

const DETECTORS = [
  missedCharge,
  salaryLate,
  duplicateCharge,
  priceCreep,
  billChanged,
  subscriptionOverlap,
  smallHabit,
  categoryDrift,
  spendingPace,
  expensiveWeekday,
  budgetRealityCheck,
  noSpendDays,
  debtAcceleration,
  debtClear,
];

/** praise is welcome, three cards of it at most — never above a leak */
const MAX_WINS = 3;

/** alerts first (they are about now), then what drains, how you spend, what a change wins */
const TIER: Record<InsightSeverity, number> = { alert: 0, leak: 1, pattern: 2, win: 3 };

const byRank = (a: Pick<Insight, 'severity' | 'impactCents' | 'id'>, b: Pick<Insight, 'severity' | 'impactCents' | 'id'>): number =>
  TIER[a.severity] - TIER[b.severity] || b.impactCents - a.impactCents || a.id.localeCompare(b.id);

/** every detector's findings, ranked: tier, then the money at stake */
export function collectInsights(inputs: InsightInputs): Insight[] {
  return DETECTORS.flatMap((detect) => detect(inputs)).sort(byRank);
}

/** one card: a finding alone, or every finding that gives the same advice */
export interface InsightGroup {
  /** the finding's own id when alone; `group:<kind>` for several */
  id: string;
  kind: InsightKind;
  severity: InsightSeverity;
  /** the members' summed impact — a card's rank */
  impactCents: number;
  /** ranked, the strongest first */
  members: Insight[];
}

/**
 * #516 (user: "three different advices that give the same advice — group
 * them as one"): findings of one kind share a card, ranked by the card's
 * summed impact; the wins are capped. Dismissal stays per finding, so a
 * new member joins the card while the dismissed ones stay away.
 */
export function groupInsights(findings: readonly Insight[], maxWins = MAX_WINS): InsightGroup[] {
  const byKind = new Map<InsightKind, Insight[]>();
  for (const finding of [...findings].sort(byRank)) byKind.set(finding.kind, [...(byKind.get(finding.kind) ?? []), finding]);
  const groups = [...byKind.entries()].map(([kind, members]): InsightGroup => ({
    id: members.length === 1 ? members[0].id : `group:${kind}`,
    kind,
    severity: members[0].severity,
    impactCents: members.reduce((sum, m) => sum + m.impactCents, 0),
    members,
  }));
  groups.sort(byRank);
  let wins = 0;
  return groups.filter((group) => group.severity !== 'win' || ++wins <= maxWins);
}
