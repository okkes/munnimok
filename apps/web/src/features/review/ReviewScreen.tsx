import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@/db/useQuery';
import { useSpaceAccounts, useSpaceTransactions, useTxTransform } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { buildSpaceMerchantMemory } from '@/application/prediction';
import { useRecurringOps, useRecurrings } from '@/application/recurring';
import { useEvents } from '@/application/events';
import { EventFormSheet } from '@/features/events/EventsScreen';
import { RecurringFormSheet, formFromTx } from '@/features/recurring/RecurringFormSheet';
import { merchantKey } from '@/domain/merchantKey';
import { draftReady, initDraft, withCategory, withCats, withKind, withLinkedAccount, withSplits, withType } from '@/domain/reviewDraft';
import { kindOf, standardTypeFor } from '@/domain/txKind';
import { EXPECTED_REIMBURSE_ID, RECEIVED_REIMBURSE_ID, REIMBURSED_ID, UNCATEGORIZED_ID, isMovementCat, specialCatType } from '@/domain/categories';
import { accountStamp, counterTypesFor, movementCatFor } from '@/domain/txType';
import { partNetCents } from '@/domain/reimbursement';
import { defaultFamilyFor } from '@/domain/defaultAccounts';
import { ensureDefaultAccount } from '@/application/defaultAccounts';
import type { DefaultFamily } from '@/application/defaultAccounts';
import { normalizeIban } from '@/domain/feedIds';
import { isPaypalAccount, isPaypalFunding } from '@/domain/paypal';
import { hapticNotify } from '@/lib/platform';
import { TxRow } from '@/ui/TxRow';
import { fetchSettlementCandidates } from '@/features/splits/settlementCandidates';
import type { SettlementCandidate } from '@/features/splits/settlementCandidates';
import { useSession } from '@/app/session';
import type { DraftCatalog, ReviewDraft } from '@/domain/reviewDraft';
import type { AccountType, RecurringRow, TxSplit, TxSplitCat, TxType } from '@/db/types';
import { resolveSplitsFor, splitsArePct } from '@/domain/splits';
import { predictTx } from '@/domain/predictCategory';
import { recurringAmountMatches } from '@/domain/recurring';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { logActivity } from '@/application/activity';
import { catName, useCategories } from '@/features/categories/useCategories';
import { fmtCents } from '@/lib/money';
import { cleanBankText, orDefaultLabel, txTitle } from '@/lib/text';
import { HelpButton } from '@/features/help/HelpButton';
import { IntroCard } from '@/features/help/IntroCard';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { SplitEditorSheet } from '@/features/transactions/SplitEditorSheet';
import { CatsSheet, catsAroundSingle, partCatsApplyPatch } from '@/features/transactions/PartCatsSheet';
import type { CatsApplyEntry } from '@/features/transactions/PartCatsSheet';
import { RecurringVisual, cadenceLabel } from '@/features/recurring/RecurringVisual';
import { TX_TYPE_VISUAL } from '@/features/transactions/TxTypeSheet';
import { CounterpartySheet } from '@/features/transactions/TxKindSheet';

/** one grouped-context row inside the category editor (counterparty,
 *  type) — the card-row anatomy in the sheet's input skin */
/** why the shown category was suggested, per prediction source */
const REASON_KEYS = {
  history: 'review.reasonHistory',
  'history-amount': 'review.reasonAmount',
  keyword: 'review.reasonKeyword',
} as const;

/** #228 feedback: the card Counterparty row's two doors — tap opens the
 *  ask (narrowed by the staged category), detach resets the pick (the
 *  counterparty and the category are one fact). Module-level for S3776. */
function buildCounterRowDoors(args: {
  draft: ReviewDraft | null;
  locked: boolean;
  amountCents: number | undefined;
  cats: DraftCatalog;
  setCounterAskCat: (v: string | null) => void;
  counterFallback: { current: ReviewDraft | null };
  setCounterOpen: (v: boolean) => void;
  counterChosen: { current: boolean };
  setStagedDraft: (d: ReviewDraft) => void;
}): { onEdit?: () => void; onDetach?: () => void } {
  const { draft } = args;
  if (!draft || args.locked) return {};
  const onEdit = () => {
    args.setCounterAskCat(draft.catId && specialCatType(draft.catId) ? draft.catId : null);
    args.counterFallback.current = null;
    args.setCounterOpen(true);
  };
  const onDetach = draft.linkedAccountId
    ? () => {
        args.counterChosen.current = true;
        args.setStagedDraft({ ...withKind(draft, 'standard', args.amountCents ?? 0, args.cats), catId: undefined });
      }
    : undefined;
  return { onEdit, onDetach };
}

/** render-time reset when the card underneath changes (prev-id ref pattern) */
function useFreshCardReset(txId: string | undefined, reset: () => void) {
  const lastTxId = useRef(txId);
  if (txId !== lastTxId.current) {
    lastTxId.current = txId;
    reset();
  }
}

/** progress bar + "n / total" sub line — skips count as handled too */
function progressState(initial: number | null, queueLen: number | undefined, skippedCount: number) {
  const total = initial ?? 1;
  const confirmed = initial === null ? 0 : Math.max(0, initial - (queueLen ?? 0));
  const done = confirmed + skippedCount;
  return {
    progress: initial ? done / initial : 0,
    sub: (queueLen ?? 0) > 0 ? `${Math.min(done + 1, total)} / ${total}` : undefined,
  };
}

/** the draft's value, an explicit null to clear a tx that had one, or nothing */
function replacing<K extends string, T>(key: K, next: T | undefined, had: boolean): Partial<Record<K, T>> {
  if (next !== undefined) return { [key]: next } as Partial<Record<K, T>>;
  // explicit null clears the synced field (undefined would be dropped)
  return had ? ({ [key]: null } as unknown as Partial<Record<K, T>>) : {};
}

/** one confirm: the whole DRAFT lands in one write (+ the bulk selection) */
async function writeConfirmation(args: {
  tx: SpaceTx;
  draft: ReviewDraft;
  recurringId: string | undefined;
  eventId: string | undefined;
  bulk: SpaceTx[];
  transform: ReturnType<typeof useTxTransform>;
  /** #221: "confirms the category + default account" — a bare movement
   *  draft links the space's default in the SAME write, so the choke
   *  mints the counter leg right here */
  defaultLinkId?: string;
}): Promise<void> {
  const { draft } = args;
  // draft-cleared fields on a tx that HAD them need an explicit null —
  // and a landed SPLIT always writes cats null: the explicit field
  // version-stamps the container so its parts never read as legacy
  // slices on a fresh device (#211)
  const splitsField = replacing('splits', draft.splits?.length ? draft.splits : undefined, !!args.tx.splits?.length);
  const draftCatEntries = draft.cats?.length ? draft.cats : undefined;
  const catsField = draft.splits?.length
    ? { cats: null as never }
    : replacing('cats', draftCatEntries, !!args.tx.cats?.length);
  const linkField = replacing('linkedAccountId', draft.linkedAccountId ?? args.defaultLinkId, !!args.tx.linkedAccountId);
  await args.transform(args.tx, {
    catId: draft.catId,
    txType: draft.txType,
    needsReview: 0,
    ...splitsField,
    ...catsField,
    ...linkField,
    ...(args.recurringId ? { recurringId: args.recurringId } : {}),
    ...(args.eventId ? { eventId: args.eventId } : {}),
  }, null); // confirm logs its own richer 'review' line (with bulk count)
  for (const item of args.bulk) {
    await args.transform(item, bulkFieldsFor(item, draft, args.recurringId, args.eventId, args.defaultLinkId), null);
  }
}

/** #211: the sibling's copy of a category spread — % entries rescale to
 *  its amount, exact euros only travel when the sum still fits (the
 *  similar-rule pre-filters exact twins; this guards drift) */
function catsForSibling(item: SpaceTx, entries: TxSplitCat[]): TxSplitCat[] | undefined {
  if (entries.every((e) => e.pct != null)) {
    const resolved = resolveSplitsFor(item.amountCents, entries.map((e) => ({ catId: e.catId, amountCents: 0, pct: e.pct })));
    return resolved.map((s) => ({ catId: s.catId, amountCents: Math.abs(s.amountCents), ...(s.pct !== undefined ? { pct: s.pct } : {}) }));
  }
  const sum = entries.reduce((total, e) => total + e.amountCents, 0);
  return sum === Math.abs(item.amountCents) ? entries.map((e) => ({ catId: e.catId, amountCents: e.amountCents })) : undefined;
}

/** the WHOLE decision rides to every selected sibling (user rule):
 *  category, type, counterparty, recurring, event. Absolute splits fit
 *  exact twins by the similar-rule, pct splits rescale per item — and
 *  sign-bound standard types re-derive by the sibling's OWN sign (the
 *  similar filter already keeps signs together; this guards any path
 *  that doesn't). A partition travels whole: parts clear a sibling's
 *  spread and vice versa (#211 — the two never mix on one row). */
function bulkFieldsFor(item: SpaceTx, draft: ReviewDraft, recurringId: string | undefined, eventId: string | undefined, defaultLinkId?: string) {
  const splits = draft.splits?.length ? resolveSplitsFor(item.amountCents, draft.splits) : undefined;
  const catEntries = !splits && draft.cats?.length ? catsForSibling(item, draft.cats) : undefined;
  const siblingType = kindOf(draft.txType) === 'standard' ? standardTypeFor(item.amountCents) : draft.txType;
  const linkedId = draft.linkedAccountId ?? defaultLinkId;
  return {
    catId: draft.catId,
    txType: siblingType,
    needsReview: 0 as const,
    ...(splits ? { splits, cats: null as never } : {}),
    ...(catEntries ? { cats: catEntries, ...(item.splits?.length ? { splits: null as never } : {}) } : {}),
    ...(linkedId ? { linkedAccountId: linkedId } : {}),
    ...(recurringId ? { recurringId } : {}),
    ...(eventId ? { eventId } : {}),
  };
}

/** "also apply to n similar": a compact summary row on the card; the full
 *  list lives in a Sheet so long histories never squeeze the card
 *  (user request), with per-row read-only detail expansion */
/** an incoming settlement is money from a PERSON, not one of your
 *  accounts — R2 makes transfer strictly account-to-account, and the
 *  old ruling already said outside money is standard. The app's own
 *  concept for money-back-from-people is the received reimbursement. */
function stageAsSettlement(draft: ReviewDraft, cats: ReturnType<typeof useCategories>): ReviewDraft {
  return withCategory(withType({ ...draft, linkedAccountId: undefined }, 'income', cats), RECEIVED_REIMBURSE_ID, cats);
}

// CardCounterRow retired (#219, user): the counterparty is a CATEGORY
// fact now — the card's category rows carry "→ account"; the raw bank
// counterparty is transaction metadata, shown on the detail's Details
// block. No transaction-level counter row, no transaction-level editing.

/** the part a numbered picker/sheet is aimed at (S3776: out of the deck) */
const partAt = (parts: readonly TxSplit[], index: number | null): TxSplit | undefined =>
  index === null ? undefined : parts[index];

/** r8: the tapped card GROWS out of its slot to the front while the old
 *  active SHRINKS back into its own slot — FLIP on the real elements,
 *  nothing reorders. Module-level for S3776; animate/rects are optional
 *  (jsdom has neither). */
function playDeckFlip(
  flip: { tappedRect: DOMRect; activeRect: DOMRect },
  card: HTMLElement | null,
  oldStrip: HTMLElement | undefined,
): void {
  const ease = 'cubic-bezier(0.32, 0.72, 0, 1)';
  const travel = (el: HTMLElement | null | undefined, from: DOMRect) => {
    if (!el) return;
    const to = el.getBoundingClientRect();
    if (!to.width || !to.height) return;
    el.animate?.(
      [
        {
          transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`,
          transformOrigin: 'top left',
          opacity: 0.85,
        },
        { transform: 'none', transformOrigin: 'top left', opacity: 1 },
      ],
      { duration: 220, easing: ease },
    );
  };
  travel(card, flip.tappedRect);
  travel(oldStrip, flip.activeRect);
}

/** does this draft stage a REAL split (2+ parts beyond the settled slice)? */
const multiPartSplits = (draft: ReviewDraft | null): boolean =>
  (draft?.splits ?? []).filter((s) => s.catId !== REIMBURSED_ID).length > 1;

// deckActiveFaces retired (#217/#220): the expanded part renders one
// row PER category entry now — the summary faces and the part-level
// counter/kind sub have no reader left.

/** one slice's story lines (#126): the typed part's label/own type and
 *  a spread part's category list — shared by the card summary region
 *  and the stacked part cards */
function sliceStory(
  slice: TxSplit,
  index: number,
  splits: readonly TxSplit[] | undefined,
  rowType: TxType | undefined,
  cats: ReturnType<typeof useCategories>,
  t: ReturnType<typeof useLang>['t'],
): { label?: string; type?: TxType; spread?: string } {
  // #211: splits mean parts, full stop — every real split wears labels
  const typed = (splits?.length ?? 0) > 1;
  return {
    label: typed ? (slice.label ?? t('split.partN', { n: index + 1 })) : undefined,
    type: slice.txType && slice.txType !== rowType ? slice.txType : undefined,
    spread: slice.cats?.length ? slice.cats.map((c) => catName(cats.byId(c.catId), t)).join(' · ') : undefined,
  };
}

/** the card's category region (#126 redesign): a single category row
 *  when the draft is whole; a compact "Split transaction · N parts"
 *  summary when it's split — the parts themselves stand as stacked
 *  cards UNDER the main card. The settled Reimbursed slice is not a
 *  part and keeps its own row either way. A visible "Split" row ends
 *  the old hide-out under the category pencil. */
function CardCategoryRows({
  draft,
  fallbackCat,
  fallbackColor,
  currency,
  onOpenCategories,
  onOpenSplit,
  onEditCounter,
}: Readonly<{
  draft: ReviewDraft | null;
  fallbackCat: ReturnType<ReturnType<typeof useCategories>['byId']>;
  fallbackColor: string | undefined;
  currency: string;
  /** the classic per-slice category editor (the chip's door) */
  onOpenCategories: () => void;
  /** the values-only split editor (#126 v2 — pure money partition) */
  onOpenSplit: () => void;
  /** #228 feedback: the card's own Counterparty row — counter-first
   *  stages the special category; absent = the row hides */
  onEditCounter?: () => void;
}>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const accounts = useSpaceAccounts();
  const slices = draft?.splits ?? [];
  const parts = slices.filter((s) => s.catId !== REIMBURSED_ID);
  // #211: the row's own category spread — several categories, ONE
  // transaction; the settled `reimbursed` entry renders wherever it lives
  const spreadEntries = (draft?.cats ?? []).filter((e) => e.catId !== REIMBURSED_ID);
  const settled = [...slices, ...(draft?.cats ?? [])].filter((s) => s.catId === REIMBURSED_ID);
  const multi = parts.length > 1;
  const single = parts.length === 1 ? parts[0] : null;
  const singleCat = single ? cats.byId(single.catId) : fallbackCat;
  const singleColor = single ? (singleCat.color ?? cats.byId(singleCat.parentId ?? '').color) : fallbackColor;
  const spread = single ? sliceStory(single, 0, slices, draft?.txType, cats, t).spread : undefined;
  const catRow = (catId: string, amountCents: number, key: string) => (
    <button
      key={key}
      data-testid={`review-cat-${catId}`}
      onClick={onOpenCategories}
      className="m-tap flex w-full items-center gap-2.5 border-none bg-transparent px-4 py-2.5 text-left text-[14px] font-medium text-ink"
    >
      <Icon
        name={cats.byId(catId).icon}
        size={18}
        color={cats.byId(catId).color ?? cats.byId(cats.byId(catId).parentId ?? '').color ?? 'var(--m-ink-3)'}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{catName(cats.byId(catId), t)}</span>
      </span>
      <span className="m-num text-[12px] text-ink-2">{fmtCents(amountCents, currency, lang)}</span>
      <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />
    </button>
  );
  return (
    <>
      {/* multi-part (#126 r3): the main card says nothing the parts
          already say — the deck under it carries every story. #228: a
          spread's rows are regular categories — no counter sublines */}
      {!multi &&
        spreadEntries.length > 1 &&
        spreadEntries.map((entry, i) => catRow(entry.catId, entry.amountCents, `${entry.catId}-${i}`))}
      {!multi && spreadEntries.length <= 1 && (
        <button
          data-testid={single ? `review-cat-${single.catId}` : 'review-category-chip'}
          onClick={onOpenCategories}
          className="m-tap flex w-full items-center gap-2.5 border-none bg-transparent px-4 py-2.5 text-left text-[14px] font-medium text-ink"
        >
          <Icon name={singleCat.icon} size={18} color={singleColor ?? 'var(--m-ink-3)'} />
          <span className="min-w-0 flex-1 truncate">
            {single || draft?.catId ? (
              <>
                {catName(singleCat, t)}
                {/* the parent gives the sub its context (user request) */}
                {singleCat.parentId && (
                  <span className="text-[12px] font-normal text-ink-4"> · {catName(cats.byId(singleCat.parentId), t)}</span>
                )}
                {spread && <span className="block truncate text-[11px] font-normal text-ink-4">{spread}</span>}
              </>
            ) : (
              t('review.pickPrompt')
            )}
          </span>
          {single && <span className="m-num text-[12px] text-ink-2">{fmtCents(single.amountCents, currency, lang)}</span>}
          <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />
        </button>
      )}
      {/* the split door, in the open (#126) */}
      {!multi && (
        <button
          data-testid="review-split-row"
          onClick={onOpenSplit}
          className="m-tap flex w-full items-center gap-2.5 border-none bg-transparent px-4 py-2.5 text-left text-[14px] text-ink"
        >
          <Icon name="call-split" size={18} color="var(--m-ink-3)" />
          <span className="min-w-0 flex-1 truncate">{t('split.title')}</span>
          <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />
        </button>
      )}
      {/* #228 feedback (user ss): the counterparty is the card's own
          row — counter-first picks the special category automatically,
          removal resets the category (same doors as the detail screen) */}
      {!multi && onEditCounter && (
        <button
          data-testid="review-counter-row"
          onClick={onEditCounter}
          className="m-tap flex w-full items-center gap-2.5 border-none bg-transparent px-4 py-2.5 text-left text-[14px] text-ink"
        >
          <Icon name="bank-transfer" size={18} color="var(--m-ink-3)" />
          <span className={`min-w-0 flex-1 truncate ${draft?.linkedAccountId ? '' : 'text-ink-4'}`}>
            {(accounts ?? []).find((a) => a.id === draft?.linkedAccountId)?.name ?? t('tx.counterNone')}
          </span>
          <span className="text-[11px] text-ink-4">{t('tx.counterAccount')}</span>
          <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />
        </button>
      )}
      {settled.map((slice) => catRow(slice.catId, slice.amountCents, `settled-${slice.catId}`))}
    </>
  );
}

/** the split, made physical (#126 v2, wallet-deck design from the
 *  user's reference): each part is a card in a deck — ONE stands
 *  expanded with every fact editable in place (label, kind +
 *  counterparty, category, event; the amount opens the values editor,
 *  since amounts are a partition), the rest collapse to slim headers a
 *  tap re-expands. A ghost card grows the split. */
export function ReviewPartDeck({
  splits,
  rowType,
  tx,
  activeEvents,
  allowedCatIds,
  lockedKind = false,
  recurrings,
  attention = false,
  onOpenValues,
  onSplits,
}: Readonly<{
  /** the split being told — a staged draft's or a stored row's */
  splits: readonly TxSplit[] | undefined;
  /** the container's type: what untyped parts inherit */
  rowType: TxType;
  tx: SpaceTx;
  activeEvents: readonly { id: string; name: string; icon?: string }[];
  allowedCatIds?: readonly string[];
  /** R1: a stamped account types every row — parts included */
  lockedKind?: boolean;
  /** r7: parts link recurring costs like whole transactions do */
  recurrings: readonly { id: string; name: string }[];
  /** r7: a refused Confirm/Apply marks the parts that still need work */
  attention?: boolean;
  onOpenValues: () => void;
  onSplits: (next: TxSplit[]) => void;
}>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const accounts = useSpaceAccounts();
  const [expanded, setExpanded] = useState(0);
  // #228 feedback: the part card's own Counterparty row — which part's
  // counter door is open (counter-first picks its category)
  const [counterForIdx, setCounterForIdx] = useState<number | null>(null);
  const [eventFor, setEventFor] = useState<number | null>(null);
  // r7: which part is linking a recurring cost
  const [recFor, setRecFor] = useState<number | null>(null);
  // r6/r7: which part is editing its categories (THE category door —
  // the same amounts/percentages editor whole transactions use)
  const [spreadFor, setSpreadFor] = useState<number | null>(null);
  // r8 (user request): the WHOLE card travels — the tapped one rises out
  // of its slot to the front while the old active shrinks back into its
  // own slot; nothing else reorders. Classic FLIP on the real elements.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const stripRefs = useRef(new Map<number, HTMLElement>());
  const flipRef = useRef<{ tappedRect: DOMRect; activeRect: DOMRect; prevIdx: number } | null>(null);
  const slices = splits ?? [];
  const parts = slices.filter((s) => s.catId !== REIMBURSED_ID);
  const openIdx = Math.min(expanded, parts.length - 1);
  useLayoutEffect(() => {
    const flip = flipRef.current;
    flipRef.current = null;
    if (!flip) return;
    playDeckFlip(flip, cardRef.current, stripRefs.current.get(flip.prevIdx));
  }, [openIdx]);
  if (parts.length <= 1) return null;

  // r7 (user rule): NO restriction on a split beyond the amounts — every
  // patch lands; incompleteness is the attention badges' job
  const patchPart = (index: number, patch: Partial<TxSplit>) => {
    const target = parts[index];
    onSplits(slices.map((s) => (s === target ? { ...s, ...patch } : s)));
  };
  const counterPart = counterForIdx === null ? undefined : parts[counterForIdx];
  const partLabel = (slice: TxSplit, i: number) =>
    orDefaultLabel(slice.label, `${txTitle(tx)} – ${t('split.partN', { n: i + 1 })}`);
  const swapTo = (i: number) => {
    if (i === openIdx) return;
    const strip = stripRefs.current.get(i);
    if (strip && cardRef.current) {
      flipRef.current = {
        tappedRect: strip.getBoundingClientRect(),
        activeRect: cardRef.current.getBoundingClientRect(),
        prevIdx: openIdx,
      };
    }
    setExpanded(i);
  };

  const active = parts[openIdx];
  // #228: settled bookkeeping is not an editable category row here
  const activeRealCats = (active.cats ?? []).filter((c) => c.catId !== REIMBURSED_ID);
  const activeEventFace = activeEvents.find((event) => event.id === active.eventId)?.name ?? t('events.linkNone');
  const activeRecFace = recurrings.find((rec) => rec.id === active.recurringId)?.name ?? t('recurring.linkNone');
  const peeking = parts.map((slice, i) => ({ slice, i })).filter(({ i }) => i !== openIdx);
  const deckDirection: 'debit' | 'credit' = tx.amountCents < 0 ? 'debit' : 'credit';
  const needsAttention = (slice: TxSplit) => attention && slice.catId === UNCATEGORIZED_ID;

  return (
    <div className="mt-3" data-testid="review-part-deck">
      {/* r5 (user illustration): the section header owns the manage door */}
      <div className="flex items-center justify-between px-1">
        <span className="flex items-center gap-2 text-[14px] font-semibold text-ink">
          <Icon name="call-split" size={17} color="var(--m-accent-deep)" />
          {t('split.title')}
        </span>
        <button
          data-testid="review-manage-splits"
          onClick={onOpenValues}
          className="m-tap flex items-center gap-1.5 rounded-card border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-accent-deep"
        >
          <Icon name="tune" size={14} />
          {t('review.manageSplits')}
        </button>
      </div>
      <div className="mt-1 flex items-center gap-1.5 px-1 text-[11px] text-ink-4">
        <Icon name="layers-outline" size={13} color="var(--m-ink-4)" />
        {t('review.splitsCount', { n: parts.length })}
      </div>

      {/* the deck: the other parts peek from behind — tap one to bring
          it on top; the active card carries every fact */}
      <div className="mt-2">
        {peeking.map(({ slice, i }) => {
          const sliceCat = cats.byId(slice.catId);
          return (
            <button
              key={slice.id ?? `p${i}`}
              ref={(el) => {
                if (el) stripRefs.current.set(i, el);
                else stripRefs.current.delete(i);
              }}
              data-testid={`deck-part-${i}`}
              onClick={() => swapTo(i)}
              className="m-tap -mb-1.5 flex w-full items-center gap-2.5 rounded-t-card border border-line bg-surface px-4 pt-2 pb-3.5 text-left opacity-90"
            >
              <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg-2 text-[11px] font-semibold text-ink-3">
                {i + 1}
                {needsAttention(slice) && (
                  <span
                    data-testid={`deck-attn-${i}`}
                    className="absolute -top-1 -right-1 flex h-3 w-3 items-center justify-center rounded-full bg-negative text-[8px] font-bold text-white"
                  >
                    !
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                {partLabel(slice, i)}
                <span className="text-[11px] font-normal text-ink-4"> · {catName(sliceCat, t)}</span>
              </span>
              <span className="m-num text-[12px] text-ink-2">{fmtCents(slice.amountCents, tx.currency, lang)}</span>
            </button>
          );
        })}
        <div
          key={active.id ?? `p${openIdx}`}
          ref={cardRef}
          data-testid={`deck-part-${openIdx}`}
          className="relative rounded-card border-2 border-accent-deep bg-surface shadow-[0_8px_20px_rgba(0,0,0,0.10)]"
        >
          <div className="flex items-center gap-2 px-3 pt-3 pb-1">
            <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-deep text-[12px] font-semibold text-white">
              {openIdx + 1}
              {needsAttention(active) && (
                <span
                  data-testid={`deck-attn-${openIdx}`}
                  className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-negative text-[9px] font-bold text-white"
                >
                  !
                </span>
              )}
            </span>
            <input
              data-testid={`deck-label-${openIdx}`}
              value={active.label ?? ''}
              placeholder={partLabel(active, openIdx)}
              onChange={(e) => patchPart(openIdx, { label: e.target.value || undefined })}
              // r8 (user rule): a label must SAY something — whitespace-only
              // settles back to the derived default on blur
              onBlur={(e) => {
                const trimmed = e.target.value.trim();
                if (trimmed !== e.target.value) patchPart(openIdx, { label: trimmed || undefined });
              }}
              className="h-9 min-w-0 flex-1 rounded-input border border-line bg-bg-2 px-3 text-[13px] text-ink outline-none placeholder:text-ink-4"
            />
            <span data-testid={`deck-amount-${openIdx}`} className="m-num text-[14px] font-semibold text-ink">
              {fmtCents(active.amountCents, tx.currency, lang)}
            </span>
          </div>
          {/* #217 (user): a spread part shows EACH category as its own
              row — same face as the unsplit card, value included; every
              row doors into the same editor. #228 feedback: no counter
              subline — the part's Counterparty row below owns it */}
          {(activeRealCats.length ? activeRealCats : [null]).map((entry, entryIdx) => {
            const rowCat = cats.byId(entry?.catId ?? active.catId);
            const rowColor = rowCat.color ?? cats.byId(rowCat.parentId ?? '').color;
            return (
              <button
                key={entry ? `${entry.catId}-${entryIdx}` : 'single'}
                data-testid={entryIdx === 0 ? `deck-cat-${openIdx}` : `deck-cat-${openIdx}-${entryIdx}`}
                onClick={() => setSpreadFor(openIdx)}
                className="m-tap flex w-full items-center gap-2.5 border-t border-line-2 bg-transparent px-3 py-2.5 text-left text-[14px] font-medium text-ink"
              >
                <Icon name={rowCat.icon} size={18} color={rowColor ?? 'var(--m-ink-3)'} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {catName(rowCat, t)}
                    {!entry && rowCat.parentId && (
                      <span className="text-[12px] font-normal text-ink-4"> · {catName(cats.byId(rowCat.parentId), t)}</span>
                    )}
                  </span>
                </span>
                <span className="m-num text-[12px] font-normal text-ink-2">
                  {fmtCents(entry ? entry.amountCents : partNetCents(active), tx.currency, lang)}
                </span>
                <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />
              </button>
            );
          })}
          {/* #228 feedback: the part's own Counterparty row — the same
              counter-first door the card and the detail screen carry */}
          {!lockedKind && (
            <button
              data-testid={`deck-counter-${openIdx}`}
              onClick={() => setCounterForIdx(openIdx)}
              className="m-tap flex w-full items-center gap-2.5 border-t border-line-2 bg-transparent px-3 py-2.5 text-left text-[14px] text-ink"
            >
              <Icon name="bank-transfer" size={18} color="var(--m-ink-3)" />
              <span className={`min-w-0 flex-1 truncate ${active.linkedAccountId ? '' : 'text-ink-4'}`}>
                {accounts?.find((a) => a.id === active.linkedAccountId)?.name ?? t('tx.counterNone')}
              </span>
              <span className="text-[11px] text-ink-4">{t('tx.counterAccount')}</span>
              <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />
            </button>
          )}
          {/* r7: parts link recurring costs, exactly like the card does */}
          <button
            data-testid={`deck-rec-${openIdx}`}
            onClick={() => setRecFor(openIdx)}
            className="m-tap flex w-full items-center gap-2.5 border-t border-line-2 bg-transparent px-3 py-2.5 text-left text-[14px] text-ink"
          >
            <Icon name="autorenew" size={18} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1 truncate">{activeRecFace}</span>
            <span className="text-[11px] text-ink-4">{t('recurring.linkTitle')}</span>
            <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />
          </button>
          <button
            data-testid={`deck-event-${openIdx}`}
            onClick={() => setEventFor(openIdx)}
            className="m-tap flex w-full items-center gap-2.5 border-t border-line-2 bg-transparent px-3 py-2.5 text-left text-[14px] text-ink"
          >
            <Icon name="party-popper" size={18} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1 truncate">{activeEventFace}</span>
            <span className="text-[11px] text-ink-4">{t('events.linkTitle')}</span>
            <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />
          </button>
        </div>
      </div>

      {/* r7: a refused Confirm points at the parts that hold it back */}
      {attention && parts.some((slice) => slice.catId === UNCATEGORIZED_ID) && (
        <p className="mt-2 rounded-card bg-negative-soft px-3 py-2 text-[12px] leading-relaxed text-negative" data-testid="deck-attention">
          {t('split.attentionNote')}
        </p>
      )}

      {/* #228 feedback: the part card's counterparty door — pick refiles
          the part's category by the account's kind (counter-first),
          remove resets it; settled bookkeeping always survives */}
      <CounterpartySheet
        open={counterForIdx !== null}
        onOpenChange={(next) => {
          if (!next) setCounterForIdx(null);
        }}
        excludeAccountId={tx.accountId}
        currentLinkedId={counterPart?.linkedAccountId}
        defaultFamily={
          counterPart && specialCatType(counterPart.catId) ? (defaultFamilyFor(counterPart.catId) ?? undefined) : undefined
        }
        counterTypes={counterPart && specialCatType(counterPart.catId) ? counterTypesFor(counterPart.catId) : undefined}
        onChoose={(account) => {
          if (counterForIdx === null) return;
          const part = parts[counterForIdx];
          const derived = movementCatFor(account.type, (tx.amountCents < 0 ? -1 : 1) * Math.abs(part.amountCents));
          patchPart(counterForIdx, {
            catId: derived,
            txType: specialCatType(derived),
            linkedAccountId: account.id,
            transferPeerId: undefined,
            cats: catsAroundSingle(part, derived),
          });
        }}
        onDetach={
          counterPart?.linkedAccountId
            ? () => {
                if (counterForIdx === null) return;
                const part = parts[counterForIdx];
                patchPart(counterForIdx, {
                  catId: UNCATEGORIZED_ID,
                  txType: undefined,
                  linkedAccountId: undefined,
                  transferPeerId: undefined,
                  cats: catsAroundSingle(part, UNCATEGORIZED_ID),
                });
              }
            : undefined
        }
      />
      {/* the expanded part's event — per-part membership (v2 model) */}
      <Sheet
        open={eventFor !== null}
        onOpenChange={(next) => {
          if (!next) setEventFor(null);
        }}
        title={t('events.linkTitle')}
        size="form"
        dragHandle
      >
        <div className="pt-1" data-testid="deck-event-list">
          <button
            data-testid="deck-event-none"
            onClick={() => {
              if (eventFor !== null) patchPart(eventFor, { eventId: undefined });
              setEventFor(null);
            }}
            className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink-2"
          >
            <Icon name="close-circle-outline" size={18} color="var(--m-ink-4)" />
            <span className="min-w-0 flex-1 truncate">{t('events.linkNone')}</span>
          </button>
          {activeEvents.map((event) => (
            <button
              key={event.id}
              data-testid={`deck-event-${event.id}`}
              onClick={() => {
                if (eventFor !== null) patchPart(eventFor, { eventId: event.id });
                setEventFor(null);
              }}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink"
            >
              <Icon name={event.icon ?? 'party-popper'} size={18} color="var(--m-accent-deep)" />
              <span className="min-w-0 flex-1 truncate">{event.name}</span>
              {eventFor !== null && parts[eventFor]?.eventId === event.id && (
                <Icon name="check" size={17} color="var(--m-accent-deep)" />
              )}
            </button>
          ))}
        </div>
      </Sheet>
      {/* r7: the part's recurring link — the manual pick, parts edition */}
      <Sheet
        open={recFor !== null}
        onOpenChange={(next) => {
          if (!next) setRecFor(null);
        }}
        title={t('recurring.linkTitle')}
        size="form"
        dragHandle
      >
        <div className="pt-1" data-testid="deck-rec-list">
          <button
            data-testid="deck-rec-none"
            onClick={() => {
              if (recFor !== null) patchPart(recFor, { recurringId: undefined });
              setRecFor(null);
            }}
            className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink-2"
          >
            <Icon name="close-circle-outline" size={18} color="var(--m-ink-4)" />
            <span className="min-w-0 flex-1 truncate">{t('recurring.linkNone')}</span>
          </button>
          {recurrings.map((rec) => (
            <button
              key={rec.id}
              data-testid={`deck-rec-${rec.id}`}
              onClick={() => {
                if (recFor !== null) patchPart(recFor, { recurringId: rec.id });
                setRecFor(null);
              }}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink"
            >
              <Icon name="autorenew" size={18} color="var(--m-accent-deep)" />
              <span className="min-w-0 flex-1 truncate">{rec.name}</span>
              {recFor !== null && parts[recFor]?.recurringId === rec.id && (
                <Icon name="check" size={17} color="var(--m-accent-deep)" />
              )}
            </button>
          ))}
        </div>
      </Sheet>
      {/* the part's categories (r6/r7) — the whole-transaction editor,
          scoped to the part's amount. #228: a lone ◆ pick asks the
          PART's counterparty inside the editor; a spread offers regular
          categories only */}
      <CatsSheet
        open={spreadFor !== null}
        onOpenChange={(next) => {
          if (!next) setSpreadFor(null);
        }}
        subject={partAt(parts, spreadFor)}
        currency={tx.currency}
        direction={deckDirection}
        txType={rowType}
        allowedCatIds={allowedCatIds}
        excludeAccountId={tx.accountId}
        askDisabled={lockedKind}
        onApply={(entries) => {
          if (spreadFor !== null) patchPart(spreadFor, partCatsApplyPatch(partAt(parts, spreadFor), entries));
        }}
      />
    </div>
  );
}

/** own-account counterparty pre-applies the link + suggested type; the
 * hidden 'uncategorized' builtin keeps the confirm armed for transfers */
function applyOwnCounterDefault(
  baseDraft: ReviewDraft | null,
  ownCounter: { id: string; type: AccountType } | undefined,
  cats: ReturnType<typeof useCategories>,
  amountCents: number,
  ownStamp?: TxType,
): ReviewDraft | null {
  if (!baseDraft || !ownCounter || baseDraft.linkedAccountId) return baseDraft;
  const linked = withLinkedAccount(baseDraft, { id: ownCounter.id, type: ownCounter.type }, cats, amountCents, ownStamp);
  return linked.catId ? linked : withCategory(linked, 'uncategorized', cats);
}

/** the bulk sheet's read-only transaction peek: (almost) the detail
 * screen's facts — amount, date, category, type, account, counterparty,
 * bank text — without any of its edit affordances (user request) */
function BulkTxPeek({ tx }: Readonly<{ tx: SpaceTx }>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const { store } = useData();
  const account = useQuery(store, async () => store.get('account', tx.accountId), [tx.accountId]);
  const cat = cats.byId(tx.catId);
  const catColor = cat.color ?? cats.byId(cat.parentId ?? '').color;
  const factRow = (label: string, value: string, icon: string, color?: string) => (
    <div className="flex items-center gap-3 border-b border-line-2 px-4 py-2.5 last:border-0">
      <Icon name={icon} size={18} color={color ?? 'var(--m-ink-3)'} />
      <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{value}</span>
      <span className="text-xs text-ink-4">{label}</span>
    </div>
  );
  return (
    <div className="flex flex-col gap-3 pt-1" data-testid="review-bulk-detail">
      <div className="m-num text-center text-[26px] text-ink">
        {fmtCents(tx.amountCents, tx.currency, lang, { sign: true })}
      </div>
      <p className="text-center text-[12px] text-ink-4">
        {new Date(tx.date).toLocaleDateString(LOCALES[lang], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
      </p>
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {factRow(t('screen.categories'), catName(cat, t), cat.icon, catColor)}
        {factRow(t('tx.type'), t(`tx.type.${tx.txType}`), TX_TYPE_VISUAL[tx.txType].icon, TX_TYPE_VISUAL[tx.txType].color)}
        {account && factRow(t('txform.account'), account.name, 'bank-outline')}
        {tx.counterIban && factRow(t('tx.counterparty'), tx.counterIban, 'swap-horizontal')}
      </div>
      {tx.description && (
        <p className="rounded-xl bg-bg-2 px-3 py-2.5 font-mono text-[11px] break-words text-ink-3">
          {cleanBankText(tx.description)}
        </p>
      )}
    </div>
  );
}

function BulkConfirmSection({
  similar,
  selected,
  onChange,
}: Readonly<{ similar: SpaceTx[]; selected: ReadonlySet<string>; onChange: (next: ReadonlySet<string>) => void }>) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  if (similar.length === 0) return null;

  const all = similar.every((s) => selected.has(s.id));
  const detail = detailId ? similar.find((s) => s.id === detailId) : undefined;
  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  return (
    <div className="mt-3 overflow-hidden rounded-card border border-line bg-surface" data-testid="review-bulk">
      {/* the WHOLE bar opens the sheet (user request); the checkbox is
          the one carve-out — two sibling buttons, no nesting */}
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          data-testid="review-bulk-toggle"
          aria-label={t('review.alsoApply', { n: similar.length })}
          onClick={() => onChange(all ? new Set() : new Set(similar.map((s) => s.id)))}
          className={`m-tap flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
            all ? 'border-accent bg-accent text-white' : 'border-line bg-surface'
          }`}
        >
          {all && <Icon name="check" size={12} />}
        </button>
        <button
          data-testid="review-bulk-expand"
          onClick={() => setOpen(true)}
          className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent p-0 text-left"
        >
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{t('review.alsoApply', { n: selected.size })}</span>
          <span className="flex items-center gap-1 text-[12px] text-ink-3">
            {t('review.bulkViewAll')}
            <Icon name="chevron-right" size={15} />
          </span>
        </button>
      </div>

      {/* near-max-height sheet styled like the transactions list (user
          redesign): TxRow rows with a checkbox rail, select/unselect all,
          and a row tap opens a compact READ-ONLY detail as a stacked sheet */}
      <Sheet open={open} onOpenChange={setOpen} title={t('review.alsoApply', { n: selected.size })} height={760} dragHandle>
        <div className="flex items-center justify-between pb-2">
          <span className="text-[12px] text-ink-3">{t('review.bulkCount', { n: similar.length })}</span>
          <button
            data-testid="review-bulk-select-all"
            onClick={() => onChange(all ? new Set() : new Set(similar.map((s) => s.id)))}
            className="m-tap border-none bg-transparent text-[12px] font-semibold text-accent-deep"
          >
            {all ? t('review.bulkUnselectAll') : t('review.bulkSelectAll')}
          </button>
        </div>
        {/* fixed px so the list scrolls INSIDE the sheet (sheet rules) */}
        <div className="max-h-[620px] overflow-y-auto overscroll-contain" data-testid="review-bulk-list">
          {similar.map((item) => {
            const checked = selected.has(item.id);
            return (
              <div key={item.id} className="flex items-center gap-2 border-b border-line-2 last:border-0">
                <button
                  data-testid={`review-bulk-${item.id}`}
                  aria-label={cleanBankText(item.merchant)}
                  onClick={() => toggleOne(item.id)}
                  className={`m-tap flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
                    checked ? 'border-accent bg-accent text-white' : 'border-line bg-surface'
                  }`}
                >
                  {checked && <Icon name="check" size={12} />}
                </button>
                <div className="min-w-0 flex-1" data-testid={`review-bulk-open-${item.id}`}>
                  {/* every row here is unreviewed by definition — the badge is noise */}
                  <TxRow tx={item} showDate hideUnreviewed onClick={() => setDetailId(item.id)} />
                </div>
              </div>
            );
          })}
        </div>
      </Sheet>

      {/* read-only peek — taller now (user request), still clearly SHORTER
          than the list sheet so its top edge stays visible against the
          parent behind it (the stacked-sheet cue) */}
      <Sheet
        open={detailId !== null}
        onOpenChange={(next) => !next && setDetailId(null)}
        title={detail ? cleanBankText(detail.merchant) : ''}
        height={600}
      >
        {detail && <BulkTxPeek tx={detail} />}
      </Sheet>
    </div>
  );
}

/**
 * The card's link row below categories: for a loan/mortgage counterparty
 * it names WHICH debt the transfer pays (a payoff is a debt payment, not
 * a recurring cost — user request 2026-07-29); otherwise the editable
 * recurring link with its price-delta warning.
 */
function DebtOrRecurringRow({
  isLoanCounter,
  payingDebt,
  recMatch,
  linkRecurring,
  manualRec,
  amountCents,
  currency,
  onEdit,
}: Readonly<{
  isLoanCounter: boolean;
  payingDebt: { name: string } | undefined;
  recMatch: RecurringRow | undefined;
  linkRecurring: boolean;
  manualRec: RecurringRow | undefined;
  amountCents: number;
  currency: string;
  onEdit: () => void;
}>) {
  const { t, lang } = useLang();
  if (isLoanCounter) {
    return (
      <div data-testid="review-debt-row" className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[14px] text-ink">
        <Icon name="hand-coin-outline" size={18} color="var(--m-ink-3)" />
        {/* v2: the counterparty account IS the loan — name it directly */}
        <span className="min-w-0 flex-1 truncate">{payingDebt?.name}</span>
        <span className="text-[11px] text-ink-4">{t('review.debtRow')}</span>
      </div>
    );
  }
  const delta = recMatch ? Math.abs(Math.abs(amountCents) - recMatch.amountCents) : 0;
  return (
    <>
      <button
        data-testid="review-recurring-row"
        onClick={onEdit}
        className="m-tap flex w-full items-center gap-2.5 border-none bg-transparent px-4 py-2.5 text-left text-[14px] text-ink"
      >
        <Icon name="autorenew" size={18} color="var(--m-ink-3)" />
        <span className="min-w-0 flex-1 truncate">{recurringRowLabel(recMatch, linkRecurring, manualRec, t)}</span>
        <span className="text-[11px] text-ink-4">{t('recurring.linkTitle')}</span>
        <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />
      </button>
      {recMatch && linkRecurring && delta >= 50 && (
        <div className="flex items-center gap-1 px-4 pb-1 text-[11px] text-warning" data-testid="review-rec-delta">
          <Icon name={Math.abs(amountCents) > recMatch.amountCents ? 'trending-up' : 'trending-down'} size={12} />
          {t(Math.abs(amountCents) > recMatch.amountCents ? 'review.recDeltaMore' : 'review.recDeltaLess', {
            amount: fmtCents(delta, currency, lang),
          })}
        </div>
      )}
    </>
  );
}

/** the recurring row's display label: linked name or "None" */
function recurringRowLabel(
  recMatch: RecurringRow | undefined,
  linkRecurring: boolean,
  manualRec: RecurringRow | undefined,
  t: ReturnType<typeof useLang>['t'],
): string {
  const linked = recMatch && linkRecurring ? recMatch : manualRec;
  if (!chosenRecurringId(recMatch, linkRecurring, manualRec?.id ?? null)) return t('recurring.linkNone');
  return linked?.name ?? t('recurring.linkTitle');
}

/** which recurring the confirm links: the auto-match wins (unless the
 *  user un-ticked it); otherwise whatever was picked by hand */
function chosenRecurringId(recMatch: RecurringRow | undefined, linkRecurring: boolean, manualRecId: string | null): string | undefined {
  if (recMatch) return linkRecurring ? recMatch.id : undefined;
  return manualRecId ?? undefined;
}

/** stacked picker for the manual recurring link: every active recurring
 *  plus an explicit "no link" row (user request — auto-detection alone
 *  missed renamed merchants) */
function RecurringPickSheet({
  open,
  onOpenChange,
  recurrings,
  selectedId,
  currency,
  onPick,
  onCreate,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recurrings: RecurringRow[];
  selectedId: string | null;
  currency: string;
  onPick: (id: string | null) => void;
  /** create-and-return door: opens the recurring form, auto-attaches */
  onCreate: () => void;
}>) {
  const { t, lang } = useLang();
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('review.linkRecurringPick')} size="form" dragHandle>
      <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="recpick-list">
        <button
          data-testid="recpick-none"
          onClick={() => onPick(null)}
          className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3 text-left"
        >
          <Icon name="close-circle-outline" size={18} color="var(--m-ink-4)" />
          <span className="min-w-0 flex-1 text-[14px] text-ink-2">{t('review.recNone')}</span>
          {!selectedId && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
        </button>
        {recurrings.map((rec) => (
          <button
            key={rec.id}
            data-testid={`recpick-${rec.id}`}
            onClick={() => onPick(rec.id)}
            className="m-tap flex w-full items-center gap-3 border-t border-line-2 px-4 py-3 text-left"
          >
            <RecurringVisual rec={rec} size={18} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] text-ink">{rec.name}</span>
              <span className="block text-[11px] text-ink-4">{cadenceLabel(rec, t)}</span>
            </span>
            <span className="m-num text-[13px] text-ink-2">{fmtCents(rec.amountCents, currency, lang)}</span>
            {selectedId === rec.id && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
          </button>
        ))}
        <button
          data-testid="recpick-create"
          onClick={onCreate}
          className="m-tap flex w-full items-center gap-3 border-t border-line-2 px-4 py-3 text-left text-[14px] font-medium text-accent-deep"
        >
          <Icon name="plus" size={18} />
          {t('recurring.add')}
        </button>
      </div>
    </Sheet>
  );
}

/** v2: the loan/mortgage counterparty IS the debt being paid (S3776:
 *  the branch lives out of the component) */
const loanCounterOf = (counter: { type: string; name: string } | undefined): { name: string } | undefined =>
  counter && ['loan', 'mortgage'].includes(counter.type) ? { name: counter.name } : undefined;

/** #133 r5/#221: the card ask derives from the PICKED category, out of
 *  the component (S3776) — every ask pins its default (the ATM pair
 *  pins the cash wallet, not the default bank account) and narrows to
 *  the account types the category can mean (the bijection) */
const askDefaultFamily = (catId: string | null): DefaultFamily | undefined =>
  catId ? (defaultFamilyFor(catId) ?? undefined) : undefined;
const askCounterTypes = (catId: string | null): readonly AccountType[] | undefined =>
  (catId ? counterTypesFor(catId) : undefined) ?? undefined;

/**
 * Review queue, rebuilt around the legacy mechanics with a calmer face:
 * one card at a time, the prediction pre-applied WITH its reason, bulk
 * confirm for similar transactions (same merchant; same amount too once
 * split), type/counter-account and splits via the shared sheets, a
 * recurring-cost link offer, and a skip pile at the end.
 */
export function ReviewScreen() {
  const { t, lang } = useLang();
  const { store, repo, spaceId, setActiveSpace } = useData();
  const navigate = useNavigate();
  // #132: a new-transactions notification names its space — arriving
  // with ?space= switches there (membership-checked), then strips the
  // param so refresh/back don't re-switch
  const { space: spaceParam } = useSearch({ strict: false }) as { space?: string };
  useEffect(() => {
    if (!spaceParam) return;
    if (spaceParam !== spaceId) {
      void store.get('space', spaceParam).then((row) => {
        if (row?.deleted === 0) void setActiveSpace(spaceParam);
      });
    }
    void navigate({ to: '/review', search: {}, replace: true });
    // one-shot per arriving param — the strip itself clears it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceParam]);
  const cats = useCategories();
  const allTxs = useSpaceTransactions();
  const transform = useTxTransform();
  const recurrings = useRecurrings();
  const recurringOps = useRecurringOps();

  const [splitOpen, setSplitOpen] = useState(false);
  // #211: two different features, two different sheets — the category
  // chip opens the SPLIT-CATEGORIES editor (the row's own spread); the
  // split doors open the split-TRANSACTION values editor (parts)
  const [catsOpen, setCatsOpen] = useState(false);
  // r7: a refused Confirm marks the parts that still need a category
  const [partsAttention, setPartsAttention] = useState(false);
  // r7 (user rule): splitting RESETS the card's own decisions — staged
  // edits get a conscious warning before the split flow opens
  const [splitResetOpen, setSplitResetOpen] = useState(false);
  const requestSplit = () => {
    if (stagedDraft !== null || eventPick !== null || manualRecId !== null) {
      setSplitResetOpen(true);
      return;
    }
    setSplitOpen(true);
  };
  const confirmSplitReset = () => {
    setStagedDraft(null);
    setEventPick(null);
    setManualRecId(null);
    setSplitResetOpen(false);
    setSplitOpen(true);
  };
  // kind + counterparty rows live ON the card now (user simplification);
  // a user-picked transfer REQUIRES a counterparty, so dismissing the
  // picker without choosing rolls the kind back to what it was
  // #133 C/#221: the ask is keyed by the PICKED category — its default
  // pin and its account types both derive from the bijection (the ATM
  // pair asks among cash wallets and pins the space's own)
  const [counterAskCat, setCounterAskCat] = useState<string | null>(null);
  const [counterOpen, setCounterOpen] = useState(false);
  const counterFallback = useRef<ReviewDraft | null>(null);
  const counterChosen = useRef(false);
  // per-visit only (user ruling): mid-review side steps happen in sheets
  // that keep the screen mounted, so state survives those — but leaving
  // review and coming back later starts the deck from the top again
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  // the card's STAGED decision (review redesign): user edits live here,
  // only Confirm writes; null = untouched, follow tx + prediction live
  const [stagedDraft, setStagedDraft] = useState<ReviewDraft | null>(null);
  const [descExpanded, setDescExpanded] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<ReadonlySet<string>>(new Set());
  // deck animation (user request): keep the outgoing card's markup as a
  // ghost that flies out left while the next card slides in from the right
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [leavingHtml, setLeavingHtml] = useState<string | null>(null);
  const captureLeaving = () => {
    if (!cardRef.current) return;
    // strip testids so the decorative ghost never doubles a live element
    setLeavingHtml(cardRef.current.innerHTML.replaceAll(/data-testid="[^"]*"/g, ''));
    setTimeout(() => setLeavingHtml(null), 260);
  };
  const [linkRecurring, setLinkRecurring] = useState(true);
  // no auto-match? the user can still link a recurring by hand (user request)
  const [manualRecId, setManualRecId] = useState<string | null>(null);
  const [recPickOpen, setRecPickOpen] = useState(false);
  // events join the review card (user redesign): staged, written on confirm
  const [eventPick, setEventPick] = useState<string | null>(null);
  const [eventPickOpen, setEventPickOpen] = useState(false);
  // create-and-return doors: snapshot ids, diff on close, auto-attach
  const [recCreating, setRecCreating] = useState(false);
  const [eventCreating, setEventCreating] = useState(false);
  const [initialCount, setInitialCount] = useState<number | null>(null);

  // teaching data: what this space (or the user's personal spaces) confirmed before
  const memory = useQuery(store, async () => buildSpaceMerchantMemory(store, spaceId), [spaceId]);

  const queue = useMemo(
    // oldest first (user request): work through the backlog chronologically
    () => allTxs?.filter((item) => item.needsReview === 1).sort((a, b) => a.date.localeCompare(b.date)),
    [allTxs],
  );
  useEffect(() => {
    if (queue && initialCount === null) setInitialCount(queue.length || 1);
  }, [queue, initialCount]);

  const remaining = useMemo(() => queue?.filter((item) => !skipped.has(item.id)), [queue, skipped]);
  const tx = remaining?.[0];

  const prediction = useMemo(
    () => (tx && memory ? predictTx({ memory, merchant: tx.merchant, titleOverride: tx.titleOverride, description: tx.description, amountCents: tx.amountCents }) : null),
    [tx, memory],
  );

  // counterparty IBAN belonging to one of MY OWN accounts = money moving
  // between my accounts — a transfer by definition, pre-applied (user
  // report: credit-card top-ups showed up as expense + income pairs)
  // the funding account, named on the card (user request)
  const cardAccount = useQuery(store, async () => (tx ? store.get('account', tx.accountId) : undefined), [tx?.accountId]);
  // R1: the row's own account stamps its type — the kind row locks and
  // a counterparty pick keeps the stamp with the forced movement sub
  const ownStamp = accountStamp(cardAccount?.type);
  const ownCounter = useQuery(
    store,
    async () => {
      const accounts = await store.allRows('account');
      const iban = tx?.counterIban ? normalizeIban(tx.counterIban) : undefined;
      const byIban = iban
        ? accounts.find((a) => a.deleted === 0 && !!a.iban && normalizeIban(a.iban) === iban)
        : undefined;
      if (byIban) return byIban;
      // PP1 rung 3: a PayPal-funding debit defaults to the PayPal account
      // (shared collection IBAN never matches — the name pattern does)
      if (tx && tx.amountCents < 0 && isPaypalFunding(tx)) {
        return accounts.find((a) => a.deleted === 0 && isPaypalAccount(a));
      }
      return undefined;
    },
    [tx?.counterIban, tx?.id],
  );

  // untouched cards follow the tx + the (async) prediction live
  const baseDraft = tx ? initDraft(tx, prediction?.catId, cats) : null;
  const ownTransferDraft = useMemo(
    () => applyOwnCounterDefault(baseDraft, ownCounter, cats, tx?.amountCents ?? 0, ownStamp),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tx?.id, ownCounter, prediction?.catId, cats, ownStamp],
  );
  const draft = stagedDraft ?? ownTransferDraft;
  const draftCounter = useQuery(
    store,
    async () => (draft?.linkedAccountId ? store.get('account', draft.linkedAccountId) : undefined),
    [draft?.linkedAccountId],
  );
  // a loan/mortgage counterparty makes this a DEBT payment: the account
  // IS the loan (v2), so the card names the counterparty itself and
  // retires the recurring row — a payoff transfer is not a recurring
  // cost (user request 2026-07-29)
  const payingDebt = loanCounterOf(draftCounter);
  const isLoanCounter = payingDebt !== undefined;
  const events = useEvents();
  const activeEvents = useMemo(() => (events ?? []).filter((e) => e.archived !== 1), [events]);
  const pickedEvent = activeEvents.find((e) => e.id === eventPick);
  const cat = cats.byId(draft?.catId);
  const parentColor = cat.parentId ? cats.byId(cat.parentId).color : cat.color;
  // #126 r3: with a real split the parts carry the stories — the main
  // card drops its kind/recurring/event rows and shows just the money
  const multiPart = (draft?.splits?.filter((s) => s.catId !== REIMBURSED_ID).length ?? 0) > 1;

  const recMatch = useMemo(
    () =>
      tx
        ? recurrings?.find(
            (r) =>
              r.active === 1 &&
              !!r.merchantKey &&
              r.merchantKey === merchantKey(tx.merchant) &&
              recurringAmountMatches(r, tx.amountCents),
          )
        : undefined,
    [tx, recurrings],
  );
  const activeRecs = useMemo(() => (recurrings ?? []).filter((r) => r.active === 1), [recurrings]);
  const manualRec = activeRecs.find((r) => r.id === manualRecId);

  // SP5: an incoming amount that exactly matches an open split settlement
  // to me is very likely that person paying me back — suggest transfer
  const identity = useSession((s) => s.identity);
  const [settlements, setSettlements] = useState<SettlementCandidate[]>([]);
  useEffect(() => {
    if (identity?.kind !== 'user') return;
    void fetchSettlementCandidates().then(setSettlements);
  }, [identity]);
  const settleMatch = useMemo(
    () => (tx && tx.amountCents > 0 ? settlements.find((c) => c.cents === tx.amountCents) : undefined),
    [tx, settlements],
  );

  // bulk rule: plain confirm reaches every same-merchant item; absolute
  // partitions (parts or a category spread, #211) only fit exact twins
  // (same amount), percentage ones scale to any amount so the whole
  // merchant group stays eligible
  const draftSplits = draft?.splits;
  const draftCats = draft?.cats;
  const similar = useMemo(() => {
    if (!tx || !queue) return [] as SpaceTx[];
    const key = merchantKey(tx.merchant);
    const mustMatchAmount =
      (!!draftSplits?.length && !splitsArePct(draftSplits)) ||
      (!!draftCats?.length && !draftCats.every((e) => e.pct != null));
    // skipped cards left the deck on purpose — bulk must not drag them
    // back in (user request: the count follows the visible queue)
    return queue.filter(
      (item) =>
        item.id !== tx.id &&
        !skipped.has(item.id) &&
        // decisions are sign-bound (income vs expense, reimbursement
        // side): a -€1000 sibling must never inherit a "received
        // reimbursement" decision made on +€1000 (user ss 2026-07-28)
        Math.sign(item.amountCents) === Math.sign(tx.amountCents) &&
        merchantKey(item.merchant) === key &&
        (!mustMatchAmount || item.amountCents === tx.amountCents),
    );
  }, [tx, queue, draftSplits, draftCats, skipped]);

  // fresh card: reset the staged draft and offer the link. This runs
  // DURING render (previous-id ref pattern), not in an effect — a late
  // effect flush could undo user input that landed right after the card
  // swap (a real race under coverage instrumentation)
  useFreshCardReset(tx?.id, () => {
    setStagedDraft(null);
    setLinkRecurring(true);
    setManualRecId(null);
    setEventPick(null);
    setDescExpanded(false);
    setPartsAttention(false);
    setSplitResetOpen(false);
  });
  // select every similar item by default. Keyed on MEMBERSHIP, not array
  // identity: the native SQL backend re-emits unchanged rows every sync
  // cycle, and an identity-keyed reset kept re-arming boxes the user had
  // just cleared (iOS ss 2026-07-28). When a sync genuinely changes the
  // list mid-card, new arrivals join checked and the user's unchecks
  // survive — the visible count stays honest either way.
  const similarKey = useMemo(() => similar.map((s) => s.id).sort((a, b) => a.localeCompare(b)).join(','), [similar]);
  const prevSimilarIds = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const ids = similarKey ? similarKey.split(',') : [];
    const prev = prevSimilarIds.current;
    prevSimilarIds.current = new Set(ids);
    setBulkSelected((sel) => new Set(ids.filter((id) => (prev.has(id) ? sel.has(id) : true))));
  }, [similarKey]);

  // the recurring OWNS the category (user rule 2026-07-28): linking one
  // stages its category once, and the editor then only offers that
  // category or expected reimbursement (the one allowed override)
  const chosenRec = useMemo(() => {
    if (isLoanCounter) return undefined; // debt payments never carry a recurring link
    const id = chosenRecurringId(recMatch, linkRecurring, manualRecId);
    return id ? (recurrings ?? []).find((r) => r.id === id) : undefined;
  }, [recMatch, linkRecurring, manualRecId, recurrings, isLoanCounter]);
  useEffect(() => {
    if (!chosenRec?.catId || !draft) return;
    // r7: a split container never takes the recurring's category — the
    // parts own their categories (and their own recurring links)
    if (multiPartSplits(draft)) return;
    if (draft.catId === chosenRec.catId || draft.catId === EXPECTED_REIMBURSE_ID) return;
    // the recurring owns ONE category — a staged spread steps aside too
    setStagedDraft(withCategory(withSplits({ ...draft, cats: undefined }, undefined), chosenRec.catId, cats));
    // once per selection — the pick itself is the trigger, not the draft
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenRec?.id, chosenRec?.catId]);
  const recurringAllowedCats = chosenRec?.catId ? [chosenRec.catId, EXPECTED_REIMBURSE_ID] : undefined;

  const counterRowDoors = buildCounterRowDoors({
    draft,
    locked: draft?.txType === 'adjustment' || !!recurringAllowedCats,
    amountCents: tx?.amountCents,
    cats,
    setCounterAskCat,
    counterFallback,
    setCounterOpen,
    counterChosen,
    setStagedDraft,
  });

  const showReason = !!tx && !stagedDraft && prediction?.catId === draft?.catId;
  const reasonLine =
    showReason && prediction ? t(REASON_KEYS[prediction.source], { n: prediction.evidence ?? 1 }) : null;

  // #211: the cats editor spreads the NET money — a settled `reimbursed`
  // entry is bookkeeping, held aside and re-attached on stage
  const spreadRowCount = draft?.cats?.filter((e) => e.catId !== REIMBURSED_ID).length ?? 0;
  const settledCatEntry = draft?.cats?.find((e) => e.catId === REIMBURSED_ID);
  const settledCatsCents = settledCatEntry?.amountCents ?? 0;

  /** the settled row's gross partition, rewritten around a single pick */
  const settledCatsFor = (catId: string) =>
    settledCatEntry
      ? [
          ...(Math.abs(tx?.amountCents ?? 0) - settledCatsCents > 0
            ? [{ catId, amountCents: Math.abs(tx?.amountCents ?? 0) - settledCatsCents }]
            : []),
          settledCatEntry,
        ]
      : undefined;

  /** ONE category decides the card — the VALUES-collapse path (catId
   *  only): stages it with the ◆ machinery — Transfer stages nothing
   *  until its mandatory counterparty answers; families ask right away */
  const stageSingleCategory = (catId: string) => {
    if (!draft) return;
    const family = specialCatType(catId);
    // #133 E: the ◆ Transfer pick stages NOTHING yet — the mandatory
    // counterparty answers it (dismiss = rollback, an unlinked transfer
    // is unrepresentable)
    if (family === 'transfer' && !ownStamp) {
      counterFallback.current = draft;
      setCounterAskCat(catId);
      setCounterOpen(true);
      return;
    }
    const next = { ...withCategory(withSplits(draft, undefined), catId, cats), cats: settledCatsFor(catId) };
    // #228: a REGULAR pick ends any movement story — the counterparty
    // clears with it (category and counter are one fact)
    setStagedDraft(family || ownStamp ? next : { ...next, linkedAccountId: undefined });
    // #133 C: a ◆ family pick unfolds the counterparty question right
    // away — the pinned Default, a real account, or dismiss (bare is
    // legal; Confirm links the default, #221). #152 r2/#221: the
    // Funding pick asks WHICH funding account, its shared pot pinned.
    if (family && family !== 'transfer' && !next.linkedAccountId && !ownStamp) {
      setCounterAskCat(catId);
      counterFallback.current = null;
      setCounterOpen(true);
    }
  };

  /** the cats EDITOR's single entry — its counterparty was already
   *  answered inside the editor (or deliberately left bare), so nothing
   *  asks afterwards; the entry's link IS the (split) transaction's one
   *  counterparty (#228) and stages at the row level. #218: a BARE
   *  entry CLEARS the row link too — the editor owns the whole story. */
  const stageSingleEntry = (entry: CatsApplyEntry) => {
    if (!draft) return;
    const next = { ...withCategory(withSplits(draft, undefined), entry.catId, cats), cats: settledCatsFor(entry.catId) };
    setStagedDraft({ ...next, linkedAccountId: entry.linkedAccountId });
  };

  const confirm = async () => {
    if (!tx || !draft) return;
    if (!draftReady(draft)) {
      // r7: a blocked Confirm POINTS at what holds it back — the deck
      // badges the parts that still need a category
      if (multiPartSplits(draft)) setPartsAttention(true);
      return;
    }
    captureLeaving();
    // r7: a split container carries no recurring/event of its own — the
    // parts do (their links ride inside draft.splits)
    const container = !multiPartSplits(draft);
    // #221: a bare movement confirm links the space's DEFAULT for the
    // category's family in the same write — the choke mints the counter
    // leg ("confirms the category + default account", user spec)
    const bareMovementFamily =
      !ownStamp && !draft.linkedAccountId && !draft.cats?.length && !draft.splits?.length && isMovementCat(draft.catId)
        ? defaultFamilyFor(draft.catId)
        : null;
    const defaultLinkId = bareMovementFamily
      ? await ensureDefaultAccount(store, repo, spaceId, bareMovementFamily)
      : undefined;
    await writeConfirmation({
      tx,
      draft,
      recurringId: container && !isLoanCounter ? chosenRecurringId(recMatch, linkRecurring, manualRecId) : undefined,
      eventId: container ? (eventPick ?? undefined) : undefined,
      bulk: similar.filter((s) => bulkSelected.has(s.id)),
      transform,
      defaultLinkId,
    });
    // other billing cycles of a linked recurring pick up their link here
    void recurringOps.reconcile().catch(() => undefined);
    const bulkN = similar.filter((s) => bulkSelected.has(s.id)).length;
    void logActivity(store, repo, spaceId, 'review', bulkN ? `${txTitle(tx)} +${bulkN}` : txTitle(tx));
    hapticNotify('SUCCESS'); // §5: a physical tick on the native shells
  };

  const { progress, sub } = progressState(initialCount, queue?.length, skipped.size);

  const emptyBecauseSkipped = queue && queue.length > 0 && remaining?.length === 0;

  // desktop affordances (D5): Enter confirms, ←/→ skips to the next card —
  // never while a sheet is open or the focus sits in an input
  useEffect(() => {
    if (!tx) return;
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open], [role="dialog"]')) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        void confirm();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        captureLeaving();
        setSkipped((prev) => new Set([...prev, tx.id]));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-review">
      <AppBar
        title={t('review.title')}
        sub={sub}
        leading={
          <IconButton label={t('action.back')} testId="review-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
        trailing={<HelpButton tourId="review" />}
      />
      {/* quiet progress line under the bar */}
      <div className="h-0.5 shrink-0 bg-bg-2">
        <div className="h-full bg-accent transition-[width]" style={{ width: `${progress * 100}%` }} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-6">
        {/* the first-time nudge must come BEFORE the user works the deck,
            not after it (user bug report) — it's one dismissible line and
            never returns once seen */}
        <IntroCard tourId="review" />
        {!tx && queue && !emptyBecauseSkipped && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center" data-testid="review-empty">
            <Icon name="check-circle-outline" size={48} color="var(--m-accent)" />
            <div className="m-h3 text-ink">{t('review.noTxs')}</div>
            <p className="max-w-[260px] text-sm text-ink-3">{t('review.noTxsSub')}</p>
          </div>
        )}
        {emptyBecauseSkipped && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center" data-testid="review-skipped-note">
            <Icon name="debug-step-over" size={40} color="var(--m-warning)" />
            <p className="max-w-[260px] text-sm text-ink-2">{t('review.skippedRemain', { n: skipped.size })}</p>
            <Button variant="outline" data-testid="review-reset-skipped" onClick={() => setSkipped(() => new Set())}>
              {t('review.reviewSkipped')}
            </Button>
          </div>
        )}
        {tx && (
          /* D3 focus layout: at lg the deck becomes a fixed 520px column,
             centered both ways (user: left-anchored read as broken); the
             pickers slide in as dimmed right-hand panels, so the card
             stays visible while editing. Skip/Confirm attach under the
             card instead of the far bottom. */
          <div className="relative flex min-h-0 flex-1 flex-col lg:mx-auto lg:my-auto lg:w-[520px] lg:flex-none lg:pb-10">
            {leavingHtml && (
              <div
                aria-hidden
                className="m-card-out pointer-events-none absolute inset-x-0 top-0 z-10"
                // our own just-rendered markup, snapshotted for the exit flight
                dangerouslySetInnerHTML={{ __html: leavingHtml }} // NOSONAR
              />
            )}
            <div key={`card-${tx.id}`} ref={cardRef} className="m-card-in">
            <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface" data-testid="review-card">
              {/* compact header (user: title + amount were too huge once
                  the card carries every editable row) */}
              <div className="px-4 pt-3 pb-2.5">
                <div className="text-[11px] text-ink-4" data-testid="review-card-meta">
                  {new Intl.DateTimeFormat(LOCALES[lang], { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(tx.date))}
                  {cardAccount && <span> · {cardAccount.name}</span>}
                </div>
                <div className="mt-0.5 flex items-baseline justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-[16px] font-semibold text-ink">{txTitle(tx)}</span>
                  <span className="m-num shrink-0 text-[18px] text-ink">{fmtCents(tx.amountCents, tx.currency, lang, { sign: true })}</span>
                </div>
                {tx.description && (
                  // tap to read everything — the clamp sits on an INNER
                  // span (display on the button kills -webkit-box)
                  <button
                    data-testid="review-description"
                    aria-expanded={descExpanded}
                    onClick={() => setDescExpanded((v) => !v)}
                    className="m-tap mt-1 block w-full border-none bg-transparent p-0 text-left font-mono text-[11px] text-ink-4"
                  >
                    <span data-testid="review-description-text" className={descExpanded ? '' : 'line-clamp-2'}>
                      {cleanBankText(tx.description)}
                    </span>
                  </button>
                )}
              </div>
              <div className="mx-4 h-px bg-line-2" />

              {/* categories first (#219), and — #228 feedback — the
                  counterparty back as the card's OWN row: counter-first
                  stages the special category, removal resets it. The
                  recurring-owned card keeps its category, so no counter
                  door there; adjustments carry no counterparty at all.
                  Multi-part (#126 r3): these rows vanish — each PART
                  carries its own story on the deck. */}
              <div data-testid="review-cats">
                <CardCategoryRows
                  draft={draft}
                  fallbackCat={cat}
                  fallbackColor={parentColor}
                  currency={tx.currency}
                  onOpenCategories={() => setCatsOpen(true)}
                  onOpenSplit={requestSplit}
                  onEditCounter={counterRowDoors.onEdit}
                />

                {!multiPart && (
                  <DebtOrRecurringRow
                    isLoanCounter={isLoanCounter}
                    payingDebt={payingDebt}
                    recMatch={recMatch}
                    linkRecurring={linkRecurring}
                    manualRec={manualRec}
                    amountCents={tx.amountCents}
                    currency={tx.currency}
                    onEdit={() => setRecPickOpen(true)}
                  />
                )}

                {!multiPart && (
                  <button
                    data-testid="review-event-row"
                    onClick={() => setEventPickOpen(true)}
                    className="m-tap flex w-full items-center gap-2.5 border-none bg-transparent px-4 py-2.5 text-left text-[14px] text-ink"
                  >
                    <Icon name="party-popper" size={18} color="var(--m-ink-3)" />
                    <span className="min-w-0 flex-1 truncate">{pickedEvent?.name ?? t('events.linkNone')}</span>
                    <span className="text-[11px] text-ink-4">{t('events.linkTitle')}</span>
                    <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />
                  </button>
                )}
              </div>

              {/* contextual offers keep their chip shape under the rows.
                  #219: the green "between your own accounts" chip is gone
                  — the category row already names the link, and detaching
                  lives in the category editor's ask (#218) */}
              {settleMatch && draft && (
                <div className="px-4 pb-3">
                  <Chip
                    testId="review-settle-match"
                    selected={draft.txType === 'transfer'}
                    onClick={() => setStagedDraft(stageAsSettlement(draft, cats))}
                  >
                    <Icon name="handshake-outline" size={13} />
                    {t('review.settleMatch', {
                      name: settleMatch.fromName ?? t('review.settleSomeone'),
                      split: settleMatch.splitName,
                    })}
                  </Chip>
                </div>
              )}
            </div>

            {/* #126: the split stands as stacked cards under the main one */}
            {draft && (
              <ReviewPartDeck
                key={tx.id}
                splits={draft.splits}
                rowType={draft.txType}
                tx={tx}
                activeEvents={activeEvents}
                allowedCatIds={recurringAllowedCats}
                lockedKind={!!ownStamp}
                recurrings={activeRecs}
                attention={partsAttention}
                onOpenValues={() => setSplitOpen(true)}
                onSplits={(next) => setStagedDraft(withSplits(draft, next))}
              />
            )}

            <BulkConfirmSection similar={similar} selected={bulkSelected} onChange={setBulkSelected} />
            </div>

            {/* mobile: pinned to the thumb at the bottom; lg: attached to the card */}
            <div className="mt-auto flex gap-3 pt-4 lg:mt-0">
              <Button
                variant="outline"
                className="w-28"
                data-testid="review-skip-btn"
                onClick={() => {
                  captureLeaving();
                  setSkipped((prev) => new Set([...prev, tx.id]));
                }}
              >
                {t('review.skip')}
              </Button>
              <Button
                variant="primary"
                className="min-w-0 flex-1"
                data-testid="review-confirm-btn"
                // r7: a split whose parts are incomplete keeps the button
                // TAPPABLE — the tap marks the parts needing attention
                disabled={!draft || (!draftReady(draft) && !multiPartSplits(draft))}
                onClick={() => void confirm()}
              >
                <span className="truncate">
                  {/* multi-category: the list above already says it all */}
                  {draft?.catId && !draft.splits?.length && spreadRowCount <= 1
                    ? t('review.confirmAs', { name: catName(cat, t) })
                    : t('review.confirm')}
                </span>
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* #211: the split-TRANSACTION editor — pure money partition; the
          parts complete their stories on the deck below the card */}
      {tx && draft && (
        <SplitEditorSheet
          open={splitOpen}
          onOpenChange={setSplitOpen}
          tx={tx}
          // empty value: the editor itself seeds "current category owns the
          // full amount + one fresh row" — exactly the add-part start
          value={draft.splits}
          seedSingle
          seedCatId={draft.catId}
          onApply={(splits) => {
            setStagedDraft(withSplits(draft, splits ?? undefined));
          }}
          onApplySingle={stageSingleCategory}
        />
      )}
      {/* #211: the split-CATEGORIES editor — the chip's door. One entry
          is a plain category pick (a lone ◆ pick asks its counterparty
          inside the editor — the transaction-level answer, #228); a
          spread stages regular categories and drops the row-level link
          (a spread means no movement story). A settled `reimbursed`
          entry is bookkeeping: held aside here, re-attached on stage. */}
      {tx && draft && (
        <CatsSheet
          open={catsOpen}
          onOpenChange={setCatsOpen}
          subject={{
            id: tx.id,
            label: txTitle(tx),
            catId: draft.catId,
            // #228 feedback: the FULL partition rides in — the sheet
            // pins settled bookkeeping read-only and nets the gross
            cats: draft.cats?.length ? draft.cats : undefined,
            amountCents: Math.abs(tx.amountCents),
            linkedAccountId: draft.linkedAccountId,
            transferPeerId: tx.transferPeerId,
          }}
          currency={tx.currency}
          direction={tx.amountCents < 0 ? 'debit' : 'credit'}
          txType={draft.txType}
          allowedCatIds={recurringAllowedCats}
          title={t('split.catsTitle')}
          reason={reasonLine}
          includePct
          excludeAccountId={tx.accountId}
          askDisabled={!!ownStamp}
          onApply={(entries) => {
            if (entries.length === 1) {
              stageSingleEntry(entries[0]);
              return;
            }
            const full = settledCatEntry ? [...entries, settledCatEntry] : entries;
            const primary = entries.reduce((best, e) => (e.amountCents > best.amountCents ? e : best), entries[0]);
            setStagedDraft({ ...withCats(draft, full), catId: primary.catId, linkedAccountId: undefined });
          }}
        />
      )}
      {/* r7 (user rule): splitting resets the card's own decisions — a
          conscious continue, never a silent drop */}
      <Sheet open={splitResetOpen} onOpenChange={setSplitResetOpen} title={t('split.resetWarnTitle')} size="compact">
        <div className="flex flex-col gap-3 pt-1">
          <p className="text-[13px] leading-relaxed text-ink-2">{t('split.resetWarnBody')}</p>
          <Button data-testid="split-reset-continue" onClick={confirmSplitReset}>
            {t('split.resetContinue')}
          </Button>
          <Button variant="outline" data-testid="split-reset-cancel" onClick={() => setSplitResetOpen(false)}>
            {t('action.cancel')}
          </Button>
        </div>
      </Sheet>
      {tx && draft && (
        <CounterpartySheet
          open={counterOpen}
          onOpenChange={(open) => {
            setCounterOpen(open);
            if (!open) {
              // dismissed without a pick: a user-chosen transfer rolls
              // back — an unlinked transfer is unrepresentable
              if (!counterChosen.current && counterFallback.current) setStagedDraft(counterFallback.current);
              counterFallback.current = null;
              counterChosen.current = false;
              setCounterAskCat(null);
            }
          }}
          excludeAccountId={tx.accountId}
          currentLinkedId={draft.linkedAccountId}
          defaultFamily={askDefaultFamily(counterAskCat)}
          counterTypes={askCounterTypes(counterAskCat)}
          onChoose={(account) => {
            counterChosen.current = true;
            setStagedDraft(withLinkedAccount(draft, account, cats, tx?.amountCents, ownStamp));
          }}
          // #228 feedback: the card row's remove door — the counterparty
          // and the category are one fact, so removal resets the pick
          onDetach={counterRowDoors.onDetach}
        />
      )}
      {tx && (
        <RecurringPickSheet
          open={recPickOpen}
          onOpenChange={setRecPickOpen}
          recurrings={activeRecs}
          selectedId={chosenRecurringId(recMatch, linkRecurring, manualRecId) ?? null}
          currency={tx.currency}
          onPick={(id) => {
            // the auto-match keeps its toggle semantics: picking it re-arms
            // the link, "no link" disarms; anything else is a manual pick
            if (id !== null && id === recMatch?.id) {
              setLinkRecurring(true);
              setManualRecId(null);
            } else {
              if (recMatch) setLinkRecurring(false);
              setManualRecId(id);
            }
            setRecPickOpen(false);
          }}
          onCreate={() => {
            setRecCreating(true);
            setRecPickOpen(false);
          }}
        />
      )}
      {/* create-and-return: a fresh recurring auto-attaches to this card,
          prefilled from the transaction itself (user request). onSaved
          carries the id — sniffing the live-query list after close was a
          lost race, which is why "create" never actually attached */}
      {recCreating && tx && (
        <RecurringFormSheet
          initial={formFromTx(tx)}
          onSaved={(id) => {
            if (recMatch) setLinkRecurring(false);
            setManualRecId(id);
          }}
          onClose={() => setRecCreating(false)}
        />
      )}
      {tx && (
        <Sheet open={eventPickOpen} onOpenChange={setEventPickOpen} title={t('events.linkTitle')} size="form" dragHandle>
          <div className="pt-1" data-testid="review-event-list">
            <button
              data-testid="review-event-none"
              onClick={() => {
                setEventPick(null);
                setEventPickOpen(false);
              }}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink-2"
            >
              <Icon name="close-circle-outline" size={18} color="var(--m-ink-4)" />
              <span className="min-w-0 flex-1 truncate">{t('events.linkNone')}</span>
              {!eventPick && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
            </button>
            {activeEvents.map((event) => (
              <button
                key={event.id}
                data-testid={`review-event-${event.id}`}
                onClick={() => {
                  setEventPick(event.id);
                  setEventPickOpen(false);
                }}
                className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink"
              >
                <Icon name={event.icon ?? 'party-popper'} size={18} color="var(--m-accent-deep)" />
                <span className="min-w-0 flex-1 truncate">{event.name}</span>
                {eventPick === event.id && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
              </button>
            ))}
            <button
              data-testid="review-event-create"
              onClick={() => {
                setEventCreating(true);
                setEventPickOpen(false);
              }}
              className="m-tap flex w-full items-center gap-3 px-1 py-3 text-left text-[14px] font-medium text-accent-deep"
            >
              <Icon name="plus" size={18} />
              {t('events.new')}
            </button>
          </div>
        </Sheet>
      )}
      {eventCreating && (
        <EventFormSheet
          initial="new"
          onSaved={(id) => setEventPick(id)}
          onClose={() => setEventCreating(false)}
        />
      )}
    </div>
  );
}
