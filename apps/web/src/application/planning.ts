import { useMemo } from 'react';
import { useData } from '@/app/data';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { PlanKind, PlanRow, PlanSegmentConfig, PlanSegmentKind, PlanSubjectRow } from '@/db/types';
import { useQuery } from '@/db/useQuery';
import { isDebtTracked } from '@/domain/debts';
import type { Period } from '@/domain/periods';
import {
  brokenSubjects,
  byBirth,
  fillInOrder,
  mirroredSubjectId,
  planId,
  recommendSubjects,
  sameSubjects,
  shortfallCents,
  stillRelevant,
  subjectFamily,
  subjectShape,
  subjectView,
} from '@/domain/planning';
import type { SubjectShape, SubjectView } from '@/domain/planning';
import { measure } from '@/lib/perf';
import { logActivity } from './activity';
import { carriedWrites, orderStamp } from './planningCarry';
import { availabilityByCat, buildPlanning, hasCurrentPlan, loadPlanningData, loadPlanningRows, sortSubjects } from './planningModel';
import type { CategoryAvailability, PlanningData, PlanningModel } from './planningModel';
import { useSpaceTransactions } from './transactions';

export type { PlanAhead, PlanEditability, PlanningData, PlanningModel, CategoryAvailability } from './planningModel';
export { segmentsOf, isMandatorySegment } from './planningModel';

/**
 * Planning (#128): the live model of the active space and the commands
 * the screens issue. Every write goes through the Repo (synced rows);
 * the arithmetic lives in domain/planning and application/planningModel.
 */

/** the model's rows joined with the space's one shared transaction read (#554); `active` false reads nothing */
function usePlanningData(active = true): PlanningData | undefined {
  const { store, spaceId } = useData();
  // two spans (2026-10-09): the rows read and the model built — the tab's cost is measured, never guessed
  const rows = useQuery(
    store,
    () => (active ? measure('planning.load', () => loadPlanningRows(store, spaceId)) : Promise.resolve(undefined)),
    [spaceId, active],
    undefined,
    active ? `planningRows:${spaceId}` : undefined,
  );
  const txs = useSpaceTransactions(active);
  return useMemo(() => (rows && txs ? { ...rows, txs } : undefined), [rows, txs]);
}

/** the live model of the active space */
export function usePlanning(): PlanningModel | undefined {
  const data = usePlanningData();
  return useMemo(() => (data ? measure('planning.build', () => buildPlanning(data)) : undefined), [data]);
}

/** the tab's dot: does the current plan hold a subject in the red? Without a current plan it reads no transaction */
export function usePlanningDot(): boolean {
  const { store, spaceId } = useData();
  const current = useQuery(store, () => hasCurrentPlan(store, spaceId), [spaceId], false, `planCurrent:${spaceId}`) ?? false;
  const data = usePlanningData(current);
  return useMemo(() => !!data && buildPlanning(data).attention.length > 0, [data]);
}

/** the category picker's hint: what the plan still has per category (empty until asked) */
export function useCategoryAvailability(active: boolean): ReadonlyMap<string, CategoryAvailability> {
  const data = usePlanningData(active);
  return useMemo(() => (data ? availabilityByCat(buildPlanning(data)) : new Map<string, CategoryAvailability>()), [data]);
}

// ── commands ─────────────────────────────────────────────────────────────

export type PlanStart =
  | { kind: 'empty' }
  | { kind: 'last' }
  | { kind: 'blueprint'; id: string }
  | { kind: 'recommendation'; nameOf: (catId: string) => string; incomeCents: number | null };

export interface ExpenseShape {
  name: string;
  icon?: string;
  color?: string;
  catIds: string[];
  excludeCatIds?: string[];
  targetCents: number;
}

export interface MirroredSource {
  id: string;
  name: string;
  icon?: string;
  color?: string;
}

export type BlueprintSave = { ok: true; id: string } | { ok: false; sameAs: string; sameId: string };

export interface PlanningOps {
  startPlan: (period: Period, from: PlanStart) => Promise<string>;
  /**
   * #557 (user 2026-10-23): a new period whose plan is still empty takes the
   * previous period's subjects that still matter, unfunded — never after a
   * Start over, never over a plan already made. True when it carried over.
   */
  continuePlan: () => Promise<boolean>;
  addExpense: (planId: string, shape: ExpenseShape) => Promise<string>;
  updateSubject: (subjectId: string, fields: Partial<Pick<PlanSubjectRow, 'name' | 'icon' | 'color' | 'catIds' | 'excludeCatIds' | 'targetCents'>>) => Promise<void>;
  /** an event subject's own total (#504); null goes back to the event's estimate */
  setOwnTarget: (subjectId: string, cents: number | null) => Promise<void>;
  removeSubject: (subjectId: string) => Promise<void>;
  /** start over (#557): the period's plan goes — subjects, one-offs and its sandbox — and the start screen comes back */
  clearPlan: (plan: PlanRow) => Promise<void>;
  addMirrored: (planId: string, segment: PlanSegmentKind, source: MirroredSource) => Promise<string>;
  /** set the funding of one subject */
  fund: (subjectId: string, cents: number) => Promise<void>;
  /** #494: fund an Unplanned row for this period only — 0 takes it back */
  fundOneOff: (plan: PlanRow, key: string, cents: number) => Promise<void>;
  fillSubject: (plan: PlanRow, subjectId: string) => Promise<void>;
  fillSegment: (plan: PlanRow, segment: PlanSegmentKind) => Promise<void>;
  /** every subject of a segment to its target, pool or no pool (user 2026-10-07; the beyond-the-pool guard asks first) */
  fundSegment: (plan: PlanRow, segment: PlanSegmentKind) => Promise<void>;
  fillAll: (plan: PlanRow) => Promise<void>;
  withdrawAll: (plan: PlanRow) => Promise<void>;
  cover: (fromId: string, toId: string, cents: number) => Promise<void>;
  reorderSubjects: (orderedIds: string[]) => Promise<void>;
  setSegments: (plan: PlanRow, segments: PlanSegmentConfig[]) => Promise<void>;
  snooze: (subjectId: string, on: boolean) => Promise<void>;
  /** take categories away from the expense subject holding them (a sub under a chosen main becomes an exclusion); a subject left with none goes (#535) */
  freeCategories: (holderId: string, catIds: string[]) => Promise<void>;
  fundAhead: (period: Period) => Promise<void>;
  withdrawAhead: (plan: PlanRow) => Promise<void>;
  /** copy the current plan's subjects into every period ahead (their funding kept where the subject persists) */
  applyToAhead: (plan: PlanRow) => Promise<void>;
  saveBlueprint: (plan: PlanRow, name: string, overrideId?: string) => Promise<BlueprintSave>;
  applyBlueprint: (blueprintId: string, target: PlanRow, alsoAhead: boolean) => Promise<void>;
  repairBlueprint: (blueprintId: string) => Promise<void>;
  renameBlueprint: (blueprintId: string, name: string) => Promise<void>;
  deleteBlueprint: (blueprintId: string) => Promise<void>;
  createSandbox: () => Promise<string>;
  resetSandbox: () => Promise<void>;
  finalizeSandbox: () => Promise<void>;
  deleteSandbox: () => Promise<void>;
  setPoolAccounts: (ids: string[] | null) => Promise<void>;
}

type SubjectFields = Omit<PlanSubjectRow, 'id' | 'spaceId' | 'hlc' | 'deleted' | 'fieldVersions'>;

/** an absent optional field is written as an explicit null: the merge then clears it on every device instead of keeping what the row held before */
const orNull = <T>(value: T | undefined): T => value ?? (null as never);

/**
 * THE RESET RULE (user 2026-10-09): a mirrored subject keeps its deterministic
 * id, so "Start over" tombstones the row and adding the source again revives
 * that same row — and the per-field merge keeps every field the add does not
 * write (a skip, old funding). So every add writes the WHOLE field set,
 * absent ones as null: a revived row starts over too — nothing funded, not
 * skipped — whatever it held before it was removed. The ops never write a
 * partial row for a new subject.
 */
const shapeFields = (shape: SubjectShape, planId: string, fundedCents = 0): SubjectFields => ({
  planId,
  segment: shape.segment,
  order: shape.order,
  name: shape.name,
  icon: orNull(shape.icon),
  color: orNull(shape.color),
  catIds: orNull(shape.catIds),
  excludeCatIds: orNull(shape.excludeCatIds?.length ? shape.excludeCatIds : undefined),
  targetCents: orNull(shape.targetCents),
  sourceId: orNull(shape.sourceId),
  fundedCents,
  snoozed: 0,
});

/** mirrored subjects keep their deterministic id across copies; expense subjects get a fresh one */
const idForShape = (repo: Repo, planId: string, shape: SubjectShape): string =>
  shape.sourceId ? mirroredSubjectId(planId, shape.segment, shape.sourceId) : repo.newId();

/**
 * The carry-over's ids (#557) are deterministic, expense subjects too: two
 * devices opening the new period both carry the plan over and must land on
 * the same rows. An expense subject keeps the tail of its lineage (its first
 * id), so the id never grows period after period.
 */
const carriedIdFor = (planId: string, shape: SubjectShape, sourceSubjectId: string): string =>
  shape.sourceId ? mirroredSubjectId(planId, shape.segment, shape.sourceId) : `psub:${planId}:expenses:${sourceSubjectId.slice(sourceSubjectId.lastIndexOf(':') + 1)}`;

/** the plan row's whole field set (the reset rule): a period started over and started again carries nothing of before */
const planFields = (kind: PlanKind, periodStart: string, segments: PlanSegmentConfig[] | undefined) => ({
  kind,
  periodStart,
  segments: orNull(segments),
  oneOffs: [],
});

/** a subject as a new plan lays it down: its row there, and the stamps of the fields it is copied from */
interface LaidRow {
  id: string;
  fields: SubjectFields;
  versions: Readonly<Record<string, string>>;
}

// what a copy sets itself instead of taking from its source: these ride with the row's first write
const OWN_SUBJECT_FIELDS = ['planId', 'fundedCents', 'snoozed'] as const;
const OWN_PLAN_FIELDS = ['periodStart', 'oneOffs'] as const;

/** the Unplanned row a mirrored segment's subject takes the place of (#494) */
const ONE_OFF_KIND: Partial<Record<PlanSegmentKind, string>> = { recurring: 'recurring', debts: 'debt', events: 'event', goals: 'goal' };

/** a subject's identity across copies: the mirrored source, or the expense subject's name and categories —
 *  in one order: a row keeps them as they were ticked, a shape sorted */
const signatureOf = (s: Pick<PlanSubjectRow, 'segment' | 'sourceId' | 'name' | 'catIds'>): string =>
  `${s.segment}|${s.sourceId ?? ''}|${s.sourceId ? '' : s.name}|${[...(s.catIds ?? [])].sort((a, b) => a.localeCompare(b)).join(',')}`;

/** the funding a copied subject inherits from its twin in the source list */
const fundingFrom =
  (source: readonly PlanSubjectRow[]) =>
  (shape: SubjectShape): number =>
    source.find((s) => signatureOf(s) === signatureOf(shape))?.fundedCents ?? 0;

/** the plan row as the fresh model knows it (the caller's copy may predate a write) */
const planIn = (model: PlanningModel, plan: PlanRow): PlanRow => model.data.plans.find((p) => p.id === plan.id) ?? plan;

/**
 * The commands. Every one reads a FRESH model from the store before it
 * writes: the screen's model can lag the store by a tick (a sandbox
 * whose subjects were still copying when the strip appeared), and a
 * multi-step command built on a stale snapshot would lose rows.
 */
export function usePlanningOps(): PlanningOps {
  const { store, repo, spaceId } = useData();
  return useMemo(() => buildOps(store, repo, spaceId), [store, repo, spaceId]);
}

/** the commands over a store and repo — the hook's body, exported so a test drives them without React (on its own `today`) */
export function buildOps(store: StorageBackend, repo: Repo, spaceId: string, today?: string): PlanningOps {
  const fresh = async (): Promise<PlanningModel> => buildPlanning(await loadPlanningData(store, spaceId), today);
  const act = (kind: string) => void logActivity(store, repo, spaceId, kind);
  const write = (id: string, fields: Partial<SubjectFields>) => repo.upsert('planSubject', spaceId, id, fields);

  /** a plan's subjects as shapes for `period`: oldest first (#535's first-come order survives the copy), the ones that no longer matter left behind */
  const relevantShapes = (model: PlanningModel, rows: readonly PlanSubjectRow[], period: Period): SubjectShape[] =>
    byBirth(rows)
      .filter((s) => stillRelevant(s, period, model.relevance))
      .map(subjectShape);

  /** a plan's subjects on the rows they take in the plan `targetId` — the same rows whichever device or door copies them */
  const carriedRows = (model: PlanningModel, source: PlanRow, period: Period, targetId: string): LaidRow[] =>
    byBirth(model.subjectsOf(source))
      .filter((row) => stillRelevant(row, period, model.relevance))
      .map((row) => {
        const shape = subjectShape(row);
        return { id: carriedIdFor(targetId, shape, row.id), fields: shapeFields(shape, targetId), versions: row.fieldVersions };
      });

  /**
   * A period's plan and its first subjects. A device that knows of no plan for the period may simply not have
   * pulled it, so the rows go down stamped: nothing written elsewhere is overwritten, whenever this runs.
   */
  const layOut = async (model: PlanningModel, period: Period, rows: readonly LaidRow[], from: Pick<PlanRow, 'segments' | 'fieldVersions'> | undefined): Promise<number> => {
    const id = planId(spaceId, 'actual', period.start);
    const plan = planFields('actual', period.start, from?.segments);
    const known = await store.get('plan', id);
    if (!known) {
      // the subjects before the plan: a push cut short leaves no plan standing, and whoever opens the period next finishes it
      return repo.upsertStamped(spaceId, [
        ...rows.flatMap((row) => carriedWrites('planSubject', row.id, row.fields, row.versions, 'planId', OWN_SUBJECT_FIELDS)),
        ...carriedWrites('plan', id, plan, from?.fieldVersions ?? {}, 'kind', OWN_PLAN_FIELDS),
      ]);
    }
    // started over: the new rows must outrank the tombstones, and nothing of before comes back with them
    if (known.deleted === 1) await removeSubjects(model.data.subjects.filter((s) => s.planId === id));
    await repo.upsert('plan', spaceId, id, plan);
    for (const row of rows) await write(row.id, row.fields);
    return rows.length + 1;
  };

  /** a new subject takes over what the plan gave its Unplanned row for this period only (#494) */
  const absorbOneOffs = async (model: PlanningModel, planIdOf: string, keys: readonly string[]): Promise<number> => {
    const row = model.data.plans.find((p) => p.id === planIdOf);
    const all = row?.oneOffs ?? [];
    const taken = all.filter((o) => keys.includes(o.key));
    if (!row || taken.length === 0) return 0;
    await repo.upsert('plan', spaceId, row.id, { oneOffs: all.filter((o) => !keys.includes(o.key)) });
    return taken.reduce((sum, o) => sum + o.fundedCents, 0);
  };

  /**
   * A subject is born with nothing funded (user 2026-10-08) — what the period
   * already paid for it is NOT funded by itself: the pool reads as what the
   * period started with (the balance plus what already left), so the person
   * assigns that money by hand, or leaves the subject in the red. A copy keeps
   * its twin's funding where the caller passes one.
   */
  const copyShapes = async (planId: string, shapes: readonly SubjectShape[], funded?: (shape: SubjectShape) => number) => {
    for (const shape of shapes) {
      await write(idForShape(repo, planId, shape), shapeFields(shape, planId, funded?.(shape) ?? 0));
    }
  };

  const removeSubjects = async (rows: readonly PlanSubjectRow[]) => {
    for (const row of rows) await repo.remove('planSubject', spaceId, row.id);
  };

  /** a target plan takes a new shape: twins keep their row and their funding (or not), strangers go */
  const replaceSubjects = async (model: PlanningModel, target: PlanRow, shapes: readonly SubjectShape[], keepFunding: boolean) => {
    const existing = model.subjectsOf(target);
    // by what the subject is, not by its id: an expense subject has no id two plans share, and its money must not go with a new one
    const twins = new Map(existing.map((s) => [signatureOf(s), s]));
    const kept = new Set<string>();
    for (const shape of shapes) {
      const twin = twins.get(signatureOf(shape));
      const id = twin?.id ?? idForShape(repo, target.id, shape);
      kept.add(id);
      await write(id, shapeFields(shape, target.id, keepFunding ? (twin?.fundedCents ?? 0) : 0));
    }
    await removeSubjects(existing.filter((s) => !kept.has(s.id)));
  };

  // THE ROW RULE (#557): a subject's row holds the period's OWN funding; what rolled over from earlier periods is
  // derived on top of it (the view's carriedCents). The screens speak in what the subject holds in all, so every
  // write here turns that into the row's part — below zero once rolled-over money is taken away again.
  const giveTo = async (views: readonly SubjectView[], availableCents: number): Promise<boolean> => {
    const gifts = fillInOrder(views, availableCents);
    for (const [id, give] of gifts) {
      const view = views.find((v) => v.subject.id === id);
      if (view) await write(id, { fundedCents: view.subject.fundedCents + give });
    }
    return gifts.size > 0;
  };

  /** a subject as its own plan reads it right now */
  const viewOf = (model: PlanningModel, subjectId: string): SubjectView | undefined => {
    const subject = model.data.subjects.find((s) => s.id === subjectId);
    const plan = subject && model.data.plans.find((p) => p.id === subject.planId);
    return plan ? model.viewsOf(plan).find((v) => v.subject.id === subjectId) : undefined;
  };

  const fillViews = async (plan: PlanRow, pick: (views: SubjectView[]) => SubjectView[]) => {
    const model = await fresh();
    const target = planIn(model, plan);
    if (await giveTo(pick(model.viewsOf(target)), model.toAllocateOf(target))) act('planFund');
  };

  /** every subject back to nothing; `rolledToo` lets go of what rolled over as well (a period ahead keeps it: that money is the plans' before it) */
  const zeroAll = async (plan: PlanRow, rolledToo: boolean) => {
    const model = await fresh();
    for (const view of model.viewsOf(planIn(model, plan))) {
      const want = rolledToo && view.carriedCents > 0 ? -view.carriedCents : 0;
      if (view.subject.fundedCents !== want) await write(view.subject.id, { fundedCents: want });
    }
  };

  /** munni's suggestion on rows two devices agree on: a mirrored source's own, an expense subject's by its main category */
  const recommendedRows = (model: PlanningModel, period: Period, from: Extract<PlanStart, { kind: 'recommendation' }>, targetId: string): LaidRow[] =>
    recommendSubjects({
      catalog: model.data.catalog,
      nameOf: from.nameOf,
      pastLedgers: model.pastLedgers,
      budgets: model.data.budgets,
      recurrings: model.data.recurrings,
      accounts: model.data.accounts,
      poolIds: model.poolIds,
      events: model.data.events,
      goals: model.data.goals,
      incomeCents: from.incomeCents,
      space: model.data.space ?? { periodType: 'month', periodDay: 1 },
      period,
    }).map((shape, index) => ({
      id: shape.sourceId ? mirroredSubjectId(targetId, shape.segment, shape.sourceId) : `psub:${targetId}:expenses:${shape.catIds?.[0] ?? index}`,
      fields: shapeFields(shape, targetId),
      versions: { planId: orderStamp(index) },
    }));

  const copyWithFunding = async (targetId: string, source: readonly PlanSubjectRow[]) =>
    copyShapes(targetId, byBirth(source).map(subjectShape), fundingFrom(source));

  const nextOrder = (model: PlanningModel, plan: string, segment: PlanSegmentKind): number => {
    const target = model.data.plans.find((p) => p.id === plan);
    return target ? model.subjectsOf(target).filter((s) => s.segment === segment).length : 0;
  };

  return {
    startPlan: async (period, from) => {
      const model = await fresh();
      const id = planId(spaceId, 'actual', period.start);
      const latest = model.pastPlans.find((p) => p.periodStart! < period.start);
      // "Like last period" and a blueprint are copies of a plan; the others take the segments as the person last set them
      const source = from.kind === 'last' ? latest : model.blueprints.find((b) => from.kind === 'blueprint' && b.id === from.id);
      let rows: LaidRow[] = [];
      if (source) rows = carriedRows(model, source, period, id);
      else if (from.kind === 'recommendation') rows = recommendedRows(model, period, from, id);
      await layOut(model, period, rows, source ?? latest);
      act('planStart');
      return id;
    },

    continuePlan: async () => {
      const model = await fresh();
      const source = model.pastPlans.at(0);
      if (!model.continuable || !source) return false;
      const id = planId(spaceId, 'actual', model.period.start);
      // made meanwhile, or started over on another device
      if (await store.get('plan', id)) return false;
      if ((await layOut(model, model.period, carriedRows(model, source, model.period, id), source)) > 0) act('planStart');
      return true;
    },

    addExpense: async (plan, shape) => {
      const model = await fresh();
      const id = repo.newId();
      // born unfunded (user 2026-10-08): its spending so far reads "Over by" until the person funds it —
      // unless its main had money for this period only (#494): that follows it into the subject
      const mains = shape.catIds.filter((catId) => !model.data.catalog.byId(catId).parentId);
      const funded = await absorbOneOffs(model, plan, mains.map((mainId) => `category:${mainId}`));
      await write(id, shapeFields({ ...shape, segment: 'expenses', order: nextOrder(model, plan, 'expenses') }, plan, funded));
      act('planEdit');
      return id;
    },

    updateSubject: async (subjectId, fields) => {
      await write(subjectId, fields);
      act('planEdit');
    },

    setOwnTarget: async (subjectId, cents) => {
      await write(subjectId, { targetCents: cents === null ? orNull(undefined) : Math.max(0, Math.round(cents)) });
      act('planEdit');
    },

    removeSubject: async (subjectId) => {
      // the subject's funding returns to the pool by its absence
      await repo.remove('planSubject', spaceId, subjectId);
      act('planEdit');
    },

    clearPlan: async (plan) => {
      // start over (user 2026-10-23: "the initial screen, not an empty plan"): the subjects go —
      // their funding back to the pool by their absence, their spending back under Unplanned —
      // and an actual plan goes with them, its sandbox too, so the start screen comes back
      // (the tombstone also keeps the period from carrying the last plan over by itself);
      // the blueprints and the periods ahead are not touched
      const model = await fresh();
      const target = planIn(model, plan);
      // one burst: the screen goes from the plan straight to the start screen, never through a half-emptied plan
      await repo.batch(async () => {
        await removeSubjects(model.subjectsOf(target));
        if (target.kind === 'actual') {
          if (model.sandbox && target.periodStart === model.period.start) {
            await removeSubjects(model.subjectsOf(model.sandbox));
            await repo.remove('plan', spaceId, model.sandbox.id);
          }
          await repo.remove('plan', spaceId, target.id);
        } else if (target.oneOffs?.length) {
          await repo.upsert('plan', spaceId, target.id, { oneOffs: [] });
        }
      });
      act('planEdit');
    },

    addMirrored: async (plan, segment, source) => {
      const model = await fresh();
      const id = mirroredSubjectId(plan, segment, source.id);
      const kind = ONE_OFF_KIND[segment];
      const funded = kind ? await absorbOneOffs(model, plan, [`${kind}:${source.id}`]) : 0;
      // the whole field set (the reset rule above): a source removed by Start over and added again starts clean
      await write(id, shapeFields({ segment, order: nextOrder(model, plan, segment), name: source.name, icon: source.icon, color: source.color, sourceId: source.id }, plan, funded));
      act('planEdit');
      return id;
    },

    fund: async (subjectId, cents) => {
      const rolled = viewOf(await fresh(), subjectId)?.carriedCents ?? 0;
      await write(subjectId, { fundedCents: Math.max(0, Math.round(cents)) - rolled });
      act('planFund');
    },

    fundOneOff: async (plan, key, cents) => {
      const model = await fresh();
      const target = planIn(model, plan);
      const rest = (target.oneOffs ?? []).filter((o) => o.key !== key);
      const amount = Math.max(0, Math.round(cents));
      await repo.upsert('plan', spaceId, target.id, { oneOffs: amount > 0 ? [...rest, { key, fundedCents: amount }] : rest });
      act('planFund');
    },

    fillSubject: (plan, subjectId) => fillViews(plan, (views) => views.filter((v) => v.subject.id === subjectId)),

    fillSegment: (plan, segment) => fillViews(plan, (views) => views.filter((v) => v.subject.segment === segment)),

    fundSegment: async (plan, segment) => {
      const model = await fresh();
      for (const view of model.viewsOf(planIn(model, plan))) {
        if (view.subject.segment !== segment || view.subject.snoozed === 1) continue;
        const need = shortfallCents(view);
        if (need > 0) await write(view.subject.id, { fundedCents: view.subject.fundedCents + need });
      }
      act('planFund');
    },

    fillAll: (plan) => fillViews(plan, (views) => views),

    withdrawAll: async (plan) => {
      await zeroAll(plan, true);
      // every subject back to zero — and what the period gave its Unplanned rows (#494)
      const model = await fresh();
      if (planIn(model, plan).oneOffs?.length) await repo.upsert('plan', spaceId, plan.id, { oneOffs: [] });
      act('planFund');
    },

    cover: async (fromId, toId, cents) => {
      const model = await fresh();
      const from = viewOf(model, fromId);
      const to = viewOf(model, toId);
      if (!from || !to) return;
      // up to all it holds — what rolled over into it can be moved like any funding
      const moved = Math.max(0, Math.min(Math.round(cents), from.fundedCents));
      if (moved === 0) return;
      await write(fromId, { fundedCents: from.subject.fundedCents - moved });
      await write(toId, { fundedCents: to.subject.fundedCents + moved });
      act('planFund');
    },

    reorderSubjects: async (orderedIds) => {
      for (const [index, id] of orderedIds.entries()) await write(id, { order: index });
    },

    setSegments: async (plan, segments) => {
      // a segment taken out of the plan takes its subjects with it — their funding returns to the pool
      const model = await fresh();
      const hidden = new Set(segments.filter((s) => s.hidden === 1).map((s) => s.kind));
      await removeSubjects(model.subjectsOf(planIn(model, plan)).filter((s) => hidden.has(s.segment)));
      await repo.upsert('plan', spaceId, plan.id, { segments });
      act('planEdit');
    },

    snooze: async (subjectId, on) => {
      await write(subjectId, { snoozed: on ? 1 : 0 });
    },

    freeCategories: async (holderId, catIds) => {
      const model = await fresh();
      const holder = model.data.subjects.find((s) => s.id === holderId);
      if (!holder) return;
      const wanted = new Set(catIds);
      const direct = (holder.catIds ?? []).filter((id) => !wanted.has(id));
      // a sub the holder owns through its main is excluded rather than removed
      const chosenMains = new Set(direct);
      const viaMain = catIds.filter((id) => chosenMains.has(model.data.catalog.byId(id).parentId ?? ''));
      const excludeCatIds = [...new Set([...(holder.excludeCatIds ?? []), ...viaMain])];
      // nothing left to answer for (#535): the subject goes, its money back to the pool
      if (subjectFamily({ catIds: direct, excludeCatIds }, model.data.catalog).size > 0) await write(holderId, { catIds: direct, excludeCatIds });
      else await repo.remove('planSubject', spaceId, holderId);
      act('planEdit');
    },

    fundAhead: async (period) => {
      const model = await fresh();
      if (!model.plan) return;
      const id = planId(spaceId, 'actual', period.start);
      const existing = model.data.plans.find((p) => p.id === id);
      let subjects: PlanSubjectRow[];
      if (existing) {
        subjects = model.subjectsOf(existing);
      } else {
        // the rows a carry-over into that period would take: a device that never pulled this plan then lands on it, not beside it
        const rows = carriedRows(model, model.plan, period, id);
        await layOut(model, period, rows, model.plan);
        subjects = sortSubjects(
          rows.map((row) => ({ ...row.fields, id: row.id, spaceId, hlc: '', deleted: 0 as const, fieldVersions: {} })),
          model.segmentsOf(model.plan),
        );
      }
      // what the period needs, filled in list order from what is left
      const ctx = model.contextFor(period);
      await giveTo(
        subjects.map((s) => subjectView(s, ctx)),
        model.toAllocateOf(model.plan),
      );
      act('planAhead');
    },

    withdrawAhead: async (plan) => {
      await zeroAll(plan, false);
      act('planAhead');
    },

    applyToAhead: async (plan) => {
      const model = await fresh();
      const subjects = model.subjectsOf(planIn(model, plan));
      for (const ahead of model.ahead) {
        await replaceSubjects(model, ahead.plan, relevantShapes(model, subjects, ahead.period), true);
        await repo.upsert('plan', spaceId, ahead.plan.id, { segments: model.segmentsOf(plan) });
      }
      act('planEdit');
    },

    saveBlueprint: async (plan, name, overrideId) => {
      const model = await fresh();
      const subjects = model.subjectsOf(planIn(model, plan));
      const twin = model.blueprints.find((b) => b.id !== overrideId && sameSubjects(model.subjectsOf(b), subjects));
      if (twin) return { ok: false, sameAs: twin.name ?? '', sameId: twin.id };
      const id = overrideId ?? repo.newId();
      await repo.upsert('plan', spaceId, id, { kind: 'blueprint', name, segments: model.segmentsOf(plan), savedAt: new Date().toISOString() });
      const previous = overrideId ? model.blueprints.find((b) => b.id === overrideId) : undefined;
      if (previous) await removeSubjects(model.subjectsOf(previous));
      await copyShapes(id, byBirth(subjects).map(subjectShape));
      act('planBlueprint');
      return { ok: true, id };
    },

    applyBlueprint: async (blueprintId, target, alsoAhead) => {
      const model = await fresh();
      const blueprint = model.blueprints.find((b) => b.id === blueprintId);
      if (!blueprint) return;
      const rows = model.subjectsOf(blueprint);
      const into = planIn(model, target);
      await replaceSubjects(model, into, relevantShapes(model, rows, model.periodOf(into)), true);
      await repo.upsert('plan', spaceId, target.id, { segments: blueprint.segments });
      if (alsoAhead) {
        // the periods ahead take the blueprint too; their funding comes back to the pool
        for (const ahead of model.ahead) {
          await replaceSubjects(model, ahead.plan, relevantShapes(model, rows, ahead.period), false);
          await repo.upsert('plan', spaceId, ahead.plan.id, { segments: blueprint.segments });
        }
      }
      act('planBlueprint');
    },

    repairBlueprint: async (blueprintId) => {
      const model = await fresh();
      const blueprint = model.blueprints.find((b) => b.id === blueprintId);
      if (!blueprint) return;
      const broken = brokenSubjects(model.subjectsOf(blueprint), {
        catalog: model.data.catalog,
        budgetIds: new Set(model.data.budgets.map((b) => b.id)),
        recurringIds: new Set(model.data.recurrings.map((r) => r.id)),
        loanIds: new Set(model.data.accounts.filter((a) => isDebtTracked(a)).map((a) => a.id)),
        eventIds: new Set(model.data.events.map((e) => e.id)),
        goalIds: new Set(model.data.goals.map((g) => g.id)),
      });
      await removeSubjects(broken);
      act('planBlueprint');
    },

    renameBlueprint: async (blueprintId, name) => {
      await repo.upsert('plan', spaceId, blueprintId, { name });
    },

    deleteBlueprint: async (blueprintId) => {
      const model = await fresh();
      const blueprint = model.blueprints.find((b) => b.id === blueprintId);
      if (blueprint) await removeSubjects(model.subjectsOf(blueprint));
      await repo.remove('plan', spaceId, blueprintId);
      act('planBlueprint');
    },

    createSandbox: async () => {
      const model = await fresh();
      if (!model.plan) throw new Error('no plan');
      const id = planId(spaceId, 'sandbox', model.period.start);
      // the one-offs are the period's too (#494): the sandbox plays with a copy
      await repo.upsert('plan', spaceId, id, { ...planFields('sandbox', model.period.start, model.segmentsOf(model.plan)), oneOffs: model.plan.oneOffs ?? [] });
      await copyWithFunding(id, model.subjectsOf(model.plan));
      act('planSandbox');
      return id;
    },

    resetSandbox: async () => {
      const model = await fresh();
      if (!model.plan || !model.sandbox) return;
      await removeSubjects(model.subjectsOf(model.sandbox));
      await copyWithFunding(model.sandbox.id, model.subjectsOf(model.plan));
      await repo.upsert('plan', spaceId, model.sandbox.id, { segments: model.segmentsOf(model.plan), oneOffs: model.plan.oneOffs ?? [] });
      act('planSandbox');
    },

    finalizeSandbox: async () => {
      const model = await fresh();
      if (!model.plan || !model.sandbox) return;
      const sandboxSubjects = model.subjectsOf(model.sandbox);
      await removeSubjects(model.subjectsOf(model.plan));
      await copyWithFunding(model.plan.id, sandboxSubjects);
      await repo.upsert('plan', spaceId, model.plan.id, { segments: model.segmentsOf(model.sandbox), oneOffs: model.sandbox.oneOffs ?? [] });
      await removeSubjects(sandboxSubjects);
      await repo.remove('plan', spaceId, model.sandbox.id);
      act('planSandbox');
    },

    deleteSandbox: async () => {
      const model = await fresh();
      if (!model.sandbox) return;
      await removeSubjects(model.subjectsOf(model.sandbox));
      await repo.remove('plan', spaceId, model.sandbox.id);
      act('planSandbox');
    },

    setPoolAccounts: async (ids) => {
      // null, not undefined: JSON drops an undefined field, so "back to all accounts" would never sync
      await repo.upsert('space', spaceId, spaceId, { planPoolAccountIds: ids ?? (null as never) });
      act('planEdit');
    },
  };
}
