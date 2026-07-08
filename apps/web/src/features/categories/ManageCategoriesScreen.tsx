import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ALL_TX_TYPES } from '@/domain/txType';
import type { CategoryRow, CatDirection, TxType } from '@/db/types';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
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
  const { db, repo, spaceId } = useData();
  const cats = useCategories();
  const [mode, setMode] = useState<FormMode | null>(null);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState(ICONS[0]);
  const [color, setColor] = useState(COLORS[0]);
  const [txType, setTxType] = useState<TxType>('expense');
  const [direction, setDirection] = useState<CatDirection>('both');
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingCommit | null>(null);
  const [pendingKind, setPendingKind] = useState<'edit' | 'delete'>('edit');
  const [copyOpen, setCopyOpen] = useState(false);

  // pointer-based drag & drop: move a custom sub onto another parent group
  const [dragging, setDragging] = useState<CategoryRow | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dropTargetRef = useRef<string | null>(null);
  dropTargetRef.current = dropTarget;

  // rows for the whole visible scope (needed for editing/moving/copying)
  const customRows = useLiveQuery(
    () => db.categories.filter((c) => c.deleted === 0).toArray(),
    [],
  );
  const rowById = (id: string) => customRows?.find((r) => r.id === id);

  // personal cats offered for copying while managing a shared space
  const personalCats = useLiveQuery(async () => {
    if (!cats.sharedScope) return [];
    const personal = new Set(
      (await db.spaces.filter((s) => s.deleted === 0 && s.kind !== 'shared').toArray()).map((s) => s.id),
    );
    return db.categories.filter((c) => c.deleted === 0 && personal.has(c.spaceId)).toArray();
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

  const save = async () => {
    if (!mode || !name.trim()) return;
    if (mode.kind === 'newMain') {
      await createMainCategory(repo, spaceId, { name: name.trim(), icon, color, txType, otherName: t('cats.other') });
      setMode(null);
    } else if (mode.kind === 'newSub') {
      await createSubCategory(db, repo, spaceId, { parentId: mode.parentId, name: name.trim(), icon, direction });
      setMode(null);
    } else {
      const changes: CategoryChanges =
        mode.kind === 'editMain'
          ? { name: name.trim(), icon, color, txType }
          : { name: name.trim(), icon, direction, ...(moveTo ? { parentId: moveTo } : {}) };
      await runGuarded(await prepareCategoryEdit(db, repo, mode.row, changes), 'edit');
    }
  };

  const remove = async () => {
    if (!mode || (mode.kind !== 'editMain' && mode.kind !== 'editSub')) return;
    await runGuarded(await prepareCategoryDelete(db, repo, mode.row), 'delete');
  };

  const confirmPending = async () => {
    if (!pending) return;
    await pending.commit();
    setPending(null);
    setMode(null);
  };

  const moveSub = async (sub: CategoryRow, parentId: string) => {
    if (sub.parentId === parentId) return;
    const commit = await prepareCategoryEdit(db, repo, sub, { parentId });
    // reuse the same warning flow as the edit sheet
    if (commit.affected.length === 0) await commit.commit();
    else {
      setPendingKind('edit');
      setPending(commit);
    }
  };

  // drag: pointermove tracks which parent group is hovered via data attrs
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const group = el?.closest?.('[data-cat-group]');
      setDropTarget((group as HTMLElement | null)?.dataset.catGroup ?? null);
    };
    const onUp = () => {
      const target = dropTargetRef.current;
      const sub = dragging;
      setDragging(null);
      setDropTarget(null);
      if (target && sub) void moveSub(sub, target);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
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
          <IconButton label={t('cats.newMain')} testId="cats-add" onClick={openNewMain}>
            <Icon name="plus" size={22} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
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
        {cats.parents.map((parent) => (
          <div
            key={parent.id}
            data-cat-group={parent.id}
            className={dropTarget === parent.id ? 'rounded-card outline-2 outline-dashed outline-[var(--m-accent)]' : ''}
          >
            <div className="m-cap mt-5 mb-1 flex items-center gap-1.5 px-1" style={{ color: parent.color }}>
              <Icon name={parent.icon} size={14} />
              <span className="flex-1">{catName(parent, t)}</span>
              <span className="rounded bg-bg-2 px-1.5 py-0.5 text-[9px] font-semibold normal-case text-ink-3">
                {t(`tx.type.${parent.txTypes[0]}`)}
              </span>
              {parent.custom && (
                <button
                  aria-label={t('action.edit')}
                  data-testid={`cats-editmain-${parent.id}`}
                  onClick={() => openEdit(parent)}
                  className="m-tap border-none bg-transparent p-0.5 text-ink-4"
                >
                  <Icon name="pencil-outline" size={14} />
                </button>
              )}
              <button
                aria-label={t('cats.addSub')}
                title={t('cats.addSub')}
                data-testid={`cats-addsub-${parent.id}`}
                onClick={() => openNewSub(parent.id)}
                className="m-tap flex h-6 w-6 items-center justify-center rounded-full border border-line bg-surface text-ink-3 shadow-[0_1px_4px_rgba(0,0,0,0.06)]"
              >
                <Icon name="plus" size={14} />
              </button>
            </div>
            <div className="overflow-hidden rounded-card border border-line bg-surface">
              {cats.childrenOf(parent.id).map((cat, i) => (
                <div key={cat.id} className={dragging?.id === cat.id ? 'opacity-40' : ''}>
                  {i > 0 && <div className="mx-4 h-px bg-line-2" />}
                  {/* custom rows read as "yours": subtle accent wash */}
                  <div className={`flex items-center ${cat.custom && !cat.isOther ? 'bg-accent-soft/35' : ''}`}>
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
                          if (row) setDragging(row);
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
          </div>
        ))}
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
            onChange={(e) => setName(e.target.value)}
            placeholder={t('cats.name')}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
          />

          {/* main: transaction type + color */}
          {isMainForm && (
            <>
              <div className="m-cap px-1">{t('cats.type')}</div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {ALL_TX_TYPES.map((type) => (
                  <button
                    key={type}
                    data-testid={`catform-type-${type}`}
                    onClick={() => setTxType(type)}
                    className={`m-tap shrink-0 rounded-full border px-3 py-1.5 text-[12px] ${
                      txType === type
                        ? 'border-accent bg-accent-soft font-medium text-accent-deep'
                        : 'border-line bg-surface text-ink-2'
                    }`}
                  >
                    {t(`tx.type.${type}`)}
                  </button>
                ))}
              </div>
              <div className="m-cap px-1">{t('cats.color')}</div>
              <div className="flex flex-wrap gap-2">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    aria-label={c}
                    data-testid={`catform-color-${c.slice(1)}`}
                    onClick={() => setColor(c)}
                    className={`m-tap h-8 w-8 rounded-full border-2 ${color === c ? 'border-ink' : 'border-transparent'}`}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </>
          )}

          {/* sub: direction (+ move when editing) */}
          {!isMainForm && (
            <>
              <div className="m-cap px-1">{t('cats.direction')}</div>
              <div className="flex gap-2">
                {DIRECTIONS.map((d) => (
                  <button
                    key={d}
                    data-testid={`catform-direction-${d}`}
                    onClick={() => setDirection(d)}
                    className={`m-tap flex-1 rounded-full border px-3 py-1.5 text-[12px] ${
                      direction === d
                        ? 'border-accent bg-accent-soft font-medium text-accent-deep'
                        : 'border-line bg-surface text-ink-2'
                    }`}
                  >
                    {t(`cats.direction.${d}`)}
                  </button>
                ))}
              </div>
              {mode?.kind === 'editSub' && (
                <>
                  <div className="m-cap px-1">{t('cats.moveTarget')}</div>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {cats.parents
                      .filter((p) => p.id !== mode.row.parentId)
                      .map((p) => (
                        <button
                          key={p.id}
                          data-testid={`catform-move-${p.id}`}
                          onClick={() => setMoveTo((cur) => (cur === p.id ? null : p.id))}
                          className={`m-tap shrink-0 rounded-full border px-3 py-1.5 text-[12px] ${
                            moveTo === p.id
                              ? 'border-accent bg-accent-soft font-medium text-accent-deep'
                              : 'border-line bg-surface text-ink-2'
                          }`}
                        >
                          {catName(p, t)}
                        </button>
                      ))}
                  </div>
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
                  onClick={() => void copyCategoryToSpace(db, repo, spaceId, r)}
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
