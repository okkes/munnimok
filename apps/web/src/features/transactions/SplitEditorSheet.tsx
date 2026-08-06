import { useEffect, useState } from 'react';
import { useData } from '@/app/data';
import { useSpaceAccounts, useSpaceTransactions, useTxTransform } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { useLang } from '@/i18n';
import { evalAmountCents, fmtCents, parseCents } from '@/lib/money';
import { txTitle } from '@/lib/text';
import { balanceLastRow, pctRemainder, primaryCatId, resolveSplitsFor, splitRemainderCents, splitsArePct, validatePctSplits, validateSplits } from '@/domain/splits';
import { givenCents, netAmountCents, netCreditCents, totalReimbursedCents } from '@/domain/reimbursement';
import { REIMBURSED_ID, UNCATEGORIZED_ID, autoSubFor, specialCatType } from '@/domain/categories';
import { kindOf } from '@/domain/txKind';
import { catName, useCategories } from '@/features/categories/useCategories';
import { CategoryPicker } from '@/features/categories/CategoryPicker';
import { CounterpartySheet } from './TxKindSheet';
import type { TxSplit, TxType } from '@/db/types';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';

/** one row in the unified editor = a plain category, always valid */
function sheetError(options: {
  seedSingle: boolean;
  rowCount: number;
  mode: 'amount' | 'pct';
  referenceCents: number;
  splits: TxSplit[];
}): ReturnType<typeof validateSplits> {
  if (options.seedSingle && options.rowCount === 1) return null;
  if (options.mode === 'pct') return validatePctSplits(options.splits);
  return validateSplits(options.referenceCents, options.splits);
}

interface Row {
  /** stable key for React list rendering (rows have no natural id) */
  key: string;
  catId: string;
  amount: string; // user-facing text, EU decimals
  // typed parts (v2): identity + story carried through the editor
  id?: string;
  label: string;
  /** the part's own type; undefined = inherits the row's */
  txType?: TxType;
  linkedAccountId?: string;
  transferPeerId?: string;
  eventId?: string;
}

let rowCounter = 0;
const newRow = (catId: string, amount: string, part?: Partial<Row>): Row => ({
  key: `r${rowCounter++}`,
  catId,
  amount,
  label: '',
  ...part,
});

/** the part's face when the user typed nothing: "<title> – split N" */
const defaultLabel = (title: string, index: number, t: ReturnType<typeof useLang>['t']): string =>
  `${title} – ${t('split.partN', { n: index + 1 })}`;

/** a mid-edit TYPE change can strand categories that don't speak the
 *  new type (user ss: Income + Maintenance) — flag them and hold Done.
 *  A part with its OWN type answers to that type, not the row's (R4);
 *  a marked special pick on a standard row pulls the type at apply
 *  (R3) and is never a stranded conflict. Out of the component (S3776). */
function computeRowConflicts(rows: Row[], effectiveType: TxType, cats: ReturnType<typeof useCategories>): boolean[] {
  return rows.map((r) => {
    if (r.catId === UNCATEGORIZED_ID) return false;
    const partType = r.txType ?? effectiveType;
    if (kindOf(partType) === 'standard' && specialCatType(r.catId)) return false;
    const speaks = cats.byId(r.catId).txTypes;
    return !!speaks && !speaks.includes(partType);
  });
}

/** a fresh part's opening amount: the current remainder — the natural
 *  next slice (pct mode starts blank-ish at zero) */
const addRowSeed = (mode: 'amount' | 'pct', remainder: number): string =>
  toText(mode === 'amount' ? Math.max(remainder, 0) : 0);

const accountNameOf = (accounts: readonly { id: string; name: string }[] | undefined, id: string): string =>
  accounts?.find((a) => a.id === id)?.name ?? '';

/** the amount an emptied-then-abandoned field falls back to, or the
 *  evaluated arithmetic (87,40-25 → 62,40); null keeps what's typed */
function blurredAmount(raw: string, stashed: string | undefined, amountMode: boolean): string | null {
  if (stashed !== undefined && raw.trim() === '') return stashed;
  if (!amountMode) return null;
  const evaluated = evalAmountCents(raw);
  return evaluated !== null && evaluated >= 0 ? toText(evaluated) : null;
}

/** the typed-part story a row carries into the stored slice */
const partFields = (r: Row): Partial<TxSplit> => ({
  ...(r.id ? { id: r.id } : {}),
  ...(r.label.trim() ? { label: r.label.trim() } : {}),
  ...(r.txType ? { txType: r.txType } : {}),
  ...(r.linkedAccountId ? { linkedAccountId: r.linkedAccountId } : {}),
  ...(r.transferPeerId ? { transferPeerId: r.transferPeerId } : {}),
  ...(r.eventId ? { eventId: r.eventId } : {}),
});

/** a part card's head: the copied-info label ("<title> – split N",
 *  editable) + the part's own kind (typed-splits v2 — R4: parts carry
 *  the story). Out of the editor component for S3776. */
function PartHeader({
  row,
  index,
  title,
  onLabel,
  onStandard,
  onTransfer,
}: Readonly<{
  row: Row;
  index: number;
  title: string;
  onLabel: (index: number, label: string) => void;
  onStandard: (index: number) => void;
  onTransfer: (index: number) => void;
}>) {
  const { t } = useLang();
  return (
    <div className="flex items-center gap-2">
      <input
        data-testid={`split-label-${index}`}
        value={row.label}
        placeholder={defaultLabel(title, index, t)}
        onChange={(e) => onLabel(index, e.target.value)}
        className="h-9 min-w-0 flex-1 rounded-input border border-line bg-bg-2 px-3 text-[13px] text-ink outline-none placeholder:text-ink-4"
      />
      <Chip testId={`split-kind-standard-${index}`} selected={!row.txType || kindOf(row.txType) === 'standard'} onClick={() => onStandard(index)}>
        {t('tx.kind.standard')}
      </Chip>
      <Chip testId={`split-kind-transfer-${index}`} selected={!!row.txType && kindOf(row.txType) === 'transfer'} onClick={() => onTransfer(index)}>
        {t('tx.kind.transfer')}
      </Chip>
    </div>
  );
}

/** the unassigned/overshoot pill — tap auto-balances the last row
 *  (out of the editor for S3776) */
function RemainderPill({
  remainder,
  mode,
  currency,
  onBalance,
}: Readonly<{ remainder: number; mode: 'amount' | 'pct'; currency: string; onBalance: () => void }>) {
  const { t, lang } = useLang();
  const shown = (cents: number) => (mode === 'pct' ? `${cents}%` : fmtCents(cents, currency, lang));
  return (
    <button
      data-testid="split-remainder"
      onClick={onBalance}
      className={`m-tap rounded-card border-none px-3 py-2 text-left text-[13px] ${
        remainder > 0 ? 'bg-warning-soft text-warning' : 'bg-negative-soft text-negative'
      }`}
    >
      {remainder > 0 ? t('split.remaining', { amount: shown(remainder) }) : t('split.over', { amount: shown(-remainder) })}
    </button>
  );
}

/** one editor row — flat category+amount, or a part CARD the moment a
 *  real split exists (typed-splits v2). Out of the editor for S3776. */
function PartRowView({
  row,
  index,
  card,
  conflict,
  removable,
  title,
  cats,
  accountName,
  onLabel,
  onStandard,
  onTransfer,
  onPickCat,
  onAmount,
  onAmountFocus,
  onAmountBlur,
  onRemove,
}: Readonly<{
  row: Row;
  index: number;
  card: boolean;
  conflict: boolean;
  removable: boolean;
  title: string;
  cats: ReturnType<typeof useCategories>;
  accountName: (id: string) => string;
  onLabel: (index: number, label: string) => void;
  onStandard: (index: number) => void;
  onTransfer: (index: number) => void;
  onPickCat: (index: number) => void;
  onAmount: (index: number, amount: string) => void;
  onAmountFocus: (index: number) => void;
  onAmountBlur: (index: number) => void;
  onRemove: (index: number) => void;
}>) {
  const { t } = useLang();
  return (
    <div className={card ? 'flex flex-col gap-1.5 rounded-card border border-line bg-surface p-2' : 'flex items-center gap-2'}>
      {card && (
        <PartHeader row={row} index={index} title={title} onLabel={onLabel} onStandard={onStandard} onTransfer={onTransfer} />
      )}
      <div className="flex items-center gap-2">
        <button
          data-testid={`split-cat-${index}`}
          onClick={() => onPickCat(index)}
          className={`m-tap flex h-11 min-w-0 flex-1 items-center gap-2 rounded-input border bg-surface px-3 text-left text-[14px] text-ink ${
            conflict ? 'border-negative' : 'border-line'
          }`}
        >
          <Icon name={cats.byId(row.catId).icon} size={17} color={cats.byId(cats.byId(row.catId).parentId ?? '').color ?? cats.byId(row.catId).color} />
          <span className="truncate">{catName(cats.byId(row.catId), t)}</span>
          {row.linkedAccountId && (
            <span className="truncate text-[11px] text-ink-4" data-testid={`split-counter-${index}`}>
              → {accountName(row.linkedAccountId)}
            </span>
          )}
        </button>
        <input
          data-testid={`split-amount-${index}`}
          value={row.amount}
          onChange={(e) => onAmount(index, e.target.value)}
          onFocus={() => onAmountFocus(index)}
          onBlur={() => onAmountBlur(index)}
          inputMode="decimal"
          className="h-11 w-24 rounded-input border border-line bg-surface px-3 text-right text-[14px] text-ink outline-none"
        />
        {removable && (
          <button
            aria-label={t('action.delete')}
            data-testid={`split-remove-${index}`}
            onClick={() => onRemove(index)}
            className="m-tap border-none bg-transparent text-ink-4"
          >
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

/** R3 per part: a marked special pick pulls the part's own type
 *  (Set aside → saving); an ordinary pick clears a stale pulled one —
 *  a counterparty-backed transfer type stays deliberate */
function pulledTypePatch(row: Row, catId: string): Partial<Row> {
  const pulled = specialCatType(catId);
  if (pulled) return { txType: pulled };
  return row.txType && !row.linkedAccountId ? { txType: undefined } : {};
}

/** categories the OTHER rows already own — hidden in the picker; a
 *  split across "Rent" and "Rent" is never meaningful (user ss) */
const excludedCatIds = (rows: Row[], pickerFor: number | null): string[] | undefined =>
  pickerFor === null ? undefined : rows.filter((x, j) => j !== pickerFor && x.catId !== UNCATEGORIZED_ID).map((x) => x.catId);

const toText = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
const toPctText = (pct: number) => String(pct).replace('.', ',');
const parsePct = (text: string): number => {
  const n = Number.parseFloat(text.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/** Editor partitioning a transaction across categories — in euros (must
 *  sum exactly) or percentages (must reach 100, scales to any amount).
 *  Controlled mode (review draft): `value`+`onApply` make the sheet
 *  report the partition instead of writing it. */
export function SplitEditorSheet({
  open,
  onOpenChange,
  tx,
  value,
  txType,
  onApply,
  seedSingle = false,
  seedCatId,
  direction,
  onApplySingle,
  reason,
  allowedCatIds,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tx: SpaceTx;
  /** controlled mode: the draft's splits instead of the tx's */
  value?: TxSplit[];
  /** controlled mode: the draft's type gates the per-slice category picker */
  txType?: SpaceTx['txType'];
  /** controlled mode: null = clear the split */
  onApply?: (splits: TxSplit[] | null) => void;
  /** empty start seeds ONE row (current category, full amount) instead
   *  of the classic two — the review card's unified editor */
  seedSingle?: boolean;
  /** seedSingle: the CURRENT category (review keeps it on the draft, not
   *  the raw tx — seeding from tx.catId showed Uncategorized, user bug) */
  seedCatId?: string;
  /** money direction override: the ADD form knows expense/income before
   *  any amount exists (amountCents 0 read as credit and hid expense
   *  categories in the picker) */
  direction?: 'debit' | 'credit';
  /** seedSingle mode: saving with one row reports the plain category */
  onApplySingle?: (catId: string) => void;
  /** why the current category was suggested (review card) — shown inline */
  reason?: string | null;
  /** recurring-linked rows pick between the recurring's category and
   *  expected reimbursement only (user rule 2026-07-28) */
  allowedCatIds?: readonly string[];
}>) {
  const { t } = useLang();
  const transform = useTxTransform();
  const { repo } = useData();
  const cats = useCategories();
  const [rows, setRows] = useState<Row[]>([]);
  const [mode, setMode] = useState<'amount' | 'pct'>('amount');
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  // which part is picking its counterparty (typed-splits v2)
  const [counterFor, setCounterFor] = useState<number | null>(null);
  // focusing an amount empties it so typing replaces instead of appending
  // (user request); blurring an untouched empty field restores the value
  const [focusStash, setFocusStash] = useState<{ index: number; amount: string } | null>(null);

  const allTxs = useSpaceTransactions();
  const accounts = useSpaceAccounts();
  // redesign (docs/reimbursement-redesign.md): stored slices are GROSS
  // with the settled value in a `reimbursed` slice. The editor still asks
  // for the NET partition — the user's real categories — and the
  // reimbursed slice is held aside here and re-attached on save.
  const settledCents =
    tx.amountCents < 0 ? totalReimbursedCents(tx) : givenCents(allTxs ?? [], tx.id);
  // controlled mode edits the draft's splits; write-through edits the tx's
  const source = onApply ? value : tx.splits?.filter((s) => s.catId !== REIMBURSED_ID);
  const netCents = tx.amountCents < 0 ? netAmountCents(tx) : netCreditCents(tx, givenCents(allTxs ?? [], tx.id));
  const referenceCents = onApply ? tx.amountCents : netCents;
  useEffect(() => {
    if (!open) return;
    if (source?.length) {
      const pctMode = splitsArePct(source);
      setMode(pctMode ? 'pct' : 'amount');
      setRows(
        source.map((s) =>
          newRow(s.catId, pctMode ? toPctText(s.pct!) : toText(s.amountCents), {
            id: s.id,
            label: s.label ?? '',
            txType: s.txType,
            linkedAccountId: s.linkedAccountId,
            transferPeerId: s.transferPeerId,
            eventId: s.eventId,
          }),
        ),
      );
    } else if (seedSingle) {
      // review's unified editor (user redesign): open on JUST the current
      // category owning the full amount — rows are added explicitly
      setMode('amount');
      setRows([newRow(seedCatId ?? tx.catId ?? UNCATEGORIZED_ID, toText(Math.abs(referenceCents)))]);
    } else {
      setMode('amount');
      // start from the current category + an empty second row
      setRows([newRow(tx.catId ?? UNCATEGORIZED_ID, toText(Math.abs(referenceCents))), newRow(UNCATEGORIZED_ID, '0,00')]);
    }
    // deliberately only on open (or a card swap): the sheet owns its
    // rows while open. Keyed by tx.id, NOT the object — background
    // writes (sync, migrations) re-emit the same row as a fresh object
    // and must never wipe rows the user is mid-editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tx.id]);

  const splits: TxSplit[] =
    mode === 'pct'
      ? rows.map((r) => ({ catId: r.catId, amountCents: 0, pct: parsePct(r.amount), ...partFields(r) }))
      : rows.map((r) => ({ catId: r.catId, amountCents: parseCents(r.amount) ?? 0, ...partFields(r) }));
  const remainder = mode === 'pct' ? pctRemainder(splits) : splitRemainderCents(referenceCents, splits);
  const error = sheetError({ seedSingle, rowCount: rows.length, mode, referenceCents, splits });

  const effectiveType = txType ?? tx.txType;
  const rowConflicts = computeRowConflicts(rows, effectiveType, cats);
  const hasTypeConflict = rowConflicts.some(Boolean);

  // an empty or zero row must be finished before ANOTHER row appears
  // (user request: + Add category waits for the current one)
  const rowUnfinished = (index: number) => {
    if (rows[index].catId === UNCATEGORIZED_ID) return true;
    const value = mode === 'pct' ? parsePct(rows[index].amount) : (parseCents(rows[index].amount) ?? 0);
    return value <= 0;
  };
  const addBlocked = rows.some((_, i) => rowUnfinished(i));

  const switchMode = (next: 'amount' | 'pct') => {
    if (next === mode) return;
    setMode(next);
    const abs = Math.abs(referenceCents);
    if (next === 'pct') {
      // carry the current euro shape over as rounded percentages
      setRows((r) =>
        r.map((row) => {
          const cents = parseCents(row.amount) ?? 0;
          return { ...row, amount: abs > 0 ? toPctText(Math.round((cents / abs) * 100)) : '0' };
        }),
      );
    } else {
      // pct → euros must land EXACTLY on the total: rounding each row on
      // its own left a ±1 cent remainder (50/50 of €34.99 → "€0.01 too
      // much", user ss). resolveSplitsFor is the same partition the save
      // path stores — tabbing back shows precisely what saving would.
      setRows((r) => {
        const pctSplits = r.map((row) => ({ catId: row.catId, amountCents: 0, pct: parsePct(row.amount) }));
        const resolved = resolveSplitsFor(abs, pctSplits);
        return r.map((row, i) => ({ ...row, amount: toText(Math.abs(resolved[i]?.amountCents ?? 0)) }));
      });
    }
  };

  const save = () => {
    if (error || hasTypeConflict) return;
    // a lone row in the unified editor means "just this category" — no
    // split is stored, the category rides through onApplySingle
    if (seedSingle && rows.length === 1) {
      onApplySingle?.(rows[0].catId);
      onOpenChange(false);
      return;
    }
    // pct splits keep their percentages AND a materialized partition, so
    // every reader (budgets, drills, exports) stays simple.
    // needsReview is NOT touched: saving a split mid-review must keep the
    // card on screen until the user confirms (user request)
    // Typed parts get a STABLE id at save (typed-splits v2): the mint
    // engine, per-part events and detail navigation key on it, and two
    // devices editing the same array converge on the same identities.
    const stored = (mode === 'pct' ? resolveSplitsFor(referenceCents, splits) : splits).map((s) => ({
      ...s,
      id: s.id ?? repo.newId(),
    }));
    if (onApply) {
      onApply(stored);
    } else {
      // the settled value rides along untouched — gross invariant kept
      const withSettled = settledCents > 0 ? [...stored, { catId: REIMBURSED_ID, amountCents: settledCents }] : stored;
      // the parent stays a CONTAINER (R4) — catId is only the compat
      // shadow old readers still glance at
      void transform(tx, {
        splits: withSettled,
        catId: primaryCatId(stored),
      });
    }
    onOpenChange(false);
  };

  const clearSplit = () => {
    if (onApply) {
      onApply(null);
    } else if (settledCents > 0) {
      // "no split" on a settled tx still needs the gross partition:
      // one slice for the chosen category, one for the settled value
      const catId = primaryCatId(splits) ?? tx.catId ?? UNCATEGORIZED_ID;
      const rest = Math.max(0, Math.abs(tx.amountCents) - settledCents);
      void transform(tx, {
        splits: [...(rest > 0 ? [{ catId, amountCents: rest }] : []), { catId: REIMBURSED_ID, amountCents: settledCents }],
        catId,
      });
    } else {
      void transform(tx, {
        splits: null as never, // explicit null clears the field
        catId: primaryCatId(splits) ?? tx.catId,
      });
    }
    onOpenChange(false);
  };

  const autoBalance = () => {
    if (mode === 'pct') {
      setRows((r) => {
        const open = 100 - r.slice(0, -1).reduce((sum, row) => sum + parsePct(row.amount), 0);
        return r.map((row, i) => (i === r.length - 1 ? { ...row, amount: toPctText(Math.max(0, open)) } : row));
      });
      return;
    }
    setRows((r) => {
      const abs = r.map((row) => ({ catId: row.catId, amountCents: parseCents(row.amount) ?? 0 }));
      return balanceLastRow(referenceCents, abs).map((s, i) => ({ ...r[i], catId: s.catId, amount: toText(s.amountCents) }));
    });
  };

  const setRowAmount = (index: number, amount: string) =>
    setRows((r) => r.map((x, j) => (j === index ? { ...x, amount } : x)));
  const setRowLabel = (index: number, label: string) =>
    setRows((r) => r.map((x, j) => (j === index ? { ...x, label } : x)));
  const removeRow = (index: number) => setRows((r) => r.filter((_, j) => j !== index));
  // a new part takes the current remainder — the natural next slice
  // (user design: adding a split copies the info and offers what's left)
  const addRow = () => setRows((r) => [...r, newRow(UNCATEGORIZED_ID, addRowSeed(mode, remainder))]);

  /** Standard part: inherits the row's type, drops any counterparty —
   *  its old mint retires through the choke point at save */
  const setPartStandard = (index: number) =>
    setRows((r) => r.map((x, j) => (j === index ? { ...x, txType: undefined, linkedAccountId: undefined } : x)));
  const accountName = (id: string) => accountNameOf(accounts, id);

  const blurAmount = (i: number) => {
    const next = blurredAmount(rows[i]?.amount ?? '', focusStash?.index === i ? focusStash.amount : undefined, mode === 'amount');
    if (next !== null) setRowAmount(i, next);
    setFocusStash(null);
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} title={t('split.title')} size="tall">
        <div className="flex flex-col gap-2 pt-1" data-testid="split-editor">
          {/* the prediction's provenance, shown in the open (user request:
              no more hiding it behind an info button) */}
          {reason && (
            <div className="flex items-center gap-1.5 rounded-xl bg-bg-2 px-3 py-2 text-[12px] text-ink-3" data-testid="split-reason">
              <Icon name="lightbulb-outline" size={14} color="var(--m-ink-4)" />
              {reason}
            </div>
          )}
          {/* exact euros for one charge, percentages when the shape repeats */}
          <div className="flex gap-1.5">
            <Chip className="flex-1" testId="split-mode-amount" selected={mode === 'amount'} onClick={() => switchMode('amount')}>
              {t('split.modeAmount')}
            </Chip>
            <Chip className="flex-1" testId="split-mode-pct" selected={mode === 'pct'} onClick={() => switchMode('pct')}>
              {t('split.modePct')}
            </Chip>
          </div>
          {rows.map((row, i) => (
            <PartRowView
              key={row.key}
              row={row}
              index={i}
              card={rows.length > 1}
              conflict={rowConflicts[i]}
              removable={rows.length > (seedSingle ? 1 : 2)}
              title={txTitle(tx)}
              cats={cats}
              accountName={accountName}
              onLabel={setRowLabel}
              onStandard={setPartStandard}
              onTransfer={setCounterFor}
              onPickCat={setPickerFor}
              onAmount={setRowAmount}
              onAmountFocus={(index) => {
                setFocusStash({ index, amount: rows[index].amount });
                setRowAmount(index, '');
              }}
              onAmountBlur={blurAmount}
              onRemove={removeRow}
            />
          ))}

          {/* finish the open row first (user request): no new row while
              one is still uncategorized or worth nothing */}
          <button
            data-testid="split-add-row"
            onClick={addRow}
            disabled={addBlocked}
            className="m-tap flex items-center gap-1.5 border-none bg-transparent px-1 py-1 text-[13px] font-medium text-accent-deep disabled:opacity-40"
          >
            <Icon name="plus" size={16} />
            {t('split.addRow')}
          </button>

          {hasTypeConflict && (
            <p className="rounded-card bg-negative-soft px-3 py-2 text-[12px] leading-relaxed text-negative" data-testid="split-type-conflict">
              {t('split.typeConflict', { type: t(`tx.type.${effectiveType}`) })}
            </p>
          )}

          {remainder !== 0 && (
            <RemainderPill remainder={remainder} mode={mode} currency={tx.currency} onBalance={autoBalance} />
          )}

          {/* "Done", not "Save": in review this only stages the draft — the
              card's Confirm is the real write (user: Save felt misleading) */}
          <Button data-testid="split-save" onClick={save} disabled={!!error || hasTypeConflict}>
            {t('split.done')}
          </Button>
          {!!source?.length && (
            <Button variant="outline" data-testid="split-clear" onClick={clearSplit}>
              {t('split.clear')}
            </Button>
          )}
        </div>
      </Sheet>
      <CategoryPicker
        open={pickerFor !== null}
        onOpenChange={(next) => {
          if (!next) setPickerFor(null);
        }}
        direction={direction ?? (tx.amountCents < 0 ? 'debit' : 'credit')}
        // add-form mode (direction given): filter by direction only — the
        // fallback type follows the category and would hide the other
        // direction's categories before one is picked (old form behavior)
        txType={direction ? undefined : (txType ?? tx.txType)}
        selectedId={pickerFor === null ? undefined : rows[pickerFor]?.catId}
        excludeIds={excludedCatIds(rows, pickerFor)}
        onlyIds={allowedCatIds}
        onPick={(catId) => {
          if (pickerFor === null) return;
          setRows((r) => r.map((x, j) => (j === pickerFor ? { ...x, catId, ...pulledTypePatch(x, catId) } : x)));
        }}
      />
      {/* per-part counterparty (typed-splits v2): a transfer part links a
          tracked account — the mint engine writes its counter leg */}
      <CounterpartySheet
        open={counterFor !== null}
        onOpenChange={(next) => {
          if (!next) setCounterFor(null);
        }}
        excludeAccountId={tx.accountId}
        currentLinkedId={counterFor === null ? undefined : rows[counterFor]?.linkedAccountId}
        onChoose={(account) => {
          if (counterFor === null) return;
          setRows((r) =>
            r.map((x, j) =>
              j === counterFor
                ? { ...x, txType: 'transfer', linkedAccountId: account.id, catId: autoSubFor('transfer', tx.amountCents) ?? x.catId }
                : x,
            ),
          );
        }}
      />
    </>
  );
}
