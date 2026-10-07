import { useMemo } from 'react';
import { useData } from '@/app/data';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { PlanRow, PlanSegmentConfig, PlanSegmentKind, PlanSubjectRow } from '@/db/types';
import { useQuery } from '@/db/useQuery';
import { isDebtTracked } from '@/domain/debts';
import type { Period } from '@/domain/periods';
import { brokenSubjects, fillInOrder, mirroredSubjectId, planId, recommendSubjects, sameSubjects, subjectShape, subjectView, shortfallCents } from '@/domain/planning';
import type { SubjectShape, SubjectView } from '@/domain/planning';
import { logActivity } from './activity';
import { availabilityByCat, buildPlanning, loadPlanningData, planOverspentCount, sortSubjects } from './planningModel';
import type { CategoryAvailability, PlanningModel } from './planningModel';

export type { PlanAhead, PlanEditability, PlanningData, PlanningModel, CategoryAvailability } from './planningModel';
export { segmentsOf, isMandatorySegment } from './planningModel';

/**
 * Planning (#128): the live model of the active space and the commands
 * the screens issue. Every write goes through the Repo (synced rows);
 * the arithmetic lives in domain/planning and application/planningModel.
 */

/** the live model of the active space */
export function usePlanning(): PlanningModel | undefined {
  const { store, spaceId } = useData();
  const data = useQuery(store, () => loadPlanningData(store, spaceId), [spaceId], undefined, `planning:${spaceId}`);
  return useMemo(() => (data ? buildPlanning(data) : undefined), [data]);
}

/** the tab's dot: does the current plan hold a subject in the red? */
export function usePlanningDot(): boolean {
  const { store, spaceId } = useData();
  return useQuery(store, async () => (await planOverspentCount(store, spaceId)) > 0, [spaceId], false, `planDot:${spaceId}`) ?? false;
}

/** the category picker's hint: what the plan still has per category (empty until asked) */
export function useCategoryAvailability(active: boolean): ReadonlyMap<string, CategoryAvailability> {
  const { store, spaceId } = useData();
  const data = useQuery(
    store,
    () => (active ? loadPlanningData(store, spaceId) : Promise.resolve(undefined)),
    [spaceId, active],
    undefined,
    active ? `planning:${spaceId}` : undefined,
  );
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
  addExpense: (planId: string, shape: ExpenseShape) => Promise<string>;
  updateSubject: (subjectId: string, fields: Partial<Pick<PlanSubjectRow, 'name' | 'icon' | 'color' | 'catIds' | 'excludeCatIds' | 'targetCents'>>) => Promise<void>;
  removeSubject: (subjectId: string) => Promise<void>;
  addMirrored: (planId: string, segment: PlanSegmentKind, source: MirroredSource) => Promise<string>;
  /** set the funding of one subject */
  fund: (subjectId: string, cents: number) => Promise<void>;
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
  /** take categories away from the expense subject holding them (a sub under a chosen main becomes an exclusion) */
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

const shapeFields = (shape: SubjectShape, planId: string, fundedCents = 0): SubjectFields => ({
  planId,
  segment: shape.segment,
  order: shape.order,
  name: shape.name,
  icon: shape.icon,
  color: shape.color,
  catIds: shape.catIds,
  excludeCatIds: shape.excludeCatIds,
  targetCents: shape.targetCents,
  sourceId: shape.sourceId,
  fundedCents,
});

/** mirrored subjects keep their deterministic id across copies; expense subjects get a fresh one */
const idForShape = (repo: Repo, planId: string, shape: SubjectShape): string =>
  shape.sourceId ? mirroredSubjectId(planId, shape.segment, shape.sourceId) : repo.newId();

/** a subject's identity across copies: the mirrored source, or the expense subject's name and categories */
const signatureOf = (s: Pick<PlanSubjectRow, 'segment' | 'sourceId' | 'name' | 'catIds'>): string =>
  `${s.segment}|${s.sourceId ?? ''}|${s.sourceId ? '' : s.name}|${(s.catIds ?? []).join(',')}`;

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

function buildOps(store: StorageBackend, repo: Repo, spaceId: string): PlanningOps {
  const fresh = async (): Promise<PlanningModel> => buildPlanning(await loadPlanningData(store, spaceId));
  const act = (kind: string) => void logActivity(store, repo, spaceId, kind);
  const write = (id: string, fields: Partial<SubjectFields>) => repo.upsert('planSubject', spaceId, id, fields);

  /**
   * What the period already paid for a subject that is only now planned: it starts
   * funded by that much (user 2026-10-07) — the balance dropped with those payments,
   * so the pool is not asked for them a second time. A period ahead has spent
   * nothing, so nothing changes there.
   */
  const paidAlready = (model: PlanningModel, planId: string, id: string, fields: SubjectFields): number => {
    const plan = model.data.plans.find((p) => p.id === planId);
    if (!plan) return 0;
    const row = { ...fields, id, spaceId, hlc: '', deleted: 0, fieldVersions: {} } as unknown as PlanSubjectRow;
    return Math.max(0, subjectView(row, model.contextFor(model.periodOf(plan))).realizedCents);
  };

  const copyShapes = async (planId: string, shapes: readonly SubjectShape[], funded?: (shape: SubjectShape) => number) => {
    const model = await fresh();
    for (const shape of shapes) {
      const id = idForShape(repo, planId, shape);
      const fields = shapeFields(shape, planId, funded?.(shape) ?? 0);
      await write(id, { ...fields, fundedCents: Math.max(fields.fundedCents, paidAlready(model, planId, id, fields)) });
    }
  };

  const removeSubjects = async (rows: readonly PlanSubjectRow[]) => {
    for (const row of rows) await repo.remove('planSubject', spaceId, row.id);
  };

  /** a target plan takes a new shape: twins keep their funding (or not), strangers go */
  const replaceSubjects = async (model: PlanningModel, target: PlanRow, shapes: readonly SubjectShape[], keepFunding: boolean) => {
    const existing = model.subjectsOf(target);
    const existingById = new Map(existing.map((s) => [s.id, s]));
    const kept = new Set<string>();
    for (const shape of shapes) {
      const id = idForShape(repo, target.id, shape);
      kept.add(id);
      const funded = keepFunding ? (existingById.get(id)?.fundedCents ?? 0) : 0;
      await write(id, shapeFields(shape, target.id, funded));
    }
    await removeSubjects(existing.filter((s) => !kept.has(s.id)));
  };

  const giveTo = async (views: readonly SubjectView[], availableCents: number): Promise<boolean> => {
    const gifts = fillInOrder(views, availableCents);
    for (const [id, give] of gifts) {
      const view = views.find((v) => v.subject.id === id);
      if (view) await write(id, { fundedCents: view.fundedCents + give });
    }
    return gifts.size > 0;
  };

  const fillViews = async (plan: PlanRow, pick: (views: SubjectView[]) => SubjectView[]) => {
    const model = await fresh();
    const target = planIn(model, plan);
    if (await giveTo(pick(model.viewsOf(target)), model.toAllocateOf(target))) act('planFund');
  };

  const zeroAll = async (plan: PlanRow) => {
    const model = await fresh();
    for (const subject of model.subjectsOf(planIn(model, plan))) {
      if (subject.fundedCents !== 0) await write(subject.id, { fundedCents: 0 });
    }
  };

  const shapesForStart = (model: PlanningModel, period: Period, from: PlanStart): SubjectShape[] => {
    switch (from.kind) {
      case 'last': {
        const source = model.pastPlans.find((p) => p.periodStart! < period.start);
        return source ? model.subjectsOf(source).map(subjectShape) : [];
      }
      case 'blueprint': {
        const blueprint = model.blueprints.find((b) => b.id === from.id);
        return blueprint ? model.subjectsOf(blueprint).map(subjectShape) : [];
      }
      case 'recommendation':
        return recommendSubjects({
          catalog: model.data.catalog,
          nameOf: from.nameOf,
          txs: model.data.txs,
          pastPeriods: model.pastPeriods,
          budgets: model.data.budgets,
          recurrings: model.data.recurrings,
          accounts: model.data.accounts,
          goals: model.data.goals,
          incomeCents: from.incomeCents,
          space: model.data.space ?? { periodType: 'month', periodDay: 1 },
          period,
        });
      default:
        return [];
    }
  };

  const copyWithFunding = async (targetId: string, source: readonly PlanSubjectRow[]) =>
    copyShapes(targetId, source.map(subjectShape), fundingFrom(source));

  const nextOrder = (model: PlanningModel, plan: string, segment: PlanSegmentKind): number => {
    const target = model.data.plans.find((p) => p.id === plan);
    return target ? model.subjectsOf(target).filter((s) => s.segment === segment).length : 0;
  };

  return {
    startPlan: async (period, from) => {
      const model = await fresh();
      const id = planId(spaceId, 'actual', period.start);
      const blueprint = from.kind === 'blueprint' ? model.blueprints.find((b) => b.id === from.id) : undefined;
      const segments = blueprint?.segments ?? (model.plan ? model.segmentsOf(model.plan) : undefined);
      await repo.upsert('plan', spaceId, id, { kind: 'actual', periodStart: period.start, segments });
      await copyShapes(id, shapesForStart(model, period, from));
      act('planStart');
      return id;
    },

    addExpense: async (plan, shape) => {
      const model = await fresh();
      const id = repo.newId();
      const fields: SubjectFields = {
        planId: plan,
        segment: 'expenses',
        order: nextOrder(model, plan, 'expenses'),
        name: shape.name,
        icon: shape.icon,
        color: shape.color,
        catIds: shape.catIds,
        excludeCatIds: shape.excludeCatIds?.length ? shape.excludeCatIds : undefined,
        targetCents: shape.targetCents,
        fundedCents: 0,
      };
      await write(id, { ...fields, fundedCents: paidAlready(model, plan, id, fields) });
      act('planEdit');
      return id;
    },

    updateSubject: async (subjectId, fields) => {
      await write(subjectId, fields);
      act('planEdit');
    },

    removeSubject: async (subjectId) => {
      // the subject's funding returns to the pool by its absence
      await repo.remove('planSubject', spaceId, subjectId);
      act('planEdit');
    },

    addMirrored: async (plan, segment, source) => {
      const model = await fresh();
      const id = mirroredSubjectId(plan, segment, source.id);
      const fields: SubjectFields = { planId: plan, segment, order: nextOrder(model, plan, segment), name: source.name, icon: source.icon, color: source.color, sourceId: source.id, fundedCents: 0 };
      await write(id, { ...fields, fundedCents: paidAlready(model, plan, id, fields) });
      act('planEdit');
      return id;
    },

    fund: async (subjectId, cents) => {
      await write(subjectId, { fundedCents: Math.max(0, Math.round(cents)) });
      act('planFund');
    },

    fillSubject: (plan, subjectId) => fillViews(plan, (views) => views.filter((v) => v.subject.id === subjectId)),

    fillSegment: (plan, segment) => fillViews(plan, (views) => views.filter((v) => v.subject.segment === segment)),

    fundSegment: async (plan, segment) => {
      const model = await fresh();
      for (const view of model.viewsOf(planIn(model, plan))) {
        if (view.subject.segment !== segment || view.subject.snoozed === 1) continue;
        const need = shortfallCents(view);
        if (need > 0) await write(view.subject.id, { fundedCents: view.fundedCents + need });
      }
      act('planFund');
    },

    fillAll: (plan) => fillViews(plan, (views) => views),

    withdrawAll: async (plan) => {
      await zeroAll(plan);
      act('planFund');
    },

    cover: async (fromId, toId, cents) => {
      const from = await store.get('planSubject', fromId);
      const to = await store.get('planSubject', toId);
      if (!from || !to || from.deleted !== 0 || to.deleted !== 0) return;
      const moved = Math.max(0, Math.min(Math.round(cents), from.fundedCents));
      if (moved === 0) return;
      await write(from.id, { fundedCents: from.fundedCents - moved });
      await write(to.id, { fundedCents: to.fundedCents + moved });
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
      await write(holderId, { catIds: direct, excludeCatIds: [...new Set([...(holder.excludeCatIds ?? []), ...viaMain])] });
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
        // the period takes the current plan's shape; the ids are minted ONCE so the
        // funding below lands on the rows just written
        await repo.upsert('plan', spaceId, id, { kind: 'actual', periodStart: period.start, segments: model.segmentsOf(model.plan) });
        const rows = model.subjectsOf(model.plan).map(subjectShape).map((shape) => ({ id: idForShape(repo, id, shape), fields: shapeFields(shape, id) }));
        for (const row of rows) await write(row.id, row.fields);
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
      await zeroAll(plan);
      act('planAhead');
    },

    applyToAhead: async (plan) => {
      const model = await fresh();
      const shapes = model.subjectsOf(planIn(model, plan)).map(subjectShape);
      for (const ahead of model.ahead) {
        await replaceSubjects(model, ahead.plan, shapes, true);
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
      await copyShapes(id, subjects.map(subjectShape));
      act('planBlueprint');
      return { ok: true, id };
    },

    applyBlueprint: async (blueprintId, target, alsoAhead) => {
      const model = await fresh();
      const blueprint = model.blueprints.find((b) => b.id === blueprintId);
      if (!blueprint) return;
      const shapes = model.subjectsOf(blueprint).map(subjectShape);
      await replaceSubjects(model, planIn(model, target), shapes, true);
      await repo.upsert('plan', spaceId, target.id, { segments: blueprint.segments });
      if (alsoAhead) {
        // the periods ahead take the blueprint too; their funding comes back to the pool
        for (const ahead of model.ahead) {
          await replaceSubjects(model, ahead.plan, shapes, false);
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
      await repo.upsert('plan', spaceId, id, { kind: 'sandbox', periodStart: model.period.start, segments: model.segmentsOf(model.plan) });
      await copyWithFunding(id, model.subjectsOf(model.plan));
      act('planSandbox');
      return id;
    },

    resetSandbox: async () => {
      const model = await fresh();
      if (!model.plan || !model.sandbox) return;
      await removeSubjects(model.subjectsOf(model.sandbox));
      await copyWithFunding(model.sandbox.id, model.subjectsOf(model.plan));
      await repo.upsert('plan', spaceId, model.sandbox.id, { segments: model.segmentsOf(model.plan) });
      act('planSandbox');
    },

    finalizeSandbox: async () => {
      const model = await fresh();
      if (!model.plan || !model.sandbox) return;
      const sandboxSubjects = model.subjectsOf(model.sandbox);
      await removeSubjects(model.subjectsOf(model.plan));
      await copyWithFunding(model.plan.id, sandboxSubjects);
      await repo.upsert('plan', spaceId, model.plan.id, { segments: model.segmentsOf(model.sandbox) });
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
      await repo.upsert('space', spaceId, spaceId, { planPoolAccountIds: ids ?? undefined });
      act('planEdit');
    },
  };
}
