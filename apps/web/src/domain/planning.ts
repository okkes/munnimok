import type {
  AccountRow,
  BudgetRow,
  GoalContributionRow,
  GoalRow,
  PlanSegmentKind,
  PlanSubjectRow,
  RecurringRow,
  SpacePeriodType,
  SpaceRow,
  TxView,
} from '@/db/types';
import { budgetFamily, budgetPeriodAt, cycleIndex } from './budgets';
import type { BudgetPeriodOpts } from './budgets';
import { LOCKED_MAIN_IDS } from './categories';
import { isDebtTracked, nextDebtPaymentDate } from './debts';
import { nextDueDate, occurrencesBetween } from './recurring';
import { nextPeriod, periodHistory } from './periods';
import type { Period } from './periods';
import { txSliceViews } from './txSlices';
import type { TxSliceView } from './txSlices';

/**
 * Planning (#128, the allocation redesign) — all pure. Money that is
 * there gets a job before it is spent: the pool (the ticked accounts'
 * balances) is handed out to subjects, one plan per space and period in
 * the space's own cadence; the plan then shows how the period really
 * went — what each subject needed (the target), what it got (funded) and
 * what left (realized) — and where the two disagree.
 *
 * Five segments: recurring costs and debts (what must be paid, first by
 * default), the person's own expense subjects (categories), budgets and
 * goals (mirrored one-to-one from their source rows). Only money that is
 * there counts; expected income never does.
 */

export type SubjectStatus = 'neutral' | 'underfunded' | 'funded' | 'overspent' | 'snoozed';

/** the default order of the segments: what must be paid comes first */
export const SEGMENT_ORDER: readonly PlanSegmentKind[] = ['recurring', 'debts', 'expenses', 'budgets', 'goals'];

/** a mirrored segment's subjects have no funding obligation of their own: budgets are a ceiling, not a wish */
export const OPTIONAL_SEGMENTS: ReadonlySet<PlanSegmentKind> = new Set(['budgets']);

export type PeriodSpace = Pick<SpaceRow, 'periodType' | 'periodDay'>;

/** deterministic: the actual plan and the sandbox of one period converge across devices */
export const planId = (spaceId: string, kind: 'actual' | 'sandbox', periodStart: string): string =>
  `plan:${spaceId}:${kind}:${periodStart}`;

/** deterministic: adding the same budget twice is one subject */
export const mirroredSubjectId = (planId: string, segment: PlanSegmentKind, sourceId: string): string =>
  `psub:${planId}:${segment}:${sourceId}`;

// ── periods ──────────────────────────────────────────────────────────────

const parseLocal = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};

const DAY_MS = 86_400_000;

/** whole days in a period, both ends included */
export const periodLengthDays = (period: Period): number =>
  Math.round((Date.parse(period.end) - Date.parse(period.start)) / DAY_MS) + 1;

/** the space period a date falls in */
export function periodAt(space: PeriodSpace, date: string): Period {
  return periodHistory(space.periodType, space.periodDay, 1, parseLocal(date))[0];
}

const periodAfter = (space: PeriodSpace, period: Period): Period => nextPeriod(space.periodType, space.periodDay, parseLocal(period.end));

/** the `count` periods after the current one, nearest first */
export function periodsAhead(space: PeriodSpace, count: number, now = new Date()): Period[] {
  const out: Period[] = [];
  let period = periodHistory(space.periodType, space.periodDay, 1, now)[0];
  for (let i = 0; i < count; i += 1) {
    period = periodAfter(space, period);
    out.push(period);
  }
  return out;
}

/**
 * How many periods it takes from `from` to reach the one holding `date`,
 * both counted: a bill due inside `from` is one period away, so its
 * whole amount is due now; a bill four periods out spreads over four.
 */
export function periodsUntil(space: PeriodSpace, from: Period, date: string, cap = 120): number {
  let count = 1;
  let period = from;
  while (period.end < date && count < cap) {
    period = periodAfter(space, period);
    count += 1;
  }
  return count;
}

/**
 * How many periods ahead the person is encouraged to fund: three months
 * of resilience (user ruling) — twelve weeks, six fortnights, three
 * months; anything longer than eight weeks one period.
 */
export function aheadSuggested(periodType: SpacePeriodType): number {
  switch (periodType) {
    case 'week':
      return 12;
    case 'biweekly':
      return 6;
    case 'month':
      return 3;
    default:
      return 1;
  }
}

// ── the pool ─────────────────────────────────────────────────────────────

/** the account types whose balances are money to give a job — savings belong to the goals */
export const POOL_TYPES: ReadonlySet<AccountRow['type']> = new Set(['checking', 'cash']);

type PoolAccount = Pick<AccountRow, 'id' | 'type' | 'deleted' | 'archived' | 'defaultFor' | 'balanceCents'>;
type PoolSpace = Pick<SpaceRow, 'planPoolAccountIds'> | null | undefined;

/** the accounts that make the planning pool: the picked list, or every checking and cash account */
export function planPoolAccounts<A extends PoolAccount>(accounts: readonly A[], space: PoolSpace): A[] {
  const picked = space?.planPoolAccountIds;
  return accounts.filter((a) => {
    if (a.deleted !== 0 || a.archived === 1) return false;
    if (picked) return picked.includes(a.id);
    return POOL_TYPES.has(a.type) && !a.defaultFor;
  });
}

export const poolCents = (accounts: readonly PoolAccount[], space: PoolSpace): number =>
  planPoolAccounts(accounts, space).reduce((sum, a) => sum + a.balanceCents, 0);

// ── families and reservations ────────────────────────────────────────────

interface CatalogLookup {
  byId: (id: string | undefined) => { id: string; parentId?: string };
  childrenOf: (id: string) => { id: string }[];
}

/**
 * The categories an expense subject answers for: a main claims every sub
 * it has (the ones made later too), minus the subs the person excluded;
 * a sub claims itself.
 */
export function subjectFamily(
  subject: Pick<PlanSubjectRow, 'catIds' | 'excludeCatIds'>,
  catalog: CatalogLookup,
): Set<string> {
  const excluded = new Set(subject.excludeCatIds ?? []);
  const family = new Set<string>();
  for (const id of subject.catIds ?? []) {
    family.add(id);
    for (const child of catalog.childrenOf(id)) if (!excluded.has(child.id)) family.add(child.id);
  }
  for (const id of excluded) family.delete(id);
  return family;
}

export interface Reservation {
  subjectId: string;
  name: string;
  segment: 'expenses' | 'budgets';
}

/**
 * Which category belongs to which subject: expense subjects and budget
 * subjects reserve their families exclusively between them (a budget's
 * family comes from the budget row); the other segments reserve nothing.
 */
/** what one live subject reserves: its family and the claim it stamps on it (nothing for the other segments) */
function reservationOf(
  subject: PlanSubjectRow,
  budgetsById: ReadonlyMap<string, Pick<BudgetRow, 'catIds' | 'name'>>,
  catalog: CatalogLookup,
): { ids: Iterable<string>; claim: Reservation } | null {
  if (subject.segment === 'expenses') {
    return { ids: subjectFamily(subject, catalog), claim: { subjectId: subject.id, name: subject.name, segment: 'expenses' } };
  }
  const budget = subject.segment === 'budgets' && subject.sourceId ? budgetsById.get(subject.sourceId) : undefined;
  if (!budget) return null;
  return { ids: budgetFamily(budget.catIds, catalog), claim: { subjectId: subject.id, name: budget.name, segment: 'budgets' } };
}

export function categoryReservations(
  subjects: readonly PlanSubjectRow[],
  budgetsById: ReadonlyMap<string, Pick<BudgetRow, 'catIds' | 'name'>>,
  catalog: CatalogLookup,
): Map<string, Reservation> {
  const out = new Map<string, Reservation>();
  for (const subject of subjects) {
    if (subject.deleted !== 0) continue;
    const reserved = reservationOf(subject, budgetsById, catalog);
    if (!reserved) continue;
    for (const id of reserved.ids) out.set(id, reserved.claim);
  }
  return out;
}

/** the categories of a candidate family another subject already holds */
export function reservationConflicts(
  family: ReadonlySet<string>,
  reservations: ReadonlyMap<string, Reservation>,
  exceptSubjectId?: string,
): Map<string, Reservation> {
  const out = new Map<string, Reservation>();
  for (const id of family) {
    const holder = reservations.get(id);
    if (holder && holder.subjectId !== exceptSubjectId) out.set(id, holder);
  }
  return out;
}

// ── realization ──────────────────────────────────────────────────────────

const inPeriod = (date: string, period: Period): boolean => date >= period.start && date <= period.end;

/**
 * What an expense subject's categories really spent: expense slices in
 * the period — minus the ones that belong to a recurring cost or move
 * money to an account (a loan payment), which answer to their own
 * segments whatever their category.
 */
export function expenseRealizedCents(family: ReadonlySet<string>, txs: readonly TxView[], period: Period): number {
  let total = 0;
  for (const { slice, spent } of periodSpending(txs, period)) {
    if (slice.recurringId || slice.linkedAccountId) continue;
    if (!family.has(slice.catId ?? '')) continue;
    total += spent;
  }
  return total;
}

/** every expense slice of the period's live rows, with what it took */
function* periodSpending(txs: readonly TxView[], period: Period): Generator<{ slice: TxSliceView; spent: number }> {
  for (const tx of txs) {
    if (tx.deleted !== 0 || !inPeriod(tx.date, period)) continue;
    for (const slice of txSliceViews(tx)) {
      if (slice.effType !== 'expense') continue;
      yield { slice, spent: slice.fromParts ? Math.abs(slice.amountCents) : -slice.amountCents };
    }
  }
}

/** where a slice's spending lands when no subject answers for it: its main and its own category; null when a segment or a locked family has it */
function unplannedKeyOf(
  slice: TxSliceView,
  covered: ReadonlySet<string>,
  catalog: CatalogLookup,
): { mainId: string; catId: string } | null {
  if (slice.recurringId || slice.linkedAccountId) return null;
  const catId = slice.catId ?? '';
  if (!catId || covered.has(catId)) return null;
  const cat = catalog.byId(catId);
  const mainId = cat.parentId ?? cat.id;
  return LOCKED_MAIN_IDS.has(mainId) ? null : { mainId, catId };
}

/** one main category spent on without a subject answering for it, its subs broken out */
export interface UnplannedMain {
  mainId: string;
  cents: number;
  subs: { catId: string; cents: number }[];
}

/**
 * What the period spent outside every subject (user request 2026-10-02):
 * expense slices whose category no expense or budget subject answers for,
 * grouped under their main — the "unplanned" segment, derived afresh each
 * period. Recurring-linked and transfer slices answer to their own
 * segments; munni's locked families are not spending.
 */
export function unplannedByCategory(
  txs: readonly TxView[],
  period: Period,
  covered: ReadonlySet<string>,
  catalog: CatalogLookup,
): UnplannedMain[] {
  const byMain = new Map<string, Map<string, number>>();
  for (const { slice, spent } of periodSpending(txs, period)) {
    const key = unplannedKeyOf(slice, covered, catalog);
    if (!key) continue;
    const subs = byMain.get(key.mainId) ?? new Map<string, number>();
    subs.set(key.catId, (subs.get(key.catId) ?? 0) + spent);
    byMain.set(key.mainId, subs);
  }
  return [...byMain]
    .map(([mainId, subs]) => ({
      mainId,
      cents: [...subs.values()].reduce((sum, v) => sum + v, 0),
      subs: [...subs].map(([catId, cents]) => ({ catId, cents })).sort((a, b) => b.cents - a.cents),
    }))
    .filter((main) => main.cents > 0)
    .sort((a, b) => b.cents - a.cents);
}

/** a budget's own rule: everything its family spent, recurring-linked rows included */
export function budgetRealizedCents(family: ReadonlySet<string>, txs: readonly TxView[], period: Period): number {
  let total = 0;
  for (const { slice, spent } of periodSpending(txs, period)) {
    if (family.has(slice.catId ?? '')) total += spent;
  }
  return total;
}

/** what a recurring cost's linked rows took in the period */
export function recurringRealizedCents(recurringId: string, txs: readonly TxView[], period: Period): number {
  let total = 0;
  for (const tx of txs) {
    if (tx.deleted !== 0 || !inPeriod(tx.date, period)) continue;
    for (const slice of txSliceViews(tx)) {
      if (slice.recurringId !== recurringId) continue;
      total += Math.abs(slice.amountCents);
    }
  }
  return total;
}

/** what went to a loan account in the period */
export function debtRealizedCents(loanId: string, txs: readonly TxView[], period: Period): number {
  let total = 0;
  for (const tx of txs) {
    if (tx.deleted !== 0 || !inPeriod(tx.date, period)) continue;
    for (const slice of txSliceViews(tx)) {
      if (slice.linkedAccountId !== loanId || slice.amountCents > 0) continue;
      total += Math.abs(slice.amountCents);
    }
  }
  return total;
}

/** what a goal was given in the period (the Goals screen's contributions) */
export function goalRealizedCents(goalId: string, contributions: readonly GoalContributionRow[], period: Period): number {
  return contributions
    .filter((c) => c.deleted === 0 && c.goalId === goalId && c.amountCents > 0 && inPeriod(c.date, period))
    .reduce((sum, c) => sum + c.amountCents, 0);
}

// ── targets ──────────────────────────────────────────────────────────────

const BUDGET_CYCLE_DAYS: Record<BudgetRow['every'], number | null> = { week: 7, '2weeks': 14, month: 30.44, period: null };

/**
 * A budget's limit scaled to the plan's period: a weekly budget on a
 * monthly plan is four or five weeks (the cycles that start inside the
 * period), a monthly budget on a weekly plan a week's share of the month.
 */
export function budgetTargetCents(budget: BudgetRow, period: Period, opts: BudgetPeriodOpts = {}): { cents: number; cycles: number } {
  const cycleDays = BUDGET_CYCLE_DAYS[budget.every];
  const days = periodLengthDays(period);
  if (cycleDays === null) return { cents: budget.amountCents, cycles: 1 };
  if (cycleDays >= days) {
    return { cents: Math.round((budget.amountCents * days) / cycleDays), cycles: 1 };
  }
  // the cycles whose start lies inside the period
  let cycles = 0;
  const first = cycleIndex(budget, period.start, opts);
  for (let index = first; index < first + 64; index += 1) {
    const start = budgetPeriodAt(budget, index, opts).start;
    if (start > period.end) break;
    if (start >= period.start) cycles += 1;
  }
  cycles = Math.max(1, cycles);
  return { cents: budget.amountCents * cycles, cycles };
}

/** what to put aside this period for an amount due in `periodsLeft` periods, what was already set aside taken off */
export function spreadTargetCents(amountCents: number, carriedCents: number, periodsLeft: number): number {
  const left = Math.max(1, periodsLeft);
  return Math.max(0, Math.round((amountCents - carriedCents) / left));
}

/** the recurring cost's next due date on or after the period's start; null once it is over */
export function recurringDueFrom(rec: Pick<RecurringRow, 'active' | 'every' | 'everyN' | 'dueDay' | 'dueMonth' | 'since' | 'until'>, period: Period): string | null {
  return nextDueDate(rec, period.start);
}

export function recurringTargetCents(
  rec: Pick<RecurringRow, 'active' | 'amountCents' | 'every' | 'everyN' | 'dueDay' | 'dueMonth' | 'since' | 'until'>,
  space: PeriodSpace,
  period: Period,
  carriedCents: number,
): number {
  // a cost that falls due more than once inside the period (a weekly cost
  // in a monthly plan) wants every occurrence, not one (user ss 2026-10-02)
  const occurrences = rec.active === 1 ? occurrencesBetween(rec, period.start, period.end).length : 0;
  if (occurrences > 1) return Math.max(0, occurrences * Math.abs(rec.amountCents) - carriedCents);
  const due = recurringDueFrom(rec, period);
  const left = due ? periodsUntil(space, period, due) : 1;
  return spreadTargetCents(Math.abs(rec.amountCents), carriedCents, left);
}

export function debtTargetCents(
  loan: Pick<AccountRow, 'paymentCents' | 'paymentEvery' | 'paymentEveryN' | 'paymentDay'>,
  space: PeriodSpace,
  period: Period,
  carriedCents: number,
): number {
  if (!loan.paymentCents) return 0;
  const due = nextDebtPaymentDate(loan, period.start);
  const left = due ? periodsUntil(space, period, due) : 1;
  return spreadTargetCents(Math.abs(loan.paymentCents), carriedCents, left);
}

/** (goal − saved) ÷ the periods before its date; null for a goal without one */
export function goalTargetCents(goal: Pick<GoalRow, 'targetCents' | 'allocatedCents' | 'targetDate'>, space: PeriodSpace, period: Period): number | null {
  if (!goal.targetDate) return null;
  const remaining = Math.max(0, goal.targetCents - goal.allocatedCents);
  if (remaining === 0) return 0;
  return Math.ceil(remaining / periodsUntil(space, period, goal.targetDate));
}

// ── status ───────────────────────────────────────────────────────────────

/**
 * The colour a subject wears. Overspent (more left than was funded) is
 * red everywhere. Budgets are green from nought funded up — a budget is a
 * ceiling, funding it is optional. The others are orange while a target
 * is unmet, green once it is, grey with no target and nothing funded; a
 * snoozed subject is green by decree.
 */
export function subjectStatus(
  segment: PlanSegmentKind,
  targetCents: number | null,
  fundedCents: number,
  realizedCents: number,
  snoozed: boolean,
): SubjectStatus {
  if (snoozed) return 'snoozed';
  if (realizedCents > fundedCents) return 'overspent';
  if (OPTIONAL_SEGMENTS.has(segment)) return 'funded';
  if (targetCents !== null && targetCents > 0) return fundedCents >= targetCents ? 'funded' : 'underfunded';
  return fundedCents > 0 ? 'funded' : 'neutral';
}

export interface SubjectView {
  subject: PlanSubjectRow;
  targetCents: number | null;
  fundedCents: number;
  realizedCents: number;
  carriedCents: number;
  /** budgets: how many of the budget's cycles the period holds */
  cycles: number;
  status: SubjectStatus;
  /** the source row is gone (a deleted budget, loan, goal or recurring cost) */
  orphaned: boolean;
  /**
   * Whether the money actually leaves this period (user 2026-10-07): a
   * recurring cost with an occurrence inside the period, a goal whose date
   * falls in it, every expense, budget and loan payment. A yearly cost
   * spread over months, or a goal years away, is NOT due — those are the
   * only ones a period may skip.
   */
  dueThisPeriod: boolean;
}

/** a subject the period may skip: a mirrored one whose money does not leave this period */
export const canSkipPeriod = (view: Pick<SubjectView, 'subject' | 'dueThisPeriod'>): boolean =>
  view.subject.segment !== 'expenses' && view.subject.segment !== 'budgets' && !view.dueThisPeriod;

export interface SubjectContext {
  space: PeriodSpace & Pick<SpaceRow, 'weekStart'>;
  period: Period;
  txs: readonly TxView[];
  catalog: CatalogLookup;
  budgetsById: ReadonlyMap<string, BudgetRow>;
  recurringsById: ReadonlyMap<string, RecurringRow>;
  loansById: ReadonlyMap<string, AccountRow>;
  goalsById: ReadonlyMap<string, GoalRow>;
  contributions: readonly GoalContributionRow[];
  /** per source id: what earlier periods set aside and never spent (recurring costs and debts roll over) */
  carriedBySource: ReadonlyMap<string, number>;
  budgetOpts: BudgetPeriodOpts;
}

/** every number the plan shows for one subject */
export function subjectView(subject: PlanSubjectRow, ctx: SubjectContext): SubjectView {
  const snoozed = subject.snoozed === 1;
  const funded = subject.fundedCents;
  const carried = ctx.carriedBySource.get(subject.sourceId ?? '') ?? 0;
  let target: number | null = null;
  let realized = 0;
  let cycles = 1;
  let orphaned = false;
  let dueThisPeriod = true;
  switch (subject.segment) {
    case 'expenses': {
      target = subject.targetCents ?? 0;
      realized = expenseRealizedCents(subjectFamily(subject, ctx.catalog), ctx.txs, ctx.period);
      break;
    }
    case 'budgets': {
      const budget = ctx.budgetsById.get(subject.sourceId ?? '');
      if (!budget) {
        orphaned = true;
        break;
      }
      const scaled = budgetTargetCents(budget, ctx.period, ctx.budgetOpts);
      target = scaled.cents;
      cycles = scaled.cycles;
      realized = budgetRealizedCents(budgetFamily(budget.catIds, ctx.catalog), ctx.txs, ctx.period);
      break;
    }
    case 'recurring': {
      const rec = ctx.recurringsById.get(subject.sourceId ?? '');
      if (!rec) {
        orphaned = true;
        break;
      }
      target = recurringTargetCents(rec, ctx.space, ctx.period, carried);
      realized = recurringRealizedCents(rec.id, ctx.txs, ctx.period);
      dueThisPeriod = rec.active === 1 && occurrencesBetween(rec, ctx.period.start, ctx.period.end).length > 0;
      break;
    }
    case 'debts': {
      const loan = ctx.loansById.get(subject.sourceId ?? '');
      if (!loan) {
        orphaned = true;
        break;
      }
      target = debtTargetCents(loan, ctx.space, ctx.period, carried);
      realized = debtRealizedCents(loan.id, ctx.txs, ctx.period);
      break;
    }
    case 'goals': {
      const goal = ctx.goalsById.get(subject.sourceId ?? '');
      if (!goal) {
        orphaned = true;
        break;
      }
      target = goalTargetCents(goal, ctx.space, ctx.period);
      realized = goalRealizedCents(goal.id, ctx.contributions, ctx.period);
      dueThisPeriod = !!goal.targetDate && goal.targetDate <= ctx.period.end;
      break;
    }
    default:
      break;
  }
  return {
    subject,
    targetCents: target,
    fundedCents: funded,
    realizedCents: realized,
    carriedCents: carried,
    cycles,
    status: subjectStatus(subject.segment, target, funded, realized, snoozed),
    orphaned,
    dueThisPeriod,
  };
}

/** what a subject still needs to reach its target (0 when it has none or is there) */
export const shortfallCents = (view: Pick<SubjectView, 'targetCents' | 'fundedCents'>): number =>
  view.targetCents === null ? 0 : Math.max(0, view.targetCents - view.fundedCents);

/** funded money not yet spent — what can be taken away without going red */
export const slackCents = (view: Pick<SubjectView, 'fundedCents' | 'realizedCents'>): number =>
  Math.max(0, view.fundedCents - view.realizedCents);

// ── ahead ────────────────────────────────────────────────────────────────

/**
 * How much of a plan's mandatory targets are funded, 0..1: every subject
 * outside the optional segments with a target, weighted by the target.
 * A plan with nothing mandatory to fund counts for nothing.
 */
export function planFundedFraction(views: readonly Pick<SubjectView, 'subject' | 'targetCents' | 'fundedCents'>[]): number {
  let need = 0;
  let got = 0;
  for (const view of views) {
    if (OPTIONAL_SEGMENTS.has(view.subject.segment) || view.subject.snoozed === 1) continue;
    if (view.targetCents === null || view.targetCents <= 0) continue;
    need += view.targetCents;
    got += Math.min(view.targetCents, view.fundedCents);
  }
  return need > 0 ? got / need : 0;
}

/** the circle's colour as it fills: nothing, a month, two, three or more (user ruling) */
export function aheadColor(count: number): 'grey' | 'green' | 'orange' | 'red' {
  if (count < 1) return 'grey';
  if (count < 2) return 'green';
  if (count < 3) return 'orange';
  return 'red';
}

// ── estimates ────────────────────────────────────────────────────────────

export interface TargetEstimate {
  /** the previous period's spend (null without a previous period) */
  lastCents: number | null;
  /** the average over the periods given (null without any) */
  averageCents: number | null;
}

/** what a family cost in the previous period and on average — `pastPeriods` newest last, the current one excluded */
export function estimateTarget(family: ReadonlySet<string>, txs: readonly TxView[], pastPeriods: readonly Period[]): TargetEstimate {
  if (pastPeriods.length === 0) return { lastCents: null, averageCents: null };
  const spent = pastPeriods.map((period) => expenseRealizedCents(family, txs, period));
  return {
    lastCents: spent.at(-1) ?? null,
    averageCents: Math.round(spent.reduce((sum, v) => sum + v, 0) / spent.length),
  };
}

// ── cover ────────────────────────────────────────────────────────────────

export interface CoverCandidates {
  /** munni's picks: the subjects that can spare it most easily */
  picks: SubjectView[];
  /** everybody with funded money to spare, the picks included */
  all: SubjectView[];
}

/**
 * Where to take money from to cover an overspend: every subject with
 * slack except the one in need; the picks are the ones already past
 * their target (nothing planned is lost) and the budgets (a ceiling,
 * not a wish), most slack first.
 */
export function coverCandidates(views: readonly SubjectView[], forSubjectId: string): CoverCandidates {
  const all = views
    .filter((v) => v.subject.id !== forSubjectId && v.subject.deleted === 0 && slackCents(v) > 0)
    .sort((a, b) => slackCents(b) - slackCents(a));
  const generous = (v: SubjectView) =>
    OPTIONAL_SEGMENTS.has(v.subject.segment) || (v.targetCents !== null && v.fundedCents > v.targetCents) || v.subject.snoozed === 1;
  const picks = all.filter(generous).slice(0, 3);
  return { picks: picks.length > 0 ? picks : all.slice(0, 3), all };
}

// ── filling ──────────────────────────────────────────────────────────────

/** the funding each subject gets when filled in list order from what is available: up to its shortfall, until the money runs out */
export function fillInOrder(views: readonly SubjectView[], availableCents: number): Map<string, number> {
  const out = new Map<string, number>();
  let left = Math.max(0, availableCents);
  for (const view of views) {
    if (view.subject.snoozed === 1) continue;
    const need = shortfallCents(view);
    if (need <= 0 || left <= 0) continue;
    const give = Math.min(need, left);
    out.set(view.subject.id, give);
    left -= give;
  }
  return out;
}

// ── blueprints ───────────────────────────────────────────────────────────

/** the part of a subject a blueprint keeps — no funding, no snooze, no id */
export interface SubjectShape {
  segment: PlanSegmentKind;
  order: number;
  name: string;
  icon?: string;
  color?: string;
  catIds?: string[];
  excludeCatIds?: string[];
  targetCents?: number;
  sourceId?: string;
}

export const subjectShape = (subject: PlanSubjectRow): SubjectShape => ({
  segment: subject.segment,
  order: subject.order,
  name: subject.name,
  icon: subject.icon,
  color: subject.color,
  catIds: subject.catIds ? [...subject.catIds].sort((a, b) => a.localeCompare(b)) : undefined,
  excludeCatIds: subject.excludeCatIds?.length ? [...subject.excludeCatIds].sort((a, b) => a.localeCompare(b)) : undefined,
  targetCents: subject.targetCents,
  sourceId: subject.sourceId,
});

const signature = (shape: SubjectShape): string =>
  [
    shape.segment,
    shape.sourceId ?? '',
    (shape.catIds ?? []).join(','),
    (shape.excludeCatIds ?? []).join(','),
    shape.targetCents ?? '',
    shape.segment === 'expenses' ? shape.name : '',
  ].join('|');

/** two sets of subjects that plan the same thing, whatever their order or ids */
export function sameSubjects(a: readonly PlanSubjectRow[], b: readonly PlanSubjectRow[]): boolean {
  const live = (rows: readonly PlanSubjectRow[]) =>
    rows
      .filter((r) => r.deleted === 0)
      .map((r) => signature(subjectShape(r)))
      .sort((x, y) => x.localeCompare(y));
  const left = live(a);
  const right = live(b);
  return left.length === right.length && left.every((s, i) => s === right[i]);
}

export interface BlueprintSources {
  catalog: CatalogLookup & { all: { id: string }[] };
  budgetIds: ReadonlySet<string>;
  recurringIds: ReadonlySet<string>;
  loanIds: ReadonlySet<string>;
  goalIds: ReadonlySet<string>;
}

/** the subjects whose source is gone: a category, budget, recurring cost, loan or goal that no longer exists */
export function brokenSubjects(subjects: readonly PlanSubjectRow[], sources: BlueprintSources): PlanSubjectRow[] {
  const known = new Set(sources.catalog.all.map((c) => c.id));
  return subjects.filter((s) => {
    if (s.deleted !== 0) return false;
    switch (s.segment) {
      case 'expenses':
        return (s.catIds ?? []).some((id) => !known.has(id));
      case 'budgets':
        return !sources.budgetIds.has(s.sourceId ?? '');
      case 'recurring':
        return !sources.recurringIds.has(s.sourceId ?? '');
      case 'debts':
        return !sources.loanIds.has(s.sourceId ?? '');
      case 'goals':
        return !sources.goalIds.has(s.sourceId ?? '');
      default:
        return false;
    }
  });
}

// ── the recommendation ───────────────────────────────────────────────────

export interface RecommendInput {
  catalog: CatalogLookup & { parents: { id: string; icon?: string; color?: string }[] };
  nameOf: (catId: string) => string;
  txs: readonly TxView[];
  /** past periods, newest last, the current one excluded */
  pastPeriods: readonly Period[];
  budgets: readonly BudgetRow[];
  recurrings: readonly RecurringRow[];
  accounts: readonly AccountRow[];
  goals: readonly GoalRow[];
  /** what the person earns per period, when it can be told (the recurring income or the period's income); null = unknown */
  incomeCents: number | null;
  space: PeriodSpace;
  period: Period;
}

/**
 * A plan munni would propose: an expense subject per main category the
 * person spent on, its target between last period and the average (a
 * budget on those categories takes the subject's place), every recurring
 * cost, every tracked loan — and the goals, when the income leaves room
 * after all of that. Nothing is funded; the person looks first.
 */
export function recommendSubjects(input: RecommendInput): SubjectShape[] {
  const out: SubjectShape[] = [];
  const budgets = input.budgets.filter((b) => b.deleted === 0 && b.active === 1);
  const reserved = new Set(budgets.flatMap((b) => [...budgetFamily(b.catIds, input.catalog)]));

  let order = 0;
  for (const rec of input.recurrings.filter((r) => r.deleted === 0 && r.active === 1)) {
    out.push({ segment: 'recurring', order: order++, name: rec.name, icon: rec.icon, sourceId: rec.id });
  }
  order = 0;
  for (const loan of input.accounts.filter((a) => a.deleted === 0 && a.archived !== 1 && !a.defaultFor && isDebtTracked(a))) {
    out.push({ segment: 'debts', order: order++, name: loan.name, sourceId: loan.id });
  }
  order = 0;
  let planned = 0;
  for (const parent of input.catalog.parents) {
    const family = subjectFamily({ catIds: [parent.id] }, input.catalog);
    if ([...family].some((id) => reserved.has(id))) continue;
    const estimate = estimateTarget(family, input.txs, input.pastPeriods);
    const last = estimate.lastCents ?? 0;
    const average = estimate.averageCents ?? 0;
    if (last <= 0 && average <= 0) continue;
    const target = Math.round((last + average) / 2);
    planned += target;
    out.push({ segment: 'expenses', order: order++, name: input.nameOf(parent.id), icon: parent.icon, color: parent.color, catIds: [parent.id], targetCents: target });
  }
  order = 0;
  for (const budget of budgets) {
    planned += budgetTargetCents(budget, input.period).cents;
    out.push({ segment: 'budgets', order: order++, name: budget.name, icon: budget.icon, sourceId: budget.id });
  }
  const committed =
    planned +
    input.recurrings.filter((r) => r.deleted === 0 && r.active === 1).reduce((sum, r) => sum + recurringTargetCents(r, input.space, input.period, 0), 0) +
    input.accounts.filter((a) => a.deleted === 0 && a.archived !== 1 && !a.defaultFor && isDebtTracked(a)).reduce((sum, a) => sum + debtTargetCents(a, input.space, input.period, 0), 0);
  if (input.incomeCents !== null && input.incomeCents > committed) {
    order = 0;
    for (const goal of input.goals.filter((g) => g.deleted === 0 && g.archived !== 1)) {
      out.push({ segment: 'goals', order: order++, name: goal.name, icon: goal.icon, color: goal.color, sourceId: goal.id });
    }
  }
  return out;
}
