import type {
  AccountRow,
  BudgetRow,
  EventRow,
  GoalContributionRow,
  GoalRow,
  PlanSegmentKind,
  PlanSubjectRow,
  RecurringRow,
  SpacePeriodType,
  SpaceRow,
  TxView,
} from '@/db/types';
import { compareHlc } from '@/sync/hlc';
import { knownCents } from '@/lib/money';
import { budgetFamily, budgetPeriodAt, cycleIndex } from './budgets';
import type { BudgetPeriodOpts } from './budgets';
import { LOCKED_MAIN_IDS, REIMBURSED_ID } from './categories';
import { isDebtTracked, loanRemainingCents, nextDebtPaymentDate } from './debts';
import { isEventMoney } from './events';
import { nextDueDate, occurrencesBetween } from './recurring';
import { nextPeriod, periodHistory } from './periods';
import type { Period } from './periods';
import { txSliceViews } from './txSlices';
import type { TxSliceView } from './txSlices';

// the pool (the ticked accounts' balances) is handed out to subjects, one plan per space and period (#128)
// only money that is there counts, expected income never does

/** overTarget (#517): spent past the target, the funding still covers it */
export type SubjectStatus = 'neutral' | 'underfunded' | 'funded' | 'overTarget' | 'overspent' | 'snoozed' | 'settled';

/** the default order of the segments: what must be paid comes first */
export const SEGMENT_ORDER: readonly PlanSegmentKind[] = ['recurring', 'debts', 'expenses', 'budgets', 'events', 'goals'];

/** a mirrored segment's subjects have no funding obligation of their own: budgets are a ceiling, not a wish */
export const OPTIONAL_SEGMENTS: ReadonlySet<PlanSegmentKind> = new Set(['budgets']);

export type PeriodSpace = Pick<SpaceRow, 'periodType' | 'periodDay'>;

/** deterministic: the actual plan and the sandbox of one period converge across devices */
export const planId = (spaceId: string, kind: 'actual' | 'sandbox', periodStart: string): string =>
  `plan:${spaceId}:${kind}:${periodStart}`;

/** deterministic: adding the same budget twice is one subject */
export const mirroredSubjectId = (planId: string, segment: PlanSegmentKind, sourceId: string): string =>
  `psub:${planId}:${segment}:${sourceId}`;

const parseLocal = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};

const DAY_MS = 86_400_000;

export const periodLengthDays = (period: Period): number =>
  Math.round((Date.parse(period.end) - Date.parse(period.start)) / DAY_MS) + 1;

export function periodAt(space: PeriodSpace, date: string): Period {
  return periodHistory(space.periodType, space.periodDay, 1, parseLocal(date))[0];
}

const periodAfter = (space: PeriodSpace, period: Period): Period => nextPeriod(space.periodType, space.periodDay, parseLocal(period.end));

export function periodsAhead(space: PeriodSpace, count: number, now = new Date()): Period[] {
  const out: Period[] = [];
  let period = periodHistory(space.periodType, space.periodDay, 1, now)[0];
  for (let i = 0; i < count; i += 1) {
    period = periodAfter(space, period);
    out.push(period);
  }
  return out;
}

/** counts both ends: a bill due inside `from` is one period away, so all of it is due now */
export function periodsUntil(space: PeriodSpace, from: Period, date: string, cap = 120): number {
  let count = 1;
  let period = from;
  while (period.end < date && count < cap) {
    period = periodAfter(space, period);
    count += 1;
  }
  return count;
}

/** three months of resilience (user ruling): 12 weeks, 6 fortnights, 3 months, otherwise 1 */
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

/** the account types whose balances are money to give a job — savings belong to the goals */
export const POOL_TYPES: ReadonlySet<AccountRow['type']> = new Set(['checking', 'cash']);

type PoolAccount = Pick<AccountRow, 'id' | 'type' | 'deleted' | 'archived' | 'balanceCents'>;
type PoolSpace = Pick<SpaceRow, 'planPoolAccountIds'> | null | undefined;

/** the picked list, else every checking and cash account — the space's cash wallet included (#348, #546) */
export function planPoolAccounts<A extends PoolAccount>(accounts: readonly A[], space: PoolSpace): A[] {
  const picked = space?.planPoolAccountIds;
  return accounts.filter((a) => {
    if (a.deleted !== 0 || a.archived === 1) return false;
    if (picked) return picked.includes(a.id);
    return POOL_TYPES.has(a.type);
  });
}

export const poolCents = (accounts: readonly PoolAccount[], space: PoolSpace): number =>
  planPoolAccounts(accounts, space).reduce((sum, a) => sum + knownCents(a.balanceCents), 0);

interface CatalogLookup {
  byId: (id: string | undefined) => { id: string; parentId?: string };
  childrenOf: (id: string) => { id: string }[];
}

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

/** when a subject came into the plan: the `planId` stamp, which only an add writes — removed and re-added is a newcomer */
export const subjectBirth = (subject: Pick<PlanSubjectRow, 'fieldVersions'>): string => subject.fieldVersions?.planId ?? '';

/** oldest first — the order in which subjects claim their categories (#535) */
export const byBirth = <S extends Pick<PlanSubjectRow, 'id' | 'fieldVersions'>>(subjects: readonly S[]): S[] =>
  [...subjects].sort((a, b) => compareHlc(subjectBirth(a), subjectBirth(b)) || a.id.localeCompare(b.id));

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

// expense and budget subjects reserve their categories exclusively between them; other segments reserve nothing
// first come keeps its place (#535): the later subject is blocked on a shared category and counts none of its spending
export function categoryReservations(
  subjects: readonly PlanSubjectRow[],
  budgetsById: ReadonlyMap<string, Pick<BudgetRow, 'catIds' | 'name'>>,
  catalog: CatalogLookup,
): Map<string, Reservation> {
  const out = new Map<string, Reservation>();
  for (const subject of byBirth(subjects)) {
    if (subject.deleted !== 0) continue;
    const reserved = reservationOf(subject, budgetsById, catalog);
    if (!reserved) continue;
    for (const id of reserved.ids) if (!out.has(id)) out.set(id, reserved.claim);
  }
  return out;
}

export interface Overlap {
  holder: Reservation;
  catIds: string[];
}

export function overlapsOf(subjectId: string, family: ReadonlySet<string>, reservations: ReadonlyMap<string, Reservation>): Overlap[] {
  const byHolder = new Map<string, Overlap>();
  for (const [catId, holder] of reservationConflicts(family, reservations, subjectId)) {
    const entry = byHolder.get(holder.subjectId) ?? { holder, catIds: [] };
    entry.catIds.push(catId);
    byHolder.set(holder.subjectId, entry);
  }
  return [...byHolder.values()];
}

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

const inPeriod = (date: string, period: Period): boolean => date >= period.start && date <= period.end;

export interface SliceOwners {
  /** live recurring costs, stopped ones included */
  recurringIds: ReadonlySet<string>;
  /** tracked debts outside the pool, archived ones included */
  loanIds: ReadonlySet<string>;
  /** live events, archived ones included */
  eventIds: ReadonlySet<string>;
  /** the pool's own accounts (#532): money moved to one of them never left the pool */
  poolIds: ReadonlySet<string>;
  /** #455: the rows a cashed-out goal answers for, by the goal's id */
  goalByTx?: ReadonlyMap<string, string>;
}

export type SliceOwner =
  | { kind: 'debt'; id: string }
  | { kind: 'recurring'; id: string }
  | { kind: 'goal'; id: string }
  | { kind: 'event'; id: string }
  | { kind: 'category'; catId: string };

// one owner per slice, so nothing is counted twice: loan, recurring, event (#504), category
// money moved to an own account (the pool's #532, savings) left nothing behind
// #455: what a cashed-out goal bought is the goal's
export function sliceOwner(slice: TxSliceView, owners: SliceOwners, txId?: string): SliceOwner | null {
  const linked = slice.linkedAccountId;
  if (linked && owners.poolIds.has(linked)) return null;
  if (linked && owners.loanIds.has(linked)) return slice.amountCents < 0 ? { kind: 'debt', id: linked } : null;
  if (slice.recurringId && owners.recurringIds.has(slice.recurringId)) return { kind: 'recurring', id: slice.recurringId };
  if (linked) return null;
  return spendingOwner(slice, owners, txId);
}

function spendingOwner(slice: TxSliceView, owners: SliceOwners, txId: string | undefined): SliceOwner | null {
  const goalId = txId ? owners.goalByTx?.get(txId) : undefined;
  // the settled part of a paid-back expense is bookkeeping on both rows: a goal's or event's total leaves it out too
  const settled = slice.catId === REIMBURSED_ID;
  if (goalId && slice.effType === 'expense') return settled ? null : { kind: 'goal', id: goalId };
  if (slice.eventId && owners.eventIds.has(slice.eventId) && isEventMoney(slice.effType)) {
    return settled ? null : { kind: 'event', id: slice.eventId };
  }
  return slice.effType === 'expense' ? { kind: 'category', catId: slice.catId ?? '' } : null;
}

/** an expense slice's spending (a refund takes off); a split's parts count as magnitudes */
const spentOf = (slice: TxSliceView): number => (slice.fromParts ? Math.abs(slice.amountCents) : -slice.amountCents);

/** event money (#448): an expense is spending, any other money that came in for it takes off */
const eventNetOf = (slice: TxSliceView): number => (slice.effType === 'expense' ? spentOf(slice) : -slice.amountCents);

export interface PeriodLedger {
  /** category spending, signed: a refund takes off */
  byCategory: ReadonlyMap<string, number>;
  byRecurring: ReadonlyMap<string, number>;
  byDebt: ReadonlyMap<string, number>;
  /** what an event cost net of what came in for it, never below zero */
  byEvent: ReadonlyMap<string, number>;
  /** #455: what a cashed-out goal bought, signed like category spending; no subject or Unplanned row counts it */
  byGoal: ReadonlyMap<string, number>;
}

const addTo = (map: Map<string, number>, key: string, cents: number) => map.set(key, (map.get(key) ?? 0) + cents);

export function periodLedger(txs: readonly TxView[], period: Period, owners: SliceOwners): PeriodLedger {
  const byCategory = new Map<string, number>();
  const byRecurring = new Map<string, number>();
  const byDebt = new Map<string, number>();
  const eventNet = new Map<string, number>();
  const byGoal = new Map<string, number>();
  for (const tx of txs) {
    if (tx.deleted !== 0 || !inPeriod(tx.date, period)) continue;
    for (const slice of txSliceViews(tx)) {
      const owner = sliceOwner(slice, owners, tx.id);
      if (owner?.kind === 'category') addTo(byCategory, owner.catId, spentOf(slice));
      else if (owner?.kind === 'recurring') addTo(byRecurring, owner.id, Math.abs(slice.amountCents));
      else if (owner?.kind === 'debt') addTo(byDebt, owner.id, Math.abs(slice.amountCents));
      else if (owner?.kind === 'event') addTo(eventNet, owner.id, eventNetOf(slice));
      else if (owner?.kind === 'goal') addTo(byGoal, owner.id, spentOf(slice));
    }
  }
  const byEvent = new Map([...eventNet].map(([id, net]): [string, number] => [id, Math.max(0, net)]));
  return { byCategory, byRecurring, byDebt, byEvent, byGoal };
}

export function eventNetBefore(txs: readonly TxView[], eventId: string, before: string, owners: SliceOwners): number {
  let net = 0;
  for (const tx of txs) {
    if (tx.deleted !== 0 || tx.date >= before) continue;
    for (const slice of txSliceViews(tx)) {
      const owner = sliceOwner(slice, owners, tx.id);
      if (owner?.kind === 'event' && owner.id === eventId) net += eventNetOf(slice);
    }
  }
  return Math.max(0, net);
}

/** what a set of categories spent in a ledger, the blocked ones left out (they answer to an older subject) */
export function familySpentCents(family: ReadonlySet<string>, ledger: PeriodLedger, blocked?: ReadonlySet<string>): number {
  let total = 0;
  for (const id of family) if (!blocked?.has(id)) total += ledger.byCategory.get(id) ?? 0;
  return total;
}

/** money a row of the Unplanned segment holds for this period only (#494) — the model fills it in from the plan's one-offs */
interface UnplannedFunding {
  fundedCents?: number;
}

export interface UnplannedMain extends UnplannedFunding {
  kind: 'category';
  mainId: string;
  cents: number;
  subs: { catId: string; cents: number }[];
}

export interface UnplannedRecurring extends UnplannedFunding {
  kind: 'recurring';
  sourceId: string;
  name: string;
  icon?: string;
  cents: number;
}

export interface UnplannedDebt extends UnplannedFunding {
  kind: 'debt';
  sourceId: string;
  name: string;
  color?: string;
  cents: number;
}

export interface UnplannedEvent extends UnplannedFunding {
  kind: 'event';
  sourceId: string;
  name: string;
  icon?: string;
  color?: string;
  cents: number;
}

export interface UnplannedGoal extends UnplannedFunding {
  kind: 'goal';
  sourceId: string;
  name: string;
  icon?: string;
  color?: string;
  cents: number;
}

// each slice has one owner (sliceOwner): the source wins over the category, so "Plan it" adds the mirrored subject
export type UnplannedRow = UnplannedMain | UnplannedRecurring | UnplannedDebt | UnplannedEvent | UnplannedGoal;

export const unplannedKey = (row: Pick<UnplannedMain, 'kind' | 'mainId'> | Pick<Exclude<UnplannedRow, UnplannedMain>, 'kind' | 'sourceId'>): string =>
  `${row.kind}:${row.kind === 'category' ? row.mainId : row.sourceId}`;

// category spending no expense or budget subject answers for; locked families and uncategorised rows are not spending here
export function unplannedByCategory(ledger: PeriodLedger, covered: ReadonlySet<string>, catalog: CatalogLookup): UnplannedMain[] {
  const byMain = new Map<string, Map<string, number>>();
  for (const [catId, spent] of ledger.byCategory) {
    if (!catId || covered.has(catId)) continue;
    const cat = catalog.byId(catId);
    const mainId = cat.parentId ?? cat.id;
    if (LOCKED_MAIN_IDS.has(mainId)) continue;
    const subs = byMain.get(mainId) ?? new Map<string, number>();
    subs.set(catId, (subs.get(catId) ?? 0) + spent);
    byMain.set(mainId, subs);
  }
  return [...byMain]
    .map(([mainId, subs]) => ({
      kind: 'category' as const,
      mainId,
      cents: [...subs.values()].reduce((sum, v) => sum + v, 0),
      subs: [...subs].map(([catId, cents]) => ({ catId, cents })).sort((a, b) => b.cents - a.cents),
    }))
    .filter((main) => main.cents > 0)
    .sort((a, b) => b.cents - a.cents);
}

// the same sets the subjects read, so a source never drops out of "already spent" when its subject goes
export interface UnplannedSources {
  /** live recurring costs, stopped ones included */
  recurrings: readonly RecurringRow[];
  /** tracked debts outside the pool, archived ones included */
  loans: readonly AccountRow[];
  /** live events, archived ones included */
  events: readonly EventRow[];
  /** live goals, archived ones included */
  goals: readonly GoalRow[];
  contributions: readonly GoalContributionRow[];
}

const mirroredIds = (subjects: readonly PlanSubjectRow[], segment: PlanSegmentKind): Set<string> =>
  new Set(subjects.filter((s) => s.deleted === 0 && s.segment === segment && s.sourceId).map((s) => s.sourceId!));

const byCents = <R extends { cents: number }>(rows: R[]): R[] => rows.filter((r) => r.cents > 0).sort((a, b) => b.cents - a.cents);

type UnplannedSource = UnplannedRecurring | UnplannedDebt | UnplannedEvent | UnplannedGoal;

export function unplannedSources(
  subjects: readonly PlanSubjectRow[],
  sources: UnplannedSources,
  ledger: PeriodLedger,
  period: Period,
): UnplannedSource[] {
  const held = (segment: PlanSegmentKind) => mirroredIds(subjects, segment);
  const recurringHeld = held('recurring');
  const recurring = byCents(
    sources.recurrings
      .filter((r) => r.deleted === 0 && !recurringHeld.has(r.id))
      .map((r): UnplannedRecurring => ({ kind: 'recurring', sourceId: r.id, name: r.name, icon: r.icon, cents: ledger.byRecurring.get(r.id) ?? 0 })),
  );
  const debtHeld = held('debts');
  const debts = byCents(
    sources.loans
      .filter((a) => a.deleted === 0 && !debtHeld.has(a.id))
      .map((a): UnplannedDebt => ({ kind: 'debt', sourceId: a.id, name: a.name, color: a.color, cents: ledger.byDebt.get(a.id) ?? 0 })),
  );
  const eventHeld = held('events');
  const events = byCents(
    sources.events
      .filter((e) => e.deleted === 0 && !eventHeld.has(e.id))
      .map((e): UnplannedEvent => ({ kind: 'event', sourceId: e.id, name: e.name, icon: e.icon, color: e.color, cents: ledger.byEvent.get(e.id) ?? 0 })),
  );
  const goalHeld = held('goals');
  const goals = byCents(
    sources.goals
      .filter((g) => g.deleted === 0 && !goalHeld.has(g.id))
      .map((g): UnplannedGoal => ({ kind: 'goal', sourceId: g.id, name: g.name, icon: g.icon, color: g.color, cents: goalRealizedCents(g.id, sources.contributions, period) })),
  );
  return [...recurring, ...debts, ...events, ...goals];
}

// the plan's own reading order: what must be paid first (recurring, loans), then categories, then events and goals
export function unplannedRows(
  subjects: readonly PlanSubjectRow[],
  sources: UnplannedSources,
  ledger: PeriodLedger,
  period: Period,
  covered: ReadonlySet<string>,
  catalog: CatalogLookup,
): UnplannedRow[] {
  const mirrored = unplannedSources(subjects, sources, ledger, period);
  const first = mirrored.filter((r) => r.kind === 'recurring' || r.kind === 'debt');
  const last = mirrored.filter((r) => r.kind === 'event' || r.kind === 'goal');
  return [...first, ...unplannedByCategory(ledger, covered, catalog), ...last];
}

const goalHeldBefore = (goalId: string, contributions: readonly GoalContributionRow[], period: Period): number =>
  contributions.filter((c) => c.deleted === 0 && c.goalId === goalId && c.date < period.start).reduce((sum, c) => sum + c.amountCents, 0);

export function goalRealizedCents(goalId: string, contributions: readonly GoalContributionRow[], period: Period): number {
  return contributions
    .filter((c) => c.deleted === 0 && c.goalId === goalId && c.amountCents > 0 && inPeriod(c.date, period))
    .reduce((sum, c) => sum + c.amountCents, 0);
}

const BUDGET_CYCLE_DAYS: Record<BudgetRow['every'], number | null> = { week: 7, '2weeks': 14, month: 30.44, period: null };

export function budgetTargetCents(budget: BudgetRow, period: Period, opts: BudgetPeriodOpts = {}): { cents: number; cycles: number } {
  const cycleDays = BUDGET_CYCLE_DAYS[budget.every];
  const days = periodLengthDays(period);
  if (cycleDays === null) return { cents: budget.amountCents, cycles: 1 };
  if (cycleDays >= days) {
    return { cents: Math.round((budget.amountCents * days) / cycleDays), cycles: 1 };
  }
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

export function spreadTargetCents(amountCents: number, carriedCents: number, periodsLeft: number): number {
  const left = Math.max(1, periodsLeft);
  return Math.max(0, Math.round((amountCents - carriedCents) / left));
}

const RECURRING_CYCLE_DAYS: Record<RecurringRow['every'], number> = { week: 7, month: 30.44, year: 365.25 };

// #557: a cost not due every period (a yearly bill in a monthly plan) is set aside to be spent later, so its unspent
// leftover stays with the period; a cost due every period hands it back
export const isLongCadence = (rec: Pick<RecurringRow, 'every' | 'everyN'>, period: Period): boolean =>
  RECURRING_CYCLE_DAYS[rec.every] * Math.max(1, rec.everyN ?? 1) > periodLengthDays(period) + 3;

export function recurringDueFrom(rec: Pick<RecurringRow, 'active' | 'every' | 'everyN' | 'dueDay' | 'dueMonth' | 'since' | 'until'>, period: Period): string | null {
  return nextDueDate(rec, period.start);
}

export function recurringTargetCents(
  rec: Pick<RecurringRow, 'active' | 'amountCents' | 'every' | 'everyN' | 'dueDay' | 'dueMonth' | 'since' | 'until'>,
  space: PeriodSpace,
  period: Period,
  carriedCents: number,
): number {
  // a cost due more than once inside the period (weekly in a monthly plan) wants every occurrence, not one
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

export function goalTargetCents(goal: Pick<GoalRow, 'targetCents' | 'allocatedCents' | 'targetDate'>, space: PeriodSpace, period: Period): number | null {
  if (!goal.targetDate) return null;
  const remaining = Math.max(0, goal.targetCents - goal.allocatedCents);
  if (remaining === 0) return 0;
  return Math.ceil(remaining / periodsUntil(space, period, goal.targetDate));
}

/** an event's first and last day; an event with one date is that one day, an undated one has neither */
const eventSpan = (event: Pick<EventRow, 'from' | 'to'>): { start: string; end: string } | null => {
  const start = event.from ?? event.to;
  const end = event.to ?? event.from;
  return start && end ? { start, end } : null;
};

/** #504: an event is past for a period once it ended before the period starts; an undated event never is */
export const isEventPast = (event: Pick<EventRow, 'from' | 'to'>, period: Period): boolean => {
  const span = eventSpan(event);
  return !!span && span.end < period.start;
};

/** the event takes place (in part) inside the period — or has no date, so it could be any time */
export const eventInPeriod = (event: Pick<EventRow, 'from' | 'to'>, period: Period): boolean => {
  const span = eventSpan(event);
  return !span || (span.start <= period.end && span.end >= period.start);
};

// #504: the person's own total, else the estimate; what it cost before and what was set aside come off, the rest
// spreads over the periods until it starts; undated, all of it is due now
export function eventTargetCents(
  event: Pick<EventRow, 'from' | 'to' | 'budgetCents'>,
  ownTotalCents: number | null | undefined,
  space: PeriodSpace,
  period: Period,
  carriedCents: number,
  spentBeforeCents: number,
): number | null {
  const total = ownTotalCents ?? event.budgetCents ?? null;
  if (total === null) return null;
  const span = eventSpan(event);
  const left = span ? periodsUntil(space, period, span.start) : 1;
  return spreadTargetCents(Math.max(0, total - spentBeforeCents), carriedCents, left);
}

// settled (#557: an ahead period earlier funding covers) wins; overspent (more left than funded) is red
// past target but funded: green with orange stripes (#517); budgets are green from nought (a ceiling)
// a skipped subject is green by decree
export function subjectStatus(
  segment: PlanSegmentKind,
  targetCents: number | null,
  fundedCents: number,
  realizedCents: number,
  snoozed: boolean,
  settled = false,
): SubjectStatus {
  if (settled) return 'settled';
  if (snoozed) return 'snoozed';
  if (realizedCents > fundedCents) return 'overspent';
  if (targetCents !== null && targetCents > 0 && realizedCents > targetCents) return 'overTarget';
  if (OPTIONAL_SEGMENTS.has(segment)) return 'funded';
  if (targetCents !== null && targetCents > 0) return fundedCents >= targetCents ? 'funded' : 'underfunded';
  return fundedCents > 0 ? 'funded' : 'neutral';
}

export interface SubjectView {
  subject: PlanSubjectRow;
  /** what the subject should hold by the end of the period: this period's share on top of what rolled over */
  targetCents: number | null;
  /** what it holds: the period's own funding (the row's `fundedCents`) and what rolled over, never below zero */
  fundedCents: number;
  realizedCents: number;
  /** #557: what earlier periods set aside and never spent (long-cadence costs, events, goals); part of funded and target */
  carriedCents: number;
  /** #557: ahead only — the funding before it already pays the loan, reaches the goal or covers the event */
  settledAhead: boolean;
  cycles: number;
  status: SubjectStatus;
  /** the source row is gone (a deleted budget, loan, goal or recurring cost) */
  orphaned: boolean;
  /** money leaves this period: an occurrence, goal date or event inside it, every expense, budget, loan payment */
  dueThisPeriod: boolean;
  /** #535: older subjects holding some of this one's categories — their spending is counted there, not here */
  overlaps: Overlap[];
  /** #532: a debt whose account is in the money pool — paying it moves money inside the pool, so nothing to plan */
  inPool: boolean;
}

export const canSkipPeriod = (view: Pick<SubjectView, 'subject' | 'dueThisPeriod'>): boolean =>
  view.subject.segment !== 'expenses' && view.subject.segment !== 'budgets' && !view.dueThisPeriod;

export interface SubjectContext {
  space: PeriodSpace & Pick<SpaceRow, 'weekStart'>;
  period: Period;
  ledger: PeriodLedger;
  catalog: CatalogLookup;
  budgetsById: ReadonlyMap<string, BudgetRow>;
  recurringsById: ReadonlyMap<string, RecurringRow>;
  /** every tracked debt the space sees, the pool's own included (#532) */
  loansById: ReadonlyMap<string, AccountRow>;
  eventsById: ReadonlyMap<string, EventRow>;
  goalsById: ReadonlyMap<string, GoalRow>;
  contributions: readonly GoalContributionRow[];
  poolIds: ReadonlySet<string>;
  eventSpentBefore: (eventId: string) => number;
  /** per source id: what earlier periods set aside and never spent — only the sources that keep it (#557) */
  carriedBySource: ReadonlyMap<string, number>;
  /** the period lies after the current one: nothing happened in it yet, and funding before it can settle a subject (#557) */
  ahead?: boolean;
  /** ahead: what the periods before it, from the current one on, hold for a loan and have not paid yet */
  debtFundedBefore?: (loanId: string) => number;
  budgetOpts: BudgetPeriodOpts;
}

const NO_OVERLAPS: Overlap[] = [];

function categoryShare(
  subject: PlanSubjectRow,
  family: ReadonlySet<string>,
  ctx: SubjectContext,
  reservations: ReadonlyMap<string, Reservation> | undefined,
): { realized: number; overlaps: Overlap[] } {
  const overlaps = reservations ? overlapsOf(subject.id, family, reservations) : NO_OVERLAPS;
  const blocked = new Set(overlaps.flatMap((o) => o.catIds));
  return { realized: familySpentCents(family, ctx.ledger, blocked), overlaps };
}

interface Measured {
  target: number | null;
  realized: number;
  cycles?: number;
  dueThisPeriod?: boolean;
  overlaps?: Overlap[];
  inPool?: boolean;
  settled?: boolean;
}

const withCarried = (share: number | null, carried: number): number | null => (share === null ? null : share + carried);

type Measure = (subject: PlanSubjectRow, ctx: SubjectContext, carried: number, reservations: ReadonlyMap<string, Reservation> | undefined) => Measured | null;

const source = <T>(byId: ReadonlyMap<string, T>, subject: PlanSubjectRow): T | undefined => byId.get(subject.sourceId ?? '');

const MEASURE: Record<PlanSegmentKind, Measure> = {
  expenses: (subject, ctx, _carried, reservations) => ({
    target: subject.targetCents ?? 0,
    ...categoryShare(subject, subjectFamily(subject, ctx.catalog), ctx, reservations),
  }),
  budgets: (subject, ctx, _carried, reservations) => {
    const budget = source(ctx.budgetsById, subject);
    if (!budget) return null;
    const scaled = budgetTargetCents(budget, ctx.period, ctx.budgetOpts);
    return { target: scaled.cents, cycles: scaled.cycles, ...categoryShare(subject, budgetFamily(budget.catIds, ctx.catalog), ctx, reservations) };
  },
  recurring: (subject, ctx, carried) => {
    const rec = source(ctx.recurringsById, subject);
    if (!rec) return null;
    return {
      target: recurringTargetCents(rec, ctx.space, ctx.period, carried) + carried,
      realized: ctx.ledger.byRecurring.get(rec.id) ?? 0,
      dueThisPeriod: rec.active === 1 && occurrencesBetween(rec, ctx.period.start, ctx.period.end).length > 0,
    };
  },
  debts: (subject, ctx) => {
    const loan = source(ctx.loansById, subject);
    if (!loan) return null;
    const inPool = ctx.poolIds.has(loan.id);
    const share = inPool ? 0 : debtTargetCents(loan, ctx.space, ctx.period, 0);
    const realized = ctx.ledger.byDebt.get(loan.id) ?? 0;
    if (!ctx.ahead || !ctx.debtFundedBefore || share === 0) return { target: share, realized, inPool };
    // ahead (#557): what the periods before this one hold already pays part of the loan, or all of it
    const open = Math.max(0, loanRemainingCents(loan) - ctx.debtFundedBefore(loan.id));
    return { target: Math.min(share, open), realized, inPool, settled: open === 0 };
  },
  events: (subject, ctx, carried) => {
    const event = source(ctx.eventsById, subject);
    if (!event) return null;
    const share = eventTargetCents(event, subject.targetCents, ctx.space, ctx.period, carried, ctx.eventSpentBefore(event.id));
    return {
      target: withCarried(share, carried),
      realized: ctx.ledger.byEvent.get(event.id) ?? 0,
      dueThisPeriod: eventInPeriod(event, ctx.period),
      // #557 (user 2026-11-11): a fully funded event that is still to come needs nothing ahead
      settled: ctx.ahead === true && share === 0 && carried > 0 && !isEventPast(event, ctx.period),
    };
  },
  goals: (subject, ctx, carried) => {
    const goal = source(ctx.goalsById, subject);
    if (!goal) return null;
    // from what the goal held when the period began: a target that shrinks with the period's own contributions reads them as past it;
    // what the plan set aside for it and has not moved to savings yet counts as on its way (#557)
    const heldBefore = goalHeldBefore(goal.id, ctx.contributions, ctx.period);
    const share = goalTargetCents({ ...goal, allocatedCents: heldBefore + carried }, ctx.space, ctx.period);
    return {
      target: withCarried(share, carried),
      realized: goalRealizedCents(goal.id, ctx.contributions, ctx.period),
      dueThisPeriod: !!goal.targetDate && goal.targetDate <= ctx.period.end,
      settled: ctx.ahead === true && carried > 0 && heldBefore + carried >= goal.targetCents,
    };
  },
};

/** a segment this build does not know (a newer device's) reads as nothing to say */
const UNKNOWN: Measured = { target: null, realized: 0 };

// `reservations` decides which overlapping categories count: a later subject counts none of an older one's (#535)
export function subjectView(subject: PlanSubjectRow, ctx: SubjectContext, reservations?: ReadonlyMap<string, Reservation>): SubjectView {
  const carried = ctx.carriedBySource.get(subject.sourceId ?? '') ?? 0;
  // the row holds the period's own funding — below zero once rolled-over money was taken away again
  const funded = Math.max(0, subject.fundedCents + carried);
  const measure = MEASURE[subject.segment] as Measure | undefined;
  const measured = measure ? measure(subject, ctx, carried, reservations) : UNKNOWN;
  const m = measured ?? UNKNOWN;
  return {
    subject,
    targetCents: m.target,
    fundedCents: funded,
    realizedCents: m.realized,
    carriedCents: carried,
    cycles: m.cycles ?? 1,
    status: subjectStatus(subject.segment, m.target, funded, m.realized, subject.snoozed === 1, m.settled),
    settledAhead: m.settled ?? false,
    orphaned: measured === null,
    dueThisPeriod: m.dueThisPeriod ?? true,
    overlaps: m.overlaps ?? NO_OVERLAPS,
    inPool: m.inPool ?? false,
  };
}

export const shortfallCents = (view: Pick<SubjectView, 'targetCents' | 'fundedCents'>): number =>
  view.targetCents === null ? 0 : Math.max(0, view.targetCents - view.fundedCents);

/** funded money not yet spent — what can be taken away without going red */
export const slackCents = (view: Pick<SubjectView, 'fundedCents' | 'realizedCents'>): number =>
  Math.max(0, view.fundedCents - view.realizedCents);

// period's own share and funding (#557): rolled-over money is no funding ahead, a settled subject asks for none
// nothing mandatory to fund counts for nothing
export function planFundedFraction(views: readonly Pick<SubjectView, 'subject' | 'targetCents' | 'fundedCents' | 'carriedCents'>[]): number {
  let need = 0;
  let got = 0;
  for (const view of views) {
    if (OPTIONAL_SEGMENTS.has(view.subject.segment) || view.subject.snoozed === 1) continue;
    const share = (view.targetCents ?? 0) - view.carriedCents;
    if (share <= 0) continue;
    need += share;
    got += Math.min(share, Math.max(0, view.fundedCents - view.carriedCents));
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

export interface TargetEstimate {
  lastCents: number | null;
  averageCents: number | null;
}

/** what a family cost in the previous period and on average — the past periods' ledgers newest last, the current one excluded */
export function estimateTarget(family: ReadonlySet<string>, pastLedgers: readonly PeriodLedger[]): TargetEstimate {
  if (pastLedgers.length === 0) return { lastCents: null, averageCents: null };
  const spent = pastLedgers.map((ledger) => familySpentCents(family, ledger));
  return {
    lastCents: spent.at(-1) ?? null,
    averageCents: Math.round(spent.reduce((sum, v) => sum + v, 0) / spent.length),
  };
}

export interface CoverCandidates {
  picks: SubjectView[];
  all: SubjectView[];
}

// picks: subjects already past their target (nothing planned is lost) and budgets (a ceiling), most slack first
export function coverCandidates(views: readonly SubjectView[], forSubjectId: string): CoverCandidates {
  const all = views
    .filter((v) => v.subject.id !== forSubjectId && v.subject.deleted === 0 && slackCents(v) > 0)
    .sort((a, b) => slackCents(b) - slackCents(a));
  const generous = (v: SubjectView) =>
    OPTIONAL_SEGMENTS.has(v.subject.segment) || (v.targetCents !== null && v.fundedCents > v.targetCents) || v.subject.snoozed === 1;
  const picks = all.filter(generous).slice(0, 3);
  return { picks: picks.length > 0 ? picks : all.slice(0, 3), all };
}

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

export interface RelevanceSources {
  recurringsById: ReadonlyMap<string, Pick<RecurringRow, 'active' | 'until'>>;
  loansById: ReadonlyMap<string, Pick<AccountRow, 'archived' | 'balanceCents'>>;
  budgetsById: ReadonlyMap<string, Pick<BudgetRow, 'active'>>;
  eventsById: ReadonlyMap<string, Pick<EventRow, 'from' | 'to' | 'archived'>>;
  goalsById: ReadonlyMap<string, Pick<GoalRow, 'archived' | 'allocatedCents' | 'targetCents'>>;
  poolIds: ReadonlySet<string>;
}

// stays behind: an event over before it starts (#504), a debt paid off, archived or in the pool, a goal reached or archived,
// a stopped or ended cost, a budget switched off, a gone source; an expense subject always goes along
export function stillRelevant(shape: Pick<SubjectShape, 'segment' | 'sourceId'>, period: Period, sources: RelevanceSources): boolean {
  const id = shape.sourceId ?? '';
  switch (shape.segment) {
    case 'recurring': {
      const rec = sources.recurringsById.get(id);
      return !!rec && rec.active === 1 && (!rec.until || rec.until >= period.start);
    }
    case 'debts': {
      const loan = sources.loansById.get(id);
      return !!loan && loan.archived !== 1 && !sources.poolIds.has(id) && loanRemainingCents(loan) > 0;
    }
    case 'budgets':
      return sources.budgetsById.get(id)?.active === 1;
    case 'events': {
      const event = sources.eventsById.get(id);
      return !!event && event.archived !== 1 && !isEventPast(event, period);
    }
    case 'goals': {
      const goal = sources.goalsById.get(id);
      return !!goal && goal.archived !== 1 && goal.allocatedCents < goal.targetCents;
    }
    default:
      return true;
  }
}

const signature = (shape: SubjectShape): string =>
  [
    shape.segment,
    shape.sourceId ?? '',
    (shape.catIds ?? []).join(','),
    (shape.excludeCatIds ?? []).join(','),
    shape.targetCents ?? '',
    shape.segment === 'expenses' ? shape.name : '',
  ].join('|');

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
  eventIds: ReadonlySet<string>;
  goalIds: ReadonlySet<string>;
}

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
      case 'events':
        return !sources.eventIds.has(s.sourceId ?? '');
      case 'goals':
        return !sources.goalIds.has(s.sourceId ?? '');
      default:
        return false;
    }
  });
}

export interface RecommendInput {
  catalog: CatalogLookup & { parents: { id: string; icon?: string; color?: string }[] };
  nameOf: (catId: string) => string;
  /** the past periods' ledgers, newest last, the current one excluded */
  pastLedgers: readonly PeriodLedger[];
  budgets: readonly BudgetRow[];
  recurrings: readonly RecurringRow[];
  accounts: readonly AccountRow[];
  /** the money pool's accounts: a card in the pool is no debt to plan (#532) */
  poolIds?: ReadonlySet<string>;
  events?: readonly EventRow[];
  goals: readonly GoalRow[];
  /** what the person earns per period, when it can be told (the recurring income or the period's income); null = unknown */
  incomeCents: number | null;
  space: PeriodSpace;
  period: Period;
}

const plannableLoan = (a: AccountRow, poolIds: ReadonlySet<string> | undefined): boolean =>
  a.deleted === 0 && a.archived !== 1 && isDebtTracked(a) && !poolIds?.has(a.id);

// nothing is funded, the person looks first; goals come in only when the income leaves room after everything else
export function recommendSubjects(input: RecommendInput): SubjectShape[] {
  const out: SubjectShape[] = [];
  const budgets = input.budgets.filter((b) => b.deleted === 0 && b.active === 1);
  const reserved = new Set(budgets.flatMap((b) => [...budgetFamily(b.catIds, input.catalog)]));
  const loans = input.accounts.filter((a) => plannableLoan(a, input.poolIds));

  let order = 0;
  for (const rec of input.recurrings.filter((r) => r.deleted === 0 && r.active === 1)) {
    out.push({ segment: 'recurring', order: order++, name: rec.name, icon: rec.icon, sourceId: rec.id });
  }
  order = 0;
  for (const loan of loans) {
    out.push({ segment: 'debts', order: order++, name: loan.name, sourceId: loan.id });
  }
  order = 0;
  let planned = 0;
  for (const parent of input.catalog.parents) {
    const family = subjectFamily({ catIds: [parent.id] }, input.catalog);
    if ([...family].some((id) => reserved.has(id))) continue;
    const estimate = estimateTarget(family, input.pastLedgers);
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
  order = 0;
  for (const event of (input.events ?? []).filter((e) => e.deleted === 0 && e.archived !== 1 && !!e.budgetCents && !isEventPast(e, input.period))) {
    planned += eventTargetCents(event, null, input.space, input.period, 0, 0) ?? 0;
    out.push({ segment: 'events', order: order++, name: event.name, icon: event.icon, color: event.color, sourceId: event.id });
  }
  const committed =
    planned +
    input.recurrings.filter((r) => r.deleted === 0 && r.active === 1).reduce((sum, r) => sum + recurringTargetCents(r, input.space, input.period, 0), 0) +
    loans.reduce((sum, a) => sum + debtTargetCents(a, input.space, input.period, 0), 0);
  if (input.incomeCents !== null && input.incomeCents > committed) {
    order = 0;
    for (const goal of input.goals.filter((g) => g.deleted === 0 && g.archived !== 1)) {
      out.push({ segment: 'goals', order: order++, name: goal.name, icon: goal.icon, color: goal.color, sourceId: goal.id });
    }
  }
  return out;
}
