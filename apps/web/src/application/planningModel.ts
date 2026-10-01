import type { StorageBackend } from '@/db/backend';
import { visibleAccounts, visibleTransactions } from '@/db/joined';
import type { SpaceAccount, SpaceTx } from '@/db/joined';
import type {
  BudgetRow,
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
import { periodHistory } from '@/domain/periods';
import type { Period } from '@/domain/periods';
import {
  OPTIONAL_SEGMENTS,
  SEGMENT_ORDER,
  aheadSuggested,
  categoryReservations,
  debtRealizedCents,
  estimateTarget,
  periodsAhead,
  planFundedFraction,
  planId,
  planPoolAccounts,
  poolCents,
  recurringRealizedCents,
  subjectFamily,
  subjectView,
} from '@/domain/planning';
import type { Reservation, SubjectContext, SubjectStatus, SubjectView, TargetEstimate } from '@/domain/planning';
import { CATALOG_BASELINE } from '@/generated/catalogBaseline';

/**
 * Planning (#128): the rows and the model every reader shares — the tab,
 * the home block, the tab's attention dot, the category picker and the
 * service worker's alert — so no two surfaces can disagree about what a
 * subject needs or has. No React in here: the worker imports it too.
 */

export interface PlanningData {
  space: SpaceRow | undefined;
  plans: PlanRow[];
  subjects: PlanSubjectRow[];
  txs: SpaceTx[];
  accounts: SpaceAccount[];
  budgets: BudgetRow[];
  recurrings: RecurringRow[];
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

/** every row the model needs, read once */
export async function loadPlanningData(store: StorageBackend, spaceId: string): Promise<PlanningData> {
  const [space, plans, subjects, txs, accounts, budgets, recurrings, goals, contributions, allSpaces, allCats, docRow] = await Promise.all([
    store.get('space', spaceId),
    store.bySpace('plan', spaceId),
    store.bySpace('planSubject', spaceId),
    visibleTransactions(store, spaceId),
    visibleAccounts(store, spaceId),
    store.bySpace('budget', spaceId),
    store.bySpace('recurring', spaceId),
    store.bySpace('goal', spaceId),
    store.bySpace('goalContribution', spaceId),
    store.allRows('space'),
    store.allRows('category'),
    store.metaGet('catalog'),
  ]);
  const vis = visibleCategoryRows(live(allSpaces), live(allCats), spaceId);
  const doc = (docRow?.value as CatalogDoc | undefined) ?? CATALOG_BASELINE;
  // goals carry their allocation derived from the contributions (the goals screen's rule)
  const allocated = new Map<string, number>();
  for (const c of live(contributions)) allocated.set(c.goalId, (allocated.get(c.goalId) ?? 0) + c.amountCents);
  return {
    space,
    plans: live(plans),
    subjects: live(subjects),
    txs,
    accounts,
    budgets: live(budgets),
    recurrings: live(recurrings),
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
  /** 0..1 — how much of the plan's mandatory targets is funded */
  fraction: number;
}

/** what a plan allows: the current and future ones everything, the previous period moving money only, older ones nothing */
export type PlanEditability = 'full' | 'moveOnly' | 'readOnly';

export interface PlanningModel {
  data: PlanningData;
  today: string;
  period: Period;
  previousPeriod: Period;
  /** newest last, the current one excluded — what the estimates look at */
  pastPeriods: Period[];
  plan: PlanRow | null;
  previousPlan: PlanRow | null;
  /** the actual plans of past periods, newest first (the previous one included) */
  pastPlans: PlanRow[];
  sandbox: PlanRow | null;
  blueprints: PlanRow[];
  poolCents: number;
  poolAccounts: SpaceAccount[];
  aheadSuggested: number;
  /** the funded future periods, nearest first */
  ahead: PlanAhead[];
  aheadFundedCents: number;
  /** periods funded ahead, partial ones as fractions */
  aheadCount: number;
  /** the next period without a plan yet */
  nextAheadPeriod: Period;
  /** money the current plan holds for later: funded and not yet realized, plus everything funded ahead */
  reservedCents: number;
  periodOf: (plan: PlanRow) => Period;
  editabilityOf: (plan: PlanRow) => PlanEditability;
  subjectsOf: (plan: PlanRow) => PlanSubjectRow[];
  viewsOf: (plan: PlanRow) => SubjectView[];
  segmentsOf: (plan: PlanRow) => PlanSegmentConfig[];
  toAllocateOf: (plan: PlanRow) => number;
  reservationsOf: (plan: PlanRow) => Map<string, Reservation>;
  estimate: (family: ReadonlySet<string>) => TargetEstimate;
  contextFor: (period: Period) => SubjectContext;
  /** the current actual plan's subjects in the red */
  attention: SubjectView[];
}

const PAST_PERIODS = 6;
const AHEAD_SEARCH = 48;

const segmentIndex = (segments: readonly PlanSegmentConfig[], kind: PlanSegmentKind): number => {
  const index = segments.findIndex((s) => s.kind === kind);
  return index === -1 ? SEGMENT_ORDER.indexOf(kind) + segments.length : index;
};

/** a plan's segment list merged with the defaults: the saved order first, the rest appended in the default order */
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

/** what earlier periods set aside for a recurring cost or a loan and never spent — walked back to the last payment */
function carriedBySource(
  data: PlanningData,
  space: SpaceRow,
  forPeriod: Period,
  actualByStart: ReadonlyMap<string, PlanRow>,
  subjectsByPlan: ReadonlyMap<string, PlanSubjectRow[]>,
): Map<string, number> {
  const out = new Map<string, number>();
  const earlier = [...actualByStart.values()]
    .filter((p) => p.periodStart && p.periodStart < forPeriod.start)
    .sort((a, b) => b.periodStart!.localeCompare(a.periodStart!));
  const sourceIds = new Set(
    data.subjects.filter((s) => (s.segment === 'recurring' || s.segment === 'debts') && s.sourceId).map((s) => s.sourceId!),
  );
  for (const sourceId of sourceIds) {
    let carried = 0;
    for (const plan of earlier) {
      const subject = (subjectsByPlan.get(plan.id) ?? []).find((s) => s.sourceId === sourceId);
      if (!subject) continue;
      const thatPeriod = periodHistory(space.periodType, space.periodDay, 1, parseLocalDate(plan.periodStart!))[0];
      const realized =
        subject.segment === 'debts' ? debtRealizedCents(sourceId, data.txs, thatPeriod) : recurringRealizedCents(sourceId, data.txs, thatPeriod);
      carried += Math.max(0, subject.fundedCents - realized);
      if (realized > 0) break; // the bill was paid in that period: funding before it was spent
    }
    if (carried > 0) out.set(sourceId, carried);
  }
  return out;
}

/** the model, pure — every screen and job reads the same arithmetic */
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
  const goalsById = new Map(data.goals.map((g) => [g.id, g]));
  const budgetOpts = budgetOptsFor(data.space);

  const contexts = new Map<string, SubjectContext>();
  const contextFor = (forPeriod: Period): SubjectContext => {
    const cached = contexts.get(forPeriod.start);
    if (cached) return cached;
    const ctx: SubjectContext = {
      space,
      period: forPeriod,
      txs: data.txs,
      catalog: data.catalog,
      budgetsById,
      recurringsById,
      loansById,
      goalsById,
      contributions: data.contributions,
      carriedBySource: carriedBySource(data, space, forPeriod, actualByStart, subjectsByPlan),
      budgetOpts,
    };
    contexts.set(forPeriod.start, ctx);
    return ctx;
  };

  const periodOf = (plan: PlanRow): Period =>
    plan.periodStart ? periodHistory(space.periodType, space.periodDay, 1, parseLocalDate(plan.periodStart))[0] : period;
  const views = new Map<string, SubjectView[]>();
  const viewsOf = (plan: PlanRow): SubjectView[] => {
    const cached = views.get(plan.id);
    if (cached) return cached;
    const ctx = contextFor(periodOf(plan));
    const list = subjectsOf(plan).map((subject) => subjectView(subject, ctx));
    views.set(plan.id, list);
    return list;
  };

  const plan = actualByStart.get(period.start) ?? null;
  const previousPlan = actualByStart.get(previousPeriod.start) ?? null;
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
        fundedCents: list.reduce((sum, v) => sum + v.fundedCents, 0),
        fraction: planFundedFraction(list),
      };
    });
  const aheadFundedCents = ahead.reduce((sum, a) => sum + a.fundedCents, 0);
  const pool = poolCents(data.accounts, data.space);
  const fundedOf = (p: PlanRow): number => subjectsOf(p).reduce((sum, s) => sum + s.fundedCents, 0);

  const taken = new Set(ahead.map((a) => a.period.start));
  const candidates = periodsAhead(space, AHEAD_SEARCH, parseLocalDate(today));
  const nextAheadPeriod = candidates.find((candidate) => !taken.has(candidate.start)) ?? candidates[0];

  const currentViews = plan ? viewsOf(plan) : [];
  const reservedCents = currentViews.reduce((sum, v) => sum + Math.max(0, v.fundedCents - v.realizedCents), 0) + aheadFundedCents;

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
    previousPlan,
    pastPlans,
    sandbox,
    blueprints,
    poolCents: pool,
    poolAccounts: planPoolAccounts(data.accounts, data.space),
    aheadSuggested: aheadSuggested(space.periodType),
    ahead,
    aheadFundedCents,
    aheadCount: ahead.reduce((sum, a) => sum + a.fraction, 0),
    nextAheadPeriod,
    reservedCents,
    periodOf,
    editabilityOf,
    subjectsOf,
    viewsOf,
    segmentsOf: (p) => segmentsOf(p),
    toAllocateOf: (p) => pool - fundedOf(p) - aheadFundedCents,
    reservationsOf: (p) => categoryReservations(subjectsOf(p), budgetsById, data.catalog),
    estimate: (family) => estimateTarget(family, data.txs, pastPeriods),
    contextFor,
    attention: currentViews.filter((v) => v.status === 'overspent'),
  };
}

/** does the space plan the current period at all? — the cheap gate before the full model is built */
export async function hasCurrentPlan(store: StorageBackend, spaceId: string): Promise<boolean> {
  const space = (await store.get('space', spaceId)) ?? DEFAULT_SPACE;
  const current = periodHistory(space.periodType, space.periodDay, 1)[0];
  const row = await store.get('plan', planId(spaceId, 'actual', current.start));
  return !!row && row.deleted === 0;
}

/** how many subjects of the current actual plan are in the red — the tab's dot, the home block, the notification */
export async function planOverspentCount(store: StorageBackend, spaceId: string): Promise<number> {
  if (!(await hasCurrentPlan(store, spaceId))) return 0;
  return buildPlanning(await loadPlanningData(store, spaceId)).attention.length;
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

/** the categories a subject answers for: its own (expenses) or its budget's (budgets); none for the rest */
function familyOf(subject: PlanSubjectRow, model: PlanningModel): ReadonlySet<string> {
  if (subject.segment === 'expenses') return subjectFamily(subject, model.data.catalog);
  if (subject.segment === 'budgets') {
    const budget = model.data.budgets.find((b) => b.id === subject.sourceId);
    return subjectFamily({ catIds: budget?.catIds ?? [] }, model.data.catalog);
  }
  return new Set<string>();
}

/** per category: what the current plan's subject answering for it still has (the picker's hint) */
export function availabilityByCat(model: PlanningModel): Map<string, CategoryAvailability> {
  const out = new Map<string, CategoryAvailability>();
  if (!model.plan) return out;
  const currency = model.data.space?.currency ?? 'EUR';
  for (const view of model.viewsOf(model.plan)) {
    const { subject } = view;
    for (const catId of familyOf(subject, model)) {
      if (out.has(catId)) continue; // a budget's claim never overrides an expense subject's (expenses come first)
      out.set(catId, { subjectName: subject.name, color: subject.color, cents: view.fundedCents - view.realizedCents, currency, status: view.status });
    }
  }
  return out;
}

export const isMandatorySegment = (segment: PlanSegmentKind): boolean => !OPTIONAL_SEGMENTS.has(segment);
