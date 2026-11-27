import type { StorageBackend } from '@/db/backend';
import { visibleAccounts, visibleTransactions } from '@/db/joined';
import type { SpaceAccount, SpaceTx } from '@/db/joined';
import type {
  BudgetRow,
  EventRow,
  GoalContributionRow,
  GoalRow,
  PlanRow,
  PlanSegmentConfig,
  PlanSegmentKind,
  PlanSubjectRow,
  RecurringRow,
  SpaceRow,
} from '@/db/types';
import { budgetOptsFor } from '@/domain/budgets';
import { buildCatalog, visibleCategoryRows } from '@/domain/catalog';
import type { Catalog } from '@/domain/catalog';
import type { CatalogDoc } from '@/domain/catalogDoc';
import { isDebtTracked } from '@/domain/debts';
import { goalPaidTxs } from '@/domain/goals';
import { nextPeriod, periodHistory } from '@/domain/periods';
import type { Period } from '@/domain/periods';
import { slackCents,
  OPTIONAL_SEGMENTS,
  SEGMENT_ORDER,
  aheadSuggested,
  categoryReservations,
  estimateTarget,
  eventNetBefore,
  goalRealizedCents,
  debtDueLater,
  isLongCadence,
  periodLedger,
  periodsAhead,
  planFundedFraction,
  planId,
  planPoolAccounts,
  poolCents,
  subjectFamily,
  subjectView,
  unplannedKey,
  unplannedRows,
} from '@/domain/planning';
import type {
  PeriodLedger,
  RelevanceSources,
  Reservation,
  SliceOwners,
  SubjectContext,
  SubjectStatus,
  SubjectView,
  TargetEstimate,
  UnplannedRow,
} from '@/domain/planning';
import { CATALOG_BASELINE } from '@/generated/catalogBaseline';

// the rows and model every reader shares (tab, home block, dot, picker, service worker alert) so surfaces agree;
// no React in here: the worker imports it

export interface PlanningData {
  space: SpaceRow | undefined;
  plans: PlanRow[];
  /** the period starts of actual plans that were started over (#557: a tombstone the continuation leaves alone) */
  removedPlanStarts: ReadonlySet<string>;
  subjects: PlanSubjectRow[];
  txs: SpaceTx[];
  accounts: SpaceAccount[];
  budgets: BudgetRow[];
  recurrings: RecurringRow[];
  events: EventRow[];
  goals: GoalRow[];
  contributions: GoalContributionRow[];
  catalog: Catalog;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** LOCAL calendar day (toISOString is UTC — wrong during the first local hours of a day) */
export const localIsoToday = (d = new Date()): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const parseLocalDate = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};

const live = <T extends { deleted: 0 | 1 }>(rows: T[]): T[] => rows.filter((r) => r.deleted === 0);

export async function loadPlanningData(store: StorageBackend, spaceId: string): Promise<PlanningData> {
  const [rows, txs] = await Promise.all([loadPlanningRows(store, spaceId), visibleTransactions(store, spaceId)]);
  return { ...rows, txs };
}

/** what the model needs besides the transactions — a screen joins those with the space's one shared
 *  read (#554: the tab's dot and Home's block each joined every transaction again on every write) */
export async function loadPlanningRows(store: StorageBackend, spaceId: string): Promise<Omit<PlanningData, 'txs'>> {
  const [space, plans, subjects, accounts, budgets, recurrings, events, goals, contributions, allSpaces, allCats, docRow] = await Promise.all([
    store.get('space', spaceId),
    store.bySpace('plan', spaceId),
    store.bySpace('planSubject', spaceId),
    visibleAccounts(store, spaceId),
    store.bySpace('budget', spaceId),
    store.bySpace('recurring', spaceId),
    store.bySpace('event', spaceId),
    store.bySpace('goal', spaceId),
    store.bySpace('goalContribution', spaceId),
    store.allRows('space'),
    store.allRows('category'),
    store.metaGet('catalog'),
  ]);
  const vis = visibleCategoryRows(live(allSpaces), live(allCats), spaceId);
  const doc = (docRow?.value as CatalogDoc | undefined) ?? CATALOG_BASELINE;
  const allocated = new Map<string, number>();
  for (const c of live(contributions)) allocated.set(c.goalId, (allocated.get(c.goalId) ?? 0) + c.amountCents);
  return {
    space,
    plans: live(plans),
    removedPlanStarts: new Set(plans.filter((p) => p.deleted === 1 && p.kind === 'actual' && p.periodStart).map((p) => p.periodStart!)),
    subjects: live(subjects),
    accounts,
    budgets: live(budgets),
    recurrings: live(recurrings),
    events: live(events),
    goals: live(goals).map((g) => ({ ...g, allocatedCents: allocated.get(g.id) ?? 0 })),
    contributions: live(contributions),
    catalog: buildCatalog(vis.rows, vis.sharedScope, vis.hiddenMains, doc),
  };
}

export interface PlanAhead {
  period: Period;
  plan: PlanRow;
  views: SubjectView[];
  fundedCents: number;
  fraction: number;
}

export type PlanEditability = 'full' | 'moveOnly' | 'readOnly';

export interface PlanningModel {
  data: PlanningData;
  today: string;
  period: Period;
  previousPeriod: Period;
  pastPeriods: Period[];
  plan: PlanRow | null;
  pastPlans: PlanRow[];
  sandbox: PlanRow | null;
  blueprints: PlanRow[];
  poolCents: number;
  poolAccounts: SpaceAccount[];
  poolIds: ReadonlySet<string>;
  relevance: RelevanceSources;
  /** #557: no plan, not started over, newest earlier plan has subjects: it carries over by itself */
  continuable: boolean;
  pastLedgers: PeriodLedger[];
  aheadSuggested: number;
  ahead: PlanAhead[];
  aheadFundedCents: number;
  aheadCount: number;
  nextAheadPeriod: Period;
  /** what the current plan still holds per segment: funded and not yet realized, a one-off under its row's segment (#541: safe to spend's set-asides) */
  heldBySegment: ReadonlyMap<PlanSegmentKind, number>;
  periodOf: (plan: PlanRow) => Period;
  editabilityOf: (plan: PlanRow) => PlanEditability;
  subjectsOf: (plan: PlanRow) => PlanSubjectRow[];
  viewsOf: (plan: PlanRow) => SubjectView[];
  segmentsOf: (plan: PlanRow) => PlanSegmentConfig[];
  /** what the plan's period STARTED with: the pool now plus what the period already spent (see toAllocateOf) */
  startedWithOf: (plan: PlanRow) => number;
  toAllocateOf: (plan: PlanRow) => number;
  reservationsOf: (plan: PlanRow) => Map<string, Reservation>;
  /** money outside every subject (unmirrored sources, unanswered category spending), with its one-off funding (#494) */
  unplannedOf: (plan: PlanRow) => UnplannedRow[];
  /** #455: what cashed-out goals bought in the period; its savings paid, so not part of what the period started with */
  goalPurchasesOf: (plan: PlanRow) => GoalPurchase[];
  estimate: (family: ReadonlySet<string>) => TargetEstimate;
  contextFor: (period: Period) => SubjectContext;
  attention: SubjectView[];
}

const PAST_PERIODS = 6;
const AHEAD_SEARCH = 48;

const segmentIndex = (segments: readonly PlanSegmentConfig[], kind: PlanSegmentKind): number => {
  const index = segments.findIndex((s) => s.kind === kind);
  return index === -1 ? SEGMENT_ORDER.indexOf(kind) + segments.length : index;
};

export function segmentsOf(plan: Pick<PlanRow, 'segments'> | null | undefined): PlanSegmentConfig[] {
  const saved = (plan?.segments ?? []).filter((s) => SEGMENT_ORDER.includes(s.kind));
  const present = new Set(saved.map((s) => s.kind));
  return [...saved, ...SEGMENT_ORDER.filter((kind) => !present.has(kind)).map((kind) => ({ kind }))];
}

export const sortSubjects = (rows: readonly PlanSubjectRow[], segments: readonly PlanSegmentConfig[]): PlanSubjectRow[] =>
  [...rows].sort(
    (a, b) => segmentIndex(segments, a.segment) - segmentIndex(segments, b.segment) || a.order - b.order || a.name.localeCompare(b.name),
  );

const DEFAULT_SPACE = { periodType: 'month', periodDay: 1 } as SpaceRow;

/** how far a plan's leftover looks past its own period for spending, when the periods after it were never planned */
const GAP_PERIODS = 24;

const NOTHING_ROLLED: ReadonlyMap<string, number> = new Map();

interface Leftover {
  start: string;
  left: ReadonlyMap<string, number>;
}

interface RollOverInput {
  chain: readonly PlanRow[];
  subjectsByPlan: ReadonlyMap<string, PlanSubjectRow[]>;
  periodOf: (plan: PlanRow) => Period;
  periodAfter: (period: Period) => Period;
  keeps: (subject: PlanSubjectRow, period: Period) => boolean;
  realized: (subject: PlanSubjectRow, period: Period) => number;
}

// #557: unspent long-cadence recurring, event and goal funding reads as funding in the next plan;
// spending in unplanned periods comes off too
function rollOver(input: RollOverInput): Leftover[] {
  const out: Leftover[] = [];
  let before: ReadonlyMap<string, number> = NOTHING_ROLLED;
  for (const [index, plan] of input.chain.entries()) {
    const own = input.periodOf(plan);
    const nextStart = input.chain[index + 1]?.periodStart;
    const left = new Map<string, number>();
    // #692: a plan started by hand on its own period begins with nothing — what earlier plans set aside is released
    if (plan.fresh === 1) before = NOTHING_ROLLED;
    for (const subject of input.subjectsByPlan.get(plan.id) ?? []) {
      if (subject.deleted !== 0 || !subject.sourceId || !input.keeps(subject, own)) continue;
      let cents = subject.fundedCents + (before.get(subject.sourceId) ?? 0) - input.realized(subject, own);
      let gap = input.periodAfter(own);
      for (let n = 0; n < GAP_PERIODS && nextStart && gap.start < nextStart; n += 1) {
        cents -= input.realized(subject, gap);
        gap = input.periodAfter(gap);
      }
      if (cents > 0) left.set(subject.sourceId, cents);
    }
    out.push({ start: plan.periodStart!, left });
    before = left;
  }
  return out;
}

export interface GoalPurchase {
  goal: GoalRow;
  cents: number;
}

const UNPLANNED_SEGMENT: Record<UnplannedRow['kind'], PlanSegmentKind> = {
  category: 'expenses',
  recurring: 'recurring',
  debt: 'debts',
  event: 'events',
  goal: 'goals',
};

const oneOffMap = (plan: PlanRow): Map<string, number> => new Map((plan.oneOffs ?? []).filter((o) => o.fundedCents !== 0).map((o) => [o.key, o.fundedCents]));

/** a one-off whose row spent nothing this period still shows — the face comes from its source */
function fundedOnlyRow(key: string, data: PlanningData, loansById: ReadonlyMap<string, SpaceAccount>): UnplannedRow | null {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  switch (kind) {
    case 'category':
      return { kind: 'category', mainId: id, cents: 0, subs: [] };
    case 'recurring': {
      const rec = data.recurrings.find((r) => r.id === id);
      return rec ? { kind: 'recurring', sourceId: id, name: rec.name, icon: rec.icon, cents: 0 } : null;
    }
    case 'debt': {
      const loan = loansById.get(id);
      return loan ? { kind: 'debt', sourceId: id, name: loan.name, color: loan.color, cents: 0 } : null;
    }
    case 'event': {
      const event = data.events.find((e) => e.id === id);
      return event ? { kind: 'event', sourceId: id, name: event.name, icon: event.icon, color: event.color, cents: 0 } : null;
    }
    case 'goal': {
      const goal = data.goals.find((g) => g.id === id);
      return goal ? { kind: 'goal', sourceId: id, name: goal.name, icon: goal.icon, color: goal.color, cents: 0 } : null;
    }
    default:
      return null;
  }
}

export function buildPlanning(data: PlanningData, today = localIsoToday()): PlanningModel {
  const space = data.space ?? DEFAULT_SPACE;
  const history = periodHistory(space.periodType, space.periodDay, PAST_PERIODS + 1, parseLocalDate(today));
  const period = history.at(-1)!;
  const pastPeriods = history.slice(0, -1);
  const previousPeriod = pastPeriods.at(-1) ?? period;

  const actualByStart = new Map<string, PlanRow>();
  const blueprints: PlanRow[] = [];
  let sandbox: PlanRow | null = null;
  for (const plan of data.plans) {
    if (plan.kind === 'actual' && plan.periodStart) actualByStart.set(plan.periodStart, plan);
    else if (plan.kind === 'blueprint') blueprints.push(plan);
    else if (plan.kind === 'sandbox' && plan.periodStart === period.start) sandbox = plan;
  }
  blueprints.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  const subjectsByPlan = new Map<string, PlanSubjectRow[]>();
  for (const subject of data.subjects) {
    const list = subjectsByPlan.get(subject.planId) ?? [];
    list.push(subject);
    subjectsByPlan.set(subject.planId, list);
  }
  const subjectsOf = (plan: PlanRow): PlanSubjectRow[] => sortSubjects(subjectsByPlan.get(plan.id) ?? [], segmentsOf(plan));

  const budgetsById = new Map(data.budgets.map((b) => [b.id, b]));
  const recurringsById = new Map(data.recurrings.map((r) => [r.id, r]));
  const loansById = new Map(data.accounts.filter((a) => isDebtTracked(a)).map((a) => [a.id, a]));
  const eventsById = new Map(data.events.map((e) => [e.id, e]));
  const goalsById = new Map(data.goals.map((g) => [g.id, g]));
  const budgetOpts = budgetOptsFor(data.space);
  const poolAccounts = planPoolAccounts(data.accounts, data.space);
  const poolIds: ReadonlySet<string> = new Set(poolAccounts.map((a) => a.id));
  // one owner per slice (sliceOwner): a debt in the pool is no debt — paying it moves money inside the pool
  const owners: SliceOwners = {
    recurringIds: new Set(recurringsById.keys()),
    loanIds: new Set([...loansById.keys()].filter((id) => !poolIds.has(id))),
    eventIds: new Set(eventsById.keys()),
    poolIds,
    goalByTx: goalPaidTxs(data.goals),
  };

  const ledgers = new Map<string, PeriodLedger>();
  const ledgerFor = (forPeriod: Period): PeriodLedger => {
    const cached = ledgers.get(forPeriod.start);
    if (cached) return cached;
    const ledger = periodLedger(data.txs, forPeriod, owners);
    ledgers.set(forPeriod.start, ledger);
    return ledger;
  };

  const periodOf = (plan: PlanRow): Period =>
    plan.periodStart ? periodHistory(space.periodType, space.periodDay, 1, parseLocalDate(plan.periodStart))[0] : period;
  const chain = [...actualByStart.values()].sort((a, b) => a.periodStart!.localeCompare(b.periodStart!));
  const realizedOf = (subject: PlanSubjectRow, forPeriod: Period): number => {
    const sourceId = subject.sourceId ?? '';
    if (subject.segment === 'goals') return goalRealizedCents(sourceId, data.contributions, forPeriod);
    if (subject.segment === 'events') return ledgerFor(forPeriod).byEvent.get(sourceId) ?? 0;
    if (subject.segment === 'debts') return ledgerFor(forPeriod).byDebt.get(sourceId) ?? 0;
    return ledgerFor(forPeriod).byRecurring.get(sourceId) ?? 0;
  };
  let leftovers: Leftover[] | null = null;
  const rolledInto = (forPeriod: Period): ReadonlyMap<string, number> => {
    leftovers ??= rollOver({
      chain,
      subjectsByPlan,
      periodOf,
      periodAfter: (p) => nextPeriod(space.periodType, space.periodDay, parseLocalDate(p.end)),
      keeps: (subject, own) => {
        if (subject.segment === 'events' || subject.segment === 'goals') return true;
        // #692: a loan payment that is not due inside the period keeps what is set aside for it, like a yearly bill
        const loan = subject.segment === 'debts' ? loansById.get(subject.sourceId ?? '') : undefined;
        if (loan) return !poolIds.has(loan.id) && debtDueLater(loan, own);
        const rec = subject.segment === 'recurring' ? recurringsById.get(subject.sourceId ?? '') : undefined;
        return !!rec && isLongCadence(rec, own);
      },
      realized: realizedOf,
    });
    if (actualByStart.get(forPeriod.start)?.fresh === 1) return NOTHING_ROLLED;
    for (let i = leftovers.length - 1; i >= 0; i -= 1) if (leftovers[i].start < forPeriod.start) return leftovers[i].left;
    return NOTHING_ROLLED;
  };
  const debtHeldBefore = (forPeriod: Period) => (loanId: string): number => {
    let held = 0;
    for (const plan of chain) {
      if (plan.periodStart! < period.start || plan.periodStart! >= forPeriod.start) continue;
      const subject = (subjectsByPlan.get(plan.id) ?? []).find((s) => s.deleted === 0 && s.segment === 'debts' && s.sourceId === loanId);
      if (subject) held += Math.max(0, subject.fundedCents - realizedOf(subject, periodOf(plan)));
    }
    return held;
  };

  const contexts = new Map<string, SubjectContext>();
  const contextFor = (forPeriod: Period): SubjectContext => {
    const cached = contexts.get(forPeriod.start);
    if (cached) return cached;
    const spentBefore = new Map<string, number>();
    const ctx: SubjectContext = {
      space,
      period: forPeriod,
      ledger: ledgerFor(forPeriod),
      catalog: data.catalog,
      budgetsById,
      recurringsById,
      loansById,
      eventsById,
      goalsById,
      contributions: data.contributions,
      poolIds,
      eventSpentBefore: (eventId) => {
        const known = spentBefore.get(eventId);
        if (known !== undefined) return known;
        const net = eventNetBefore(data.txs, eventId, forPeriod.start, owners);
        spentBefore.set(eventId, net);
        return net;
      },
      carriedBySource: rolledInto(forPeriod),
      ahead: forPeriod.start > period.start,
      debtFundedBefore: forPeriod.start > period.start ? debtHeldBefore(forPeriod) : undefined,
      budgetOpts,
    };
    contexts.set(forPeriod.start, ctx);
    return ctx;
  };

  const reservationsOf = (plan: PlanRow): Map<string, Reservation> => categoryReservations(subjectsOf(plan), budgetsById, data.catalog);
  const views = new Map<string, SubjectView[]>();
  const viewsOf = (plan: PlanRow): SubjectView[] => {
    const cached = views.get(plan.id);
    if (cached) return cached;
    const ctx = contextFor(periodOf(plan));
    const reservations = reservationsOf(plan);
    const list = subjectsOf(plan).map((subject) => subjectView(subject, ctx, reservations));
    views.set(plan.id, list);
    return list;
  };

  // a period ahead holds what it was given itself: the money that rolled into it is the plans' before it, counted there (#557)
  const ownFunded = (list: readonly SubjectView[]): number => list.reduce((sum, v) => sum + Math.max(0, v.subject.fundedCents), 0);
  const plan = actualByStart.get(period.start) ?? null;
  const pastPlans = [...actualByStart.values()]
    .filter((p) => p.periodStart! < period.start)
    .sort((a, b) => b.periodStart!.localeCompare(a.periodStart!));
  const ahead: PlanAhead[] = [...actualByStart.values()]
    .filter((p) => p.periodStart! > period.start)
    .sort((a, b) => a.periodStart!.localeCompare(b.periodStart!))
    .map((p) => {
      const list = viewsOf(p);
      return {
        period: periodOf(p),
        plan: p,
        views: list,
        fundedCents: ownFunded(list),
        fraction: planFundedFraction(list),
      };
    });
  const aheadFundedCents = ahead.reduce((sum, a) => sum + a.fundedCents, 0);
  const pool = poolCents(data.accounts, data.space);

  // the Unplanned rows read the very sources the subjects read (#557: archived loans, stopped
  // recurring costs, archived goals and events included), so no money drops out when a subject goes
  const sources = {
    recurrings: data.recurrings,
    loans: [...loansById.values()].filter((a) => !poolIds.has(a.id)),
    events: data.events,
    goals: data.goals,
    contributions: data.contributions,
  };
  const unplanned = new Map<string, UnplannedRow[]>();
  const unplannedOf = (p: PlanRow): UnplannedRow[] => {
    const cached = unplanned.get(p.id);
    if (cached) return cached;
    const subjects = subjectsOf(p);
    const covered = new Set<string>();
    for (const subject of subjects) for (const id of familyOf(subject, data, budgetsById)) covered.add(id);
    const forPeriod = periodOf(p);
    const rows = unplannedRows(subjects, sources, ledgerFor(forPeriod), forPeriod, covered, data.catalog);
    const funding = oneOffMap(p);
    const list: UnplannedRow[] = rows.map((row) => {
      const funded = funding.get(unplannedKey(row));
      return funded ? { ...row, fundedCents: funded } : row;
    });
    const shown = new Set(rows.map(unplannedKey));
    for (const [key, funded] of funding) {
      const row = shown.has(key) ? null : fundedOnlyRow(key, data, loansById);
      if (row) list.push({ ...row, fundedCents: funded });
    }
    unplanned.set(p.id, list);
    return list;
  };
  const goalPurchasesOf = (p: PlanRow): GoalPurchase[] =>
    [...ledgerFor(periodOf(p)).byGoal]
      .flatMap(([id, cents]): GoalPurchase[] => {
        const goal = goalsById.get(id);
        return goal && cents > 0 ? [{ goal, cents }] : [];
      })
      .sort((a, b) => b.cents - a.cents);
  const oneOffsFunded = (p: PlanRow): number => [...oneOffMap(p).values()].reduce((sum, cents) => sum + cents, 0);

  // THE POOL RULE: the pool reads as what the period STARTED with (balance now + what it spent, in and outside subjects);
  // funding and the OTHER periods ahead come off UNCLAMPED (an overspend is handed back as money to assign)
  // INVARIANCE: adding a subject moves its money from Unplanned under it, never changing what the period started with (#557)
  const startedWithOf = (p: PlanRow): number =>
    pool + viewsOf(p).reduce((sum, v) => sum + v.realizedCents, 0) + unplannedOf(p).reduce((sum, m) => sum + m.cents, 0);
  const isAhead = (p: PlanRow): boolean => p.kind === 'actual' && !!p.periodStart && p.periodStart > period.start;
  // #557: what rolled over is money in the pool that is spoken for — it comes off like the period's own funding
  const fundedOf = (p: PlanRow): number =>
    (isAhead(p) ? ownFunded(viewsOf(p)) : viewsOf(p).reduce((sum, v) => sum + v.fundedCents, 0)) + oneOffsFunded(p);
  const aheadHeldExcept = (p: PlanRow): number => ahead.filter((a) => a.plan.id !== p.id).reduce((sum, a) => sum + a.fundedCents, 0);

  const taken = new Set(ahead.map((a) => a.period.start));
  const candidates = periodsAhead(space, AHEAD_SEARCH, parseLocalDate(today));
  const nextAheadPeriod = candidates.find((candidate) => !taken.has(candidate.start)) ?? candidates[0];

  const currentViews = plan ? viewsOf(plan) : [];
  const heldBySegment = new Map<PlanSegmentKind, number>();
  const hold = (segment: PlanSegmentKind, cents: number) => heldBySegment.set(segment, (heldBySegment.get(segment) ?? 0) + cents);
  for (const view of currentViews) hold(view.subject.segment, slackCents(view));
  if (plan) for (const row of unplannedOf(plan)) hold(UNPLANNED_SEGMENT[row.kind], Math.max(0, (row.fundedCents ?? 0) - row.cents));

  const editabilityOf = (p: PlanRow): PlanEditability => {
    if (p.kind !== 'actual' || !p.periodStart || p.periodStart >= period.start) return 'full';
    return p.periodStart === previousPeriod.start ? 'moveOnly' : 'readOnly';
  };

  return {
    data,
    today,
    period,
    previousPeriod,
    pastPeriods,
    plan,
    pastPlans,
    sandbox,
    blueprints,
    poolCents: pool,
    poolAccounts,
    poolIds,
    relevance: { recurringsById, loansById, budgetsById, eventsById, goalsById, poolIds },
    continuable: !plan && !data.removedPlanStarts.has(period.start) && pastPlans.length > 0 && (subjectsByPlan.get(pastPlans[0].id) ?? []).length > 0,
    pastLedgers: pastPeriods.map(ledgerFor),
    aheadSuggested: aheadSuggested(space.periodType),
    ahead,
    aheadFundedCents,
    aheadCount: ahead.reduce((sum, a) => sum + a.fraction, 0),
    nextAheadPeriod,
    heldBySegment,
    periodOf,
    editabilityOf,
    subjectsOf,
    viewsOf,
    segmentsOf: (p) => segmentsOf(p),
    startedWithOf,
    toAllocateOf: (p) => startedWithOf(p) - fundedOf(p) - aheadHeldExcept(p),
    reservationsOf,
    unplannedOf,
    goalPurchasesOf,
    estimate: (family) => estimateTarget(family, pastPeriods.map(ledgerFor)),
    contextFor,
    attention: currentViews.filter((v) => v.status === 'overspent'),
  };
}

export async function hasCurrentPlan(store: StorageBackend, spaceId: string): Promise<boolean> {
  const space = (await store.get('space', spaceId)) ?? DEFAULT_SPACE;
  const current = periodHistory(space.periodType, space.periodDay, 1)[0];
  const row = await store.get('plan', planId(spaceId, 'actual', current.start));
  return !!row && row.deleted === 0;
}

export interface CategoryAvailability {
  subjectName: string;
  color?: string;
  /** funded minus realized — negative when the subject is overspent */
  cents: number;
  /** the space's ledger currency, so a reader without the space row formats it right */
  currency: string;
  status: SubjectStatus;
}

function familyOf(subject: PlanSubjectRow, data: PlanningData, budgetsById: ReadonlyMap<string, BudgetRow>): ReadonlySet<string> {
  if (subject.segment === 'expenses') return subjectFamily(subject, data.catalog);
  if (subject.segment === 'budgets') {
    const budget = subject.sourceId ? budgetsById.get(subject.sourceId) : undefined;
    return subjectFamily({ catIds: budget?.catIds ?? [] }, data.catalog);
  }
  return new Set<string>();
}

export function availabilityByCat(model: PlanningModel): Map<string, CategoryAvailability> {
  const out = new Map<string, CategoryAvailability>();
  if (!model.plan) return out;
  const currency = model.data.space?.currency ?? 'EUR';
  const views = new Map(model.viewsOf(model.plan).map((v) => [v.subject.id, v]));
  // a category answers to the subject that holds it — the one that came into the plan first (#535)
  for (const [catId, holder] of model.reservationsOf(model.plan)) {
    const view = views.get(holder.subjectId);
    if (!view) continue;
    out.set(catId, { subjectName: holder.name, color: view.subject.color, cents: view.fundedCents - view.realizedCents, currency, status: view.status });
  }
  return out;
}

export const isMandatorySegment = (segment: PlanSegmentKind): boolean => !OPTIONAL_SEGMENTS.has(segment);
