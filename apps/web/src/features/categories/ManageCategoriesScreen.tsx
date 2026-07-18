import { useRef, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { ALL_TX_TYPES } from '@/domain/txType';
import type { CategoryRow, CatDirection, TxType } from '@/db/types';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { hapticNotify } from '@/lib/platform';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { ColorPicker } from '@/ui/ColorPicker';
import { Collapse } from '@/ui/Collapse';
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
import type { TFunc } from '@/i18n';
import { MDI_NAMES } from '@/generated/mdiNames';
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
}: Readonly<{ cat: Cat; parentColor?: string; onEdit: () => void; onMenu: () => void; t: TFunc }>) {
  const canHold = !!cat.custom && !cat.isOther;
  const hold = useHoldMenu(canHold, onMenu);
  return (
    <div
      data-testid={`cats-subrow-${cat.id}`}
      className={`flex select-none items-center ${canHold ? 'bg-accent-soft/35' : ''}`}
    >
      <button
        data-testid={`managecat-${cat.id}`}
        disabled={!cat.custom || cat.isOther}
        {...hold.handlers}
        onClick={() => {
          if (hold.fired.fired) return; // the hold consumed this press
          onEdit();
        }}
        className={`m-tap relative isolate flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent px-4 py-3 text-left text-[14px] text-ink disabled:pointer-events-none ${hold.holding ? 'm-holding' : ''}`}
      >
        <Icon name={cat.icon} size={19} color={parentColor} />
        <span className="min-w-0 flex-1 truncate">{catName(cat, t)}</span>
        {cat.direction && cat.direction !== 'both' && (
          <span title={t(cat.direction === 'debit' ? 'cats.legendDebit' : 'cats.legendCredit')}>
            <Icon name={cat.direction === 'debit' ? 'arrow-up-thin' : 'arrow-down-thin'} size={15} color="var(--m-ink-4)" />
          </span>
        )}
        {canHold && (
          <>
            <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent-deep">
              {t('cats.customBadge')}
            </span>
            <Icon name="pencil-outline" size={16} color="var(--m-ink-4)" />
          </>
        )}
      </button>
    </div>
  );
}

function GroupHeader({
  parent,
  mainHidden,
  isExpanded,
  onToggle,
  onMenu,
  onAddSub,
  t,
}: Readonly<{
  parent: Cat;
  mainHidden: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onMenu: () => void;
  onAddSub: () => void;
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
        <span className="min-w-0 flex-1 truncate">{catName(parent, t)}</span>
        <span className="rounded-md bg-bg-2 px-2 py-0.5 text-[10px] font-semibold text-ink-3">
          {t(`tx.type.${parent.txTypes[0]}`)}
        </span>
      </button>
      {!mainHidden && (
        <button
          aria-label={t('cats.addSub')}
          title={t('cats.addSub')}
          data-testid={`cats-addsub-${parent.id}`}
          onClick={onAddSub}
          className="m-tap flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-ink-3 shadow-[0_1px_4px_rgba(0,0,0,0.06)]"
        >
          <Icon name="plus" size={18} />
        </button>
      )}
    </div>
  );
}

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
  const [color, setColor] = useState(COLORS[0]);
  const [txType, setTxType] = useState<TxType>('expense');
  const [direction, setDirection] = useState<CatDirection>('both');
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const [moveSheetOpen, setMoveSheetOpen] = useState(false);
  // hold on a custom sub opens its action sheet (drag-to-move retired)
  const [subMenu, setSubMenu] = useState<Cat | null>(null);
  const [pending, setPending] = useState<PendingCommit | null>(null);
  const [pendingKind, setPendingKind] = useState<'edit' | 'delete'>('edit');
  const [copyOpen, setCopyOpen] = useState(false);

  // pointer-based drag & drop: lift a custom sub (long-press or handle),
  // every main folds into a drop row, a ghost follows the finger on a
  // vertical rail, edges auto-scroll, release asks for confirmation
  const [nameError, setNameError] = useState<CategoryNameConflict | null>(null);
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
      <div className="relative min-h-0 flex-1 overflow-y-auto px-5 pb-6">
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
          return (
            <div key={parent.id} data-cat-group={parent.id} className={mainHidden ? 'opacity-55' : ''}>
              <GroupHeader
                parent={parent}
                mainHidden={mainHidden}
                isExpanded={expandedGroups.has(parent.id)}
                onToggle={() => toggleGroup(parent.id)}
                onMenu={() => setGroupMenu(parent)}
                onAddSub={() => openNewSub(parent.id)}
                t={t}
              />
              {mainHidden && (
                <p className="px-1 text-[11px] text-ink-4" data-testid={`cats-hiddennote-${parent.id}`}>
                  {t('cats.hiddenNote')}
                </p>
              )}
              {!mainHidden && (
              <Collapse open={expandedGroups.has(parent.id)}>
              <div className="overflow-hidden rounded-card border border-line bg-surface">
                {cats.childrenOf(parent.id).map((cat, i) => (
                  <div key={cat.id}>
                    {i > 0 && <div className="mx-4 h-px bg-line-2" />}
                    {/* custom rows read as "yours": subtle accent wash */}
                    <SubCatRow cat={cat} parentColor={parent.color} onEdit={() => openEdit(cat)} onMenu={() => setSubMenu(cat)} t={t} />
                  </div>
                ))}
              </div>
              </Collapse>
              )}
            </div>
          );
        })}

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

          {/* icon picker: a curated grid by default; searching opens the
              whole self-hosted font (7k+ glyphs, fully offline) */}
          <input
            data-testid="catform-icon-search"
            value={iconQuery}
            onChange={(e) => setIconQuery(e.target.value)}
            placeholder={t('cats.iconSearch')}
            className="h-10 w-full rounded-input border border-line bg-surface px-3 text-[13px] text-ink outline-none placeholder:text-ink-4"
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
                onClick={() => setIcon(name_)}
                className={`m-tap flex h-11 items-center justify-center rounded-xl border ${
                  icon === name_ ? 'border-accent bg-accent-soft text-accent-deep' : 'border-line bg-surface text-ink-2'
                }`}
              >
                <Icon name={name_} size={20} />
              </button>
            ))}
            {iconQuery.trim() && MDI_NAMES.every((n) => !n.includes(iconQuery.trim().toLowerCase())) && (
              <p className="col-span-6 py-2 text-center text-[12px] text-ink-4">{t('cats.iconNone')}</p>
            )}
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

      {/* hold-menu on a group header: the quiet actions live here now */}
      <Sheet
        open={!!groupMenu}
        onOpenChange={(next) => !next && setGroupMenu(null)}
        title={groupMenu ? catName(groupMenu, t) : ''}
        size="compact"
      >
        {groupMenu && (
          <div className="flex flex-col pt-1" data-testid="cats-group-menu">
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
          </div>
        )}
      </Sheet>
    </div>
  );
}
