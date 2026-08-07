import { useEffect, useState } from 'react';
import { useData } from '@/app/data';
import { useSpaceAccounts, useSpaceTransactions, useTxTransform } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { useLang } from '@/i18n';
import { evalAmountCents, fmtCents, parseCents } from '@/lib/money';
import { nextAmountEntry } from '@/lib/amountRegister';
import type { AmountEntryMode } from '@/lib/amountRegister';
import { txTitle } from '@/lib/text';
import { balanceOpenRow, balanceTargetIndex, pctRemainder, primaryCatId, resolveSplitsFor, splitRemainderCents, splitsArePct, validatePctSplits, validateSplits } from '@/domain/splits';
import { givenCents, netAmountCents, netCreditCents, totalReimbursedCents } from '@/domain/reimbursement';
import { REIMBURSED_ID, UNCATEGORIZED_ID, autoSubFor, specialCatType } from '@/domain/categories';
import { kindOf } from '@/domain/txKind';
import { hasTypedParts } from '@/domain/txSlices';
import { catName, useCategories } from '@/features/categories/useCategories';
import { CategoryPicker } from '@/features/categories/CategoryPicker';
import { CounterpartySheet } from './TxKindSheet';
import type { TxSplit, TxType } from '@/db/types';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';

/** the partition must always add up — a lone row included: it means
 *  "no split", which is only sound when it still covers the WHOLE
 *  (50% typed on a single row held Done armed — user report #126 r3) */
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
  if (options.mode === 'pct') return validatePctSplits(options.splits);
  return validateSplits(options.referenceCents, options.splits);
}

/** an extra category entry inside a PART (v2.1 per-part spread) */
interface EntryDraft {
  key: string;
  catId: string;
  amount: string;
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
  /** part mode: the part's categories beyond the first (v2.1) */
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

/** the part's face when the user typed nothing: "<title> – split N" */
const defaultLabel = (title: string, index: number, t: ReturnType<typeof useLang>['t']): string =>
  `${title} – ${t('split.partN', { n: index + 1 })}`;

/** every category a row speaks for: the main entry + the part spread */
const rowCatIds = (row: Row): string[] => [row.catId, ...row.extraCats.map((x) => x.catId)];

/** a mid-edit TYPE change can strand categories that don't speak the
 *  new type (user ss: Income + Maintenance) — flag them and hold Done.
 *  A part with its OWN type answers to that type, not the row's (R4);
 *  a marked special pick on a standard row pulls the type at apply
 *  (R3) and is never a stranded conflict. Out of the component (S3776). */
function computeRowConflicts(rows: Row[], effectiveType: TxType, cats: ReturnType<typeof useCategories>): boolean[] {
  return rows.map((r) => {
    const partType = r.txType ?? effectiveType;
    return rowCatIds(r).some((catId) => {
      if (catId === UNCATEGORIZED_ID) return false;
      if (kindOf(partType) === 'standard' && specialCatType(catId)) return false;
      const speaks = cats.byId(catId).txTypes;
      return !!speaks && !speaks.includes(partType);
    });
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

/** the stored slice a row becomes: a plain category slice, or a part
 *  spread across categories (v2.1 — amount = the spread's sum, catId =
 *  the largest entry as the compat shadow) */
function rowToSplit(r: Row, partMode: boolean): TxSplit {
  const main = { catId: r.catId, amountCents: parseCents(r.amount) ?? 0 };
  const extras = partMode ? r.extraCats.map((x) => ({ catId: x.catId, amountCents: parseCents(x.amount) ?? 0 })) : [];
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

/** where an amount/category edit lands: the row's main entry (cat 0)
 *  or one of its extra spread entries (cat = extras index + 1) */
interface EntryAddress {
  row: number;
  cat: number;
}

/** #126 v2: the values-only row — the split as pure money: label +
 *  amount, exact euros or percentages. Categories, kinds and events are
 *  the part deck's job on the review screen. */
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
        onChange={(e) => handlers.onAmount({ row: index, cat: 0 }, e.target.value)}
        onFocus={() => handlers.onAmountFocus({ row: index, cat: 0 })}
        onBlur={() => handlers.onAmountBlur({ row: index, cat: 0 })}
        inputMode="decimal"
        className="h-11 w-24 rounded-input border border-line bg-surface px-3 text-right text-[14px] text-ink outline-none"
      />
      {removable && (
        <button
          aria-label={t('action.delete')}
          data-testid={`split-remove-${index}`}
          onClick={() => handlers.onRemove({ row: index, cat: 0 })}
          className="m-tap border-none bg-transparent text-ink-4"
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}

/** one category+amount line — the editor's atom, shared by classic rows
 *  and the entries inside a part card. Testids keep the historical
 *  main-entry names (split-cat-0) and suffix spread entries (-0-1). */
function EntryRow({
  at,
  catId,
  amount,
  conflict,
  removable,
  linkedAccountId,
  cats,
  accountName,
  onPickCat,
  onAmount,
  onAmountFocus,
  onAmountBlur,
  onRemove,
}: Readonly<{
  at: EntryAddress;
  catId: string;
  amount: string;
  conflict: boolean;
  removable: boolean;
  linkedAccountId?: string;
  cats: ReturnType<typeof useCategories>;
  accountName: (id: string) => string;
  onPickCat: (at: EntryAddress) => void;
  onAmount: (at: EntryAddress, amount: string) => void;
  onAmountFocus: (at: EntryAddress) => void;
  onAmountBlur: (at: EntryAddress) => void;
  onRemove: (at: EntryAddress) => void;
}>) {
  const { t } = useLang();
  const suffix = at.cat === 0 ? `${at.row}` : `${at.row}-${at.cat}`;
  return (
    <div className="flex items-center gap-2">
      <button
        data-testid={`split-cat-${suffix}`}
        onClick={() => onPickCat(at)}
        className={`m-tap flex h-11 min-w-0 flex-1 items-center gap-2 rounded-input border bg-surface px-3 text-left text-[14px] text-ink ${
          conflict ? 'border-negative' : 'border-line'
        }`}
      >
        <Icon name={cats.byId(catId).icon} size={17} color={cats.byId(cats.byId(catId).parentId ?? '').color ?? cats.byId(catId).color} />
        <span className="truncate">{catName(cats.byId(catId), t)}</span>
        {linkedAccountId && (
          <span className="truncate text-[11px] text-ink-4" data-testid={`split-counter-${suffix}`}>
            → {accountName(linkedAccountId)}
          </span>
        )}
      </button>
      <input
        data-testid={`split-amount-${suffix}`}
        value={amount}
        onChange={(e) => onAmount(at, e.target.value)}
        onFocus={() => onAmountFocus(at)}
        onBlur={() => onAmountBlur(at)}
        inputMode="decimal"
        className="h-11 w-24 rounded-input border border-line bg-surface px-3 text-right text-[14px] text-ink outline-none"
      />
      {removable && (
        <button
          aria-label={t('action.delete')}
          data-testid={`split-remove-${suffix}`}
          onClick={() => onRemove(at)}
          className="m-tap border-none bg-transparent text-ink-4"
        >
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}

/** shared entry handlers, bundled once — the card and the flat row pass
 *  them straight through to EntryRow (out of the editor for S3776) */
interface EntryHandlers {
  cats: ReturnType<typeof useCategories>;
  accountName: (id: string) => string;
  onPickCat: (at: EntryAddress) => void;
  onAmount: (at: EntryAddress, amount: string) => void;
  onAmountFocus: (at: EntryAddress) => void;
  onAmountBlur: (at: EntryAddress) => void;
  onRemove: (at: EntryAddress) => void;
}

/** one editor row — a flat category line by default; a part CARD (label,
 *  kind, its own category spread) only in part mode (v2.1: plain
 *  multi-category keeps the classic look). Out of the editor for S3776. */
function PartRowView({
  row,
  index,
  card,
  conflict,
  removable,
  title,
  handlers,
  onLabel,
  onStandard,
  onTransfer,
  onAddCat,
}: Readonly<{
  row: Row;
  index: number;
  card: boolean;
  conflict: boolean;
  removable: boolean;
  title: string;
  handlers: EntryHandlers;
  onLabel: (index: number, label: string) => void;
  onStandard: (index: number) => void;
  onTransfer: (index: number) => void;
  onAddCat: (index: number) => void;
}>) {
  const { t } = useLang();
  // inside a card the part removes as a whole (header ×) — the main
  // entry itself never does; classic flat rows keep the row rule
  const mainEntry = (
    <EntryRow
      at={{ row: index, cat: 0 }}
      catId={row.catId}
      amount={row.amount}
      conflict={conflict}
      removable={!card && removable}
      linkedAccountId={row.linkedAccountId}
      {...handlers}
    />
  );
  if (!card) return mainEntry;
  const transferPart = !!row.txType && kindOf(row.txType) === 'transfer';
  return (
    <div className="flex flex-col gap-1.5 rounded-card border border-line bg-surface p-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <PartHeader row={row} index={index} title={title} onLabel={onLabel} onStandard={onStandard} onTransfer={onTransfer} />
        </div>
        {removable && (
          <button
            aria-label={t('action.delete')}
            data-testid={`split-remove-part-${index}`}
            onClick={() => handlers.onRemove({ row: index, cat: 0 })}
            className="m-tap border-none bg-transparent text-ink-4"
          >
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
      {mainEntry}
      {row.extraCats.map((entry, k) => (
        <EntryRow
          key={entry.key}
          at={{ row: index, cat: k + 1 }}
          catId={entry.catId}
          amount={entry.amount}
          conflict={conflict}
          removable
          {...handlers}
        />
      ))}
      {/* a transfer part's category is the locked movement sub — a
          spread across categories only makes sense for standard parts */}
      {!transferPart && (
        <button
          data-testid={`split-addcat-${index}`}
          onClick={() => onAddCat(index)}
          className="m-tap flex items-center gap-1.5 self-start border-none bg-transparent px-1 py-0.5 text-[12px] font-medium text-accent-deep"
        >
          <Icon name="plus" size={14} />
          {t('split.addRow')}
        </button>
      )}
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

// ── pure row transforms (module level for S2004: the setRows updaters
// stay one arrow deep) ──

/** rows with one entry (main or spread) patched at the address */
function patchRowsAt(rows: Row[], at: EntryAddress, patch: { catId?: string; amount?: string }): Row[] {
  return rows.map((row, i) => {
    if (i !== at.row) return row;
    if (at.cat === 0) return { ...row, ...patch };
    return { ...row, extraCats: row.extraCats.map((x, k) => (k === at.cat - 1 ? { ...x, ...patch } : x)) };
  });
}

/** part mode auto-balance: the remainder lands on the first EMPTY entry
 *  (the one being worked on, #130) — else the very last entry absorbs
 *  the correction, same "fix the tail" fallback the classic rows have */
function absorbIntoOpenEntry(rows: Row[], remainder: number): Row[] {
  // entries flattened row-major: the main entry then its spread entries
  const entries: { row: number; cat: number; cents: number }[] = [];
  rows.forEach((row, i) => {
    entries.push({ row: i, cat: 0, cents: parseCents(row.amount) ?? 0 });
    row.extraCats.forEach((x, k) => entries.push({ row: i, cat: k + 1, cents: parseCents(x.amount) ?? 0 }));
  });
  if (entries.length === 0) return rows;
  const target = entries[balanceTargetIndex(entries.map((e) => e.cents))];
  const next = toText(Math.max(0, target.cents + remainder));
  return rows.map((row, i) => {
    if (i !== target.row) return row;
    if (target.cat === 0) return { ...row, amount: next };
    return { ...row, extraCats: row.extraCats.map((x, k) => (k === target.cat - 1 ? { ...x, amount: next } : x)) };
  });
}

/** the addressed spread entry dropped from its row */
const dropExtraAt = (rows: Row[], at: EntryAddress): Row[] =>
  rows.map((row, i) => (i === at.row ? { ...row, extraCats: row.extraCats.filter((_, k) => k !== at.cat - 1) } : row));

/** a fresh uncategorized spread entry appended to one row (v2.1) */
const appendExtraAt = (rows: Row[], index: number, amount: string): Row[] =>
  rows.map((row, i) =>
    i === index ? { ...row, extraCats: [...row.extraCats, { key: newKey(), catId: UNCATEGORIZED_ID, amount }] } : row,
  );

/** the category pick applied at the address — the type pull (R3)
 *  follows the part's MAIN pick; spread entries refine the money,
 *  not the part's story */
function pickCatAt(rows: Row[], at: EntryAddress, catId: string): Row[] {
  return rows.map((row, i) => {
    if (i !== at.row) return row;
    if (at.cat === 0) return { ...row, catId, ...pulledTypePatch(row, catId) };
    return { ...row, extraCats: row.extraCats.map((e, k) => (k === at.cat - 1 ? { ...e, catId } : e)) };
  });
}

/** categories the OTHER entries already own — hidden in the picker; a
 *  split across "Rent" and "Rent" is never meaningful (user ss) */
function excludedCatIds(rows: Row[], pickerFor: EntryAddress | null): string[] | undefined {
  if (pickerFor === null) return undefined;
  const taken: string[] = [];
  rows.forEach((row, i) => {
    rowCatIds(row).forEach((catId, k) => {
      if (i === pickerFor.row && k === pickerFor.cat) return;
      if (catId !== UNCATEGORIZED_ID) taken.push(catId);
    });
  });
  return taken;
}

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
  valuesOnly = false,
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
  /** #126 v2 (review): the split as pure money — label + amount rows,
   *  exact or percentage; categories/kinds live on the part deck */
  valuesOnly?: boolean;
}>) {
  const { t } = useLang();
  const transform = useTxTransform();
  const { repo } = useData();
  const cats = useCategories();
  const [rows, setRows] = useState<Row[]>([]);
  const [mode, setMode] = useState<'amount' | 'pct'>('amount');
  // v2.1: plain multi-category (classic flat rows) vs typed PARTS with
  // labels, kinds and per-part category spreads — an explicit door
  const [partMode, setPartMode] = useState(false);
  const [pickerFor, setPickerFor] = useState<EntryAddress | null>(null);
  // which part is picking its counterparty (typed-splits v2)
  const [counterFor, setCounterFor] = useState<number | null>(null);
  // focusing an amount empties it so typing replaces instead of appending
  // (user request); blurring an untouched empty field restores the value
  const [focusStash, setFocusStash] = useState<{ at: EntryAddress; amount: string } | null>(null);
  // register-style entry for the focused amount (lib/amountRegister) —
  // one field is focused at a time, so one mode is enough
  const [entryMode, setEntryMode] = useState<AmountEntryMode>('register');

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
      // a stored part story (labels, kinds, spreads) reopens in part
      // mode; a plain category partition reopens classic (v2.1)
      setPartMode(hasTypedParts({ splits: source }));
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
      // review's unified editor (user redesign): open on JUST the current
      // category owning the full amount — rows are added explicitly
      setMode('amount');
      setPartMode(false);
      setRows([newRow(seedCatId ?? tx.catId ?? UNCATEGORIZED_ID, toText(Math.abs(referenceCents)))]);
    } else {
      setMode('amount');
      setPartMode(false);
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
      : rows.map((r) => rowToSplit(r, partMode));
  const remainder = mode === 'pct' ? pctRemainder(splits) : splitRemainderCents(referenceCents, splits);
  const error = sheetError({ mode, referenceCents, splits });

  const effectiveType = txType ?? tx.txType;
  // values-only: categories are invisible here — never block on them
  const rowConflicts = valuesOnly ? rows.map(() => false) : computeRowConflicts(rows, effectiveType, cats);
  const hasTypeConflict = rowConflicts.some(Boolean);

  // an empty or zero entry must be finished before ANOTHER one appears
  // (user request: + Add category waits for the current one)
  const entryUnfinished = (catId: string, amount: string) => {
    if (!valuesOnly && catId === UNCATEGORIZED_ID) return true;
    const value = mode === 'pct' ? parsePct(amount) : (parseCents(amount) ?? 0);
    return value <= 0;
  };
  const addBlocked = rows.some(
    (r) => entryUnfinished(r.catId, r.amount) || r.extraCats.some((x) => entryUnfinished(x.catId, x.amount)),
  );

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
    if (seedSingle && rows.length === 1 && !partMode) {
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
      // the still-open share lands on the row being worked on — the
      // first empty one — not blindly on the last (#130)
      setRows((r) => {
        const values = r.map((row) => parsePct(row.amount));
        const target = balanceTargetIndex(values);
        const open = 100 - values.reduce((sum, v, i) => (i === target ? sum : sum + v), 0);
        return r.map((row, i) => (i === target ? { ...row, amount: toPctText(Math.max(0, open)) } : row));
      });
      return;
    }
    if (partMode) {
      setRows((r) => absorbIntoOpenEntry(r, remainder));
      return;
    }
    setRows((r) => {
      const abs = r.map((row) => ({ catId: row.catId, amountCents: parseCents(row.amount) ?? 0 }));
      return balanceOpenRow(referenceCents, abs).map((s, i) => ({ ...r[i], catId: s.catId, amount: toText(s.amountCents) }));
    });
  };

  const patchEntry = (at: EntryAddress, patch: { catId?: string; amount?: string }) =>
    setRows((r) => patchRowsAt(r, at, patch));
  const entryAmount = (at: EntryAddress): string =>
    at.cat === 0 ? (rows[at.row]?.amount ?? '') : (rows[at.row]?.extraCats[at.cat - 1]?.amount ?? '');
  const setRowLabel = (index: number, label: string) =>
    setRows((r) => r.map((x, j) => (j === index ? { ...x, label } : x)));
  const removeEntry = (at: EntryAddress) => {
    if (at.cat > 0) {
      setRows((r) => dropExtraAt(r, at));
      return;
    }
    setRows((r) => r.filter((_, j) => j !== at.row));
  };
  // a new part takes the current remainder — the natural next slice
  // (user design: adding a split copies the info and offers what's left)
  const addRow = () => setRows((r) => [...r, newRow(UNCATEGORIZED_ID, addRowSeed(mode, remainder))]);
  // v2.1: a part spreads across one more category, seeded the same way
  const addCatToRow = (index: number) => setRows((r) => appendExtraAt(r, index, addRowSeed(mode, remainder)));

  /** Standard part: inherits the row's type, drops any counterparty —
   *  its old mint retires through the choke point at save */
  const setPartStandard = (index: number) =>
    setRows((r) => r.map((x, j) => (j === index ? { ...x, txType: undefined, linkedAccountId: undefined } : x)));
  const accountName = (id: string) => accountNameOf(accounts, id);

  const blurEntry = (at: EntryAddress) => {
    const stashed = focusStash?.at.row === at.row && focusStash?.at.cat === at.cat ? focusStash?.amount : undefined;
    const next = blurredAmount(entryAmount(at), stashed, mode === 'amount');
    if (next !== null) patchEntry(at, { amount: next });
    setFocusStash(null);
  };

  const entryHandlers: EntryHandlers = {
    cats,
    accountName,
    onPickCat: setPickerFor,
    onAmount: (at, raw) => {
      // register-style entry (user request): digits fill cents from the
      // right — euros only; percentages keep plain typing
      if (mode !== 'amount') {
        patchEntry(at, { amount: raw });
        return;
      }
      const next = nextAmountEntry(entryMode, entryAmount(at), raw);
      setEntryMode(next.mode);
      patchEntry(at, { amount: next.text });
    },
    onAmountFocus: (at) => {
      setFocusStash({ at, amount: entryAmount(at) });
      patchEntry(at, { amount: '' });
      // the field just emptied — the register is armed
      setEntryMode('register');
    },
    onAmountBlur: blurEntry,
    onRemove: removeEntry,
  };

  const pickedCatId = pickerFor === null ? undefined : rowCatIds(rows[pickerFor.row] ?? newRow(UNCATEGORIZED_ID, ''))[pickerFor.cat];

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
          {/* exact euros for one charge, percentages when the shape repeats
              — parts are always exact, so the choice hides behind the door */}
          {!partMode && (
            <div className="flex gap-1.5">
              <Chip className="flex-1" testId="split-mode-amount" selected={mode === 'amount'} onClick={() => switchMode('amount')}>
                {t('split.modeAmount')}
              </Chip>
              <Chip className="flex-1" testId="split-mode-pct" selected={mode === 'pct'} onClick={() => switchMode('pct')}>
                {t('split.modePct')}
              </Chip>
            </div>
          )}
          {rows.map((row, i) =>
            valuesOnly ? (
              <ValuesRow
                key={row.key}
                row={row}
                index={i}
                removable={rows.length > (seedSingle ? 1 : 2)}
                title={txTitle(tx)}
                onLabel={setRowLabel}
                handlers={entryHandlers}
              />
            ) : (
              <PartRowView
                key={row.key}
                row={row}
                index={i}
                card={partMode}
                conflict={rowConflicts[i]}
                removable={rows.length > (seedSingle ? 1 : 2)}
                title={txTitle(tx)}
                handlers={entryHandlers}
                onLabel={setRowLabel}
                onStandard={setPartStandard}
                onTransfer={setCounterFor}
                onAddCat={addCatToRow}
              />
            ),
          )}

          {/* finish the open row first (user request): no new row while
              one is still uncategorized or worth nothing */}
          <button
            data-testid="split-add-row"
            onClick={addRow}
            disabled={addBlocked}
            className="m-tap flex items-center gap-1.5 border-none bg-transparent px-1 py-1 text-[13px] font-medium text-accent-deep disabled:opacity-40"
          >
            <Icon name="plus" size={16} />
            {partMode || valuesOnly ? t('split.addPart') : t('split.addRow')}
          </button>

          {/* r4: typed parts are born in the VALUES flow (Split row →
              amounts → completion deck) — this editor stays the plain
              category partition; stored part stories still reopen here
              read-true via partMode */}

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
        selectedId={pickedCatId}
        excludeIds={excludedCatIds(rows, pickerFor)}
        onlyIds={allowedCatIds}
        onPick={(catId) => {
          if (pickerFor === null) return;
          setRows((r) => pickCatAt(r, pickerFor, catId));
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
