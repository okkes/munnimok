import { useEffect, useMemo, useState } from 'react';
import { LOCKED_MAIN_IDS } from '@/domain/categories';
import { useLang } from '@/i18n';
import { catName, useCategories } from '@/features/categories/useCategories';
import type { Cat } from '@/features/categories/useCategories';
import { Button } from '@/ui/Button';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import type { TrendGraph, TrendGraphDraft } from './useTrendGraphs';

type Tick = 'checked' | 'half' | 'off';
const TICK_BOX: Record<Tick, string> = {
  checked: 'border-accent bg-accent',
  half: 'border-accent bg-accent-soft',
  off: 'border-line bg-transparent',
};

/** a main's tick: chosen itself, half when only some of its subs are */
const mainTick = (picked: ReadonlySet<string>, main: Cat, subs: readonly Cat[]): Tick => {
  if (picked.has(main.id)) return 'checked';
  return subs.some((sub) => picked.has(sub.id)) ? 'half' : 'off';
};

/** ticking a main stores the main (its subs ride along, future ones too);
 *  unticking it frees them all */
function toggleMain(picked: ReadonlySet<string>, main: Cat, subs: readonly Cat[]): Set<string> {
  const next = new Set(picked);
  if (next.has(main.id)) {
    next.delete(main.id);
  } else {
    next.add(main.id);
    for (const sub of subs) next.delete(sub.id);
  }
  return next;
}

/** a sub alone stores its own id; taking one OUT of a ticked main keeps the others as subs */
function toggleSub(picked: ReadonlySet<string>, main: Cat, sub: Cat, subs: readonly Cat[]): Set<string> {
  const next = new Set(picked);
  if (next.has(main.id)) {
    next.delete(main.id);
    for (const other of subs) if (other.id !== sub.id) next.add(other.id);
  } else if (next.has(sub.id)) {
    next.delete(sub.id);
  } else {
    next.add(sub.id);
  }
  return next;
}

function TickBox({ tick }: Readonly<{ tick: Tick }>) {
  return (
    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${TICK_BOX[tick]}`}>
      {tick === 'checked' && <Icon name="check" size={14} color="white" />}
      {tick === 'half' && <span className="h-0.5 w-2.5 rounded bg-accent" />}
    </span>
  );
}

/** the expense mains with their subs, each a tick */
function CategoryTree({ picked, onChange }: Readonly<{ picked: ReadonlySet<string>; onChange: (next: Set<string>) => void }>) {
  const { t } = useLang();
  const cats = useCategories();
  const mains = useMemo(
    () => cats.parents.filter((parent) => parent.txTypes.includes('expense') && !LOCKED_MAIN_IDS.has(parent.id)),
    [cats],
  );
  // a ticked main, or one with a ticked sub, starts unfolded — an edit shows what it covers
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        mains
          .filter((main) => picked.has(main.id) || cats.childrenOf(main.id).some((sub) => picked.has(sub.id)))
          .map((main) => main.id),
      ),
  );
  const fold = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="trends-graph-cats">
      {mains.map((main) => {
        const subs = cats.childrenOf(main.id);
        const unfolded = open.has(main.id);
        return (
          <div key={main.id} className="border-b border-line-2 last:border-0">
            <div className="flex items-center gap-3 px-3 py-2">
              <button
                data-testid={`trends-graph-cat-${main.id}`}
                onClick={() => onChange(toggleMain(picked, main, subs))}
                className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent p-0 text-left"
              >
                <TickBox tick={mainTick(picked, main, subs)} />
                <Icon name={main.icon} size={18} color={main.color} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{catName(main, t)}</span>
              </button>
              {subs.length > 0 && (
                <button
                  data-testid={`trends-graph-fold-${main.id}`}
                  aria-label={catName(main, t)}
                  onClick={() => fold(main.id)}
                  className="m-tap flex h-8 w-8 items-center justify-center border-none bg-transparent text-ink-4"
                >
                  <Icon name={unfolded ? 'chevron-up' : 'chevron-down'} size={18} />
                </button>
              )}
            </div>
            {unfolded &&
              subs.map((sub) => (
                <button
                  key={sub.id}
                  data-testid={`trends-graph-cat-${sub.id}`}
                  onClick={() => onChange(toggleSub(picked, main, sub, subs))}
                  className="m-tap flex w-full items-center gap-3 border-none bg-transparent py-2 pr-3 pl-11 text-left"
                >
                  <TickBox tick={picked.has(sub.id) || picked.has(main.id) ? 'checked' : 'off'} />
                  <Icon name={sub.icon} size={16} color={sub.color ?? main.color} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{catName(sub, t)}</span>
                </button>
              ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A custom graph's shape (user 2026-10-08): a name and one or more
 * (sub)categories. New and edit share the sheet; delete asks once through
 * the shared danger confirm.
 */
export function GraphEditorSheet({
  open,
  onOpenChange,
  initial,
  onSave,
  onDelete,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = a new graph */
  initial: TrendGraph | null;
  onSave: (draft: TrendGraphDraft) => void;
  onDelete: (id: string) => void;
}>) {
  const { t } = useLang();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  // every opening starts from the graph it edits (or blank)
  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setPicked(new Set(initial?.catIds ?? []));
  }, [open, initial]);

  const dirty = name !== (initial?.name ?? '') || picked.size !== (initial?.catIds.length ?? 0) || (initial?.catIds ?? []).some((id) => !picked.has(id));
  const canSave = name.trim().length > 0 && picked.size > 0;

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={onOpenChange}
        title={initial ? t('trends.editGraph') : t('trends.newGraph')}
        size="tall"
        dirty={dirty}
        footer={
          <div className="flex gap-2">
            {initial && (
              <Button variant="danger" data-testid="trends-graph-delete" onClick={() => setConfirming(true)}>
                {t('action.delete')}
              </Button>
            )}
            <Button
              className="flex-1"
              data-testid="trends-graph-save"
              disabled={!canSave}
              onClick={() => onSave({ id: initial?.id, name: name.trim(), catIds: [...picked] })}
            >
              {t('action.save')}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4 pt-1">
          <label className="flex flex-col gap-1.5">
            <span className="m-cap px-1">{t('trends.graphName')}</span>
            <input
              data-testid="trends-graph-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('trends.graphNamePlaceholder')}
              className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="m-cap px-1">{t('trends.graphCategories')}</span>
            <p className="px-1 text-[11px] text-ink-4">{t('trends.graphCategoriesHint')}</p>
            {open && <CategoryTree key={initial?.id ?? 'new'} picked={picked} onChange={setPicked} />}
          </div>
        </div>
      </Sheet>
      {initial && (
        <DangerConfirmSheet
          open={confirming}
          onOpenChange={setConfirming}
          title={t('trends.deleteGraph')}
          body={t('trends.deleteGraphBody', { name: initial.name })}
          confirmLabel={t('action.delete')}
          testId="trends-graph-delete"
          cooldown={0}
          onConfirm={() => {
            setConfirming(false);
            onDelete(initial.id);
          }}
        />
      )}
    </>
  );
}
