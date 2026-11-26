import { useEffect, useState } from 'react';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import type { RecurringKind } from '@/db/types';
import type { LuxuryScope } from '@/domain/recurring';
import { Button } from '@/ui/Button';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { TickBox } from './GraphEditorSheet';
import type { RecurringCatOption } from './RecurringTab';
import type { RecurringGraph, RecurringGraphDraft } from './useTrendGraphs';

const KINDS: readonly { kind: RecurringKind; labelKey: TranslationKey; icon: string }[] = [
  { kind: 'fixed', labelKey: 'recurring.fixed', icon: 'home-outline' },
  { kind: 'subscription', labelKey: 'recurring.subs', icon: 'autorenew' },
];

type Luxury = LuxuryScope | 'all';
const LUXURY: readonly { value: Luxury; labelKey: TranslationKey }[] = [
  { value: 'all', labelKey: 'trends.recLuxuryAll' },
  { value: 'only', labelKey: 'trends.recLuxuryOnly' },
  { value: 'without', labelKey: 'trends.recLuxuryWithout' },
];

const ROW = 'm-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-3 py-2.5 text-left last:border-0';

const sameSet = (a: ReadonlySet<string> | null, b: readonly string[] | undefined): boolean =>
  a === null || b === undefined ? (a === null) === (b === undefined) : a.size === b.length && b.every((id) => a.has(id));

/** #690: a graph over recurring costs says which of them it reads — the kinds, its word on luxury, the categories.
 *  Every category is the absence of a list, so a category that turns up later joins by itself (like a spending graph's accounts) */
export function RecurringGraphSheet({
  open,
  onOpenChange,
  initial,
  options,
  onSave,
  onDelete,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = a new graph */
  initial: RecurringGraph | null;
  options: readonly RecurringCatOption[];
  onSave: (draft: RecurringGraphDraft) => void;
  onDelete: (id: string) => void;
}>) {
  const { t } = useLang();
  const [name, setName] = useState('');
  const [kinds, setKinds] = useState<ReadonlySet<RecurringKind>>(new Set(['fixed', 'subscription']));
  const [luxury, setLuxury] = useState<Luxury>('all');
  const [catPick, setCatPick] = useState<Set<string> | null>(null);
  const [confirming, setConfirming] = useState(false);

  // every opening starts from the graph it edits (or blank)
  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setKinds(new Set(initial?.kinds ?? ['fixed', 'subscription']));
    setLuxury(initial?.luxury ?? 'all');
    setCatPick(initial?.catIds ? new Set(initial.catIds) : null);
  }, [open, initial]);

  const toggleKind = (kind: RecurringKind) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  const toggleCat = (id: string) => {
    const next = new Set(catPick ?? options.map((option) => option.id));
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCatPick(options.every((option) => next.has(option.id)) ? null : next);
  };

  const initialKinds = initial?.kinds ?? ['fixed', 'subscription'];
  const dirty =
    name !== (initial?.name ?? '') ||
    kinds.size !== initialKinds.length ||
    initialKinds.some((kind) => !kinds.has(kind)) ||
    luxury !== (initial?.luxury ?? 'all') ||
    !sameSet(catPick, initial?.catIds);
  const canSave = name.trim().length > 0 && kinds.size > 0 && (catPick === null || catPick.size > 0);

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
              <Button variant="danger" data-testid="trends-rec-delete" onClick={() => setConfirming(true)}>
                {t('action.delete')}
              </Button>
            )}
            <Button
              className="flex-1"
              data-testid="trends-rec-save"
              disabled={!canSave}
              onClick={() =>
                onSave({
                  id: initial?.id,
                  name: name.trim(),
                  kinds: kinds.size === KINDS.length ? null : [...kinds],
                  luxury: luxury === 'all' ? null : luxury,
                  catIds: catPick ? [...catPick] : null,
                })
              }
            >
              {t('action.save')}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4 pt-1" data-testid="trends-rec-editor">
          <label className="flex flex-col gap-1.5">
            <span className="m-cap px-1">{t('trends.graphName')}</span>
            <input
              data-testid="trends-rec-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('trends.recNamePlaceholder')}
              className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="m-cap px-1">{t('trends.recKinds')}</span>
            <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="trends-rec-kinds">
              {KINDS.map(({ kind, labelKey, icon }) => (
                <button key={kind} type="button" data-testid={`trends-rec-kind-${kind}`} aria-pressed={kinds.has(kind)} onClick={() => toggleKind(kind)} className={ROW}>
                  <TickBox tick={kinds.has(kind) ? 'checked' : 'off'} />
                  <Icon name={icon} size={18} color="var(--m-ink-3)" />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{t(labelKey)}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="m-cap px-1">{t('recurring.luxury')}</span>
            <p className="px-1 text-[11px] text-ink-4">{t('trends.recLuxuryHint')}</p>
            <div className="flex rounded-xl bg-bg-2 p-0.5" role="radiogroup" aria-label={t('recurring.luxury')}>
              {LUXURY.map(({ value, labelKey }) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={luxury === value}
                  data-testid={`trends-rec-luxury-${value}`}
                  onClick={() => setLuxury(value)}
                  className={`m-tap flex-1 rounded-[10px] border-none py-2 text-[12px] whitespace-nowrap ${
                    luxury === value ? 'bg-surface font-semibold text-ink shadow-sm' : 'bg-transparent text-ink-3'
                  }`}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="m-cap px-1">{t('trends.graphCategories')}</span>
            <p className="px-1 text-[11px] text-ink-4">{t('trends.recCategoriesHint')}</p>
            <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="trends-rec-cats">
              <button type="button" data-testid="trends-rec-cat-all" aria-pressed={catPick === null} onClick={() => setCatPick(catPick === null ? new Set() : null)} className={ROW}>
                <TickBox tick={catPick === null ? 'checked' : 'off'} />
                <Icon name="shape-outline" size={18} color="var(--m-ink-3)" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{t('trends.recAllCats')}</span>
                  <span className="block truncate text-[11px] text-ink-4">{t('trends.recAllCatsSub')}</span>
                </span>
              </button>
              {options.map((option) => {
                const on = catPick === null || catPick.has(option.id);
                return (
                  <button key={option.id || 'none'} type="button" data-testid={`trends-rec-cat-${option.id || 'none'}`} aria-pressed={on} onClick={() => toggleCat(option.id)} className={ROW}>
                    <TickBox tick={on ? 'checked' : 'off'} />
                    <Icon name={option.icon} size={18} color={option.color ?? 'var(--m-ink-3)'} />
                    <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{option.name}</span>
                    <span className="m-num shrink-0 text-[12px] text-ink-4">{option.count}</span>
                  </button>
                );
              })}
            </div>
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
          testId="trends-rec-delete"
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
