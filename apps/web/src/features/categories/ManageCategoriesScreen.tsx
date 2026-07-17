import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { ALL_TX_TYPES } from '@/domain/txType';
import type { CategoryRow, CatDirection, TxType } from '@/db/types';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { ColorPicker } from '@/ui/ColorPicker';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import {
  copyCategoryToSpace,
  createMainCategory,
  createSubCategory,
  prepareCategoryDelete,
  prepareCategoryEdit,
} from './categoryOps';
import type { CategoryChanges, PendingCommit } from './categoryOps';
import { catName, useCategories } from './useCategories';
import type { Cat } from './useCategories';
import { categoryNameConflict } from '@/domain/categoryNames';
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

const DIRECTIONS: CatDirection[] = ['debit', 'credit', 'both'];

type FormMode =
  | { kind: 'newMain' }
  | { kind: 'newSub'; parentId: string }
  | { kind: 'editMain'; row: CategoryRow }
  | { kind: 'editSub'; row: CategoryRow };

export function ManageCategoriesScreen() {
  const { t } = useLang();
  const { store, repo, spaceId } = useData();
  const cats = useCategories();
  const [mode, setMode] = useState<FormMode | null>(null);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState(ICONS[0]);
  const [color, setColor] = useState(COLORS[0]);
  const [txType, setTxType] = useState<TxType>('expense');
  const [direction, setDirection] = useState<CatDirection>('both');
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const [moveSheetOpen, setMoveSheetOpen] = useState(false);
  const [pending, setPending] = useState<PendingCommit | null>(null);
  const [pendingKind, setPendingKind] = useState<'edit' | 'delete'>('edit');
  const [copyOpen, setCopyOpen] = useState(false);

  // pointer-based drag & drop: lift a custom sub (long-press or handle),
  // every main folds into a drop row, a ghost follows the finger on a
  // vertical rail, edges auto-scroll, release asks for confirmation
  const [dragging, setDragging] = useState<CategoryRow | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moveConfirm, setMoveConfirm] = useState<{ sub: CategoryRow; targetId: string; commit: PendingCommit } | null>(null);
  const [nameError, setNameError] = useState<CategoryNameConflict | null>(null);
  const [dragError, setDragError] = useState<CategoryNameConflict | null>(null);
  const dropTargetRef = useRef<string | null>(null);
  dropTargetRef.current = dropTarget;
  const ghostRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pointerY = useRef(0);
  const pressTimer = useRef<number | null>(null);
  // a drag consumes the trailing click — it must not open the edit sheet
  const dragStartedRef = useRef(false);
  // live "a drag owns the pointer" flag for the touch blocker (state is
  // too slow: the blocker runs inside native touchmove dispatch)
  const dragActiveRef = useRef(false);

  // rows for the whole visible scope (needed for editing/moving/copying)
  const customRows = useQuery(
    store,
    async () => (await store.allRows('category')).filter((c) => c.deleted === 0),
    [],
  );
  const rowById = (id: string) => customRows?.find((r) => r.id === id);

  // personal cats offered for copying while managing a shared space
  const personalCats = useQuery(store, async () => {
    if (!cats.sharedScope) return [];
    const personal = new Set(
      (await store.allRows('space')).filter((s) => s.deleted === 0 && s.kind !== 'shared').map((s) => s.id),
    );
    return (await store.allRows('category')).filter((c) => c.deleted === 0 && personal.has(c.spaceId));
  }, [cats.sharedScope]);

  const openNewMain = () => {
    setName('');
    setIcon(ICONS[0]);
    setColor(COLORS[0]);
    setTxType('expense');
    setMode({ kind: 'newMain' });
  };
  const openNewSub = (parentId: string) => {
    setName('');
    setIcon(ICONS[0]);
    setDirection('both');
    setMode({ kind: 'newSub', parentId });
  };
  const openEdit = (cat: Cat) => {
    if (dragStartedRef.current) {
      dragStartedRef.current = false; // the click that trails a drag
      return;
    }
    const row = rowById(cat.id);
    if (!row || cat.isOther) return; // "Other" subs are fixed (direction locked to both)
    setName(row.name ?? '');
    setIcon(row.icon);
    setColor(row.color || COLORS[0]);
    setTxType(row.txType);
    setDirection(row.direction ?? 'both');
    setMoveTo(null);
    setMode(row.isParent === 1 ? { kind: 'editMain', row } : { kind: 'editSub', row });
  };

  const runGuarded = async (commit: PendingCommit, kind: 'edit' | 'delete') => {
    if (commit.affected.length === 0) {
      await commit.commit();
      setMode(null);
    } else {
      setPendingKind(kind);
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
    let candidateParentId: string | undefined;
    if (mode.kind === 'newSub') candidateParentId = mode.parentId;
    else if (mode.kind === 'editSub') candidateParentId = moveTo ?? mode.row.parentId;
    const conflict = categoryNameConflict(
      {
        name,
        parentId: candidateParentId,
        selfId: mode.kind === 'editMain' || mode.kind === 'editSub' ? mode.row.id : undefined,
      },
      namedCategories(),
    );
    if (conflict) {
      setNameError(conflict);
      return;
    }
    if (mode.kind === 'newMain') {
      await createMainCategory(repo, spaceId, { name: name.trim(), icon, color, txType, otherName: t('cats.other') });
      setMode(null);
    } else if (mode.kind === 'newSub') {
      await createSubCategory(store, repo, spaceId, { parentId: mode.parentId, name: name.trim(), icon, direction });
      setMode(null);
    } else {
      const changes: CategoryChanges =
        mode.kind === 'editMain'
          ? { name: name.trim(), icon, color, txType }
          : { name: name.trim(), icon, direction, ...(moveTo ? { parentId: moveTo } : {}) };
      await runGuarded(await prepareCategoryEdit(store, repo, mode.row, changes), 'edit');
    }
  };

  const remove = async () => {
    if (!mode || (mode.kind !== 'editMain' && mode.kind !== 'editSub')) return;
    await runGuarded(await prepareCategoryDelete(store, repo, mode.row), 'delete');
  };

  const confirmPending = async () => {
    if (!pending) return;
    await pending.commit();
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

  const startDrag = (row: CategoryRow, clientY: number) => {
    dragStartedRef.current = true;
    dragActiveRef.current = true;
    pointerY.current = clientY;
    navigator.vibrate?.(15); // lift feedback where supported
    setDragging(row);
  };

  /** long-press anywhere on a movable row lifts it (the handle lifts instantly) */
  const pressHandlers = (cat: Cat) => {
    if (!cat.custom || cat.isOther || cat.isParent) return {};
    const clear = () => {
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    };
    return {
      onPointerDown: (e: React.PointerEvent) => {
        const startX = e.clientX;
        const startY = e.clientY;
        clear();
        // the touch blocker must exist from GESTURE START: browsers only
        // honor preventDefault on touchmove for listeners registered
        // before their scroll takes over. It bites only once the
        // long-press activates a drag — plain scrolling stays native.
        const blockTouch = (ev: TouchEvent) => {
          if (dragActiveRef.current && ev.cancelable) ev.preventDefault();
        };
        window.addEventListener('touchmove', blockTouch, { passive: false });
        const onMove = (ev: PointerEvent) => {
          if (dragActiveRef.current) return; // the drag owns movement now
          // finger drifted before the timer fired — it's a scroll, not a lift
          if (Math.abs(ev.clientX - startX) > 8 || Math.abs(ev.clientY - startY) > 8) endGesture();
        };
        const endGesture = () => {
          clear();
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', endGesture);
          window.removeEventListener('pointercancel', endGesture);
          window.removeEventListener('touchmove', blockTouch);
        };
        pressTimer.current = window.setTimeout(() => {
          const row = rowById(cat.id);
          if (row) startDrag(row, startY);
        }, 320);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', endGesture);
        window.addEventListener('pointercancel', endGesture);
      },
    };
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
      // the trailing click (if any) dispatches synchronously after
      // pointerup — release the guard right after it
      setTimeout(() => {
        dragStartedRef.current = false;
      }, 0);
    };
    const onMove = (e: PointerEvent) => {
      pointerY.current = e.clientY;
      positionGhost();
      setDropTarget(targetUnderRail());
    };
    const onUp = () => {
      const targetId = dropTargetRef.current;
      endDrag();
      if (!targetId || targetId === dragging.parentId) return;
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
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
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
        sub={cats.sharedScope ? t('cats.manageSpace') : t('cats.manageUser')}
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
        {/* one-line legend: the arrows carry meaning nowhere else explained */}
        <p className="mt-2 flex items-center gap-1 px-1 text-[11px] text-ink-4">
          <Icon name="arrow-up-thin" size={13} /> {t('cats.legendDebit')}
          <span className="px-0.5">·</span>
          <Icon name="arrow-down-thin" size={13} /> {t('cats.legendCredit')}
        </p>
        {cats.sharedScope && (personalCats?.length ?? 0) > 0 && (
          <button
            data-testid="cats-copy-open"
            onClick={() => setCopyOpen(true)}
            className="m-tap mt-2 flex w-full items-center gap-2 rounded-card border border-accent bg-accent-soft px-4 py-3 text-left text-[13px] font-medium text-accent-deep"
          >
            <Icon name="content-copy" size={17} />
            {t('cats.copyFromPersonal')}
          </button>
        )}
        {cats.allParents.map((parent) => {
          const mainHidden = cats.hiddenMains.has(parent.id);
          if (dragging) {
            if (mainHidden) return null; // hidden mains take no drops
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
              <div className="m-cap mt-5 mb-1 flex items-center gap-1.5 px-1" style={{ color: parent.color }}>
                <Icon name={parent.icon} size={14} />
                <span className="flex-1">{catName(parent, t)}</span>
                <span className="rounded bg-bg-2 px-1.5 py-0.5 text-[9px] font-semibold normal-case text-ink-3">
                  {t(`tx.type.${parent.txTypes[0]}`)}
                </span>
                {/* per-space visibility: a hidden main leaves the pickers of
                    THIS space only; existing transactions keep resolving */}
                <button
                  aria-label={t(mainHidden ? 'cats.showMain' : 'cats.hideMain')}
                  title={t(mainHidden ? 'cats.showMain' : 'cats.hideMain')}
                  data-testid={`cats-togglemain-${parent.id}`}
                  onClick={() => void toggleMainVisibility(parent.id)}
                  className="m-tap border-none bg-transparent p-0.5 text-ink-4"
                >
                  <Icon name={mainHidden ? 'eye-off-outline' : 'eye-outline'} size={14} />
                </button>
                {parent.custom && !mainHidden && (
                  <button
                    aria-label={t('action.edit')}
                    data-testid={`cats-editmain-${parent.id}`}
                    onClick={() => openEdit(parent)}
                    className="m-tap border-none bg-transparent p-0.5 text-ink-4"
                  >
                    <Icon name="pencil-outline" size={14} />
                  </button>
                )}
                {!mainHidden && (
                  <button
                    aria-label={t('cats.addSub')}
                    title={t('cats.addSub')}
                    data-testid={`cats-addsub-${parent.id}`}
                    onClick={() => openNewSub(parent.id)}
                    className="m-tap flex h-6 w-6 items-center justify-center rounded-full border border-line bg-surface text-ink-3 shadow-[0_1px_4px_rgba(0,0,0,0.06)]"
                  >
                    <Icon name="plus" size={14} />
                  </button>
                )}
              </div>
              {mainHidden && (
                <p className="px-1 text-[11px] text-ink-4" data-testid={`cats-hiddennote-${parent.id}`}>
                  {t('cats.hiddenNote')}
                </p>
              )}
              {!mainHidden && (
              <div className="overflow-hidden rounded-card border border-line bg-surface">
                {cats.childrenOf(parent.id).map((cat, i) => (
                  <div key={cat.id}>
                    {i > 0 && <div className="mx-4 h-px bg-line-2" />}
                    {/* custom rows read as "yours": subtle accent wash */}
                    <div
                      className={`flex select-none items-center ${cat.custom && !cat.isOther ? 'bg-accent-soft/35' : ''}`}
                      {...pressHandlers(cat)}
                    >
                      <button
                        data-testid={`managecat-${cat.id}`}
                        disabled={!cat.custom || cat.isOther}
                        onClick={() => openEdit(cat)}
                        className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent px-4 py-3 text-left text-[14px] text-ink disabled:pointer-events-none"
                      >
                        <Icon name={cat.icon} size={19} color={parent.color} />
                        <span className="min-w-0 flex-1 truncate">{catName(cat, t)}</span>
                        {cat.direction && cat.direction !== 'both' && (
                          <span title={t(cat.direction === 'debit' ? 'cats.legendDebit' : 'cats.legendCredit')}>
                            <Icon name={cat.direction === 'debit' ? 'arrow-up-thin' : 'arrow-down-thin'} size={15} color="var(--m-ink-4)" />
                          </span>
                        )}
                        {cat.custom && !cat.isOther && (
                          <>
                            <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent-deep">
                              {t('cats.customBadge')}
                            </span>
                            <Icon name="pencil-outline" size={16} color="var(--m-ink-4)" />
                          </>
                        )}
                      </button>
                      {cat.custom && !cat.isOther && !cat.isParent && (
                        <button
                          aria-label={t('cats.moveTarget')}
                          data-testid={`cats-drag-${cat.id}`}
                          onPointerDown={(e) => {
                            e.preventDefault();
                            const row = rowById(cat.id);
                            if (row) startDrag(row, e.clientY);
                          }}
                          className="m-tap flex h-9 w-9 shrink-0 touch-none select-none items-center justify-center border-none bg-transparent text-ink-4"
                        >
                          <Icon name="drag-horizontal-variant" size={18} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
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

      {/* create / edit */}
      <Sheet open={mode !== null} onOpenChange={(open) => !open && setMode(null)} title={formTitle} size="tall">
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
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
          />
          {nameError && (
            <p className="text-[12px] text-negative" data-testid="catform-name-error">
              {t(NAME_ERROR_KEYS[nameError])}
            </p>
          )}

          {/* main: transaction type + color */}
          {isMainForm && (
            <>
              <div className="m-cap px-1">{t('cats.type')}</div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {ALL_TX_TYPES.map((type) => (
                  <Chip key={type} testId={`catform-type-${type}`} selected={txType === type} onClick={() => setTxType(type)}>
                    {t(`tx.type.${type}`)}
                  </Chip>
                ))}
              </div>
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

          {/* sub: direction (+ move when editing) */}
          {!isMainForm && (
            <>
              <div className="m-cap px-1">{t('cats.direction')}</div>
              <div className="flex gap-2">
                {DIRECTIONS.map((d) => (
                  <Chip
                    key={d}
                    className="flex-1"
                    testId={`catform-direction-${d}`}
                    selected={direction === d}
                    onClick={() => setDirection(d)}
                  >
                    {t(`cats.direction.${d}`)}
                  </Chip>
                ))}
              </div>
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

          {/* icon grid */}
          <div className="grid grid-cols-6 gap-2">
            {ICONS.map((name_) => (
              <button
                key={name_}
                data-testid={`catform-icon-${name_}`}
                onClick={() => setIcon(name_)}
                className={`m-tap flex h-11 items-center justify-center rounded-xl border ${
                  icon === name_ ? 'border-accent bg-accent-soft text-accent-deep' : 'border-line bg-surface text-ink-2'
                }`}
              >
                <Icon name={name_} size={20} />
              </button>
            ))}
          </div>
          <Button data-testid="catform-save" onClick={() => void save()} disabled={!name.trim()}>
            {editing ? t('action.save') : t('action.add')}
          </Button>
          {editing && (
            <Button variant="danger" data-testid="catform-delete" onClick={() => void remove()}>
              {t('action.delete')}
            </Button>
          )}
        </div>
      </Sheet>

      {/* move-target picker (stacked over the edit sheet) */}
      <Sheet open={moveSheetOpen} onOpenChange={setMoveSheetOpen} title={t('cats.moveTarget')} size="form">
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
              .filter((p) => p.id !== mode.row.parentId)
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
                  void moveConfirm.commit.commit().then(() => setMoveConfirm(null));
                }}
              >
                {t('action.confirm')}
              </Button>
            </div>
          </>
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

      {/* copy personal categories into this shared space */}
      <Sheet open={copyOpen} onOpenChange={setCopyOpen} title={t('cats.copyFromPersonal')} size="tall">
        <div data-testid="cats-copy-list">
          {(personalCats ?? [])
            .filter((r) => r.isOther !== 1 && (r.isParent === 1 || !personalCats?.some((p) => p.id === r.parentId)))
            .map((r) => (
              <div key={r.id} className="flex items-center gap-3 border-b border-line-2 px-1 py-2.5 last:border-0">
                <Icon name={r.icon} size={19} color={r.color || 'var(--m-ink-3)'} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{r.name}</span>
                <Button
                  size="sm"
                  data-testid={`cats-copy-${r.id}`}
                  onClick={() => void copyCategoryToSpace(store, repo, spaceId, r)}
                >
                  {t('action.add')}
                </Button>
              </div>
            ))}
        </div>
      </Sheet>
    </div>
  );
}
