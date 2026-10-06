import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import type { CategoryRow, TxType } from '@/db/types';
import { useLang } from '@/i18n';
import { SpacePicture } from '@/features/spaces/SpacePicture';
import { useData } from '@/app/data';
import { logActivity } from '@/application/activity';
import { hapticNotify } from '@/lib/platform';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { ColorPicker } from '@/ui/ColorPicker';
import { FormBlockerNote, blockerRing } from '@/ui/FormBlockerNote';
import { Collapse } from '@/ui/Collapse';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { SearchField } from '@/ui/SearchField';
import {
  copyCategoryToSpace,
  copyableUnits,
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
import type { TFunc } from '@/i18n';
import { MDI_NAMES } from '@/generated/mdiNames';
import { categoryNameConflict } from '@/domain/categoryNames';
import { LOCKED_MAIN_IDS } from '@/domain/categories';
import { SpecialCatMark } from './SpecialCatMark';
import type { CategoryNameConflict, NamedCategory } from '@/domain/categoryNames';

const NAME_ERROR_KEYS = {
  duplicateParent: 'cats.nameDuplicateParent',
  subNamedLikeParent: 'cats.nameIsParent',
  duplicateSub: 'cats.nameDuplicateSub',
} as const;

// curated MDI icons for custom categories
const ICONS = [
  'silverware-fork-knife', 'coffee-outline', 'cart-outline', 'cash', 'gift-outline', 'home-outline',
  'car-outline', 'bus', 'bike', 'airplane', 'gamepad-variant-outline', 'music',
  'movie-open-outline', 'book-open-outline', 'school-outline', 'heart-outline', 'medical-bag', 'pill',
  'dumbbell', 'run', 'tshirt-crew-outline', 'shoe-sneaker', 'laptop', 'cellphone',
  'sofa-outline', 'flower-outline', 'paw', 'baby-carriage', 'beach', 'tent',
  'tools', 'lightning-bolt-outline', 'water-outline', 'fire', 'leaf', 'tag-outline',
];

const COLORS = [
  '#E67E22', '#3498DB', '#27AE60', '#9B59B6', '#E74C3C', '#1ABC9C',
  '#F39C12', '#16A085', '#2980B9', '#E91E63', '#795548', '#607D8B',
];


type FormMode =
  | { kind: 'newMain' }
  | { kind: 'newSub'; parentId: string }
  | { kind: 'editMain'; row: CategoryRow }
  | { kind: 'editSub'; row: CategoryRow };

/** group header (user redesign 2026-07-17): the whole row is a fold
 *  toggle; press-and-hold opens the action menu (visibility, edit, add
 *  sub) that used to crowd the row as tiny 14px icons */
/** hold-menu feedback: native haptic tick + web vibration where supported */
function holdFeedback(): void {
  hapticNotify('SUCCESS');
  navigator.vibrate?.(20);
}

/** press-and-hold arming shared by mains and subs: the growing
 *  highlight, the haptic cue, then the menu; `fired` lets the trailing
 *  click know the hold consumed this press */
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
        setHolding(true); // the growing highlight (user request)
        hold.current.timer = setTimeout(() => {
          hold.current.fired = true;
          setHolding(false);
          holdFeedback(); // a physical cue that the menu is coming (user request)
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

/** a sub row: hold (custom, non-Other) opens the action menu; the
 *  handlers sit on the native row button itself */
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
  /** custom subs drag onto another main (restored, user request) */
  /** present on movable rows: lifts the row into the fold-and-drop flow */
  onDragStart?: (clientY: number) => void;
  dragging?: boolean;
}>) {
  const canHold = !!cat.custom && !cat.isOther;
  const hold = useHoldMenu(canHold, onMenu);
  return (
    <div
      data-testid={`cats-subrow-${cat.id}`}
      className="flex select-none items-center"
      style={dragging ? { opacity: 0.3 } : undefined}
    >
      <button
        data-testid={`managecat-${cat.id}`}
        data-custom={canHold ? '1' : undefined}
        disabled={!cat.custom || cat.isOther}
        {...hold.handlers}
        onClick={() => {
          if (hold.fired.fired) return; // the hold consumed this press
          onEdit();
        }}
        className={`m-tap relative isolate flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent px-4 py-3 text-left text-[14px] text-ink disabled:pointer-events-none ${hold.holding ? 'm-holding' : ''}`}
      >
        <Icon name={cat.icon} size={19} color={parentColor} />
        {/* #244: direction left the user's vocabulary — the parent's
            nature (expense / income badge on the group) says it all */}
        {/* #261: the ◆ shows here too — managing must tell special apart */}
        <SpecialCatMark cat={cat} color={parentColor} />
        <span className="min-w-0 flex-1 truncate">{catName(cat, t)}</span>
        {/* #386 (user): the badge and the wash were overkill — the pencil (and the handle) say "yours" */}
        {canHold && <Icon name="pencil-outline" size={16} color="var(--m-ink-4)" />}
      </button>
      {/* right-side handle (restored pre-replacement design): lifts
          instantly; touch-none keeps the whole gesture ours on Android */}
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
  mainHidden,
  isExpanded,
  onToggle,
  onMenu,
  onEdit,
  t,
}: Readonly<{
  parent: Cat;
  mainHidden: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onMenu: () => void;
  /** #383: a custom main shows its pencil — the hold menu stays for the rest */
  onEdit?: () => void;
  t: TFunc;
}>) {
  const hold = useHoldMenu(true, onMenu);
  return (
    <div className="mt-5 mb-1 flex items-center gap-2 px-1">
      <button
        data-testid={`cats-group-${parent.id}`}
        aria-expanded={isExpanded}
        {...hold.handlers}
        onClick={() => {
          if (hold.fired.fired) return; // the hold consumed this press
          onToggle();
        }}
        className={`m-tap relative isolate flex h-8 min-w-0 flex-1 select-none items-center gap-2.5 border-none bg-transparent p-0 text-left text-[14px] font-semibold ${hold.holding ? 'm-holding' : ''}`}
        style={{ color: parent.color }}
      >
        <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={20} />
        <Icon name={parent.icon} size={20} />
        <SpecialCatMark cat={parent} color={parent.color} />
        <span className="min-w-0 flex-1 truncate">{catName(parent, t)}</span>
        <span className="rounded-md bg-bg-2 px-2 py-0.5 text-[10px] font-semibold text-ink-3">
          {t(`tx.type.${parent.txTypes[0]}`)}
        </span>
      </button>
      {!mainHidden && onEdit && (
        <button
          aria-label={t('action.edit')}
          title={t('action.edit')}
          data-testid={`cats-editmain-btn-${parent.id}`}
          onClick={onEdit}
          className="m-tap flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink-3 shadow-[0_1px_4px_rgba(0,0,0,0.06)]"
        >
          <Icon name="pencil-outline" size={16} />
        </button>
      )}
    </div>
  );
}

/** the parent a sub form files under: a new sub's parent, or an edited sub's (possibly moved) one */
const parentIdOf = (mode: FormMode | null, moveTo: string | null): string | undefined => {
  if (mode?.kind === 'newSub') return mode.parentId;
  if (mode?.kind === 'editSub') return moveTo ?? mode.row.parentId;
  return undefined;
};
/** the row an edit form stands for — excluded from its own conflict checks */
const selfIdOf = (mode: FormMode | null): string | undefined =>
  mode?.kind === 'editMain' || mode?.kind === 'editSub' ? mode.row.id : undefined;

export function ManageCategoriesScreen() {
  // fold state (user redesign): everything starts collapsed
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
  const { store, repo, spaceId } = useData();
  const cats = useCategories();
  const [mode, setMode] = useState<FormMode | null>(null);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState(ICONS[0]);
  const [iconQuery, setIconQuery] = useState('');
  // #389: a sibling already wears the picked icon
  const [iconError, setIconError] = useState(false);
  // #390: the other spaces' custom categories this space lacks, ticked for copying
  const [copyPicked, setCopyPicked] = useState<ReadonlySet<string>>(new Set());
  const toggleCopyUnit = (id: string, on: boolean) =>
    setCopyPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const [color, setColor] = useState(COLORS[0]);
  const [txType, setTxType] = useState<TxType>('expense');
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const [moveSheetOpen, setMoveSheetOpen] = useState(false);
  // hold on a custom sub opens its action sheet (accessible alternative)
  const [subMenu, setSubMenu] = useState<Cat | null>(null);
  // restored pre-replacement drag (user request, from 683f068a): lift a
  // custom sub via its right-side handle, every main folds into a drop
  // row, a ghost follows the finger on a vertical rail, edges
  // auto-scroll, release asks for confirmation
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

  const startDrag = (row: CategoryRow, clientY: number) => {
    dragActiveRef.current = true;
    pointerY.current = clientY;
    navigator.vibrate?.(15); // lift feedback where supported
    setDragging(row);
  };
  const [pending, setPending] = useState<PendingCommit | null>(null);
  const [pendingKind, setPendingKind] = useState<'edit' | 'delete'>('edit');
  const [pendingDetail, setPendingDetail] = useState<string | undefined>(undefined);
  const [copyOpen, setCopyOpen] = useState(false);

  // pointer-based drag & drop: lift a custom sub (long-press or handle),
  // every main folds into a drop row, a ghost follows the finger on a
  // vertical rail, edges auto-scroll, release asks for confirmation
  const [nameError, setNameError] = useState<CategoryNameConflict | null>(null);
  // #195: tappable — an invalid tap names the blocker
  const [attempted, setAttempted] = useState(false);
  // a drag consumes the trailing click — it must not open the edit sheet
  // live "a drag owns the pointer" flag for the touch blocker (state is
  // too slow: the blocker runs inside native touchmove dispatch)

  // rows for the whole visible scope (needed for editing/moving/copying)
  const customRows = useQuery(
    store,
    async () => (await store.allRows('category')).filter((c) => c.deleted === 0),
    [],
  );
  const rowById = (id: string) => customRows?.find((r) => r.id === id);

  // #390: what the user's other spaces have that this one lacks
  const copyUnits = useQuery(
    store,
    async () => copyableUnits(spaceId, (await store.allRows('space')).filter((s) => s.deleted === 0), await store.allRows('category')),
    [spaceId],
  );
  const copySelected = async () => {
    const chosen = (copyUnits ?? []).filter((u) => copyPicked.has(u.row.id));
    for (const unit of chosen) {
      await copyCategoryToSpace(store, repo, spaceId, unit.row);
      void logActivity(store, repo, spaceId, 'catAdd', unit.row.name);
    }
    setCopyPicked(new Set());
    setCopyOpen(false);
  };

  const openNewMain = () => {
    setName('');
    setIcon(ICONS[0]);
    setIconQuery(''); // #384: a search never outlives the sheet
    setIconError(false);
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
    const worn = new Set(cats.childrenOf(parentId).map((c) => c.icon));
    setIcon(ICONS.find((candidate) => !worn.has(candidate)) ?? ICONS[0]);
    setIconQuery('');
    setIconError(false);
    setNameError(null); // #247
    setAttempted(false);
    setMode({ kind: 'newSub', parentId });
  };
  const openEdit = (cat: Cat) => {
    const row = rowById(cat.id);
    if (!row || cat.isOther) return; // "Other" subs are fixed
    setName(row.name ?? '');
    setIcon(row.icon);
    setIconQuery('');
    setIconError(false);
    setColor(row.color || COLORS[0]);
    setTxType(row.txType);
    setMoveTo(null);
    setNameError(null); // #247
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

  // naming rules (user rules): resolved names, builtins included
  const namedCategories = (): NamedCategory[] =>
    cats.all.map((cat) => ({
      id: cat.id,
      name: catName(cat, t),
      isParent: !!cat.isParent,
      parentId: cat.parentId,
    }));

  const save = async () => {
    if (!mode || !name.trim()) return;
    const candidateParentId = parentIdOf(mode, moveTo);
    const conflict = categoryNameConflict({ name, parentId: candidateParentId, selfId: selfIdOf(mode) }, namedCategories());
    if (conflict) {
      setNameError(conflict);
      return;
    }
    if (mode.kind !== 'newMain' && mode.kind !== 'editMain' && iconConflict({ icon, parentId: candidateParentId, selfId: selfIdOf(mode) }, cats.all)) {
      setIconError(true);
      return;
    }
    if (mode.kind === 'newMain') {
      // #244 (user): every new parent IS an expense group — the form
      // says so instead of asking
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

  // the active drag: ghost follows the pointer, edges auto-scroll, the
  // hovered fold row highlights, release opens the confirmation sheet
  useEffect(() => {
    if (!dragging) return;
    const scroller = scrollRef.current;

    const targetUnderRail = () => {
      // the rail ignores horizontal drift: probe at the list's center X
      const rect = scroller?.getBoundingClientRect();
      const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const y = rect ? Math.min(Math.max(pointerY.current, rect.top + 1), rect.bottom - 1) : pointerY.current;
      const group = document.elementFromPoint(x, y)?.closest?.('[data-cat-group]');
      return (group as HTMLElement | null)?.dataset.catGroup ?? null;
    };
    // the ghost is ABSOLUTE inside the scroll container, not fixed:
    // iOS misplaces fixed elements inside our measured-height app frame,
    // and content coordinates stay correct while auto-scroll runs
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
      if (!targetId || targetId === dragging.parentId || LOCKED_MAIN_IDS.has(targetId)) return;
      // naming rules apply to drags too: the target parent may already
      // hold a sub with this name (or the name IS a parent's)
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
    // holding still near an edge must keep scrolling — hence a rAF loop,
    // not just pointermove; it also re-resolves the hovered group and
    // re-anchors the ghost while content slides beneath the finger
    let raf = requestAnimationFrame(function tick() {
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        const zone = 64;
        let dy = 0;
        if (pointerY.current < rect.top + zone) dy = -Math.ceil((rect.top + zone - pointerY.current) / 6);
        else if (pointerY.current > rect.bottom - zone) dy = Math.ceil((pointerY.current - (rect.bottom - zone)) / 6);
        if (dy !== 0) {
          scroller.scrollTop += dy;
          positionGhost();
          setDropTarget(targetUnderRail());
        }
      }
      raf = requestAnimationFrame(tick);
    });
    positionGhost(); // anchor before the first move
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
  // #389: the icons the form's siblings already wear (the row being edited excluded) — dimmed in the grid
  const wornIcons = (() => {
    const parentId = parentIdOf(mode, moveTo);
    if (!parentId) return new Set<string>();
    const selfId = selfIdOf(mode);
    return new Set(cats.childrenOf(parentId).filter((c) => c.id !== selfId).map((c) => c.icon));
  })();
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
            <IconButton label={t('cats.newMain')} testId="cats-add" onClick={openNewMain}>
              <Icon name="plus" size={22} />
            </IconButton>
          </>
        }
      />
      <div ref={scrollRef} className={`relative min-h-0 flex-1 overflow-y-auto px-5 pb-6 ${dragging ? 'select-none' : ''}`}>
        {dragError && (
          <p
            className="mt-2 rounded-card border border-negative/40 bg-negative/10 px-3 py-2 text-[12px] text-negative"
            data-testid="cats-drag-error"
          >
            {t(NAME_ERROR_KEYS[dragError])}
          </p>
        )}
        {(copyUnits?.length ?? 0) > 0 && (
          <button
            data-testid="cats-copy-open"
            onClick={() => setCopyOpen(true)}
            className="m-tap mt-2 flex w-full items-center gap-2 rounded-card border border-accent bg-accent-soft px-4 py-3 text-left text-[13px] font-medium text-accent-deep"
          >
            <Icon name="content-copy" size={17} />
            <span className="min-w-0 flex-1">{t('cats.copyBanner', { n: copyUnits?.length ?? 0 })}</span>
            <Icon name="chevron-right" size={17} />
          </button>
        )}
        {cats.allParents.map((parent) => {
          const mainHidden = cats.hiddenMains.has(parent.id);
          if (dragging) {
            if (mainHidden) return null; // hidden mains take no drops
            // #385: a locked special main takes no sub — not through the form, not through a drop
            if (LOCKED_MAIN_IDS.has(parent.id)) {
              return (
                <div
                  key={parent.id}
                  data-testid={`cats-nodrop-${parent.id}`}
                  className="mt-2 flex items-center gap-2.5 rounded-card border border-dashed border-line px-4 py-3.5 opacity-45"
                >
                  <Icon name="lock-outline" size={17} color="var(--m-ink-4)" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-3">{catName(parent, t)}</span>
                  <span className="text-[11px] text-ink-4">{t('cats.noDropLocked')}</span>
                </div>
              );
            }
            // fold mode: every main collapses into one fat drop row, so
            // even a long list fits a couple of screens while dragging
            let foldClass = 'border-line bg-surface';
            if (dropTarget === parent.id) foldClass = 'border-accent bg-accent-soft';
            else if (parent.id === dragging.parentId) foldClass = 'border-line bg-surface opacity-55';
            return (
              <div
                key={parent.id}
                data-cat-group={parent.id}
                data-testid={`cats-drop-${parent.id}`}
                className={`mt-2 flex items-center gap-2.5 rounded-card border px-4 py-3.5 transition-colors ${foldClass}`}
              >
                <Icon name={parent.icon} size={17} color={parent.color} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium" style={{ color: parent.color }}>
                  {catName(parent, t)}
                </span>
                <span className="rounded bg-bg-2 px-1.5 py-0.5 text-[9px] font-semibold text-ink-3">
                  {t(`tx.type.${parent.txTypes[0]}`)}
                </span>
              </div>
            );
          }
          return (
            <div key={parent.id} data-cat-group={parent.id} className={mainHidden ? 'opacity-55' : ''}>
              <GroupHeader
                parent={parent}
                mainHidden={mainHidden}
                isExpanded={expandedGroups.has(parent.id)}
                onToggle={() => toggleGroup(parent.id)}
                onMenu={() => setGroupMenu(parent)}
                onEdit={parent.custom ? () => openEdit(parent) : undefined}
                t={t}
              />
              {mainHidden && (
                <p className="px-1 text-[11px] text-ink-4" data-testid={`cats-hiddennote-${parent.id}`}>
                  {t('cats.hiddenNote')}
                </p>
              )}
              {!mainHidden && (
              <Collapse open={expandedGroups.has(parent.id)}>
              {/* #386 (user): subs read as nested — the card starts under the main's name, never wider than it */}
              <div className="ml-7 overflow-hidden rounded-card border border-line bg-surface">
                {cats.childrenOf(parent.id).map((cat, i) => (
                  <div key={cat.id}>
                    {i > 0 && <div className="mx-4 h-px bg-line-2" />}
                    {/* custom rows read as "yours": subtle accent wash */}
                    <SubCatRow
                      cat={cat}
                      parentColor={parent.color}
                      onEdit={() => openEdit(cat)}
                      onMenu={() => setSubMenu(cat)}
                      t={t}
                      onDragStart={
                        cat.custom && !cat.isOther && !cat.isParent
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
                {!LOCKED_MAIN_IDS.has(parent.id) && (
                  <>
                    <div className="mx-4 h-px bg-line-2" />
                    <button
                      data-testid={`cats-addsub-${parent.id}`}
                      onClick={() => openNewSub(parent.id)}
                      className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3 text-left text-[13px] font-medium text-accent-deep"
                    >
                      <Icon name="plus-circle-outline" size={19} />
                      {t('cats.addSub')}
                    </button>
                  </>
                )}
              </div>
              </Collapse>
              )}
            </div>
          );
        })}

        {/* the lifted sub floats on a vertical rail above the list —
            absolutely positioned in CONTENT coordinates (fixed proved
            unreliable inside the measured-height app frame on iOS) */}
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

      {/* hold menu for a custom sub (drag retired — user request) */}
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

      {/* drop confirmation: show the move visually before committing */}
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
                    style={{ color: end?.color }}
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
                    // cross-main moves log like any other category edit
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

      {/* create / edit */}
      <Sheet
        open={mode !== null}
        onOpenChange={(open) => {
          if (open) return;
          setMode(null);
          // #247 (user): the error outlived the sheet — a click-away
          // flashed the OLD conflict while the exit animation ran
          setNameError(null);
          setAttempted(false);
          setIconQuery(''); // #384
          setIconError(false);
        }}
        title={formTitle}
        size="tall"
        // pinned footer (user ss: the sticky version floated over the
        // icon grid once the keyboard/safe-area shifted the scrollport)
        footer={
          <div className="flex flex-col gap-2">
            <Button
              data-testid="catform-save"
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
          {/* #195 r2 (user): the blocker sits AT the field, not by the
              footer button — the sheet scrolls it into view */}
          <FormBlockerNote show={attempted && !name.trim()} text={t('form.needName')} testId="catform-save-blocker" />
          {nameError && (
            <p className="text-[12px] text-negative" data-testid="catform-name-error">
              {t(NAME_ERROR_KEYS[nameError])}
            </p>
          )}

          {/* main: color. #244 (user): the type question is gone — a new
              parent IS an expense group (Housing, Transport, …); income
              lives under the special Income category. Say it plainly. */}
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

          {/* sub: move when editing (#244: the direction question is
              gone — a sub simply follows its parent's nature) */}
          {!isMainForm && (
            <>
              {mode?.kind === 'editSub' && (
                <>
                  <div className="m-cap px-1">{t('cats.moveTarget')}</div>
                  {/* a picker row instead of a chip row: the list of mains
                      grows, chips don't */}
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

          {/* icon picker: a curated grid by default; searching opens the
              whole self-hosted font (7k+ glyphs, fully offline) */}
          <SearchField
            testId="catform-icon-search"
            value={iconQuery}
            onChange={setIconQuery}
            placeholder={t('cats.iconSearch')}
            height="h-10"
            textSize="text-[13px]"
          />
          <div className="grid max-h-56 grid-cols-6 gap-2 overflow-y-auto">
            {(iconQuery.trim()
              ? MDI_NAMES.filter((n) => n.includes(iconQuery.trim().toLowerCase())).slice(0, 60)
              : ICONS
            ).map((name_) => (
              <button
                key={name_}
                data-testid={`catform-icon-${name_}`}
                title={name_}
                onClick={() => {
                  setIcon(name_);
                  setIconError(false);
                }}
                data-worn={wornIcons.has(name_) ? '1' : undefined}
                className={`m-tap flex h-11 items-center justify-center rounded-xl border ${
                  icon === name_ ? 'border-accent bg-accent-soft text-accent-deep' : 'border-line bg-surface text-ink-2'
                } ${wornIcons.has(name_) ? 'opacity-35' : ''}`}
              >
                <Icon name={name_} size={20} />
              </button>
            ))}
            {iconQuery.trim() && MDI_NAMES.every((n) => !n.includes(iconQuery.trim().toLowerCase())) && (
              <p className="col-span-6 py-2 text-center text-[12px] text-ink-4">{t('cats.iconNone')}</p>
            )}
          </div>
          {iconError && (
            <p className="text-[12px] text-negative" data-testid="catform-icon-error">
              {t('cats.iconTaken')}
            </p>
          )}
        </div>
      </Sheet>

      {/* move-target picker (stacked over the edit sheet) */}
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

      {/* impact warning before a breaking change */}
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

      {/* #390: the other spaces' custom categories this space lacks — grouped by space, ticked, copied in one go */}
      <Sheet
        open={copyOpen}
        onOpenChange={setCopyOpen}
        title={t('cats.copyFromSpaces')}
        size="tall"
        footer={
          <Button data-testid="cats-copy-commit" disabled={copyPicked.size === 0} onClick={() => void copySelected()}>
            {t('cats.copyCommit', { n: copyPicked.size })}
          </Button>
        }
      >
        <div data-testid="cats-copy-list" className="pt-1">
          {(copyUnits?.length ?? 0) === 0 && <p className="py-3 text-center text-[13px] text-ink-3">{t('cats.copyNone')}</p>}
          {[...new Map((copyUnits ?? []).map((u) => [u.space.id, u.space])).values()].map((space) => (
            <div key={space.id} className="mb-3">
              <div className="m-cap flex items-center gap-2 px-1">
                {space.picture ? (
                  <SpacePicture space={space} className="h-4 w-4" />
                ) : (
                  <Icon name={space.icon ?? 'leaf'} size={14} color={space.color} />
                )}
                {t('cats.copyFrom', { space: space.name })}
              </div>
              {(copyUnits ?? [])
                .filter((u) => u.space.id === space.id)
                .map((u) => (
                  <label
                    key={u.row.id}
                    className="flex cursor-pointer items-center gap-3 border-b border-line-2 px-1 py-2.5 last:border-0"
                  >
                    <input
                      type="checkbox"
                      data-testid={`cats-copy-unit-${u.row.id}`}
                      checked={copyPicked.has(u.row.id)}
                      onChange={(e) => toggleCopyUnit(u.row.id, e.target.checked)}
                    />
                    <Icon name={u.row.icon} size={19} color={u.row.color || 'var(--m-ink-3)'} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] text-ink">{u.row.name}</span>
                      {u.subs.length > 0 && (
                        <span className="block truncate text-[11px] text-ink-4">{t('cats.copySubs', { n: u.subs.length })}</span>
                      )}
                      {u.row.isParent !== 1 && u.row.parentId && (
                        <span className="block truncate text-[11px] text-ink-4">{catName(cats.byId(u.row.parentId) ?? { id: u.row.parentId, icon: '', txTypes: ['expense'], direction: 'both' } as never, t)}</span>
                      )}
                    </span>
                  </label>
                ))}
            </div>
          ))}
        </div>
      </Sheet>

      {/* hold-menu on a group header: the quiet actions live here now */}
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
            {/* #261: locked system mains (incl. Adjustment) refuse user
                subs through EVERY door — this menu had slipped the gate */}
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
