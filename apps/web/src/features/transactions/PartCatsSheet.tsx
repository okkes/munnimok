import { useEffect, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { fmtCents, parseCents } from '@/lib/money';
import { nextAmountEntry } from '@/lib/amountRegister';
import type { AmountEntryMode } from '@/lib/amountRegister';
import { REIMBURSED_ID, UNCATEGORIZED_ID, specialCatType } from '@/domain/categories';
import { defaultFamilyFor } from '@/domain/defaultAccounts';
import { counterTypesFor, movementCatFor, movementCatsForCounter } from '@/domain/txType';
import { kindOf } from '@/domain/txKind';
import { resolveSplitsFor } from '@/domain/splits';
import { useSpaceAccounts } from '@/application/transactions';
import type { DefaultFamily } from '@/application/defaultAccounts';
import { catName, useCategories } from '@/features/categories/useCategories';
import { CategoryPicker } from '@/features/categories/CategoryPicker';
import { CounterpartySheet } from './TxKindSheet';
import type { AccountType, TxSplit, TxSplitCat, TxType } from '@/db/types';
import { Button } from '@/ui/Button';
import { FormBlockerNote } from '@/ui/FormBlockerNote';
import { Icon } from '@/ui/Icon';
import { InfoHint } from '@/ui/InfoHint';
import { Chip } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';

/** link fields are SINGLE-entry only (#228): the lone entry's counterparty goes out to the caller */
interface CatEntry {
  key: string;
  catId: string;
  amount: string; // user-facing text in the mode's units, EU decimals
  linkedAccountId?: string;
  transferPeerId?: string;
}

export interface CatsApplyEntry extends TxSplitCat {
  linkedAccountId?: string;
  transferPeerId?: string;
}

// the ATM pair's ask pins the cash wallet (#546); every ask lists only the account types its category can mean
// Transfer's ask is mandatory: dismissing rolls back, a bare transfer is unrepresentable
function counterAskFor(catId: string): { defaultFamily?: DefaultFamily; counterTypes?: readonly AccountType[]; mandatory: boolean } | null {
  const family = specialCatType(catId);
  if (!family) return null;
  return {
    defaultFamily: defaultFamilyFor(catId) ?? undefined,
    counterTypes: counterTypesFor(catId),
    mandatory: family === 'transfer',
  };
}

const entryLink = (entry: Pick<CatEntry, 'linkedAccountId' | 'transferPeerId'>): Partial<CatsApplyEntry> => ({
  ...(entry.linkedAccountId ? { linkedAccountId: entry.linkedAccountId } : {}),
  ...(entry.transferPeerId ? { transferPeerId: entry.transferPeerId } : {}),
});

// a pick the linked counter can also mean keeps the link (credit card: transfer or debt payment);
// the peer rides (#218, #228)
function keepLinkPatch(
  prev: CatEntry | undefined,
  catId: string,
  accounts: readonly { id: string; type: AccountType }[] | undefined,
): Partial<CatEntry> | null {
  const counterType = accounts?.find((a) => a.id === prev?.linkedAccountId)?.type;
  if (!prev?.linkedAccountId || !counterType || !counterTypesFor(catId)?.includes(counterType)) return null;
  return { catId };
}

function counterNarrowFor(
  accounts: readonly { id: string; type: AccountType }[] | undefined,
  entry: CatEntry | undefined,
  direction: 'debit' | 'credit',
): string[] | undefined {
  const type = accounts?.find((a) => a.id === entry?.linkedAccountId)?.type;
  return type ? [...movementCatsForCounter(type, direction)] : undefined;
}

// an unstamped subject's derived transfer type must not gate the picker;
// stamps and adjustments keep their narrow lists (#218)
const pickerTxTypeFor = (askDisabled: boolean, txType: TxType | undefined): TxType | undefined =>
  !askDisabled && txType && kindOf(txType) === 'transfer' ? undefined : txType;

// detaching the counterparty resets the category: a special category and its counter are one story (#218, #228)
const detachPatch = (catId: string | undefined): Partial<CatEntry> => ({
  linkedAccountId: undefined,
  transferPeerId: undefined,
  ...(specialCatType(catId ?? '') ? { catId: UNCATEGORIZED_ID } : {}),
});

// the answered account's kind names the category; a Create-door kind mismatch refiles (#133, #218)
const answeredCatFor = (current: CatEntry | undefined, accountType: AccountType, sign: 1 | -1): string | undefined =>
  current && (current.catId === UNCATEGORIZED_ID || specialCatType(current.catId)) ? movementCatFor(accountType, sign) : undefined;

const remainderPill = (remainder: number) =>
  remainder > 0
    ? ({ tone: 'bg-warning-soft text-warning', key: 'split.remaining' } as const)
    : ({ tone: 'bg-negative-soft text-negative', key: 'split.over' } as const);

let entryCounter = 0;
const newKey = () => `pc${entryCounter++}`;
const toText = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
const toPctText = (pct: number) => String(pct).replace('.', ',');
const parsePct = (text: string): number => {
  const n = Number.parseFloat(text.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

// one entry collapses to a plain category; several keep the spread, largest entry as compat shadow; a spread clears the
// part-level link (#228); settled `reimbursed` entries always re-attach, only the reimbursement link removes them
export function catsPatch(entries: CatsApplyEntry[], settled: readonly TxSplitCat[] = []): Partial<TxSplit> {
  if (entries.length <= 1) {
    const catId = entries[0]?.catId ?? UNCATEGORIZED_ID;
    return {
      catId,
      cats: settled.length ? [{ catId, amountCents: entries[0]?.amountCents ?? 0 }, ...settled] : undefined,
    };
  }
  const primary = entries.reduce((best, entry) => (entry.amountCents > best.amountCents ? entry : best), entries[0]);
  return {
    catId: primary.catId,
    cats: [
      ...entries.map((entry) => ({ catId: entry.catId, amountCents: entry.amountCents, ...(entry.pct !== undefined ? { pct: entry.pct } : {}) })),
      ...settled,
    ],
    linkedAccountId: undefined,
    transferPeerId: undefined,
  };
}

export const settledEntriesOf = (cats: readonly TxSplitCat[] | undefined): TxSplitCat[] =>
  (cats ?? []).filter((c) => c.catId === REIMBURSED_ID).map((c) => ({ catId: c.catId, amountCents: c.amountCents }));

// the reimbursement's slice is never the counterparty doors' to drop (#228)
export const catsAroundSingle = (
  subject: { amountCents: number; cats?: TxSplitCat[] },
  catId: string,
): TxSplitCat[] | undefined => {
  const settled = settledEntriesOf(subject.cats);
  return settled.length ? [{ catId, amountCents: subjectNetCents(subject) }, ...settled] : undefined;
};

// a single special pick pulls the part's own type, an ordinary single pick clears a stale pulled one, spreads never pull;
// the single entry's counterparty is the part's own link (#228)
export function partCatsApplyPatch(slice: TxSplit | undefined, entries: CatsApplyEntry[]): Partial<TxSplit> {
  const patch = catsPatch(entries, settledEntriesOf(slice?.cats));
  if (entries.length !== 1) return patch;
  const entry = entries[0];
  const link = { linkedAccountId: entry.linkedAccountId, transferPeerId: entry.transferPeerId };
  const pulled = specialCatType(entry.catId);
  if (pulled) return { ...patch, ...link, txType: pulled };
  return slice?.txType && !slice.linkedAccountId ? { ...patch, ...link, txType: undefined } : { ...patch, ...link };
}

export interface CatsSubject {
  /** stable identity for the reseed effect (part id / tx id) */
  id?: string;
  label?: string;
  catId?: string;
  /** the FULL partition: settled `reimbursed` entries are pinned read-only, only the real ones are edited */
  cats?: TxSplitCat[];
  /** the subject's GROSS money; the sheet nets settled value before balancing */
  amountCents: number;
  /** the subject's ONE counterparty seeds the lone entry; a spread never carries it (#228) */
  linkedAccountId?: string;
  transferPeerId?: string;
}

const seedEntries = (subject: CatsSubject, pctMode: boolean): CatEntry[] => {
  const real = (subject.cats ?? []).filter((c) => c.catId !== REIMBURSED_ID);
  const base: TxSplitCat[] = real.length
    ? real
    : [{ catId: subject.catId ?? UNCATEGORIZED_ID, amountCents: subjectNetCents(subject) }];
  const single = base.length === 1;
  return base.map((entry) => ({
    key: newKey(),
    catId: entry.catId,
    amount: pctMode && entry.pct !== undefined ? toPctText(entry.pct) : toText(entry.amountCents),
    ...(single ? { linkedAccountId: subject.linkedAccountId, transferPeerId: subject.transferPeerId } : {}),
  }));
};

/** the gross minus settled bookkeeping, which belongs to the reimbursement link alone */
const subjectNetCents = (subject: Pick<CatsSubject, 'amountCents' | 'cats'>): number =>
  Math.max(
    0,
    Math.abs(subject.amountCents) - settledEntriesOf(subject.cats).reduce((sum, c) => sum + c.amountCents, 0),
  );

// a %-typed spread reopens in %; the settled `reimbursed` entry has no pct and must not flip it to amounts (#216)
const seedsAsPct = (subject: CatsSubject): boolean => {
  const real = (subject.cats ?? []).filter((entry) => entry.catId !== REIMBURSED_ID);
  return real.length > 0 && real.every((entry) => entry.pct != null);
};

// the one split-categories editor (#211); a split TRANSACTION uses a different editor. Only ONE special category per
// transaction, spanning the whole: a lone special pick asks its counterparty, a spread offers regular and
// reimbursement categories only (#228)
export function CatsSheet({
  open,
  onOpenChange,
  subject,
  currency,
  direction,
  txType,
  allowedCatIds,
  title,
  reason,
  includePct = false,
  excludeAccountId,
  askDisabled = false,
  anchor,
  onCreateCustomNav,
  counterPickAccounts,
  onApply,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subject?: CatsSubject;
  currency: string;
  direction: 'debit' | 'credit';
  /** gates the picker; undefined = direction-only (the add form) */
  txType?: TxType;
  allowedCatIds?: readonly string[];
  /** row-level callers say "Split categories"; parts keep their title */
  title?: string;
  reason?: string | null;
  /** row-level spreads keep their % shape for the #141 sibling offer */
  includePct?: boolean;
  excludeAccountId: string;
  /** R1: a stamped account's rows never ask (the stamp owns the story) */
  askDisabled?: boolean;
  /** the row being spread — enables the pick-existing fork on manual
   *  counterparties (row-level editors only; the lone entry anchors) */
  anchor?: { id: string; date: string };
  onCreateCustomNav?: () => void;
  /** #339 (user): pick-by-counter chips in the category picker — for
   *  "I know where the money went, not what to call it" (review) */
  counterPickAccounts?: readonly { id: string; name: string; type: AccountType }[];
  onApply: (entries: CatsApplyEntry[]) => void;
}>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const accounts = useSpaceAccounts();
  const [entries, setEntries] = useState<CatEntry[]>([]);
  const [mode, setMode] = useState<'amount' | 'pct'>('amount');
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  // a Transfer pick's ask is mandatory: dismissing it rolls back to the previous category
  // (an unlinked transfer is unrepresentable)
  const [counterFor, setCounterFor] = useState<number | null>(null);
  const rollbackRef = useRef<{ index: number; catId: string; linkedAccountId?: string; transferPeerId?: string } | null>(null);
  const [focusStash, setFocusStash] = useState<{ index: number; amount: string } | null>(null);
  const [entryMode, setEntryMode] = useState<AmountEntryMode>('register');
  // the pill's pointerdown runs before the focused field blurs: capture which field was meant (#130)
  const pendingTarget = useRef<number | null>(null);

  const settled = settledEntriesOf(subject?.cats);
  const refCents = subject ? subjectNetCents(subject) : 0;
  const [attempted, setAttempted] = useState(false);
  useEffect(() => {
    if (!open || !subject) return;
    const pctMode = includePct && seedsAsPct(subject);
    setMode(pctMode ? 'pct' : 'amount');
    setEntries(seedEntries(subject, pctMode));
    setCounterFor(null);
    setAttempted(false);
    rollbackRef.current = null;
    // deliberately only on open: the sheet owns its rows while open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, subject?.id]);

  const applyPick = (catId: string) => {
    if (pickerFor === null) return;
    const prev = entries[pickerFor];
    if (prev?.catId === catId) return;
    const kept = keepLinkPatch(prev, catId, accounts);
    if (kept) {
      patchEntry(pickerFor, kept);
      return;
    }
    // a NEW category starts a fresh story: the old entry's link never rides along
    patchEntry(pickerFor, { catId, linkedAccountId: undefined, transferPeerId: undefined });
    const ask = askDisabled || entries.length > 1 ? null : counterAskFor(catId);
    if (ask) {
      // dismissing a Transfer ask rolls the pick back; families and funding may stay bare
      rollbackRef.current = ask.mandatory
        ? { index: pickerFor, catId: prev?.catId ?? UNCATEGORIZED_ID, linkedAccountId: prev?.linkedAccountId, transferPeerId: prev?.transferPeerId }
        : null;
      setCounterFor(pickerFor);
    }
  };
  // a pick through a counter chip already names the counterparty and links at once (#339);
  // a stamped row's chips only narrow
  const applyPickWithCounter = (catId: string, accountId: string) => {
    if (pickerFor === null) return;
    if (askDisabled) {
      applyPick(catId);
      return;
    }
    patchEntry(pickerFor, { catId, linkedAccountId: accountId, transferPeerId: undefined });
  };
  const valueOf = (entry: CatEntry) => (mode === 'pct' ? parsePct(entry.amount) : (parseCents(entry.amount) ?? 0));
  const centsOf = (entry: CatEntry) => {
    if (entries.length === 1) return refCents;
    if (mode === 'pct') return Math.round((parsePct(entry.amount) / 100) * refCents);
    return parseCents(entry.amount) ?? 0;
  };
  const remainder = (mode === 'pct' ? 100 : refCents) - entries.reduce((sum, entry) => sum + valueOf(entry), 0);
  const unpicked = entries.some((entry) => entry.catId === UNCATEGORIZED_ID);
  const duplicate = new Set(entries.map((entry) => entry.catId)).size !== entries.length;
  // a Transfer without its counterparty is unrepresentable; the mandatory ask normally prevents it (#133)
  const transferUnlinked = entries.some(
    (entry) => specialCatType(entry.catId) === 'transfer' && !entry.linkedAccountId && !askDisabled,
  );
  // ONE entry means "just this category" and spans the whole: the add form has no amount yet
  const ready =
    (entries.length === 1
      ? !unpicked
      : entries.length > 0 && remainder === 0 && !unpicked && !duplicate && entries.every((entry) => valueOf(entry) > 0)) &&
    !transferUnlinked;
  // a special category spans the whole transaction: no rows join it, split the TRANSACTION to combine (#228)
  const specialClaims = entries.length === 1 && !!specialCatType(entries[0].catId);
  // no new row while one is uncategorized or worth nothing
  const addBlocked = specialClaims || entries.some((entry) => entry.catId === UNCATEGORIZED_ID || valueOf(entry) <= 0);

  const patchEntry = (index: number, patch: Partial<CatEntry>) =>
    setEntries((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

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
    // iOS WebKit stalls the caret when the value swaps in the same beat as focus: the field empties one frame later (#134)
    setEntryMode('register');
    const amount = entries[index]?.amount ?? '';
    requestAnimationFrame(() => {
      // another editable already took focus: stand down (a synthetic test focus leaves activeElement on body)
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
    // Done closes the sheet: in a real browser a lingering open sheet shields everything underneath
    const emit = (out: CatsApplyEntry[]) => {
      onApply(out);
      onOpenChange(false);
    };
    if (entries.length === 1) {
      emit([{ catId: entries[0].catId, amountCents: refCents, ...entryLink(entries[0]) }]);
      return;
    }
    if (mode === 'pct') {
      const resolved = resolveSplitsFor(
        refCents,
        entries.map((entry) => ({ catId: entry.catId, amountCents: 0, pct: parsePct(entry.amount) })),
      );
      emit(
        resolved.map((slice) => ({
          catId: slice.catId,
          amountCents: Math.abs(slice.amountCents),
          // the % shape survives on row spreads: pct scales to any sibling, exact euros only to exact twins (#141)
          ...(includePct && slice.pct !== undefined ? { pct: slice.pct } : {}),
        })),
      );
      return;
    }
    emit(entries.map((entry) => ({ catId: entry.catId, amountCents: parseCents(entry.amount) ?? 0 })));
  };

  const shownRemainder = mode === 'pct' ? `${remainder}%` : fmtCents(Math.abs(remainder), currency, lang);
  const pill = remainderPill(remainder);
  const sourceType = (accounts ?? []).find((a) => a.id === excludeAccountId)?.type;
  const pickerEntry = pickerFor === null ? undefined : entries[pickerFor];
  const pickedCatId = pickerEntry?.catId;
  // with a counterparty on the entry the picker narrows to what that counter can mean;
  // anything else needs the detach door (#218)
  const counterNarrowedIds = counterNarrowFor(accounts, pickerEntry, direction);
  const pickerTxType = pickerTxTypeFor(askDisabled, txType);
  const excluded = entries
    .filter((_, i) => i !== pickerFor)
    .map((entry) => entry.catId)
    .filter((catId) => catId !== UNCATEGORIZED_ID);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} title={title ?? t('split.partCatsTitle')} size="tall">
        {/* data-counter: a deterministic test signal that the lone entry's counterparty answer landed (#228) */}
        <div
          className="flex flex-col gap-2 pt-1"
          data-testid="part-cats-editor"
          data-counter={(entries.length === 1 ? entries[0].linkedAccountId : undefined) ?? ''}
        >
          {reason && (
            <div className="flex items-center gap-1.5 rounded-xl bg-bg-2 px-3 py-2 text-[12px] text-ink-3" data-testid="split-reason">
              <Icon name="lightbulb-outline" size={14} color="var(--m-ink-4)" />
              {reason}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 rounded-xl bg-bg-2 px-3 py-2 text-[12px] text-ink-3">
            <span className="min-w-0 truncate">{subject?.label ?? t('split.catsTitle')}</span>
            <span className="m-num shrink-0 font-semibold text-ink">{fmtCents(refCents, currency, lang)}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip className="flex-1" testId="part-cat-mode-amount" selected={mode === 'amount'} onClick={() => switchMode('amount')}>
              {t('split.modeAmount')}
            </Chip>
            <Chip className="flex-1" testId="part-cat-mode-pct" selected={mode === 'pct'} onClick={() => switchMode('pct')}>
              {t('split.modePct')}
            </Chip>
            <InfoHint text={t('split.modeHint')} testId="part-cat-mode-hint" />
          </div>
          {settled.map((entry, i) => (
            <div
              key={`settled-${entry.catId}-${entry.amountCents}`}
              data-testid={`part-cat-settled-${i}`}
              className="flex items-center gap-2 opacity-60"
            >
              <div className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-input border border-line bg-bg-2 px-3 text-[14px] text-ink-2">
                <Icon name={cats.byId(entry.catId).icon} size={17} color="var(--m-ink-4)" />
                <span className="min-w-0 flex-1 truncate">{catName(cats.byId(entry.catId), t)}</span>
                <Icon name="lock-outline" size={13} color="var(--m-ink-4)" />
              </div>
              <div className="m-num flex h-11 w-24 items-center justify-end rounded-input border border-line bg-bg-2 px-3 text-right text-[14px] text-ink-3">
                {toText(entry.amountCents)}
              </div>
            </div>
          ))}
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
          {specialClaims && (
            <p className="px-1 text-[12px] leading-snug text-ink-4" data-testid="part-cat-one-special">
              {t('split.oneSpecialHint')}
            </p>
          )}
          {remainder !== 0 && (
            <button
              data-testid="part-cat-remainder"
              onPointerDown={() => {
                pendingTarget.current = focusStash?.index ?? null;
              }}
              onClick={balance}
              className={`m-tap rounded-card border-none px-3 py-2 text-left text-[13px] ${pill.tone}`}
            >
              {t(pill.key, { amount: shownRemainder })}
            </button>
          )}
          {/* the remainder pill explains an unbalanced partition; the note covers the pill-less blocks */}
          <FormBlockerNote show={attempted && !ready && remainder === 0} text={t('form.fixErrors')} testId="part-cat-save-blocker" />
          <Button
            data-testid="part-cat-save"
            aria-invalid={attempted && !ready}
            onClick={() => {
              if (!ready) {
                setAttempted(true);
                return;
              }
              apply();
            }}
          >
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
        txType={pickerTxType}
        sourceAccountType={sourceType}
        selectedId={pickedCatId}
        excludeIds={excluded}
        onlyIds={allowedCatIds ?? counterNarrowedIds}
          onCreateCustomNav={onCreateCustomNav}
        noSpecials={entries.length > 1}
        // when the counter narrows the list, the picker offers the detach door in place (#322)
        onClearCounter={
          !allowedCatIds && counterNarrowedIds && pickerFor !== null
            ? () => {
                patchEntry(pickerFor, detachPatch(entries[pickerFor]?.catId));
                rollbackRef.current = null;
              }
            : undefined
        }
        // chips only where ONE story is told: a spread holds regular categories alone (#339)
        counterAccounts={entries.length > 1 ? undefined : counterPickAccounts}
        onPickWithCounter={applyPickWithCounter}
        onPick={applyPick}
        counterLinked={!!pickerEntry?.linkedAccountId}
      />
      <EntryCounterAsk
        counterFor={counterFor}
        setCounterFor={setCounterFor}
        entries={entries}
        patchEntry={patchEntry}
        rollbackRef={rollbackRef}
        askDisabled={askDisabled}
        excludeAccountId={excludeAccountId}
        direction={direction}
        anchor={anchor}
        centsOf={centsOf}
      />
    </>
  );
}

const signedCents = (direction: 'debit' | 'credit', cents: number): number => (direction === 'debit' ? -cents : cents);

function EntryCounterAsk({
  counterFor,
  setCounterFor,
  entries,
  patchEntry,
  rollbackRef,
  askDisabled,
  excludeAccountId,
  direction,
  anchor,
  centsOf,
}: Readonly<{
  counterFor: number | null;
  setCounterFor: (next: number | null) => void;
  entries: CatEntry[];
  patchEntry: (index: number, patch: Partial<CatEntry>) => void;
  rollbackRef: { current: { index: number; catId: string; linkedAccountId?: string; transferPeerId?: string } | null };
  askDisabled: boolean;
  excludeAccountId: string;
  direction: 'debit' | 'credit';
  anchor?: { id: string; date: string };
  centsOf: (entry: CatEntry) => number;
}>) {
  const counterEntry = counterFor === null ? undefined : entries[counterFor];
  const counterAsk = counterEntry && !askDisabled ? counterAskFor(counterEntry.catId) : null;
  return (
    <CounterpartySheet
      open={counterFor !== null}
      onOpenChange={(next) => {
        if (next) return;
        const rollback = rollbackRef.current;
        if (rollback) {
          patchEntry(rollback.index, {
            catId: rollback.catId,
            linkedAccountId: rollback.linkedAccountId,
            transferPeerId: rollback.transferPeerId,
          });
          rollbackRef.current = null;
        }
        setCounterFor(null);
      }}
      excludeAccountId={excludeAccountId}
      currentLinkedId={counterEntry?.linkedAccountId}
      amountCents={counterEntry ? signedCents(direction, centsOf(counterEntry)) : undefined}
      defaultFamily={counterAsk?.defaultFamily}
      counterTypes={counterAsk?.counterTypes}
      onDetach={
        counterEntry?.linkedAccountId
          ? () => {
              if (counterFor === null) return;
              patchEntry(counterFor, detachPatch(entries[counterFor]?.catId));
              rollbackRef.current = null;
            }
          : undefined
      }
      anchor={
        anchor && counterEntry
          ? {
              id: anchor.id,
              amountCents: signedCents(direction, centsOf(counterEntry)),
              date: anchor.date,
            }
          : undefined
      }
      onChoose={(account, peer) => {
        if (counterFor === null) return;
        const derived = answeredCatFor(entries[counterFor], account.type, direction === 'debit' ? -1 : 1);
        patchEntry(counterFor, {
          ...(derived ? { catId: derived } : {}),
          linkedAccountId: account.id,
          transferPeerId: peer?.txId,
        });
        rollbackRef.current = null;
      }}
    />
  );
}
