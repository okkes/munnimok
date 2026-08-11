import { useEffect, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { fmtCents, parseCents } from '@/lib/money';
import { nextAmountEntry } from '@/lib/amountRegister';
import type { AmountEntryMode } from '@/lib/amountRegister';
import { UNCATEGORIZED_ID, specialCatType } from '@/domain/categories';
import { resolveSplitsFor } from '@/domain/splits';
import { useSpaceAccounts } from '@/application/transactions';
import type { DefaultFamily } from '@/application/defaultAccounts';
import { catName, useCategories } from '@/features/categories/useCategories';
import { CategoryPicker } from '@/features/categories/CategoryPicker';
import { CounterpartySheet } from './TxKindSheet';
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
  /** #133 r4: the entry's own counterparty, picked the moment its ◆
   *  category lands (or seeded from storage) */
  linkedAccountId?: string;
  transferPeerId?: string;
}

/** #133 r4: does this category ask a counterparty, and which face of
 *  the sheet answers it? Families pin the Default pot, funding filters
 *  to funding attachments, transfer is the mandatory plain ask. */
function counterAskFor(catId: string): { defaultFamily?: DefaultFamily; fundingOnly: boolean; mandatory: boolean } | null {
  const family = specialCatType(catId);
  if (!family) return null;
  if (family === 'transfer') return { fundingOnly: false, mandatory: true };
  if (family === 'funding') return { fundingOnly: true, mandatory: false };
  return { defaultFamily: family as DefaultFamily, fundingOnly: false, mandatory: false };
}

/** the stored link fields an entry carries out of the editor */
const entryLink = (entry: Pick<CatEntry, 'linkedAccountId' | 'transferPeerId'>): Partial<TxSplitCat> => ({
  ...(entry.linkedAccountId ? { linkedAccountId: entry.linkedAccountId } : {}),
  ...(entry.transferPeerId ? { transferPeerId: entry.transferPeerId } : {}),
});

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
 *  the compat shadow (v2.1 storage rule). #133 r4: a multi-entry spread
 *  owns its counterparties PER ENTRY — the part-level link clears so no
 *  entry inherits a story that isn't its own. */
export function catsPatch(entries: TxSplitCat[]): Partial<TxSplit> {
  if (entries.length <= 1) return { catId: entries[0]?.catId ?? UNCATEGORIZED_ID, cats: undefined };
  const primary = entries.reduce((best, entry) => (entry.amountCents > best.amountCents ? entry : best), entries[0]);
  return { catId: primary.catId, cats: entries, linkedAccountId: undefined, transferPeerId: undefined };
}

/** the full apply for a part's category edit: the cats patch plus the R3
 *  type pull — a single ◆ special pick pulls the part's own type, an
 *  ordinary single pick clears a stale pulled one (a counterparty-backed
 *  transfer type stays deliberate). Spreads never pull. #133 r4: a
 *  single entry's counterparty (answered inside the editor) lands as the
 *  part's own link. */
export function partCatsApplyPatch(slice: TxSplit | undefined, entries: TxSplitCat[]): Partial<TxSplit> {
  const patch = catsPatch(entries);
  if (entries.length !== 1) return patch;
  const entry = entries[0];
  const link = entry.linkedAccountId
    ? { linkedAccountId: entry.linkedAccountId, transferPeerId: entry.transferPeerId }
    : {};
  const pulled = specialCatType(entry.catId);
  if (pulled) return { ...patch, ...link, txType: pulled };
  return slice?.txType && !slice.linkedAccountId ? { ...patch, ...link, txType: undefined } : { ...patch, ...link };
}

/** whose money the sheet spreads: a container PART or — #211 — the
 *  whole transaction itself; both carry the same category anatomy */
export interface CatsSubject {
  /** stable identity for the reseed effect (part id / tx id) */
  id?: string;
  label?: string;
  catId?: string;
  cats?: TxSplitCat[];
  /** the money being partitioned — for a row: NET of any settled value */
  amountCents: number;
  /** #133 r4: the owner's whole-story counterparty — seeds the single
   *  entry so its link shows and travels through a re-spread */
  linkedAccountId?: string;
  transferPeerId?: string;
}

const seedEntries = (subject: CatsSubject, pctMode: boolean): CatEntry[] =>
  (subject.cats?.length
    ? subject.cats
    : [
        {
          catId: subject.catId ?? UNCATEGORIZED_ID,
          amountCents: Math.abs(subject.amountCents),
          linkedAccountId: subject.linkedAccountId,
          transferPeerId: subject.transferPeerId,
        },
      ]
  ).map((entry) => ({
    key: newKey(),
    catId: entry.catId,
    amount: pctMode && entry.pct !== undefined ? toPctText(entry.pct) : toText(entry.amountCents),
    linkedAccountId: entry.linkedAccountId,
    transferPeerId: entry.transferPeerId,
  }));

/** a %-typed spread reopens in % — the stored pct is the user's shape */
const seedsAsPct = (subject: CatsSubject): boolean =>
  !!subject.cats?.length && subject.cats.every((entry) => entry.pct != null);

/**
 * #126 r6/r7 (user request): money spreads across categories with the
 * SAME editor logic the whole transaction had before splitting existed:
 * category + amount rows, exact euros or percentages, register-style
 * entry, and the leftover pill that fills the field it was tapped from
 * (#130). #211 made it THE split-categories editor — the row's own
 * spread and a part's spread are the same gesture; the split-transaction
 * editor is a different door entirely. #133 r4 (user): a ◆ pick asks its
 * counterparty ON THE SPOT, per entry — a spread can mix a saving leg to
 * one pot, a funding leg to another and plain spending side by side.
 */
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
  onApply,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** whose money is being spread; undefined while closed */
  subject?: CatsSubject;
  currency: string;
  direction: 'debit' | 'credit';
  /** gates the picker; undefined = direction-only (the add form) */
  txType?: TxType;
  allowedCatIds?: readonly string[];
  /** row-level callers say "Split categories"; parts keep their title */
  title?: string;
  /** why the current category was suggested (review) — shown inline */
  reason?: string | null;
  /** row-level spreads keep their % shape for the #141 sibling offer */
  includePct?: boolean;
  /** #133 r4: the owning account — its own rows never list as candidates */
  excludeAccountId: string;
  /** R1: a stamped account's rows never ask (the stamp owns the story) */
  askDisabled?: boolean;
  /** the row being spread — enables the pick-existing fork on manual
   *  counterparties (row-level editors only; the entry's amount anchors) */
  anchor?: { id: string; date: string };
  onApply: (entries: TxSplitCat[]) => void;
}>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const accounts = useSpaceAccounts();
  const [entries, setEntries] = useState<CatEntry[]>([]);
  const [mode, setMode] = useState<'amount' | 'pct'>('amount');
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  // #133 r4: which entry's counterparty question is open, and — on a ◆
  // Transfer pick — the category to roll back to if the ask is dismissed
  // (an unlinked transfer is unrepresentable, same rule as whole rows)
  const [counterFor, setCounterFor] = useState<number | null>(null);
  const rollbackRef = useRef<{ index: number; catId: string; linkedAccountId?: string; transferPeerId?: string } | null>(null);
  // focusing empties the field so typing replaces; blurring an untouched
  // empty field restores the stashed value (split-editor behavior)
  const [focusStash, setFocusStash] = useState<{ index: number; amount: string } | null>(null);
  const [entryMode, setEntryMode] = useState<AmountEntryMode>('register');
  // #130: the pill's pointerdown runs BEFORE the focused field blurs —
  // capture WHICH field the user meant here
  const pendingTarget = useRef<number | null>(null);

  const refCents = Math.abs(subject?.amountCents ?? 0);
  useEffect(() => {
    if (!open || !subject) return;
    const pctMode = includePct && seedsAsPct(subject);
    setMode(pctMode ? 'pct' : 'amount');
    setEntries(seedEntries(subject, pctMode));
    setCounterFor(null);
    rollbackRef.current = null;
    // deliberately only on open: the sheet owns its rows while open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, subject?.id]);

  const valueOf = (entry: CatEntry) => (mode === 'pct' ? parsePct(entry.amount) : (parseCents(entry.amount) ?? 0));
  /** the entry's share in CENTS — anchors the pick-existing fork */
  const centsOf = (entry: CatEntry) => {
    if (entries.length === 1) return refCents; // spans the whole
    if (mode === 'pct') return Math.round((parsePct(entry.amount) / 100) * refCents);
    return parseCents(entry.amount) ?? 0;
  };
  const remainder = (mode === 'pct' ? 100 : refCents) - entries.reduce((sum, entry) => sum + valueOf(entry), 0);
  const unpicked = entries.some((entry) => entry.catId === UNCATEGORIZED_ID);
  const duplicate = new Set(entries.map((entry) => entry.catId)).size !== entries.length;
  // #133 r4 safety net: a Transfer entry without its counterparty is
  // unrepresentable — the mandatory ask normally guarantees this
  const transferUnlinked = entries.some(
    (entry) => specialCatType(entry.catId) === 'transfer' && !entry.linkedAccountId && !askDisabled,
  );
  // ONE entry means "just this category" — it spans the whole by
  // definition (the add form has no amount yet, review parity keeps
  // the single pick one tap)
  const ready =
    (entries.length === 1
      ? !unpicked
      : entries.length > 0 && remainder === 0 && !unpicked && !duplicate && entries.every((entry) => valueOf(entry) > 0)) &&
    !transferUnlinked;
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
    // Done CLOSES the sheet (like every editor) — the callers only
    // stage/write; in a real browser a lingering open sheet would
    // shield everything underneath (the review-a2 CI catch)
    const emit = (out: TxSplitCat[]) => {
      onApply(out);
      onOpenChange(false);
    };
    // the single entry spans the whole — its typed amount is decorative
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
        resolved.map((slice, i) => ({
          catId: slice.catId,
          amountCents: Math.abs(slice.amountCents),
          // the % shape survives on row spreads (#141: pct scales to any
          // sibling; exact euros reach only exact twins)
          ...(includePct && slice.pct !== undefined ? { pct: slice.pct } : {}),
          ...entryLink(entries[i]),
        })),
      );
      return;
    }
    emit(entries.map((entry) => ({ catId: entry.catId, amountCents: parseCents(entry.amount) ?? 0, ...entryLink(entry) })));
  };

  const shownRemainder = mode === 'pct' ? `${remainder}%` : fmtCents(Math.abs(remainder), currency, lang);
  const pickedCatId = pickerFor === null ? undefined : entries[pickerFor]?.catId;
  const counterEntry = counterFor === null ? undefined : entries[counterFor];
  const counterAsk = counterEntry && !askDisabled ? counterAskFor(counterEntry.catId) : null;
  const excluded = entries
    .filter((_, i) => i !== pickerFor)
    .map((entry) => entry.catId)
    .filter((catId) => catId !== UNCATEGORIZED_ID);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} title={title ?? t('split.partCatsTitle')} size="tall">
        <div className="flex flex-col gap-2 pt-1" data-testid="part-cats-editor">
          {/* the prediction's provenance, shown in the open (review) */}
          {reason && (
            <div className="flex items-center gap-1.5 rounded-xl bg-bg-2 px-3 py-2 text-[12px] text-ink-3" data-testid="split-reason">
              <Icon name="lightbulb-outline" size={14} color="var(--m-ink-4)" />
              {reason}
            </div>
          )}
          {/* whose money is being spread */}
          <div className="flex items-center justify-between gap-2 rounded-xl bg-bg-2 px-3 py-2 text-[12px] text-ink-3">
            <span className="min-w-0 truncate">{subject?.label ?? t('split.catsTitle')}</span>
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
          {entries.map((entry, i) => {
            // #133 r4: a ◆ entry answers its counterparty right under its
            // own row — the ask opens on pick, this is the re-ask door
            const ask = askDisabled ? null : counterAskFor(entry.catId);
            const counterName = entry.linkedAccountId
              ? ((accounts ?? []).find((a) => a.id === entry.linkedAccountId)?.name ?? t('tx.counterparty'))
              : undefined;
            return (
              <div key={entry.key} className="flex flex-col">
                <div className="flex items-center gap-2">
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
                {(ask || entry.linkedAccountId) && (
                  <button
                    data-testid={`part-cat-counter-${i}`}
                    onClick={() => setCounterFor(i)}
                    className="m-tap ml-3 flex items-center gap-1.5 border-none bg-transparent px-1 py-1 text-left text-[12px]"
                  >
                    <Icon
                      name="bank-transfer"
                      size={14}
                      color={entry.linkedAccountId ? 'var(--m-accent-deep)' : 'var(--m-ink-4)'}
                    />
                    <span className={`truncate ${entry.linkedAccountId ? 'text-ink-2' : 'text-ink-4'}`}>
                      {counterName ?? t('split.chooseCounter')}
                    </span>
                    <Icon name="pencil-outline" size={11} color="var(--m-ink-4)" />
                  </button>
                )}
              </div>
            );
          })}
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
          if (pickerFor === null) return;
          const prev = entries[pickerFor];
          if (prev?.catId === catId) return;
          // a NEW category starts a fresh story — the old entry's link
          // never rides along; a ◆ pick asks its counterparty right away
          // (#133 r4, user: "before adding another category")
          patchEntry(pickerFor, { catId, linkedAccountId: undefined, transferPeerId: undefined });
          const ask = askDisabled ? null : counterAskFor(catId);
          if (ask) {
            // ◆ Transfer is mandatory: dismissing the ask rolls the pick
            // back; families and funding may stay bare (deliberate)
            rollbackRef.current = ask.mandatory
              ? { index: pickerFor, catId: prev?.catId ?? UNCATEGORIZED_ID, linkedAccountId: prev?.linkedAccountId, transferPeerId: prev?.transferPeerId }
              : null;
            setCounterFor(pickerFor);
          }
        }}
      />
      {/* #133 r4: the per-entry counterparty question — the same sheet
          every surface uses, scoped to ONE entry's money */}
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
        defaultFamily={counterAsk?.defaultFamily}
        fundingOnly={counterAsk?.fundingOnly ?? false}
        anchor={
          anchor && counterEntry
            ? {
                id: anchor.id,
                amountCents: direction === 'debit' ? -centsOf(counterEntry) : centsOf(counterEntry),
                date: anchor.date,
              }
            : undefined
        }
        onChoose={(account, peer) => {
          if (counterFor !== null) patchEntry(counterFor, { linkedAccountId: account.id, transferPeerId: peer?.txId });
          rollbackRef.current = null;
        }}
      />
    </>
  );
}
