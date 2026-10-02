import { useMemo, useState } from 'react';
import { useLang } from '@/i18n';
import type { PlanRow, PlanSubjectRow } from '@/db/types';
import type { PlanningModel, PlanningOps } from '@/application/planning';
import { reservationConflicts, subjectFamily } from '@/domain/planning';
import type { Reservation } from '@/domain/planning';
import { catName, useCategories } from '@/features/categories/useCategories';
import type { Cat } from '@/features/categories/useCategories';
import { MDI_NAMES } from '@/generated/mdiNames';
import { parseCents } from '@/lib/money';
import { Button } from '@/ui/Button';
import { ColorPicker } from '@/ui/ColorPicker';
import { FormBlockerNote, blockerRing } from '@/ui/FormBlockerNote';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { SearchField } from '@/ui/SearchField';
import { Sheet } from '@/ui/Sheet';
import { SUBJECT_COLORS, SUBJECT_ICONS } from './planningUi';
import type { MoneyFmt } from './SegmentSection';

type TickState = 'checked' | 'half' | 'off';
const TICK_BOX: Record<TickState, string> = {
  checked: 'border-accent bg-accent',
  half: 'border-accent bg-accent-soft',
  off: 'border-line bg-transparent',
};

interface Draft {
  name: string;
  icon: string;
  color: string;
  /** the chosen categories: mains and/or subs */
  catIds: Set<string>;
  /** subs of a chosen main that are left out */
  excludeIds: Set<string>;
  target: string;
}

/** a subject suggested by the plan itself (an unplanned main, its spending as the target) */
export interface EditorPreset {
  name: string;
  icon?: string;
  color?: string;
  catIds: string[];
  targetCents: number;
}

const draftOf = (subject: PlanSubjectRow | null, preset: EditorPreset | null): Draft => {
  const seed = subject ?? preset;
  return {
    name: seed?.name ?? '',
    icon: seed?.icon ?? SUBJECT_ICONS[0],
    color: seed?.color ?? SUBJECT_COLORS[0],
    catIds: new Set(seed?.catIds ?? []),
    excludeIds: new Set(subject?.excludeCatIds ?? []),
    target: seed?.targetCents ? (seed.targetCents / 100).toFixed(2) : '',
  };
};

/** the icon grid: a first pick, or the whole font by search */
function IconGrid({ icon, query, onQuery, onPick }: Readonly<{ icon: string; query: string; onQuery: (q: string) => void; onPick: (name: string) => void }>) {
  const { t } = useLang();
  const needle = query.trim().toLowerCase();
  const candidates = needle ? MDI_NAMES.filter((n) => n.includes(needle)).slice(0, 48) : [...SUBJECT_ICONS];
  return (
    <>
      <SearchField testId="plan-editor-icon-search" value={query} onChange={onQuery} placeholder={t('cats.iconSearch')} height="h-10" textSize="text-[13px]" />
      <div className="grid max-h-40 grid-cols-6 gap-2 overflow-y-auto">
        {candidates.map((candidate) => (
          <button
            key={candidate}
            data-testid={`plan-editor-icon-${candidate}`}
            title={candidate}
            onClick={() => onPick(candidate)}
            className={`m-tap flex h-11 items-center justify-center rounded-xl border ${
              icon === candidate ? 'border-accent bg-accent-soft text-accent-deep' : 'border-line bg-surface text-ink-2'
            }`}
          >
            <Icon name={candidate} size={19} />
          </button>
        ))}
        {needle && candidates.length === 0 && <p className="col-span-6 py-2 text-center text-[12px] text-ink-4">{t('cats.iconNone')}</p>}
      </div>
    </>
  );
}

/** a main's tick: chosen itself, half when only some of its subs are, off otherwise */
const mainTick = (draft: Draft, main: Cat, subs: readonly Cat[]): TickState => {
  if (draft.catIds.has(main.id)) return 'checked';
  return subs.some((s) => draft.catIds.has(s.id)) ? 'half' : 'off';
};

/** a sub's tick: chosen directly, or through its main unless excluded */
const subTick = (draft: Draft, main: Cat, sub: Cat): TickState => {
  if (draft.catIds.has(sub.id)) return 'checked';
  if (draft.catIds.has(main.id) && !draft.excludeIds.has(sub.id)) return 'checked';
  return 'off';
};

function CategoryTree({
  draft,
  conflicts,
  onToggleMain,
  onToggleSub,
  onTakeOver,
}: Readonly<{
  draft: Draft;
  conflicts: ReadonlyMap<string, Reservation>;
  onToggleMain: (main: Cat, subs: readonly Cat[]) => void;
  onToggleSub: (main: Cat, sub: Cat) => void;
  onTakeOver: (reservation: Reservation, catId: string) => void;
}>) {
  const { t } = useLang();
  const cats = useCategories();
  const [openMains, setOpenMains] = useState<ReadonlySet<string>>(new Set());
  const mains = useMemo(() => cats.parents.filter((p) => p.txTypes.includes('expense')), [cats]);
  const conflictNote = (catId: string) => {
    const reservation = conflicts.get(catId);
    if (!reservation) return null;
    if (reservation.segment === 'budgets') {
      return (
        <span className="block text-[10px] text-ink-4" data-testid={`plan-editor-budget-${catId}`}>
          {t('plan.subject.conflictBudget', { name: reservation.name })}
        </span>
      );
    }
    return (
      <span className="flex items-center gap-2 text-[10px] text-warning" data-testid={`plan-editor-conflict-${catId}`}>
        {t('plan.subject.conflict', { name: reservation.name })}
        <button
          data-testid={`plan-editor-takeover-${catId}`}
          onClick={(e) => {
            e.stopPropagation();
            onTakeOver(reservation, catId);
          }}
          className="m-tap border-none bg-transparent p-0 font-semibold text-accent-deep"
        >
          {t('plan.subject.conflictFree')}
        </button>
      </span>
    );
  };
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="plan-editor-cats">
      {mains.map((main) => {
        const subs = cats.childrenOf(main.id);
        const tick = mainTick(draft, main, subs);
        const open = openMains.has(main.id);
        return (
          <div key={main.id} className="border-b border-line-2 last:border-0">
            <div className="flex items-center gap-3 px-3 py-2">
              <button
                data-testid={`plan-editor-cat-${main.id}`}
                onClick={() => onToggleMain(main, subs)}
                className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent p-0 text-left"
              >
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${TICK_BOX[tick]}`}>
                  {tick === 'checked' && <Icon name="check" size={14} color="white" />}
                  {tick === 'half' && <span className="h-0.5 w-2.5 rounded bg-accent" />}
                </span>
                <Icon name={main.icon} size={18} color={main.color} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{catName(main, t)}</span>
                  {conflictNote(main.id)}
                </span>
              </button>
              {subs.length > 0 && (
                <button
                  data-testid={`plan-editor-expand-${main.id}`}
                  aria-label={catName(main, t)}
                  onClick={() => setOpenMains((prev) => {
                    const next = new Set(prev);
                    if (next.has(main.id)) next.delete(main.id);
                    else next.add(main.id);
                    return next;
                  })}
                  className="m-tap flex h-8 w-8 items-center justify-center border-none bg-transparent text-ink-4"
                >
                  <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} />
                </button>
              )}
            </div>
            {open &&
              subs.map((sub) => {
                const state = subTick(draft, main, sub);
                return (
                  <button
                    key={sub.id}
                    data-testid={`plan-editor-sub-${sub.id}`}
                    onClick={() => onToggleSub(main, sub)}
                    className="m-tap flex w-full items-center gap-3 border-none bg-transparent py-2 pr-3 pl-11 text-left"
                  >
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${TICK_BOX[state]}`}>
                      {state === 'checked' && <Icon name="check" size={14} color="white" />}
                    </span>
                    <Icon name={sub.icon} size={16} color={sub.color ?? main.color} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">{catName(sub, t)}</span>
                      {conflictNote(sub.id)}
                    </span>
                  </button>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

type Blocker = 'name' | 'cats' | 'target' | null;
const blockerOf = (draft: Draft, target: number | null): Blocker => {
  if (!draft.name.trim()) return 'name';
  if (draft.catIds.size === 0) return 'cats';
  if (target === null || target <= 0) return 'target';
  return null;
};
const BLOCKER_KEY = { name: 'plan.subject.blockerName', cats: 'plan.subject.blockerCats', target: 'plan.subject.blockerTarget' } as const;

/**
 * An expense subject's own shape (#128): a name, a face, the categories
 * it answers for — a main claims its subs, future ones too, an unticked
 * sub under it is an exclusion — and the target, with last period and the
 * average as chips. A category another expense subject already answers
 * for can be taken over from here.
 */
export function SubjectEditor({
  open,
  onOpenChange,
  subject,
  preset = null,
  plan,
  model,
  ops,
  fmt,
  currency,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = a new subject */
  subject: PlanSubjectRow | null;
  /** a new subject that starts filled in */
  preset?: EditorPreset | null;
  plan: PlanRow;
  model: PlanningModel;
  ops: PlanningOps;
  fmt: MoneyFmt;
  currency: string;
}>) {
  const { t } = useLang();
  const [draft, setDraft] = useState<Draft>(() => draftOf(subject, preset));
  const [iconQuery, setIconQuery] = useState('');
  const [attempted, setAttempted] = useState(false);
  const patch = (fields: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...fields }));

  const family = useMemo(() => subjectFamily({ catIds: [...draft.catIds], excludeCatIds: [...draft.excludeIds] }, model.data.catalog), [draft.catIds, draft.excludeIds, model]);
  const conflicts = useMemo(() => reservationConflicts(family, model.reservationsOf(plan), subject?.id), [family, model, plan, subject?.id]);
  const estimate = useMemo(() => model.estimate(family), [family, model]);
  const target = parseCents(draft.target);
  const blocker = blockerOf(draft, target);
  const expenseConflicts = [...conflicts.values()].some((r) => r.segment === 'expenses');

  const toggleMain = (main: Cat, subs: readonly Cat[]) => {
    const catIds = new Set(draft.catIds);
    const excludeIds = new Set(draft.excludeIds);
    if (catIds.has(main.id)) {
      catIds.delete(main.id);
    } else {
      catIds.add(main.id);
      for (const sub of subs) catIds.delete(sub.id); // the main speaks for its subs now
    }
    for (const sub of subs) excludeIds.delete(sub.id);
    patch({ catIds, excludeIds });
  };
  const toggleSub = (main: Cat, sub: Cat) => {
    const catIds = new Set(draft.catIds);
    const excludeIds = new Set(draft.excludeIds);
    if (catIds.has(main.id)) {
      // under a chosen main a sub toggles its exclusion
      if (excludeIds.has(sub.id)) excludeIds.delete(sub.id);
      else excludeIds.add(sub.id);
    } else if (catIds.has(sub.id)) {
      catIds.delete(sub.id);
    } else {
      catIds.add(sub.id);
    }
    patch({ catIds, excludeIds });
  };

  const save = async () => {
    setAttempted(true);
    if (blocker || target === null || expenseConflicts) return;
    const fields = {
      name: draft.name.trim(),
      icon: draft.icon,
      color: draft.color,
      catIds: [...draft.catIds],
      excludeCatIds: [...draft.excludeIds],
      targetCents: target,
    };
    if (subject) await ops.updateSubject(subject.id, fields);
    else await ops.addExpense(plan.id, fields);
    onOpenChange(false);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={subject ? t('plan.fund.edit') : t('plan.addExpense')}
      size="tall"
      dirty={draft.name !== (subject?.name ?? '')}
      footer={
        <Button className="w-full" data-testid="plan-editor-save" onClick={() => void save()}>
          {t('plan.subject.save')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3" data-testid="plan-editor">
        <IconGrid icon={draft.icon} query={iconQuery} onQuery={setIconQuery} onPick={(icon) => patch({ icon })} />
        <ColorPicker colors={SUBJECT_COLORS} value={draft.color} onChange={(color) => patch({ color })} testIdPrefix="plan-editor-color" customLabel={t('plan.subject.customColor')} />
        <input
          data-testid="plan-editor-name"
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder={t('plan.subject.namePlaceholder')}
          className={`h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4${blockerRing(attempted && blocker === 'name')}`}
        />
        <FormBlockerNote show={attempted && blocker === 'name'} text={t(BLOCKER_KEY.name)} testId="plan-editor-blocker" />

        <div className="m-cap px-1">{t('plan.subject.categories')}</div>
        <p className="-mt-2 px-1 text-[11px] text-ink-4">{t('plan.subject.categoriesHint')}</p>
        <CategoryTree
          draft={draft}
          conflicts={conflicts}
          onToggleMain={toggleMain}
          onToggleSub={toggleSub}
          onTakeOver={(reservation, catId) => void ops.freeCategories(reservation.subjectId, [catId])}
        />
        <FormBlockerNote show={attempted && blocker === 'cats'} text={t(BLOCKER_KEY.cats)} testId="plan-editor-blocker" />
        <FormBlockerNote show={attempted && !blocker && expenseConflicts} text={t('plan.subject.blockerConflict')} testId="plan-editor-blocker" />

        <div className="m-cap px-1">{t('plan.target')}</div>
        <input
          data-testid="plan-editor-target"
          inputMode="decimal"
          value={draft.target}
          onChange={(e) => patch({ target: e.target.value })}
          placeholder="0.00"
          className={`h-12 w-full rounded-input border border-line bg-surface px-4 font-mono text-[15px] text-ink outline-none placeholder:text-ink-4${blockerRing(attempted && blocker === 'target')}`}
        />
        <FormBlockerNote show={attempted && blocker === 'target'} text={t(BLOCKER_KEY.target)} testId="plan-editor-blocker" />
        {(estimate.lastCents !== null || estimate.averageCents !== null) && (
          <div className="flex flex-wrap gap-2" data-testid="plan-editor-chips">
            {estimate.lastCents !== null && (
              <Chip selected={false} testId="plan-editor-chip-last" onClick={() => patch({ target: (estimate.lastCents! / 100).toFixed(2) })}>
                {t('plan.subject.estimateLast', { amount: fmt(estimate.lastCents, currency) })}
              </Chip>
            )}
            {estimate.averageCents !== null && (
              <Chip selected={false} testId="plan-editor-chip-avg" onClick={() => patch({ target: (estimate.averageCents! / 100).toFixed(2) })}>
                {t('plan.subject.estimateAvg', { amount: fmt(estimate.averageCents, currency) })}
              </Chip>
            )}
          </div>
        )}
        <p className="px-1 text-[11px] text-ink-4">{t('plan.targetHint')}</p>
      </div>
    </Sheet>
  );
}
