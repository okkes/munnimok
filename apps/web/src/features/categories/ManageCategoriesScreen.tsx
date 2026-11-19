import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import type { CategoryRow, TxType } from '@/db/types';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useCanEdit } from '@/app/useCanEdit';
import { ReadOnlyNote } from '@/features/spaces/ReadOnlyNote';
import { logActivity } from '@/application/activity';
import { hapticNotify } from '@/lib/platform';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { ColorPicker } from '@/ui/ColorPicker';
import { FormBlockerNote, blockerRing } from '@/ui/FormBlockerNote';
import { Collapse } from '@/ui/Collapse';
import { Icon } from '@/ui/Icon';
import { useUserInk } from '@/ui/userInk';
import { IconPicker } from '@/ui/IconPicker';
import { Sheet } from '@/ui/Sheet';
import {
  copyCount,
  copyGroups,
  withoutDeclined,
  iconConflict,
  createMainCategory,
  createSubCategory,
  prepareCategoryDelete,
  prepareCategoryEdit,
} from './categoryOps';
import type { CategoryChanges, PendingCommit } from './categoryOps';
import { catName, useCategories } from './useCategories';
import type { Cat } from './useCategories';
import { takeCategoriesCreateIntent } from './categoriesHandoff';
import { CopyCategoriesSheet } from './CopyCategoriesSheet';
import type { TFunc } from '@/i18n';
import { CATEGORY_ICONS, firstFreeIcon } from './categoryIcons';
import { categoryNameConflict } from '@/domain/categoryNames';
import { LOCKED_MAIN_IDS } from '@/domain/categories';
import { SpecialCatMark } from './SpecialCatMark';
import type { CategoryNameConflict, NamedCategory } from '@/domain/categoryNames';

const NAME_ERROR_KEYS = {
  duplicateParent: 'cats.nameDuplicateParent',
  subNamedLikeParent: 'cats.nameIsParent',
  duplicateSub: 'cats.nameDuplicateSub',
} as const;

const COLORS = [
  '#E67E22', '#3498DB', '#27AE60', '#9B59B6', '#E74C3C', '#1ABC9C',
  '#F39C12', '#16A085', '#2980B9', '#E91E63', '#795548', '#607D8B',
];


type FormMode =
  | { kind: 'newMain' }
  | { kind: 'newSub'; parentId: string }
  | { kind: 'editMain'; row: CategoryRow }
  | { kind: 'editSub'; row: CategoryRow };

function holdFeedback(): void {
  hapticNotify('SUCCESS');
  navigator.vibrate?.(20);
}

/** `fired` lets the trailing click know the hold consumed this press */
function useHoldMenu(enabled: boolean, onMenu: () => void) {
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });
  const [holding, setHolding] = useState(false);
  const cancel = () => {
    if (hold.current.timer) clearTimeout(hold.current.timer);
    hold.current.timer = null;
    setHolding(false);
  };
  return {
    holding,
    fired: hold.current,
    handlers: {
      onPointerDown: () => {
        if (!enabled) return;
        hold.current.fired = false;
        setHolding(true);
        hold.current.timer = setTimeout(() => {
          hold.current.fired = true;
          setHolding(false);
          holdFeedback();
          onMenu();
        }, 450);
      },
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onPointerCancel: cancel,
      onContextMenu: (e: React.MouseEvent) => enabled && e.preventDefault(),
    },
  };
}

/** the plate under a category's icon: its own colour thinned, so the icon stays the loudest thing on it */
const tileTint = (color: string | undefined): string => `color-mix(in srgb, ${color || 'var(--m-ink-3)'} 14%, transparent)`;

/** where a sub's row starts: under its main's icon, past the chevron — the nesting is read from the row, the card stays whole */
const SUB_INSET = 'pl-[42px]';
const SUB_RULE = 'ml-[42px] mr-3 h-px bg-line-2';

function SubCatRow({
  cat,
  parentColor,
  onEdit,
  onMenu,
  t,
  onDragStart,
  dragging,
}: Readonly<{
  cat: Cat;
  parentColor?: string;
  onEdit: () => void;
  onMenu: () => void;
  t: TFunc;
  onDragStart?: (clientY: number) => void;
  dragging?: boolean;
}>) {
  const canHold = !!cat.custom && !cat.isOther;
  const hold = useHoldMenu(canHold, onMenu);
  const ink = useUserInk();
  return (
    <div
      data-testid={`cats-subrow-${cat.id}`}
      className={`flex select-none items-center pr-1.5 ${SUB_INSET}`}
      style={dragging ? { opacity: 0.3 } : undefined}
    >
      <button
        data-testid={`managecat-${cat.id}`}
        data-custom={canHold ? '1' : undefined}
        disabled={!cat.custom || cat.isOther}
        {...hold.handlers}
        onClick={() => {
          if (hold.fired.fired) return;
          onEdit();
        }}
        className={`m-tap relative isolate flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent py-2 pr-2 pl-0 text-left text-[14px] text-ink disabled:pointer-events-none ${hold.holding ? 'm-holding' : ''}`}
      >
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: tileTint(parentColor), color: ink(parentColor) }}
        >
          <Icon name={cat.icon} size={16} />
        </span>
        <SpecialCatMark cat={cat} color={parentColor} />
        <span className="min-w-0 flex-1 truncate">{catName(cat, t)}</span>
        {/* #386: no badge or wash: the pencil and the handle say "yours" */}
        {canHold && <Icon name="pencil-outline" size={16} color="var(--m-ink-4)" />}
      </button>
      {/* touch-none keeps the whole gesture ours on Android */}
      {onDragStart && (
        <button
          aria-label={t('cats.moveTarget')}
          data-testid={`cats-drag-${cat.id}`}
          onPointerDown={(e) => {
            e.preventDefault();
            onDragStart(e.clientY);
          }}
          className="m-tap flex h-9 w-9 shrink-0 touch-none items-center justify-center border-none bg-transparent text-ink-4 select-none"
        >
          <Icon name="drag-horizontal-variant" size={18} />
        </button>
      )}
    </div>
  );
}

function GroupHeader({
  parent,
  subCount,
  mainHidden,
  isExpanded,
  onToggle,
  onMenu,
  onEdit,
  t,
}: Readonly<{
  parent: Cat;
  subCount: number;
  mainHidden: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onMenu: () => void;
  onEdit?: () => void;
  t: TFunc;
}>) {
  const ink = useUserInk();
  const hold = useHoldMenu(true, onMenu);
  return (
    <div className="flex items-center gap-2 px-3 py-2.5">
      <button
        data-testid={`cats-group-${parent.id}`}
        aria-expanded={isExpanded}
        {...hold.handlers}
        onClick={() => {
          if (hold.fired.fired) return;
          onToggle();
        }}
        className={`m-tap relative isolate flex min-w-0 flex-1 select-none items-center gap-2.5 border-none bg-transparent p-0 text-left ${hold.holding ? 'm-holding' : ''}`}
      >
        <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={20} color="var(--m-ink-3)" />
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
          style={{ backgroundColor: tileTint(parent.color), color: ink(parent.color) }}
        >
          <Icon name={parent.icon} size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-[15px] font-semibold text-ink">{catName(parent, t)}</span>
            <SpecialCatMark cat={parent} color={parent.color} />
          </span>
          <span className="block text-[12px] leading-tight text-ink-3" data-testid={`cats-count-${parent.id}`}>
            {t(subCount === 1 ? 'cats.subCountOne' : 'cats.subCount', { n: subCount })}
          </span>
        </span>
        <span className="shrink-0 rounded-md bg-bg-2 px-2 py-0.5 text-[10px] font-semibold text-ink-3">
          {t(`tx.type.${parent.txTypes[0]}`)}
        </span>
      </button>
      {!mainHidden && onEdit && (
        <button
          aria-label={t('action.edit')}
          title={t('action.edit')}
          data-testid={`cats-editmain-btn-${parent.id}`}
          onClick={onEdit}
          className="m-tap flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink-3"
        >
          <Icon name="pencil-outline" size={16} />
        </button>
      )}
    </div>
  );
}

/** a main while a sub is lifted: a drop row, or a refused one that says why */
function DropRow({ parent, state, target, home, t }: Readonly<{ parent: Cat; state: DropState; target: boolean; home: boolean; t: TFunc }>) {
  const ink = useUserInk();
  if (state !== 'open') {
    return (
      <div
        data-testid={`cats-nodrop-${parent.id}`}
        data-reason={state}
        className="mt-2 flex items-center gap-2.5 rounded-card border border-dashed border-line px-4 py-3.5 opacity-45"
      >
        <Icon name={state === 'locked' ? 'lock-outline' : parent.icon} size={17} color="var(--m-ink-4)" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-3">{catName(parent, t)}</span>
        <span className="text-[11px] text-ink-4">{t(state === 'locked' ? 'cats.noDropLocked' : 'cats.noDropIcon')}</span>
      </div>
    );
  }
  let tone = 'border-line bg-surface';
  if (target) tone = 'border-accent bg-accent-soft';
  else if (home) tone = 'border-line bg-surface opacity-55';
  return (
    <div data-testid={`cats-drop-${parent.id}`} className={`mt-2 flex items-center gap-2.5 rounded-card border px-4 py-3.5 transition-colors ${tone}`}>
      <Icon name={parent.icon} size={17} color={parent.color} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium" style={{ color: ink(parent.color) }}>
        {catName(parent, t)}
      </span>
      <span className="rounded bg-bg-2 px-1.5 py-0.5 text-[9px] font-semibold text-ink-3">{t(`tx.type.${parent.txTypes[0]}`)}</span>
    </div>
  );
}

const parentIdOf = (mode: FormMode | null, moveTo: string | null): string | undefined => {
  if (mode?.kind === 'newSub') return mode.parentId;
  if (mode?.kind === 'editSub') return moveTo ?? mode.row.parentId;
  return undefined;
};
const selfIdOf = (mode: FormMode | null): string | undefined =>
  mode?.kind === 'editMain' || mode?.kind === 'editSub' ? mode.row.id : undefined;
// a main is a drop place for a lifted sub, or refused: a locked special (#385) or a main where a sub already wears
// the lifted one's icon (#389)
type DropState = 'open' | 'locked' | 'icon';
const dropStateOf = (parentId: string, lifted: CategoryRow, all: readonly Cat[]): DropState => {
  if (LOCKED_MAIN_IDS.has(parentId)) return 'locked';
  if (parentId !== lifted.parentId && iconConflict({ icon: lifted.icon, parentId, selfId: lifted.id }, all)) return 'icon';
  return 'open';
};
// #389: a clash the person CHOSE (a new pick or a move); a sub that already shared its face before the rule still saves
const iconClashes = (mode: FormMode | null, icon: string, moveTo: string | null, worn: ReadonlySet<string>): boolean => {
  if (mode?.kind !== 'newSub' && mode?.kind !== 'editSub') return false;
  if (!worn.has(icon)) return false;
  return mode.kind === 'newSub' || icon !== mode.row.icon || moveTo !== null;
};

export function ManageCategoriesScreen() {
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const [groupMenu, setGroupMenu] = useState<Cat | null>(null);
  const toggleGroup = (id: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const { t } = useLang();
  const ink = useUserInk();
  const { store, repo, spaceId } = useData();
  const cats = useCategories();
  // #505: the space's categories are its members' to change — a reader only browses them
  const canEdit = useCanEdit();
  const [mode, setMode] = useState<FormMode | null>(null);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState(CATEGORY_ICONS[0]);
  const [iconQuery, setIconQuery] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [txType, setTxType] = useState<TxType>('expense');
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const [moveSheetOpen, setMoveSheetOpen] = useState(false);
  const [subMenu, setSubMenu] = useState<Cat | null>(null);
  const [dragging, setDragging] = useState<CategoryRow | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moveConfirm, setMoveConfirm] = useState<{ sub: CategoryRow; targetId: string; commit: PendingCommit } | null>(null);
  const [dragError, setDragError] = useState<CategoryNameConflict | null>(null);
  const dropTargetRef = useRef<string | null>(null);
  dropTargetRef.current = dropTarget;
  const ghostRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pointerY = useRef(0);
  // live "a drag owns the pointer" flag (state is too slow for native
  // event dispatch)
  const dragActiveRef = useRef(false);

  // #572: the drop rows keep the last lifted sub while they fold away after the drop
  const [lifted, setLifted] = useState<CategoryRow | null>(null);

  const startDrag = (row: CategoryRow, clientY: number) => {
    dragActiveRef.current = true;
    pointerY.current = clientY;
    navigator.vibrate?.(15);
    setLifted(row);
    setDragging(row);
  };
  const [pending, setPending] = useState<PendingCommit | null>(null);
  const [pendingKind, setPendingKind] = useState<'edit' | 'delete'>('edit');
  const [pendingDetail, setPendingDetail] = useState<string | undefined>(undefined);
  const [copyOpen, setCopyOpen] = useState(false);

  const [nameError, setNameError] = useState<CategoryNameConflict | null>(null);
  const [attempted, setAttempted] = useState(false);

  const customRows = useQuery(
    store,
    async () => (await store.allRows('category')).filter((c) => c.deleted === 0),
    [],
  );
  const rowById = (id: string) => customRows?.find((r) => r.id === id);

  const copyOffers = useQuery(
    store,
    async () => {
      const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0);
      const all = copyGroups(spaceId, spaces, await store.allRows('category'));
      // #390 r4: what this space said no to stays out until its main gains a sub
      const offered = withoutDeclined(all, spaces.find((s) => s.id === spaceId)?.copyDeclined);
      return { offered, hidden: all.length - offered.length };
    },
    [spaceId],
  );
  const copyable = copyOffers?.offered;
  const copyTotal = copyCount(copyable ?? []);

  const openNewMain = () => {
    setName('');
    setIcon(CATEGORY_ICONS[0]);
    setIconQuery('');
    setColor(COLORS[0]);
    setTxType('expense');
    setNameError(null); // #247: a stale conflict must not flash into a fresh form
    setAttempted(false);
    setMode({ kind: 'newMain' });
  };
  // #180: the home FAB's "new category" arrives with the create intent
  useEffect(() => {
    if (takeCategoriesCreateIntent()) openNewMain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const openNewSub = (parentId: string) => {
    setName('');
    // #389: siblings never share an icon — start on the first curated one that is still free
    setIcon(firstFreeIcon(new Set(cats.childrenOf(parentId).map((c) => c.icon))));
    setIconQuery('');
    setNameError(null);
    setAttempted(false);
    setMode({ kind: 'newSub', parentId });
  };
  const openEdit = (cat: Cat) => {
    const row = rowById(cat.id);
    if (!row || cat.isOther) return; // "Other" subs are fixed
    setName(row.name ?? '');
    setIcon(row.icon);
    setIconQuery('');
    setColor(row.color || COLORS[0]);
    setTxType(row.txType);
    setMoveTo(null);
    setNameError(null);
    setAttempted(false);
    setMode(row.isParent === 1 ? { kind: 'editMain', row } : { kind: 'editSub', row });
  };

  const runGuarded = async (commit: PendingCommit, kind: 'edit' | 'delete', detail?: string) => {
    if (commit.affected.length === 0) {
      await commit.commit();
      void logActivity(store, repo, spaceId, kind === 'delete' ? 'catRemove' : 'catEdit', detail);
      setMode(null);
    } else {
      setPendingKind(kind);
      setPendingDetail(detail);
      setPending(commit);
    }
  };

  const namedCategories = (): NamedCategory[] =>
    cats.all.map((cat) => ({
      id: cat.id,
      name: catName(cat, t),
      isParent: !!cat.isParent,
      parentId: cat.parentId,
    }));

  // #389: the icons the form's siblings already wear (the row being edited excluded) — refused in the grid
  const wornIcons = (() => {
    const parentId = parentIdOf(mode, moveTo);
    if (!parentId) return new Set<string>();
    const selfId = selfIdOf(mode);
    return new Set(cats.childrenOf(parentId).filter((c) => c.id !== selfId).map((c) => c.icon));
  })();
  const iconBlocked = iconClashes(mode, icon, moveTo, wornIcons);

  const save = async () => {
    if (!mode || !name.trim() || iconBlocked) return;
    const candidateParentId = parentIdOf(mode, moveTo);
    const conflict = categoryNameConflict({ name, parentId: candidateParentId, selfId: selfIdOf(mode) }, namedCategories());
    if (conflict) {
      setNameError(conflict);
      return;
    }
    if (mode.kind === 'newMain') {
      // #244: every new parent IS an expense group
      await createMainCategory(repo, spaceId, { name: name.trim(), icon, color, txType: 'expense', otherName: t('cats.other') });
      void logActivity(store, repo, spaceId, 'catAdd', name.trim());
      setMode(null);
    } else if (mode.kind === 'newSub') {
      await createSubCategory(store, repo, spaceId, { parentId: mode.parentId, name: name.trim(), icon });
      void logActivity(store, repo, spaceId, 'catAdd', name.trim());
      setMode(null);
    } else {
      const changes: CategoryChanges =
        mode.kind === 'editMain'
          ? { name: name.trim(), icon, color, txType }
          : { name: name.trim(), icon, ...(moveTo ? { parentId: moveTo } : {}) };
      await runGuarded(await prepareCategoryEdit(store, repo, mode.row, changes), 'edit', name.trim());
    }
  };

  const remove = async () => {
    if (!mode || (mode.kind !== 'editMain' && mode.kind !== 'editSub')) return;
    await runGuarded(await prepareCategoryDelete(store, repo, mode.row), 'delete', mode.row.name);
  };

  const confirmPending = async () => {
    if (!pending) return;
    await pending.commit();
    void logActivity(store, repo, spaceId, pendingKind === 'delete' ? 'catRemove' : 'catEdit', pendingDetail);
    setPending(null);
    setMode(null);
  };

  /** per-space main visibility: hidden mains leave every picker but data never blocks */
  const toggleMainVisibility = async (id: string) => {
    const space = await store.get('space', spaceId);
    if (!space) return;
    const next = new Set(space.hiddenMains ?? []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    await repo.upsert('space', spaceId, spaceId, { hiddenMains: [...next] });
  };

  useEffect(() => {
    if (!dragging) return;
    const scroller = scrollRef.current;

    const targetUnderRail = () => {
      const rect = scroller?.getBoundingClientRect();
      const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const y = rect ? Math.min(Math.max(pointerY.current, rect.top + 1), rect.bottom - 1) : pointerY.current;
      const group = document.elementFromPoint(x, y)?.closest?.('[data-cat-group]');
      return (group as HTMLElement | null)?.dataset.catGroup ?? null;
    };
    // ABSOLUTE inside the scroll container, not fixed: iOS misplaces fixed elements inside our measured-height app frame
    const positionGhost = () => {
      const rect = scroller?.getBoundingClientRect();
      if (!ghostRef.current || !rect || !scroller) return;
      ghostRef.current.style.top = `${pointerY.current - rect.top + scroller.scrollTop}px`;
    };
    const endDrag = () => {
      dragActiveRef.current = false;
      setDragging(null);
      setDropTarget(null);
    };
    const onMove = (e: PointerEvent) => {
      pointerY.current = e.clientY;
      positionGhost();
      setDropTarget(targetUnderRail());
    };
    const onUp = () => {
      const targetId = dropTargetRef.current;
      endDrag();
      if (!targetId || targetId === dragging.parentId || dropStateOf(targetId, dragging, cats.all) !== 'open') return;
      // naming rules apply to drags too: the target parent may already hold the name
      const conflict = categoryNameConflict(
        { name: catName(cats.byId(dragging.id), t), parentId: targetId, selfId: dragging.id },
        namedCategories(),
      );
      if (conflict) {
        setDragError(conflict);
        setTimeout(() => setDragError(null), 4000);
        return;
      }
      prepareCategoryEdit(store, repo, dragging, { parentId: targetId })
        .then((commit) => setMoveConfirm({ sub: dragging, targetId, commit }))
        .catch(() => undefined); // db closed under us (teardown) — drop the move
    };
    // the browser reclaimed the pointer (Android does this the moment it
    // decides the gesture is a scroll) — that is a CANCEL, never a drop
    const onCancel = () => endDrag();
    // the drag owns every touch until the finger lifts — without this,
    // Android reclaims the gesture as a scroll mid-drag
    const blockTouch = (ev: TouchEvent) => {
      if (dragActiveRef.current && ev.cancelable) ev.preventDefault();
    };
    // a rAF loop, not just pointermove: holding still near an edge must keep scrolling
    let raf = requestAnimationFrame(function tick() {
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        const zone = 64;
        let dy = 0;
        if (pointerY.current < rect.top + zone) dy = -Math.ceil((rect.top + zone - pointerY.current) / 6);
        else if (pointerY.current > rect.bottom - zone) dy = Math.ceil((pointerY.current - (rect.bottom - zone)) / 6);
        if (dy !== 0) scroller.scrollTop += dy;
      }
      // #572: the list folds over a few frames under a finger that may stand still — every frame re-anchors
      positionGhost();
      setDropTarget(targetUnderRail());
      raf = requestAnimationFrame(tick);
    });
    positionGhost();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onCancel, { once: true });
    window.addEventListener('touchmove', blockTouch, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('touchmove', blockTouch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  const editing = mode?.kind === 'editMain' || mode?.kind === 'editSub';
  const isMainForm = mode?.kind === 'newMain' || mode?.kind === 'editMain';
  let formParent = null;
  if (mode?.kind === 'newSub') formParent = cats.byId(mode.parentId);
  else if (mode?.kind === 'editSub') formParent = cats.byId(mode.row.parentId);
  let formTitle = t('cats.editCustom');
  if (mode?.kind === 'newMain') formTitle = t('cats.newMain');
  else if (mode?.kind === 'newSub') formTitle = t('cats.newSub');

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-manage-cats">
      <AppBar
        title={t('screen.categories')}
        sub={t('cats.manageSpace')}
        leading={
          <IconButton label={t('action.back')} testId="cats-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
        trailing={
          <>
            <HelpButton tourId="categories" />
            {canEdit && (
              <IconButton label={t('cats.newMain')} testId="cats-add" onClick={openNewMain}>
                <Icon name="plus" size={22} />
              </IconButton>
            )}
          </>
        }
      />
      <div ref={scrollRef} className={`relative min-h-0 flex-1 overflow-y-auto px-5 pb-6 ${dragging ? 'select-none' : ''}`}>
        <ReadOnlyNote className="mt-2" testId="cats-readonly-note" />
        {dragError && (
          <p
            className="mt-2 rounded-card border border-negative/40 bg-negative/10 px-3 py-2 text-[12px] text-negative"
            data-testid="cats-drag-error"
          >
            {t(NAME_ERROR_KEYS[dragError])}
          </p>
        )}
        {canEdit && copyTotal > 0 && (
          <button
            data-testid="cats-copy-open"
            onClick={() => setCopyOpen(true)}
            className="m-tap mt-2 flex w-full items-center gap-2 rounded-card border border-accent bg-accent-soft px-4 py-3 text-left text-[13px] font-medium text-accent-deep"
          >
            <Icon name="content-copy" size={17} />
            <span className="min-w-0 flex-1">{t(copyTotal === 1 ? 'cats.copyBannerOne' : 'cats.copyBanner', { n: copyTotal })}</span>
            <Icon name="chevron-right" size={17} />
          </button>
        )}
        {cats.allParents.map((parent) => {
          const mainHidden = cats.hiddenMains.has(parent.id);
          // fold mode: every main collapses into a drop row so a long list fits a couple of screens; hidden mains take no drops,
          // refused ones say why (#385, #389)
          const drop = lifted && !mainHidden ? dropStateOf(parent.id, lifted, cats.all) : null;
          return (
            <div key={parent.id} data-cat-group={!dragging || drop === 'open' ? parent.id : undefined} className={mainHidden ? 'opacity-55' : ''}>
              <Collapse open={!dragging}>
              {/* #651: one card per main, as wide as the list — its subs open inside it, inset under its icon */}
              <div className="pt-2.5">
              <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid={`cats-card-${parent.id}`}>
              <GroupHeader
                parent={parent}
                subCount={cats.childrenOf(parent.id).length}
                mainHidden={mainHidden}
                isExpanded={expandedGroups.has(parent.id)}
                onToggle={() => toggleGroup(parent.id)}
                onMenu={() => canEdit && setGroupMenu(parent)}
                onEdit={parent.custom && canEdit ? () => openEdit(parent) : undefined}
                t={t}
              />
              {mainHidden && (
                <p className={`pr-3 pb-2.5 text-[11px] text-ink-4 ${SUB_INSET}`} data-testid={`cats-hiddennote-${parent.id}`}>
                  {t('cats.hiddenNote')}
                </p>
              )}
              {!mainHidden && (
              <Collapse open={expandedGroups.has(parent.id)}>
              <div className="border-t border-line-2 py-1">
                {cats.childrenOf(parent.id).map((cat, i) => (
                  <div key={cat.id}>
                    {i > 0 && <div className={SUB_RULE} />}
                    <SubCatRow
                      cat={cat}
                      parentColor={parent.color}
                      onEdit={() => canEdit && openEdit(cat)}
                      onMenu={() => canEdit && setSubMenu(cat)}
                      t={t}
                      onDragStart={
                        canEdit && cat.custom && !cat.isOther && !cat.isParent
                          ? (clientY) => {
                              const row = rowById(cat.id);
                              if (row) startDrag(row, clientY);
                            }
                          : undefined
                      }
                      dragging={false} /* fold mode replaces rows while a drag is live */
                    />
                  </div>
                ))}
                {/* #382 (user): the add door sits below "Other", where the new sub will land */}
                {canEdit && !LOCKED_MAIN_IDS.has(parent.id) && (
                  <>
                    <div className={SUB_RULE} />
                    <button
                      data-testid={`cats-addsub-${parent.id}`}
                      onClick={() => openNewSub(parent.id)}
                      className={`m-tap flex w-full items-center gap-3 border-none bg-transparent py-2 pr-4 text-left text-[13px] font-medium text-accent-deep ${SUB_INSET}`}
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                        <Icon name="plus-circle-outline" size={19} />
                      </span>
                      {t('cats.addSub')}
                    </button>
                  </>
                )}
              </div>
              </Collapse>
              )}
              </div>
              </div>
              </Collapse>
              <Collapse open={!!dragging && !mainHidden}>
                {lifted && drop && <DropRow parent={parent} state={drop} target={dropTarget === parent.id} home={parent.id === lifted.parentId} t={t} />}
              </Collapse>
            </div>
          );
        })}

        {/* content coordinates: fixed proved unreliable inside the measured-height app frame on iOS */}
        {dragging && (
          <div
            ref={ghostRef}
            data-testid="cats-drag-ghost"
            className="pointer-events-none absolute inset-x-0 z-30 mx-auto w-[80%] max-w-sm -translate-y-1/2"
          >
            <div className="flex items-center gap-3 rounded-card border border-accent bg-surface px-4 py-3 shadow-xl">
              <Icon name={dragging.icon} size={19} color={cats.byId(dragging.parentId ?? '')?.color} />
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{dragging.name}</span>
              <Icon name="drag-horizontal-variant" size={18} color="var(--m-ink-4)" />
            </div>
          </div>
        )}
      </div>

      <Sheet
        open={subMenu !== null}
        onOpenChange={(next) => !next && setSubMenu(null)}
        title={subMenu ? catName(subMenu, t) : ''}
        size="compact"
      >
        {subMenu && (
          <div className="flex flex-col pt-1" data-testid="cats-sub-menu">
            <button
              data-testid={`cats-editsub-${subMenu.id}`}
              onClick={() => {
                const row = subMenu;
                setSubMenu(null);
                openEdit(row);
              }}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-2 py-3.5 text-left text-[15px] text-ink"
            >
              <Icon name="pencil-outline" size={20} color="var(--m-ink-3)" />
              {t('action.edit')}
            </button>
            <button
              data-testid={`cats-movesub-${subMenu.id}`}
              onClick={() => {
                const row = subMenu;
                setSubMenu(null);
                openEdit(row);
                setMoveSheetOpen(true);
              }}
              className="m-tap flex w-full items-center gap-3 bg-transparent px-2 py-3.5 text-left text-[15px] text-ink"
            >
              <Icon name="folder-move-outline" size={20} color="var(--m-ink-3)" />
              {t('cats.moveTarget')}
            </button>
          </div>
        )}
      </Sheet>

      <Sheet
        open={moveConfirm !== null}
        onOpenChange={(open) => !open && setMoveConfirm(null)}
        title={t('cats.moveConfirmTitle')}
        size="compact"
      >
        {moveConfirm && (
          <>
            <div className="flex items-center justify-center gap-2.5 pt-3" data-testid="cats-move-visual">
              {[cats.byId(moveConfirm.sub.parentId ?? ''), cats.byId(moveConfirm.targetId)].map((end, i) => (
                <span key={end?.id ?? i} className="contents">
                  {i === 1 && <Icon name="arrow-right" size={17} color="var(--m-ink-4)" />}
                  <span
                    className="flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] font-medium"
                    style={{ color: ink(end?.color) }}
                  >
                    <Icon name={end?.icon ?? 'help-circle-outline'} size={15} />
                    <span className="max-w-[110px] truncate">{end ? catName(end, t) : '?'}</span>
                  </span>
                </span>
              ))}
            </div>
            <p className="pt-3 text-center text-[14px] text-ink-2" data-testid="cats-move-text">
              {t('cats.moveConfirmText', { name: moveConfirm.sub.name ?? '' })}
            </p>
            {moveConfirm.commit.affected.length > 0 && (
              <p className="pt-1 text-center text-[12px]" style={{ color: 'var(--m-warning)' }}>
                {t('cats.impactWarning', { n: moveConfirm.commit.affected.length })}
              </p>
            )}
            <div className="mt-4 flex gap-3">
              <Button variant="outline" className="flex-1" data-testid="cats-move-cancel" onClick={() => setMoveConfirm(null)}>
                {t('action.cancel')}
              </Button>
              <Button
                className="flex-1"
                data-testid="cats-move-confirm"
                onClick={() => {
                  void moveConfirm.commit.commit().then(() => {
                    void logActivity(store, repo, spaceId, 'catEdit', moveConfirm.sub.name);
                    setMoveConfirm(null);
                  });
                }}
              >
                {t('action.confirm')}
              </Button>
            </div>
          </>
        )}
      </Sheet>

      <Sheet
        open={mode !== null}
        onOpenChange={(open) => {
          if (open) return;
          setMode(null);
          // #247: a click-away flashed the OLD conflict while the exit animation ran
          setNameError(null);
          setAttempted(false);
          setIconQuery('');
        }}
        title={formTitle}
        size="tall"
        // pinned footer: a sticky one floated over the icon grid once the keyboard/safe-area shifted the scrollport
        footer={
          <div className="flex flex-col gap-2">
            <Button
              data-testid="catform-save"
              disabled={iconBlocked}
              onClick={() => {
                if (!name.trim()) {
                  setAttempted(true);
                  return;
                }
                void save();
              }}
            >
              {editing ? t('action.save') : t('action.add')}
            </Button>
            {editing && (
              <Button variant="danger" data-testid="catform-delete" onClick={() => void remove()}>
                {t('action.delete')}
              </Button>
            )}
          </div>
        }
      >
        <div className="flex flex-col gap-3 pt-1">
          {formParent && (
            <div className="flex items-center gap-2 text-[13px] text-ink-3">
              <Icon name={formParent.icon} size={16} color={formParent.color} />
              {catName(formParent, t)} ·{' '}
              <span data-testid="catform-inherited-type">{t(`tx.type.${formParent.txTypes[0]}`)}</span>
            </div>
          )}
          <input
            data-testid="catform-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
            placeholder={t('cats.name')}
            aria-invalid={attempted && !name.trim()}
            className={`h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4${blockerRing(attempted && !name.trim())}`}
          />
          {/* #195: the blocker sits AT the field; the sheet scrolls it into view */}
          <FormBlockerNote show={attempted && !name.trim()} text={t('form.needName')} testId="catform-save-blocker" />
          {nameError && (
            <p className="text-[12px] text-negative" data-testid="catform-name-error">
              {t(NAME_ERROR_KEYS[nameError])}
            </p>
          )}

          {/* #244: a new parent IS an expense group; income lives under the special Income category */}
          {isMainForm && (
            <>
              {mode?.kind === 'newMain' && (
                <p className="rounded-card bg-bg-2 px-3 py-2 text-[12px] leading-relaxed text-ink-3" data-testid="catform-expense-note">
                  {t('cats.newMainExpenseNote')}
                </p>
              )}
              <div className="m-cap px-1">{t('cats.color')}</div>
              <ColorPicker
                colors={COLORS}
                value={color}
                onChange={setColor}
                testIdPrefix="catform-color"
                customLabel={t('color.custom')}
              />
            </>
          )}

          {!isMainForm && (
            <>
              {mode?.kind === 'editSub' && (
                <>
                  <div className="m-cap px-1">{t('cats.moveTarget')}</div>
                  {/* a picker row: the list of mains grows, chips don't */}
                  <button
                    data-testid="catform-move-open"
                    onClick={() => setMoveSheetOpen(true)}
                    className="m-tap flex h-12 w-full items-center gap-3 rounded-input border border-line bg-surface px-4 text-left text-[14px]"
                  >
                    {(() => {
                      const target = moveTo ? cats.byId(moveTo) : null;
                      return target ? (
                        <>
                          <Icon name={target.icon} size={18} color={target.color} />
                          <span className="min-w-0 flex-1 truncate font-medium text-ink">{catName(target, t)}</span>
                        </>
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-ink-3">{t('cats.moveNone')}</span>
                      );
                    })()}
                    <Icon name="chevron-down" size={17} color="var(--m-ink-4)" />
                  </button>
                </>
              )}
            </>
          )}

          {/* #389: icons a sibling wears are asleep and refused: no error after the fact */}
          <IconPicker
            value={icon}
            onChange={setIcon}
            featured={CATEGORY_ICONS}
            query={iconQuery}
            onQuery={setIconQuery}
            testIdPrefix="catform-icon"
            taken={isMainForm ? undefined : wornIcons}
          />
          {/* only a move can land the icon on a sibling's: say so before Save, which waits for a free one */}
          {iconBlocked && (
            <p className="text-[12px] text-negative" data-testid="catform-icon-taken">
              {t('cats.iconTaken')}
            </p>
          )}
        </div>
      </Sheet>

      <Sheet open={moveSheetOpen} onOpenChange={setMoveSheetOpen} title={t('cats.moveTarget')} size="form" dragHandle>
        {mode?.kind === 'editSub' && (
          <div className="pt-1" data-testid="catform-move-list">
            <button
              data-testid="catform-move-keep"
              onClick={() => {
                setMoveTo(null);
                setMoveSheetOpen(false);
              }}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink-2"
            >
              <Icon name="undo-variant" size={18} color="var(--m-ink-4)" />
              <span className="min-w-0 flex-1 truncate">{t('cats.moveNone')}</span>
              {moveTo === null && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
            </button>
            {cats.parents
              .filter((p) => p.id !== mode.row.parentId && !LOCKED_MAIN_IDS.has(p.id))
              .map((p) => (
                <button
                  key={p.id}
                  data-testid={`catform-move-${p.id}`}
                  onClick={() => {
                    setMoveTo(p.id);
                    setMoveSheetOpen(false);
                  }}
                  className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink last:border-0"
                >
                  <Icon name={p.icon} size={18} color={p.color} />
                  <span className="min-w-0 flex-1 truncate">{catName(p, t)}</span>
                  <span className="rounded bg-bg-2 px-1.5 py-0.5 text-[9px] font-semibold text-ink-3">
                    {t(`tx.type.${p.txTypes[0]}`)}
                  </span>
                  {moveTo === p.id && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
                </button>
              ))}
          </div>
        )}
      </Sheet>

      <Sheet open={pending !== null} onOpenChange={(open) => !open && setPending(null)} title={t('cats.impactTitle')} size="compact">
        <p className="pt-1 text-[14px] text-ink-2" data-testid="cats-impact-text">
          {t(pendingKind === 'delete' ? 'cats.deleteWarning' : 'cats.impactWarning', {
            n: pending?.affected.length ?? 0,
          })}
        </p>
        <div className="mt-4 flex gap-3">
          <Button variant="outline" className="flex-1" data-testid="cats-impact-cancel" onClick={() => setPending(null)}>
            {t('action.cancel')}
          </Button>
          <Button variant="danger" className="flex-1" data-testid="cats-impact-confirm" onClick={() => void confirmPending()}>
            {t('action.confirm')}
          </Button>
        </div>
      </Sheet>

      <CopyCategoriesSheet open={copyOpen} onOpenChange={setCopyOpen} groups={copyable ?? []} hidden={copyOffers?.hidden ?? 0} />

      <Sheet
        open={!!groupMenu}
        onOpenChange={(next) => !next && setGroupMenu(null)}
        title={groupMenu ? catName(groupMenu, t) : ''}
        size="compact"
      >
        {groupMenu && (
          <div className="flex flex-col pt-1" data-testid="cats-group-menu">
            {/* #381 (user): a custom main is this space's own — hiding it makes no sense, deleting does */}
            {!groupMenu.custom && (
              <button
                data-testid={`cats-togglemain-${groupMenu.id}`}
                onClick={() => {
                  void toggleMainVisibility(groupMenu.id);
                  setGroupMenu(null);
                }}
                className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-2 py-3.5 text-left text-[15px] text-ink"
              >
                <Icon
                  name={cats.hiddenMains.has(groupMenu.id) ? 'eye-outline' : 'eye-off-outline'}
                  size={20}
                  color="var(--m-ink-3)"
                />
                {t(cats.hiddenMains.has(groupMenu.id) ? 'cats.showMain' : 'cats.hideMain')}
              </button>
            )}
            {groupMenu.custom && (
              <button
                data-testid={`cats-editmain-${groupMenu.id}`}
                onClick={() => {
                  const row = groupMenu;
                  setGroupMenu(null);
                  openEdit(row);
                }}
                className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-2 py-3.5 text-left text-[15px] text-ink"
              >
                <Icon name="pencil-outline" size={20} color="var(--m-ink-3)" />
                {t('action.edit')}
              </button>
            )}
            {/* #261: locked system mains refuse user subs through EVERY door */}
            {!LOCKED_MAIN_IDS.has(groupMenu.id) && (
              <button
                data-testid={`cats-menu-addsub-${groupMenu.id}`}
                onClick={() => {
                  const id = groupMenu.id;
                  setGroupMenu(null);
                  openNewSub(id);
                }}
                className="m-tap flex w-full items-center gap-3 bg-transparent px-2 py-3.5 text-left text-[15px] text-ink"
              >
                <Icon name="plus" size={20} color="var(--m-ink-3)" />
                {t('cats.addSub')}
              </button>
            )}
          </div>
        )}
      </Sheet>
    </div>
  );
}
