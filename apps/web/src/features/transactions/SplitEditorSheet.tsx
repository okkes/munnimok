import { useEffect, useRef, useState } from 'react';
import { useData } from '@/app/data';
import type { SpaceTx } from '@/application/transactions';
import { useLang } from '@/i18n';
import { evalAmountCents, fmtCents, parseCents } from '@/lib/money';
import { nextAmountEntry } from '@/lib/amountRegister';
import type { AmountEntryMode } from '@/lib/amountRegister';
import { txTitle } from '@/lib/text';
import { balanceTargetIndex, pctRemainder, resolveSplitsFor, splitRemainderCents, splitsArePct, validatePctSplits, validateSplits } from '@/domain/splits';
import { REIMBURSED_ID, UNCATEGORIZED_ID } from '@/domain/categories';
import type { TxSplit, TxType } from '@/db/types';
import { Button } from '@/ui/Button';
import { FormBlockerNote } from '@/ui/FormBlockerNote';
import { Icon } from '@/ui/Icon';
import { InfoHint } from '@/ui/InfoHint';
import { Chip } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';

// the partition must always add up, a lone row included (it means "no split"; 50% on one row held Done armed, #126)
// parts may share a category: two sub-transactions differ by note/event/identity
function sheetError(options: {
  mode: 'amount' | 'pct';
  referenceCents: number;
  splits: TxSplit[];
}): ReturnType<typeof validateSplits> {
  if (options.splits.length === 1) {
    const off =
      options.mode === 'pct' ? pctRemainder(options.splits) : splitRemainderCents(options.referenceCents, options.splits);
    return off === 0 ? null : 'notBalanced';
  }
  const error =
    options.mode === 'pct' ? validatePctSplits(options.splits) : validateSplits(options.referenceCents, options.splits);
  return error === 'duplicateCategory' ? null : error;
}

/** a part's category entries beyond the first (v2.1 spread): never edited here, but must survive a resave */
interface EntryDraft {
  key: string;
  catId: string;
  amount: string;
}

interface Row {
  key: string;
  catId: string;
  amount: string; // user-facing text, EU decimals
  id?: string;
  label: string;
  /** the part's own type; undefined = inherits the row's */
  txType?: TxType;
  linkedAccountId?: string;
  transferPeerId?: string;
  eventId?: string;
  extraCats: EntryDraft[];
}

let rowCounter = 0;
const newKey = () => `r${rowCounter++}`;
const newRow = (catId: string, amount: string, part?: Partial<Omit<Row, 'key'>>): Row => ({
  key: newKey(),
  catId,
  amount,
  label: '',
  extraCats: [],
  ...part,
});

const defaultLabel = (title: string, index: number, t: ReturnType<typeof useLang>['t']): string =>
  `${title} – ${t('split.partN', { n: index + 1 })}`;

function blurredAmount(raw: string, stashed: string | undefined, amountMode: boolean): string | null {
  if (stashed !== undefined && raw.trim() === '') return stashed;
  if (!amountMode) return null;
  const evaluated = evalAmountCents(raw);
  return evaluated !== null && evaluated >= 0 ? toText(evaluated) : null;
}

const partFields = (r: Row): Partial<TxSplit> => ({
  ...(r.id ? { id: r.id } : {}),
  ...(r.label.trim() ? { label: r.label.trim() } : {}),
  ...(r.txType ? { txType: r.txType } : {}),
  ...(r.linkedAccountId ? { linkedAccountId: r.linkedAccountId } : {}),
  ...(r.transferPeerId ? { transferPeerId: r.transferPeerId } : {}),
  ...(r.eventId ? { eventId: r.eventId } : {}),
});

/** a kept spread: amount = the spread's sum, catId = the largest entry as compat shadow */
function rowToSplit(r: Row): TxSplit {
  const main = { catId: r.catId, amountCents: parseCents(r.amount) ?? 0 };
  const extras = r.extraCats.map((x) => ({ catId: x.catId, amountCents: parseCents(x.amount) ?? 0 }));
  if (extras.length === 0) return { ...main, ...partFields(r) };
  const entries = [main, ...extras];
  const primary = entries.reduce((best, e) => (e.amountCents > best.amountCents ? e : best), entries[0]);
  return {
    catId: primary.catId,
    amountCents: entries.reduce((sum, e) => sum + e.amountCents, 0),
    cats: entries,
    ...partFields(r),
  };
}

/** onArm fires on pointerdown, before the focused field's blur restores its stash: that is how it knows which row (#130) */
function RemainderPill({
  remainder,
  mode,
  currency,
  onArm,
  onBalance,
}: Readonly<{ remainder: number; mode: 'amount' | 'pct'; currency: string; onArm: () => void; onBalance: () => void }>) {
  const { t, lang } = useLang();
  const shown = (cents: number) => (mode === 'pct' ? `${cents}%` : fmtCents(cents, currency, lang));
  return (
    <button
      data-testid="split-remainder"
      onPointerDown={onArm}
      onClick={onBalance}
      className={`m-tap rounded-card border-none px-3 py-2 text-left text-[13px] ${
        remainder > 0 ? 'bg-warning-soft text-warning' : 'bg-negative-soft text-negative'
      }`}
    >
      {remainder > 0 ? t('split.remaining', { amount: shown(remainder) }) : t('split.over', { amount: shown(-remainder) })}
    </button>
  );
}

function ValuesRow({
  row,
  index,
  removable,
  title,
  onLabel,
  handlers,
}: Readonly<{
  row: Row;
  index: number;
  removable: boolean;
  title: string;
  onLabel: (index: number, label: string) => void;
  handlers: EntryHandlers;
}>) {
  const { t } = useLang();
  return (
    <div className="flex items-center gap-2">
      <input
        data-testid={`split-label-${index}`}
        value={row.label}
        placeholder={defaultLabel(title, index, t)}
        onChange={(e) => onLabel(index, e.target.value)}
        className="h-11 min-w-0 flex-1 rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none placeholder:text-ink-4"
      />
      <input
        data-testid={`split-amount-${index}`}
        value={row.amount}
        onChange={(e) => handlers.onAmount(index, e.target.value)}
        onFocus={(e) => handlers.onAmountFocus(index, e.currentTarget)}
        onBlur={() => handlers.onAmountBlur(index)}
        inputMode="decimal"
        className="h-11 w-24 rounded-input border border-line bg-surface px-3 text-right text-[14px] text-ink outline-none"
      />
      {removable && (
        <button
          aria-label={t('action.delete')}
          data-testid={`split-remove-${index}`}
          onClick={() => handlers.onRemove(index)}
          className="m-tap border-none bg-transparent text-ink-4"
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}

interface EntryHandlers {
  onAmount: (index: number, amount: string) => void;
  /** the element rides along so the deferred focus-empty (#134) can
   *  stand down when focus already moved elsewhere */
  onAmountFocus: (index: number, el?: HTMLInputElement) => void;
  onAmountBlur: (index: number) => void;
  onRemove: (index: number) => void;
}

const toText = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
const toPctText = (pct: number) => String(pct).replace('.', ',');
const parsePct = (text: string): number => {
  const n = Number.parseFloat(text.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/** controlled mode (review draft): `value`+`onApply` report the partition instead of writing it */
export function SplitEditorSheet({
  open,
  onOpenChange,
  tx,
  value,
  onApply,
  seedSingle = false,
  seedCatId,
  onApplySingle,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tx: SpaceTx;
  /** the staged partition being edited (the caller owns the write) */
  value?: TxSplit[];
  /** null = clear the split */
  onApply: (splits: TxSplit[] | null) => void;
  /** empty start seeds ONE row instead of two; collapsing back to it means "no split" */
  seedSingle?: boolean;
  /** seedSingle: the current category — review keeps it on the draft, not the raw tx */
  seedCatId?: string;
  /** seedSingle mode: saving with one row reports the plain category */
  onApplySingle?: (catId: string) => void;
}>) {
  const { t } = useLang();
  const { repo } = useData();
  const [rows, setRows] = useState<Row[]>([]);
  const [mode, setMode] = useState<'amount' | 'pct'>('amount');
  const [focusStash, setFocusStash] = useState<{ index: number; amount: string } | null>(null);
  const [entryMode, setEntryMode] = useState<AmountEntryMode>('register');
  // the pill's pointerdown runs before the focused field blurs: capture which field was meant (#130)
  const pendingBalanceTarget = useRef<number | null>(null);
  const armBalance = () => {
    pendingBalanceTarget.current = focusStash?.index ?? null;
  };

  const [attempted, setAttempted] = useState(false);
  const source = value;
  const referenceCents = tx.amountCents;
  useEffect(() => {
    if (!open) return;
    setAttempted(false);
    if (source?.length) {
      // settled `reimbursed` slices carry no pct and must not flip a %-shaped partition to amount mode (#216)
      const pctMode = splitsArePct(source.filter((s) => s.catId !== REIMBURSED_ID));
      setMode(pctMode ? 'pct' : 'amount');
      setRows(
        source.map((s) => {
          const spread = s.cats?.length ? s.cats : undefined;
          const main = spread?.[0];
          return newRow(main?.catId ?? s.catId, pctMode ? toPctText(s.pct!) : toText(main?.amountCents ?? s.amountCents), {
            id: s.id,
            label: s.label ?? '',
            txType: s.txType,
            linkedAccountId: s.linkedAccountId,
            transferPeerId: s.transferPeerId,
            eventId: s.eventId,
            extraCats: (spread?.slice(1) ?? []).map((c) => ({ key: newKey(), catId: c.catId, amount: toText(c.amountCents) })),
          });
        }),
      );
    } else if (seedSingle) {
      setMode('amount');
      setRows([newRow(seedCatId ?? tx.catId ?? UNCATEGORIZED_ID, toText(Math.abs(referenceCents)))]);
    } else {
      setMode('amount');
      setRows([newRow(tx.catId ?? UNCATEGORIZED_ID, toText(Math.abs(referenceCents))), newRow(UNCATEGORIZED_ID, '0,00')]);
    }
    // only on open or a card swap; keyed by tx.id, not the object: background writes re-emit the same row as a
    // new object and must not wipe rows mid-edit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tx.id]);

  const rowValue = (r: Row): number => {
    if (mode === 'pct') return parsePct(r.amount);
    const main = parseCents(r.amount) ?? 0;
    return main + r.extraCats.reduce((sum, x) => sum + (parseCents(x.amount) ?? 0), 0);
  };
  const splits: TxSplit[] =
    mode === 'pct'
      ? rows.map((r) => ({ catId: r.catId, amountCents: 0, pct: parsePct(r.amount), ...partFields(r) }))
      : rows.map((r) => rowToSplit(r));
  const remainder = mode === 'pct' ? pctRemainder(splits) : splitRemainderCents(referenceCents, splits);
  const error = sheetError({ mode, referenceCents, splits });

  const addBlocked = rows.some((r) => rowValue(r) <= 0);

  const switchMode = (next: 'amount' | 'pct') => {
    if (next === mode) return;
    setMode(next);
    const abs = Math.abs(referenceCents);
    if (next === 'pct') {
      setRows((r) =>
        r.map((row) => {
          const cents = parseCents(row.amount) ?? 0;
          return { ...row, amount: abs > 0 ? toPctText(Math.round((cents / abs) * 100)) : '0' };
        }),
      );
    } else {
      // pct to euros must land exactly on the total: rounding each row alone left a ±1 cent remainder;
      // resolveSplitsFor is the partition save stores
      setRows((r) => {
        const pctSplits = r.map((row) => ({ catId: row.catId, amountCents: 0, pct: parsePct(row.amount) }));
        const resolved = resolveSplitsFor(abs, pctSplits);
        return r.map((row, i) => ({ ...row, amount: toText(Math.abs(resolved[i]?.amountCents ?? 0)) }));
      });
    }
  };

  const save = () => {
    if (error) return;
    if (seedSingle && rows.length === 1) {
      onApplySingle?.(rows[0].catId);
      onOpenChange(false);
      return;
    }
    // pct splits keep percentages AND a materialized partition for every reader; needsReview stays untouched so a
    // mid-review save keeps the card on screen; parts get a stable id at save (mint engine, per-part events, device convergence)
    const stored = (mode === 'pct' ? resolveSplitsFor(referenceCents, splits) : splits).map((s) => ({
      ...s,
      id: s.id ?? repo.newId(),
    }));
    onApply(stored);
    onOpenChange(false);
  };

  const clearSplit = () => {
    onApply(null);
    onOpenChange(false);
  };

  const autoBalance = () => {
    // the field the pill was tapped from wins (#130); else the first empty row; else the last
    const forced = pendingBalanceTarget.current;
    pendingBalanceTarget.current = null;
    setRows((r) => {
      const values = r.map(rowValue);
      const target = forced ?? balanceTargetIndex(values);
      const total = mode === 'pct' ? 100 : Math.abs(referenceCents);
      const open = total - values.reduce((sum, v, i) => (i === target ? sum : sum + v), 0);
      const next = mode === 'pct' ? toPctText(Math.max(0, open)) : toText(Math.max(0, open));
      // the balanced row's stored spread no longer matches: it collapses to the shadow category
      return r.map((row, i) => (i === target ? { ...row, amount: next, extraCats: [] } : row));
    });
  };

  const entryAmount = (index: number): string => rows[index]?.amount ?? '';
  const patchAmount = (index: number, amount: string) =>
    setRows((r) => r.map((x, j) => (j === index ? { ...x, amount } : x)));
  const setRowLabel = (index: number, label: string) =>
    setRows((r) => r.map((x, j) => (j === index ? { ...x, label } : x)));
  const removeEntry = (index: number) => setRows((r) => r.filter((_, j) => j !== index));
  const addRow = () =>
    setRows((r) => [...r, newRow(UNCATEGORIZED_ID, mode === 'amount' ? toText(Math.max(remainder, 0)) : toPctText(Math.max(remainder, 0)))]);

  const blurEntry = (index: number) => {
    const stashed = focusStash?.index === index ? focusStash?.amount : undefined;
    const next = blurredAmount(entryAmount(index), stashed, mode === 'amount');
    if (next !== null) patchAmount(index, next);
    setFocusStash(null);
  };

  const entryHandlers: EntryHandlers = {
    onAmount: (index, raw) => {
      if (mode !== 'amount') {
        patchAmount(index, raw);
        return;
      }
      const next = nextAmountEntry(entryMode, entryAmount(index), raw);
      setEntryMode(next.mode);
      patchAmount(index, next.text);
    },
    onAmountFocus: (index, el) => {
      setEntryMode('register');
      // iOS WebKit stalls the caret when the value swaps in the same beat as focus: the field empties one frame later (#134)
      const amount = entryAmount(index);
      requestAnimationFrame(() => {
        // another editable already took focus: stand down (a synthetic test focus leaves activeElement on body)
        const active = document.activeElement;
        if (el && active !== el && active instanceof HTMLElement && active.matches('input, textarea')) return;
        if (el && el.value !== amount) return;
        setFocusStash({ index, amount });
        patchAmount(index, '');
      });
    },
    onAmountBlur: blurEntry,
    onRemove: removeEntry,
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('split.title')} size="tall">
      <div className="flex flex-col gap-2 pt-1" data-testid="split-editor">
        {/* split categories is the everyday tool; the transaction split is for parts that need lives of their own (#210) */}
        <p className="px-1 text-[12px] leading-relaxed text-ink-3" data-testid="split-vs-cats-hint">
          {t('split.vsCatsHint')}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip className="flex-1" testId="split-mode-amount" selected={mode === 'amount'} onClick={() => switchMode('amount')}>
            {t('split.modeAmount')}
          </Chip>
          <Chip className="flex-1" testId="split-mode-pct" selected={mode === 'pct'} onClick={() => switchMode('pct')}>
            {t('split.modePct')}
          </Chip>
          <InfoHint text={t('split.modeHint')} testId="split-mode-hint" />
        </div>
        {rows.map((row, i) => (
          <ValuesRow
            key={row.key}
            row={row}
            index={i}
            removable={rows.length > (seedSingle ? 1 : 2)}
            title={txTitle(tx)}
            onLabel={setRowLabel}
            handlers={entryHandlers}
          />
        ))}

        <button
          data-testid="split-add-row"
          onClick={addRow}
          disabled={addBlocked}
          className="m-tap flex items-center gap-1.5 border-none bg-transparent px-1 py-1 text-[13px] font-medium text-accent-deep disabled:opacity-40"
        >
          <Icon name="plus" size={16} />
          {t('split.addPart')}
        </button>

        {remainder !== 0 && (
          <RemainderPill remainder={remainder} mode={mode} currency={tx.currency} onArm={armBalance} onBalance={autoBalance} />
        )}

        {/* "Done" only stages the draft in review; translateZ stops iOS painting the old enabled button as a ghost band */}
        <div className="flex flex-col gap-2" style={{ transform: 'translateZ(0)' }}>
          {/* the remainder pill explains an unbalanced split; the note covers pill-less errors (a zero row) */}
          <FormBlockerNote show={attempted && !!error && remainder === 0} text={t('form.fixErrors')} testId="split-save-blocker" />
          <Button
            data-testid="split-save"
            aria-invalid={attempted && !!error}
            onClick={() => {
              if (error) {
                setAttempted(true);
                return;
              }
              save();
            }}
          >
            {t('split.done')}
          </Button>
          {!!source?.length && (
            <Button variant="outline" data-testid="split-clear" onClick={clearSplit}>
              {t('split.clear')}
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
