import { useEffect, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { fmtCents, parseCents } from '@/lib/money';
import { nextAmountEntry } from '@/lib/amountRegister';
import type { AmountEntryMode } from '@/lib/amountRegister';
import { UNCATEGORIZED_ID, specialCatType } from '@/domain/categories';
import { resolveSplitsFor } from '@/domain/splits';
import { catName, useCategories } from '@/features/categories/useCategories';
import { CategoryPicker } from '@/features/categories/CategoryPicker';
import type { TxSplit, TxSplitCat, TxType } from '@/db/types';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';

/** one category's share of the part while editing */
interface CatEntry {
  key: string;
  catId: string;
  amount: string; // user-facing text in the mode's units, EU decimals
}

let entryCounter = 0;
const newKey = () => `pc${entryCounter++}`;
const toText = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
const toPctText = (pct: number) => String(pct).replace('.', ',');
const parsePct = (text: string): number => {
  const n = Number.parseFloat(text.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/** the part patch a finished spread becomes: one entry collapses back to
 *  a plain category, several keep the spread with the largest entry as
 *  the compat shadow (v2.1 storage rule) */
export function catsPatch(entries: TxSplitCat[]): Partial<TxSplit> {
  if (entries.length <= 1) return { catId: entries[0]?.catId ?? UNCATEGORIZED_ID, cats: undefined };
  const primary = entries.reduce((best, entry) => (entry.amountCents > best.amountCents ? entry : best), entries[0]);
  return { catId: primary.catId, cats: entries };
}

/** the full apply for a part's category edit: the cats patch plus the R3
 *  type pull — a single ◆ special pick pulls the part's own type, an
 *  ordinary single pick clears a stale pulled one (a counterparty-backed
 *  transfer type stays deliberate). Spreads never pull. */
export function partCatsApplyPatch(slice: TxSplit | undefined, entries: TxSplitCat[]): Partial<TxSplit> {
  const patch = catsPatch(entries);
  if (entries.length !== 1) return patch;
  const pulled = specialCatType(entries[0].catId);
  if (pulled) return { ...patch, txType: pulled };
  return slice?.txType && !slice.linkedAccountId ? { ...patch, txType: undefined } : patch;
}

const seedEntries = (part: TxSplit): CatEntry[] =>
  (part.cats?.length ? part.cats : [{ catId: part.catId, amountCents: Math.abs(part.amountCents) }]).map((entry) => ({
    key: newKey(),
    catId: entry.catId,
    amount: toText(entry.amountCents),
  }));

/**
 * #126 r6/r7 (user request): a part is a full transaction — its money
 * spreads across categories with the SAME editor logic the whole
 * transaction had before splitting existed: category + amount rows,
 * exact euros or percentages, register-style entry, and the leftover
 * pill that fills the field it was tapped from (#130).
 */
export function PartCatsSheet({
  open,
  onOpenChange,
  part,
  currency,
  direction,
  txType,
  allowedCatIds,
  onApply,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** the part whose money is being spread; undefined while closed */
  part?: TxSplit;
  currency: string;
  direction: 'debit' | 'credit';
  /** the container's type gates the picker, same as the split editor */
  txType: TxType;
  allowedCatIds?: readonly string[];
  onApply: (entries: TxSplitCat[]) => void;
}>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const [entries, setEntries] = useState<CatEntry[]>([]);
  const [mode, setMode] = useState<'amount' | 'pct'>('amount');
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  // focusing empties the field so typing replaces; blurring an untouched
  // empty field restores the stashed value (split-editor behavior)
  const [focusStash, setFocusStash] = useState<{ index: number; amount: string } | null>(null);
  const [entryMode, setEntryMode] = useState<AmountEntryMode>('register');
  // #130: the pill's pointerdown runs BEFORE the focused field blurs —
  // capture WHICH field the user meant here
  const pendingTarget = useRef<number | null>(null);

  const refCents = Math.abs(part?.amountCents ?? 0);
  useEffect(() => {
    if (!open || !part) return;
    setMode('amount');
    setEntries(seedEntries(part));
    // deliberately only on open: the sheet owns its rows while open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, part?.id]);

  const valueOf = (entry: CatEntry) => (mode === 'pct' ? parsePct(entry.amount) : (parseCents(entry.amount) ?? 0));
  const remainder = (mode === 'pct' ? 100 : refCents) - entries.reduce((sum, entry) => sum + valueOf(entry), 0);
  const unpicked = entries.some((entry) => entry.catId === UNCATEGORIZED_ID);
  const duplicate = new Set(entries.map((entry) => entry.catId)).size !== entries.length;
  const ready =
    entries.length > 0 && remainder === 0 && !unpicked && !duplicate && entries.every((entry) => valueOf(entry) > 0);
  // finish the open entry first (split-editor rule): no new row while
  // one is still uncategorized or worth nothing
  const addBlocked = entries.some((entry) => entry.catId === UNCATEGORIZED_ID || valueOf(entry) <= 0);

  const patchEntry = (index: number, patch: Partial<CatEntry>) =>
    setEntries((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  /** euros ⇄ percentages, the split editor's exact conversion rules */
  const switchMode = (next: 'amount' | 'pct') => {
    if (next === mode) return;
    setMode(next);
    if (next === 'pct') {
      setEntries((rows) =>
        rows.map((row) => {
          const cents = parseCents(row.amount) ?? 0;
          return { ...row, amount: refCents > 0 ? toPctText(Math.round((cents / refCents) * 100)) : '0' };
        }),
      );
    } else {
      setEntries((rows) => {
        const pctSplits = rows.map((row) => ({ catId: row.catId, amountCents: 0, pct: parsePct(row.amount) }));
        const resolved = resolveSplitsFor(refCents, pctSplits);
        return rows.map((row, i) => ({ ...row, amount: toText(Math.abs(resolved[i]?.amountCents ?? 0)) }));
      });
    }
  };

  const onAmount = (index: number, raw: string) => {
    // register-style entry is a euros affordance; percentages type plain
    if (mode === 'pct') {
      patchEntry(index, { amount: raw });
      return;
    }
    const next = nextAmountEntry(entryMode, entries[index]?.amount ?? '', raw);
    setEntryMode(next.mode);
    patchEntry(index, { amount: next.text });
  };
  const onFocus = (index: number, el?: HTMLInputElement) => {
    // the register arms right away; the empty-for-typing happens ONE
    // FRAME LATER (#134): iOS WebKit stalls the caret when the value
    // swaps in the same beat as focus. Stand down if focus moved on.
    setEntryMode('register');
    const amount = entries[index]?.amount ?? '';
    requestAnimationFrame(() => {
      // another editable already took focus (spam-switch): stand down.
      // (Synthetic test focus leaves activeElement on body — proceed.)
      const active = document.activeElement;
      if (el && active !== el && active instanceof HTMLElement && active.matches('input, textarea')) return;
      // typing already replaced the value inside this frame: keep it
      if (el && el.value !== amount) return;
      setFocusStash({ index, amount });
      patchEntry(index, { amount: '' });
    });
  };
  const onBlur = (index: number) => {
    if (focusStash?.index === index && (entries[index]?.amount ?? '').trim() === '') {
      patchEntry(index, { amount: focusStash.amount });
    }
    setFocusStash(null);
  };

  const balance = () => {
    const forced = pendingTarget.current;
    pendingTarget.current = null;
    setEntries((rows) => {
      const values = rows.map((row) => (mode === 'pct' ? parsePct(row.amount) : (parseCents(row.amount) ?? 0)));
      const firstEmpty = values.indexOf(0);
      const target = forced ?? (firstEmpty === -1 ? rows.length - 1 : firstEmpty);
      const others = values.reduce((sum, v, i) => (i === target ? sum : sum + v), 0);
      const open = Math.max(0, (mode === 'pct' ? 100 : refCents) - others);
      return rows.map((row, i) =>
        i === target ? { ...row, amount: mode === 'pct' ? toPctText(open) : toText(open) } : row,
      );
    });
  };

  const addEntry = () =>
    setEntries((rows) => [
      ...rows,
      {
        key: newKey(),
        catId: UNCATEGORIZED_ID,
        amount: mode === 'pct' ? toPctText(Math.max(remainder, 0)) : toText(Math.max(remainder, 0)),
      },
    ]);
  const removeEntry = (index: number) => setEntries((rows) => rows.filter((_, i) => i !== index));

  const apply = () => {
    if (!ready) return;
    if (mode === 'pct') {
      const resolved = resolveSplitsFor(
        refCents,
        entries.map((entry) => ({ catId: entry.catId, amountCents: 0, pct: parsePct(entry.amount) })),
      );
      onApply(resolved.map((slice) => ({ catId: slice.catId, amountCents: Math.abs(slice.amountCents) })));
      return;
    }
    onApply(entries.map((entry) => ({ catId: entry.catId, amountCents: parseCents(entry.amount) ?? 0 })));
  };

  const shownRemainder = mode === 'pct' ? `${remainder}%` : fmtCents(Math.abs(remainder), currency, lang);
  const pickedCatId = pickerFor === null ? undefined : entries[pickerFor]?.catId;
  const excluded = entries
    .filter((_, i) => i !== pickerFor)
    .map((entry) => entry.catId)
    .filter((catId) => catId !== UNCATEGORIZED_ID);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} title={t('split.partCatsTitle')} size="tall">
        <div className="flex flex-col gap-2 pt-1" data-testid="part-cats-editor">
          {/* whose money is being spread */}
          <div className="flex items-center justify-between gap-2 rounded-xl bg-bg-2 px-3 py-2 text-[12px] text-ink-3">
            <span className="min-w-0 truncate">{part?.label ?? t('split.title')}</span>
            <span className="m-num shrink-0 font-semibold text-ink">{fmtCents(refCents, currency, lang)}</span>
          </div>
          {/* exact euros or percentages — the whole-transaction editor's
              two gears, unchanged for parts (#126 r7) */}
          <div className="flex gap-1.5">
            <Chip className="flex-1" testId="part-cat-mode-amount" selected={mode === 'amount'} onClick={() => switchMode('amount')}>
              {t('split.modeAmount')}
            </Chip>
            <Chip className="flex-1" testId="part-cat-mode-pct" selected={mode === 'pct'} onClick={() => switchMode('pct')}>
              {t('split.modePct')}
            </Chip>
          </div>
          {entries.map((entry, i) => (
            <div key={entry.key} className="flex items-center gap-2">
              <button
                data-testid={`part-cat-${i}`}
                onClick={() => setPickerFor(i)}
                className="m-tap flex h-11 min-w-0 flex-1 items-center gap-2 rounded-input border border-line bg-surface px-3 text-left text-[14px] text-ink"
              >
                <Icon
                  name={cats.byId(entry.catId).icon}
                  size={17}
                  color={cats.byId(cats.byId(entry.catId).parentId ?? '').color ?? cats.byId(entry.catId).color}
                />
                <span className="truncate">{catName(cats.byId(entry.catId), t)}</span>
              </button>
              <input
                data-testid={`part-cat-amount-${i}`}
                value={entry.amount}
                onChange={(e) => onAmount(i, e.target.value)}
                onFocus={(e) => onFocus(i, e.currentTarget)}
                onBlur={() => onBlur(i)}
                inputMode="decimal"
                className="h-11 w-24 rounded-input border border-line bg-surface px-3 text-right text-[14px] text-ink outline-none"
              />
              {entries.length > 1 && (
                <button
                  aria-label={t('action.delete')}
                  data-testid={`part-cat-remove-${i}`}
                  onClick={() => removeEntry(i)}
                  className="m-tap border-none bg-transparent text-ink-4"
                >
                  <Icon name="close" size={16} />
                </button>
              )}
            </div>
          ))}
          <button
            data-testid="part-cat-add"
            onClick={addEntry}
            disabled={addBlocked}
            className="m-tap flex items-center gap-1.5 border-none bg-transparent px-1 py-1 text-[13px] font-medium text-accent-deep disabled:opacity-40"
          >
            <Icon name="plus" size={16} />
            {t('split.addRow')}
          </button>
          {remainder !== 0 && (
            <button
              data-testid="part-cat-remainder"
              onPointerDown={() => {
                pendingTarget.current = focusStash?.index ?? null;
              }}
              onClick={balance}
              className={`m-tap rounded-card border-none px-3 py-2 text-left text-[13px] ${
                remainder > 0 ? 'bg-warning-soft text-warning' : 'bg-negative-soft text-negative'
              }`}
            >
              {remainder > 0
                ? t('split.remaining', { amount: shownRemainder })
                : t('split.over', { amount: shownRemainder })}
            </button>
          )}
          <Button data-testid="part-cat-save" onClick={apply} disabled={!ready}>
            {t('split.done')}
          </Button>
        </div>
      </Sheet>
      <CategoryPicker
        open={pickerFor !== null}
        onOpenChange={(next) => {
          if (!next) setPickerFor(null);
        }}
        direction={direction}
        txType={txType}
        selectedId={pickedCatId}
        excludeIds={excluded}
        onlyIds={allowedCatIds}
        onPick={(catId) => {
          if (pickerFor !== null) patchEntry(pickerFor, { catId });
        }}
      />
    </>
  );
}
