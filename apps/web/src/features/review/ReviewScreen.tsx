import { SelectAllRow } from '@/ui/SelectAllRow';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSpaceAccount, useSpaceAccounts, useSpaceTransactions, useTxTransform } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { useReviewedSettle } from './useReviewedSettle';
import { requestReviewSuggestions, suggestionFor, useReviewSuggestions } from '@/application/reviewSuggestions';
import type { ReviewSuggestion, ReviewSuggestions } from '@/application/reviewSuggestions';
import { fileRememberedCounter, storyBasis } from '@/domain/reviewSuggest';
import { linkAsEntry, useProposedMatches, useTxReceiptEntry } from '@/application/receiptLinks';
import { useAttachableReceipts } from '@/application/connections';
import { useReceiptOps } from '@/application/receipts';
import { applyPick, attachedElsewhere, candidatesFor, describeTxFor, dropAttached, suggestionsFor } from '@/features/shopping/receiptPick';
import { ReceiptPickSheet } from '@/features/shopping/ReceiptPickSheet';
import { ReceiptPeekSheet } from '@/features/shopping/ReceiptPeekSheet';
import { ReceiptCaptureRungs } from '@/features/shopping/ReceiptCapture';
import { BulkReceiptQueue } from '@/features/shopping/BulkReceiptQueue';
import { receiptsToVerify } from '@/features/shopping/receiptWalk';
import { partyName } from '@/features/connectors/logos';
import { useRecurringOps, useRecurrings } from '@/application/recurring';
import { useEvents } from '@/application/events';
import { EventFormSheet } from '@/features/events/EventsScreen';
import { EventPickList } from '@/features/events/EventPickList';
import { RecurringFormSheet, formFromTx } from '@/features/recurring/RecurringFormSheet';
import type { FormState as RecurringFormState } from '@/features/recurring/RecurringFormSheet';
import { merchantKey } from '@/domain/merchantKey';
import { draftReady, initDraft, withCategory, withCats, withKind, withLinkedAccount, withSplits, withType } from '@/domain/reviewDraft';
import { EXPECTED_REIMBURSE_ID, RECEIVED_REIMBURSE_ID, REIMBURSED_ID, UNCATEGORIZED_ID, isMovementCat, specialCatType } from '@/domain/categories';
import { COUNTERABLE_ACCOUNT_TYPES, accountStamp, counterTypesFor, movementCatFor } from '@/domain/txType';
import { partNetCents } from '@/domain/reimbursement';
import { defaultFamilyFor } from '@/domain/defaultAccounts';
import type { DefaultFamily } from '@/application/defaultAccounts';
import { hapticNotify } from '@/lib/platform';
import { measure } from '@/lib/perf';
import { TxRow } from '@/ui/TxRow';
import { fetchSettlementCandidates } from '@/features/splits/settlementCandidates';
import type { SettlementCandidate } from '@/features/splits/settlementCandidates';
import { useSession } from '@/app/session';
import type { DraftCatalog, ReviewDraft } from '@/domain/reviewDraft';
import type { AccountType, EventRow, ReceiptLinkRow, ReceiptRow, RecurringEvery, RecurringRow, TxSplit, TxSplitCat, TxType } from '@/db/types';
import { setChooserLoanPrefill } from '@/features/accounts/AddAccountChooser';
import { resolveSplitsFor, splitsArePct } from '@/domain/splits';
import { cardRowGates } from './cardRows';
import { canBeRecurringCost } from '@/domain/recurring';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { logActivity } from '@/application/activity';
import { pairWithExistingRow, releasePeerLeg } from '@/application/counterPair';
import { catName, useCategories } from '@/features/categories/useCategories';
import { fmtCents } from '@/lib/money';
import { cleanBankText, orDefaultLabel, txTitle } from '@/lib/text';
import { HelpButton } from '@/features/help/HelpButton';
import { IntroCard } from '@/features/help/IntroCard';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { FormBlockerNote, blockerRing } from '@/ui/FormBlockerNote';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { EntryReviewRow } from '@/features/transactions/EntryLinkSection';
import { SplitEditorSheet } from '@/features/transactions/SplitEditorSheet';
import { CatsSheet, catsAroundSingle, partCatsApplyPatch } from '@/features/transactions/PartCatsSheet';
import { TitleSearchButton } from '@/features/transactions/TitleSearch';
import { ReadOnlyNote } from '@/features/spaces/ReadOnlyNote';
import { useCanEdit } from '@/app/useCanEdit';
import type { CatsApplyEntry } from '@/features/transactions/PartCatsSheet';
import { RecurringVisual, cadenceLabel } from '@/features/recurring/RecurringVisual';
import { TX_TYPE_VISUAL } from '@/features/transactions/TxTypeSheet';
import { BulkCounterQueue, CounterMatchSheet, CounterpartySheet } from '@/features/transactions/TxKindSheet';
import { setReviewReturn, takeReviewReturn } from './reviewReturn';
import { AUTO_STAGE, cardReceipt, markedReceiptId, receiptSettlement } from './reviewReceipt';
import type { ReceiptStage } from './reviewReceipt';
import { keepFiledPicks, useReceiptFiled } from './useReceiptFiled';

// the height of a full card: a title, two description lines, every row, the notes and the bulk strip under it
const CARD_ROOM_MD = 'md:min-h-[540px]';

const REASON_KEYS = {
  history: 'review.reasonHistory',
  'history-amount': 'review.reasonAmount',
  keyword: 'review.reasonKeyword',
} as const;

function cardReason(filedByReceipt: boolean, shown: ReviewSuggestion | undefined, t: ReturnType<typeof useLang>['t']): string | null {
  if (filedByReceipt) return t('receiptcats.autoNote');
  return shown?.source ? t(REASON_KEYS[shown.source], { n: shown.evidence ?? 1 }) : null;
}

// the card's counterparty row: detach resets the category too, counterparty and category are one fact (#228)
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

function useFreshCardReset(txId: string | undefined, reset: () => void) {
  const lastTxId = useRef(txId);
  if (txId !== lastTxId.current) {
    lastTxId.current = txId;
    reset();
  }
}

// held while the card is up: a finishing pass must not reshuffle it; a row changed elsewhere no longer matches
function useCardSuggestion(tx: SpaceTx | undefined, map: ReviewSuggestions | undefined): ReviewSuggestion | undefined {
  const held = useRef<{ txId?: string; value?: ReviewSuggestion }>({});
  const current = held.current;
  const stillHolds = current.txId === tx?.id && !!current.value && !!tx && current.value.basis === storyBasis(tx);
  if (!stillHolds) held.current = { txId: tx?.id, value: suggestionFor(map, tx) };
  return held.current.value;
}

const unpreparedStates = (queue: readonly SpaceTx[] | undefined, map: ReviewSuggestions | undefined): string[] =>
  (queue ?? []).filter((item) => !suggestionFor(map, item)).map((item) => `${item.id}:${storyBasis(item)}`);

function askOnce(asked: Set<string>, states: readonly string[]): boolean {
  const fresh = states.some((state) => !asked.has(state));
  for (const state of states) asked.add(state);
  return fresh;
}

function progressState(initial: number | null, queueLen: number | undefined, skippedCount: number) {
  const total = initial ?? 1;
  const confirmed = initial === null ? 0 : Math.max(0, initial - (queueLen ?? 0));
  const done = confirmed + skippedCount;
  return {
    progress: initial ? done / initial : 0,
    sub: (queueLen ?? 0) > 0 ? `${Math.min(done + 1, total)} / ${total}` : undefined,
  };
}

function replacing<K extends string, T>(key: K, next: T | undefined, had: boolean): Partial<Record<K, T>> {
  if (next !== undefined) return { [key]: next } as Partial<Record<K, T>>;
  // explicit null clears the synced field (undefined would be dropped)
  return had ? ({ [key]: null } as unknown as Partial<Record<K, T>>) : {};
}

async function pairReviewPicks(
  deps: { store: ReturnType<typeof useData>['store']; repo: ReturnType<typeof useData>['repo']; spaceId: string },
  tx: SpaceTx,
  pickedPeerTxId: string | undefined,
  partPeers: readonly TxSplit[],
): Promise<void> {
  if (pickedPeerTxId) await pairWithExistingRow(deps.store, deps.repo, deps.spaceId, tx, pickedPeerTxId);
  for (const part of partPeers) {
    await pairWithExistingRow(
      deps.store,
      deps.repo,
      deps.spaceId,
      { id: tx.id, accountId: tx.accountId, amountCents: (tx.amountCents < 0 ? -1 : 1) * Math.abs(part.amountCents) },
      part.transferPeerId!,
    );
  }
}

// the leg's amount wears the LEG's currency: a $35.88 PayPal leg read as €35.88 next to its €32.63 debit
function counterTxFaceFor(
  peer: SpaceTx | undefined,
  bankFed: boolean,
  currency: string,
  lang: ReturnType<typeof useLang>['lang'],
  t: ReturnType<typeof useLang>['t'],
): string {
  if (peer) return `${txTitle(peer)} · ${fmtCents(peer.amountCents, peer.currency || currency, lang)}`;
  return t(bankFed ? 'review.counterAwaitFeed' : 'review.counterWillCreate');
}

export const partRecurringPrefill = (tx: SpaceTx, part: TxSplit | undefined): RecurringFormState => {
  const base = formFromTx({ ...tx, amountCents: part?.amountCents ?? tx.amountCents });
  const withCat = { ...base, catId: stagedRealCatId(part?.catId) };
  return part?.label ? { ...withCat, name: part.label } : withCat;
};

const stagedRealCatId = (catId: string | undefined): string | undefined =>
  catId && catId !== UNCATEGORIZED_ID ? catId : undefined;

// the field has a border (border-box): the frame's two edges ride on top of the content-only scrollHeight
const autoGrowNotes = (el: HTMLTextAreaElement): void => {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
};

/** near-monthly = every gap 25–35 days; anything else stays unguessed */
export function guessCadence(dates: readonly string[]): RecurringEvery | undefined {
  const stamps = [...new Set(dates)].sort((a, b) => a.localeCompare(b)).map((d) => Date.parse(d));
  if (stamps.length < 2) return undefined;
  const dayMs = 86_400_000;
  const monthly = stamps.slice(1).every((ms, i) => {
    const gap = Math.round((ms - stamps[i]) / dayMs);
    return gap >= 25 && gap <= 35;
  });
  return monthly ? 'month' : undefined;
}

const partSignedCents = (containerCents: number, partAbsCents: number): number =>
  (containerCents < 0 ? -1 : 1) * partAbsCents;

// pointing at ONE existing row is specific to its card: a standing bulk offer asks first, then stands down (#237)
const stageWithBulkWarning = (
  similarCount: number,
  stage: () => void,
  warn: (ask: { n: number; stage: () => void }) => void,
): void => {
  if (similarCount > 0) warn({ n: similarCount, stage });
  else stage();
};

const shownCard = (held: SpaceTx | null, remaining: SpaceTx[] | undefined): SpaceTx | undefined =>
  held ?? remaining?.[0];

// a container carries no note of its own
function stagedNoteFor(noteDraft: string | null, container: boolean, current: string | undefined): string | undefined {
  const staged = noteDraft?.trim();
  if (!container || staged === undefined) return undefined;
  return staged === (current ?? '') ? undefined : staged;
}

const rowOff = (enabled: boolean): string => (enabled ? '' : ' opacity-50');

// a stamped account's parts name no counterparty (R1)
function partRowGates(part: TxSplit, rowType: TxType, counter: { type: AccountType } | undefined, lockedKind: boolean, moneyIn: boolean) {
  const gates = cardRowGates(
    { catId: part.catId, txType: part.txType ?? rowType },
    { recurringOwnsCategory: false, loanCounter: counter?.type === 'loan' || counter?.type === 'mortgage', moneyIn },
  );
  return { ...gates, counter: gates.counter && !lockedKind };
}

// the ring draws INSET: the card's overflow-hidden clipped a box-edge ring at both sides (#316)
const counterRowRing = (required: boolean | undefined): string =>
  required ? ` rounded-lg${blockerRing(true)} ring-inset` : '';

function counterValueTone(required: boolean | undefined, linkedAccountId: string | undefined): string {
  if (required) return 'text-negative';
  return linkedAccountId ? '' : 'text-ink-4';
}

const heldDeckProps = (held: boolean): { marker: '1' | undefined; inertCls: string } =>
  held ? { marker: '1', inertCls: ' pointer-events-none' } : { marker: undefined, inertCls: '' };

function queuedCounterBulk(
  pickedPeer: { txId: string; linkedId: string } | null,
  bulk: SpaceTx[],
  draft: ReviewDraft,
  accounts: readonly { id: string; name: string }[] | undefined,
  recurringId: string | undefined,
  eventId: string | undefined,
  note: string | undefined,
): { items: SpaceTx[]; draft: ReviewDraft; recurringId?: string; eventId?: string; note?: string; target: { id: string; name: string } } | null {
  if (!pickedPeer || bulk.length === 0 || !draft.linkedAccountId) return null;
  const linkedId = draft.linkedAccountId;
  return {
    items: bulk,
    draft,
    recurringId,
    eventId,
    note,
    target: { id: linkedId, name: accounts?.find((a) => a.id === linkedId)?.name ?? '' },
  };
}

// reads the whole space again (Confirm stalled 3–4 s): runs idle, off the tap's path; idempotent
function runWhenIdle(task: () => void): void {
  const host = globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
  if (typeof host.requestIdleCallback === 'function') host.requestIdleCallback(task, { timeout: 2_000 });
  else setTimeout(task, 600);
}

function logConfirmActivity(
  deps: { store: ReturnType<typeof useData>['store']; repo: ReturnType<typeof useData>['repo']; spaceId: string },
  tx: SpaceTx,
  picked: boolean,
  bulkLen: number,
): void {
  const bulkN = picked ? 0 : bulkLen;
  void logActivity(deps.store, deps.repo, deps.spaceId, 'review', bulkN ? `${txTitle(tx)} +${bulkN}` : txTitle(tx));
}

const resetPickDoor = (bankFed: boolean, wantBank: boolean, clear: () => void): (() => void) | undefined =>
  bankFed === wantBank ? clear : undefined;

// the split's Done drops imported/predicted categories like hand-picked ones: read the visible story (#330)
const splitWouldReset = (args: {
  draft: ReviewDraft | null;
  staged: ReviewDraft | null;
  recurringId: string | undefined;
  eventPick: string | null;
  note: string;
}): boolean =>
  args.staged !== null ||
  args.recurringId !== undefined ||
  args.eventPick !== null ||
  args.note.trim() !== '' ||
  !!args.draft?.cats?.length ||
  !!args.draft?.splits?.length ||
  !!args.draft?.linkedAccountId ||
  (!!args.draft?.catId && args.draft.catId !== UNCATEGORIZED_ID);

// a STORED pair is the person's to change: the tap re-points or releases it on confirm; none on a funding pot
function counterTxDescriptor(
  tx: SpaceTx | undefined,
  counterAcct: { type: AccountType } | undefined,
  peer: SpaceTx | undefined,
  bankFed: boolean,
  lang: ReturnType<typeof useLang>['lang'],
  t: ReturnType<typeof useLang>['t'],
  onEdit: () => void,
): { face: string; onEdit?: () => void } | undefined {
  if (!tx || !counterAcct || counterAcct.type === 'funding') return undefined;
  const face = counterTxFaceFor(peer, bankFed, tx.currency, lang, t);
  return { face, onEdit };
}

async function writeConfirmation(args: {
  tx: SpaceTx;
  draft: ReviewDraft;
  recurringId: string | undefined;
  eventId: string | undefined;
  /** #324 (user): the staged note — undefined leaves the row's own alone */
  note?: string;
  bulk: SpaceTx[];
  transform: ReturnType<typeof useTxTransform>;
  pairPeerId?: string;
  /** a stored pair released on the card: the row forgets its peer; the peer leg was released beforehand */
  releasePeer?: boolean;
}): Promise<void> {
  const { draft } = args;
  // cleared fields on a tx that had them need an explicit null; a landed split always writes cats null so the
  // container is version-stamped and its parts never read as legacy slices on a fresh device (#211)
  const splitsField = replacing('splits', draft.splits?.length ? draft.splits : undefined, !!args.tx.splits?.length);
  const draftCatEntries = draft.cats?.length ? draft.cats : undefined;
  const catsField = draft.splits?.length
    ? { cats: null as never }
    : replacing('cats', draftCatEntries, !!args.tx.cats?.length);
  const linkField = replacing('linkedAccountId', draft.linkedAccountId, !!args.tx.linkedAccountId);
  await args.transform(args.tx, {
    catId: draft.catId,
    needsReview: 0,
    ...splitsField,
    ...catsField,
    ...linkField,
    // a pick-existing peer rides the SAME write: the choke sees the incoming peer and mints nothing (#237)
    ...peerWriteFor(args.pairPeerId, args.releasePeer),
    ...replacing('recurringId', args.recurringId, !!args.tx.recurringId),
    ...replacing('eventId', args.eventId, !!args.tx.eventId),
    ...(args.note !== undefined ? { notes: args.note } : {}),
  }, null); // confirm logs its own richer 'review' line (with bulk count)
  for (const item of args.bulk) {
    await args.transform(item, bulkFieldsFor(item, draft, args.recurringId, args.eventId, args.note), null);
  }
}

function peerWriteFor(pairPeerId: string | undefined, releasePeer: boolean | undefined): { transferPeerId?: string } {
  if (pairPeerId) return { transferPeerId: pairPeerId };
  // an explicit null clears the stored pointer (the transform's write shape, as the detail screen does it)
  return releasePeer ? { transferPeerId: null as never } : {};
}

/** a stored pair re-pointed, released or orphaned lets its old peer leg go first */
function pairReleasePlan(
  tx: Pick<SpaceTx, 'transferPeerId'>,
  draft: Pick<ReviewDraft, 'linkedAccountId'>,
  pickedPeer: { txId: string } | null,
  releaseStored: boolean,
): { releasePeer: boolean; pairNew: string | undefined } {
  const repointed = !!pickedPeer && pickedPeer.txId !== tx.transferPeerId;
  const releasePeer = !!tx.transferPeerId && (releaseStored || repointed || !draft.linkedAccountId);
  const pairNew = pickedPeer && (repointed || !tx.transferPeerId) ? pickedPeer.txId : undefined;
  return { releasePeer, pairNew };
}

function ReviewReceiptRow({ row, onLook, onAsk }: Readonly<{ row: ReturnType<typeof receiptRowFor>; onLook: (receipt: ReceiptRow) => void; onAsk: () => void }>) {
  const { t } = useLang();
  const { receipt } = row;
  return (
    <div className="flex items-center">
      <button
        data-testid="review-receipt-row"
        onClick={onAsk}
        className={`m-tap flex min-w-0 flex-1 items-center gap-2.5 border-none bg-transparent py-2.5 pl-4 text-left text-[14px] text-ink ${receipt ? 'pr-1' : 'pr-4'}`}
      >
        <Icon name="receipt-text-outline" size={18} color={row.asks ? 'var(--m-accent-deep)' : 'var(--m-ink-3)'} />
        <span className={`min-w-0 flex-1 truncate ${receipt || row.asks ? '' : 'text-ink-4'}`}>{row.face}</span>
        <span className="text-[11px] text-ink-4">{t('receipt.title')}</span>
        {!receipt && <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />}
      </button>
      {receipt && (
        <button
          data-testid="review-receipt-look"
          aria-label={t('review.receiptView')}
          onClick={() => onLook(receipt)}
          className="m-tap mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-none bg-transparent"
        >
          <Icon name="eye-outline" size={16} color="var(--m-ink-3)" />
        </button>
      )}
    </div>
  );
}

/** #542: the row stands on every card so a photo can always be added; `receipt` is what the eye looks at (#496) */
function receiptRowFor(
  state: {
    attached: ReceiptRow | null | undefined;
    proposal: ReceiptLinkRow | undefined;
    stage: ReceiptStage;
    auto: ReceiptRow | null;
  },
  currency: string,
  lang: ReturnType<typeof useLang>['lang'],
  t: ReturnType<typeof useLang>['t'],
): { face: string; receipt?: ReceiptRow; asks: boolean } {
  const { attached, proposal, stage, auto } = state;
  const name = (r: ReceiptRow) => `${r.merchant ?? partyName(r.source)} · ${fmtCents(r.totalCents, currency, lang)}`;
  const none = { face: t('review.receiptNone'), asks: false };
  if (stage.kind === 'picked') return { face: name(stage.receipt), receipt: stage.receipt, asks: true };
  if (stage.kind === 'none') return none;
  if (attached) return { face: name(attached), receipt: attached, asks: false };
  if (proposal) {
    const asked = linkAsEntry(proposal).data;
    return { face: `${name(asked)} · ${t('receipts.proposedBadge')}`, receipt: asked, asks: true };
  }
  return auto ? { face: `${name(auto)} · ${t('review.receiptAuto')}`, receipt: auto, asks: true } : none;
}

/** % entries rescale to the sibling's amount; exact euros travel only when the sum still fits */
function catsForSibling(item: SpaceTx, entries: TxSplitCat[]): TxSplitCat[] | undefined {
  if (entries.every((e) => e.pct != null)) {
    const resolved = resolveSplitsFor(item.amountCents, entries.map((e) => ({ catId: e.catId, amountCents: 0, pct: e.pct })));
    return resolved.map((s) => ({ catId: s.catId, amountCents: Math.abs(s.amountCents), ...(s.pct !== undefined ? { pct: s.pct } : {}) }));
  }
  const sum = entries.reduce((total, e) => total + e.amountCents, 0);
  return sum === Math.abs(item.amountCents) ? entries.map((e) => ({ catId: e.catId, amountCents: e.amountCents })) : undefined;
}

/** the whole decision rides to every sibling; a partition travels whole: parts clear a spread and vice versa (#211) */
function bulkFieldsFor(item: SpaceTx, draft: ReviewDraft, recurringId: string | undefined, eventId: string | undefined, note?: string) {
  // a sibling's copy must never point at the same existing row (#237)
  const splits = draft.splits?.length
    ? resolveSplitsFor(item.amountCents, draft.splits).map((s) => ({ ...s, transferPeerId: undefined }))
    : undefined;
  const catEntries = !splits && draft.cats?.length ? catsForSibling(item, draft.cats) : undefined;
  const linkedId = draft.linkedAccountId;
  return {
    catId: draft.catId,
    needsReview: 0 as const,
    ...(splits ? { splits, cats: null as never } : {}),
    ...(catEntries ? { cats: catEntries, ...(item.splits?.length ? { splits: null as never } : {}) } : {}),
    ...(linkedId ? { linkedAccountId: linkedId } : {}),
    ...(recurringId ? { recurringId } : {}),
    ...(eventId ? { eventId } : {}),
    // an untouched or emptied note never blanks a sibling's own note
    ...(note ? { notes: note } : {}),
  };
}

/** an incoming settlement is money from a person, not an account: transfer is strictly account-to-account (R2) */
function stageAsSettlement(draft: ReviewDraft, cats: ReturnType<typeof useCategories>): ReviewDraft {
  return withCategory(withType({ ...draft, linkedAccountId: undefined }, 'income', cats), RECEIVED_REIMBURSE_ID, cats);
}

const partAt = (parts: readonly TxSplit[], index: number | null): TxSplit | undefined =>
  index === null ? undefined : parts[index];

function partCounterTxFaceOf(
  part: TxSplit,
  counterAcct: { type: AccountType; source?: string } | undefined,
  allTxs: readonly SpaceTx[] | undefined,
  currency: string,
  lang: ReturnType<typeof useLang>['lang'],
  t: ReturnType<typeof useLang>['t'],
): string | undefined {
  if (!counterAcct || counterAcct.type === 'funding') return undefined;
  const peer = part.transferPeerId ? allTxs?.find((r) => r.id === part.transferPeerId) : undefined;
  return counterTxFaceFor(peer, (counterAcct.source ?? 'manual') !== 'manual', currency, lang, t);
}

function partCounterAsk(part: TxSplit | undefined): { defaultFamily?: DefaultFamily; counterTypes?: readonly AccountType[] } {
  if (!part || !specialCatType(part.catId)) return {};
  return { defaultFamily: defaultFamilyFor(part.catId) ?? undefined, counterTypes: counterTypesFor(part.catId) };
}

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

const multiPartSplits = (draft: ReviewDraft | null): boolean =>
  (draft?.splits ?? []).filter((s) => s.catId !== REIMBURSED_ID).length > 1;

function sliceStory(
  slice: TxSplit,
  index: number,
  splits: readonly TxSplit[] | undefined,
  rowType: TxType | undefined,
  cats: ReturnType<typeof useCategories>,
  t: ReturnType<typeof useLang>['t'],
): { label?: string; type?: TxType; spread?: string } {
  const typed = (splits?.length ?? 0) > 1;
  return {
    label: typed ? (slice.label ?? t('split.partN', { n: index + 1 })) : undefined,
    type: slice.txType && slice.txType !== rowType ? slice.txType : undefined,
    spread: slice.cats?.length ? slice.cats.map((c) => catName(cats.byId(c.catId), t)).join(' · ') : undefined,
  };
}

/** the settled Reimbursed slice is not a part and keeps its own row either way */
function CardCategoryRows({
  draft,
  fallbackCat,
  fallbackColor,
  currency,
  onOpenCategories,
  onEditCounter,
  counterRequired,
  counterTx,
}: Readonly<{
  draft: ReviewDraft | null;
  fallbackCat: ReturnType<ReturnType<typeof useCategories>['byId']>;
  fallbackColor: string | undefined;
  currency: string;
  onOpenCategories: () => void;
  onEditCounter?: () => void;
  counterRequired?: boolean;
  counterTx?: { face: string; onEdit?: () => void };
}>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const accounts = useSpaceAccounts();
  const slices = draft?.splits ?? [];
  const parts = slices.filter((s) => s.catId !== REIMBURSED_ID);
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
      {/* multi-part: the deck under the card carries every story; a spread's rows are regular categories (#126, #228) */}
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
      {/* the row stands on every card; an ordinary filing has no counterparty, so it is disabled (#565) */}
      {!multi && (
        <>
          <button
            data-testid="review-counter-row"
            onClick={onEditCounter}
            disabled={!onEditCounter}
            aria-disabled={!onEditCounter}
            className={'m-tap flex w-full items-center gap-2.5 border-none bg-transparent px-4 py-2.5 text-left text-[14px] text-ink' + counterRowRing(counterRequired) + rowOff(!!onEditCounter)}
          >
            <Icon name="bank-transfer" size={18} color={counterRequired ? 'var(--m-negative)' : 'var(--m-ink-3)'} />
            <span className={`min-w-0 flex-1 truncate ${counterValueTone(counterRequired, draft?.linkedAccountId)}`}>
              {(accounts ?? []).find((a) => a.id === draft?.linkedAccountId)?.name ?? t('tx.counterNone')}
            </span>
            <span className="text-[11px] text-ink-4">{t('tx.counterAccount')}</span>
            {onEditCounter && <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />}
          </button>
          <FormBlockerNote show={!!counterRequired} text={t('review.counterRequired')} testId="review-counter-required" className="px-4 pb-2" />
        </>
      )}
      {!multi && (
        <button
          data-testid="review-countertx-row"
          onClick={counterTx?.onEdit}
          disabled={!counterTx?.onEdit}
          aria-disabled={!counterTx?.onEdit}
          className={`m-tap flex w-full items-center gap-2.5 border-none bg-transparent px-4 py-2.5 text-left text-[14px] text-ink${rowOff(!!counterTx)}`}
        >
          <Icon name="swap-horizontal" size={18} color="var(--m-ink-3)" />
          <span className={`min-w-0 flex-1 truncate ${counterTx ? '' : 'text-ink-4'}`}>{counterTx?.face ?? t('review.counterTxNone')}</span>
          <span className="text-[11px] text-ink-4">{t('tx.counterTxRow')}</span>
          {counterTx?.onEdit && <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />}
        </button>
      )}
      {settled.map((slice) => catRow(slice.catId, slice.amountCents, `settled-${slice.catId}`))}
    </>
  );
}

/** the parts as a deck: one expanded, the rest slim; the amount opens the values editor (amounts are a partition) */
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
  onPickExisting,
}: Readonly<{
  splits: readonly TxSplit[] | undefined;
  /** the container's type: what untyped parts inherit */
  rowType: TxType;
  tx: SpaceTx;
  activeEvents: readonly EventRow[];
  allowedCatIds?: readonly string[];
  /** R1: a stamped account types every row — parts included */
  lockedKind?: boolean;
  recurrings: readonly Pick<RecurringRow, 'id' | 'name' | 'logo' | 'icon' | 'kind'>[];
  attention?: boolean;
  onOpenValues: () => void;
  onSplits: (next: TxSplit[]) => void;
  /** a part pointed at an existing row: the screen may warn (bulk turns off) before `stage` runs (#237) */
  onPickExisting?: (stage: () => void) => void;
}>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const accounts = useSpaceAccounts();
  const allTxs = useSpaceTransactions();
  const [expanded, setExpanded] = useState(0);
  const [counterForIdx, setCounterForIdx] = useState<number | null>(null);
  const [counterTxForIdx, setCounterTxForIdx] = useState<number | null>(null);
  const [eventFor, setEventFor] = useState<number | null>(null);
  const [recFor, setRecFor] = useState<number | null>(null);
  const [recCreateFor, setRecCreateFor] = useState<number | null>(null);
  const [eventCreateFor, setEventCreateFor] = useState<number | null>(null);
  const [spreadFor, setSpreadFor] = useState<number | null>(null);
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

  // no restriction on a split beyond the amounts; incompleteness is the attention badges' job
  const patchPart = (index: number, patch: Partial<TxSplit>) => {
    const target = parts[index];
    onSplits(slices.map((s) => (s === target ? { ...s, ...patch } : s)));
  };
  const counterPart = counterForIdx === null ? undefined : parts[counterForIdx];
  const counterAsk = partCounterAsk(counterPart);
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
  const activeRealCats = (active.cats ?? []).filter((c) => c.catId !== REIMBURSED_ID);
  const activeEventFace = activeEvents.find((event) => event.id === active.eventId)?.name ?? t('events.linkNone');
  const activeRecFace = recurrings.find((rec) => rec.id === active.recurringId)?.name ?? t('recurring.linkNone');
  // a stamped account owns its parts' story (#565)
  const partCounterAcct = accounts?.find((a) => a.id === active.linkedAccountId);
  const partGates = partRowGates(active, rowType, partCounterAcct, lockedKind, !canBeRecurringCost(tx.amountCents));
  const partCounterTxFace = partCounterTxFaceOf(active, partCounterAcct, allTxs, tx.currency, lang, t);
  const peeking = parts.map((slice, i) => ({ slice, i })).filter(({ i }) => i !== openIdx);
  const deckDirection: 'debit' | 'credit' = tx.amountCents < 0 ? 'debit' : 'credit';
  const needsAttention = (slice: TxSplit) => attention && slice.catId === UNCATEGORIZED_ID;

  return (
    <div className="mt-3" data-testid="review-part-deck">
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
              // a whitespace-only label settles back to the derived default on blur
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
          <button
            data-testid={`deck-counter-${openIdx}`}
            onClick={() => setCounterForIdx(openIdx)}
            disabled={!partGates.counter}
            aria-disabled={!partGates.counter}
            className={`m-tap flex w-full items-center gap-2.5 border-t border-line-2 bg-transparent px-3 py-2.5 text-left text-[14px] text-ink${rowOff(partGates.counter)}`}
          >
            <Icon name="bank-transfer" size={18} color="var(--m-ink-3)" />
            <span className={`min-w-0 flex-1 truncate ${active.linkedAccountId ? '' : 'text-ink-4'}`}>
              {partCounterAcct?.name ?? t('tx.counterNone')}
            </span>
            <span className="text-[11px] text-ink-4">{t('tx.counterAccount')}</span>
            {partGates.counter && <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />}
          </button>
          <button
            data-testid={`deck-countertx-${openIdx}`}
            onClick={() => setCounterTxForIdx(openIdx)}
            disabled={!partCounterTxFace}
            aria-disabled={!partCounterTxFace}
            className={`m-tap flex w-full items-center gap-2.5 border-t border-line-2 bg-transparent px-3 py-2.5 text-left text-[14px] text-ink${rowOff(!!partCounterTxFace)}`}
          >
            <Icon name="swap-horizontal" size={18} color="var(--m-ink-3)" />
            <span className={`min-w-0 flex-1 truncate ${partCounterTxFace ? '' : 'text-ink-4'}`}>{partCounterTxFace ?? t('review.counterTxNone')}</span>
            <span className="text-[11px] text-ink-4">{t('tx.counterTxRow')}</span>
            {partCounterTxFace && <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />}
          </button>
          <button
            data-testid={`deck-rec-${openIdx}`}
            onClick={() => setRecFor(openIdx)}
            disabled={!partGates.recurring}
            aria-disabled={!partGates.recurring}
            className={`m-tap flex w-full items-center gap-2.5 border-t border-line-2 bg-transparent px-3 py-2.5 text-left text-[14px] text-ink${rowOff(partGates.recurring)}`}
          >
            <Icon name="autorenew" size={18} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1 truncate">{partGates.recurring ? activeRecFace : t('recurring.linkNone')}</span>
            <span className="text-[11px] text-ink-4">{t('recurring.linkTitle')}</span>
            {partGates.recurring && <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />}
          </button>
          <button
            data-testid={`deck-event-${openIdx}`}
            onClick={() => setEventFor(openIdx)}
            disabled={!partGates.event}
            aria-disabled={!partGates.event}
            className={`m-tap flex w-full items-center gap-2.5 border-t border-line-2 bg-transparent px-3 py-2.5 text-left text-[14px] text-ink${rowOff(partGates.event)}`}
          >
            <Icon name="party-popper" size={18} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1 truncate">{partGates.event ? activeEventFace : t('events.linkNone')}</span>
            <span className="text-[11px] text-ink-4">{t('events.linkTitle')}</span>
            {partGates.event && <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />}
          </button>
        </div>
      </div>

      {attention && parts.some((slice) => slice.catId === UNCATEGORIZED_ID) && (
        <p className="mt-2 rounded-card bg-negative-soft px-3 py-2 text-[12px] leading-relaxed text-negative" data-testid="deck-attention">
          {t('split.attentionNote')}
        </p>
      )}

      <CounterpartySheet
        open={counterForIdx !== null}
        onOpenChange={(next) => {
          if (!next) setCounterForIdx(null);
        }}
        excludeAccountId={tx.accountId}
        currentLinkedId={counterPart?.linkedAccountId}
        amountCents={counterPart ? partSignedCents(tx.amountCents, Math.abs(counterPart.amountCents)) : undefined}
        defaultFamily={counterAsk.defaultFamily}
        counterTypes={counterAsk.counterTypes}
        onChoose={(account) => {
          if (counterForIdx === null) return;
          const index = counterForIdx;
          const part = parts[index];
          const derived = movementCatFor(account.type, (tx.amountCents < 0 ? -1 : 1) * Math.abs(part.amountCents));
          patchPart(index, {
            catId: derived,
            txType: specialCatType(derived),
            linkedAccountId: account.id,
            // a (re-)pick resets any standing leg pick: it was bound to the previous counter account
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
      {(() => {
        const matchPart = counterTxForIdx === null ? undefined : parts[counterTxForIdx];
        const matchAcct = accounts?.find((a) => a.id === matchPart?.linkedAccountId);
        const matchBankFed = (matchAcct?.source ?? 'manual') !== 'manual';
        const clearPick = () => {
          if (counterTxForIdx !== null) patchPart(counterTxForIdx, { transferPeerId: undefined });
        };
        return (
          <CounterMatchSheet
            open={counterTxForIdx !== null}
            onOpenChange={(next) => {
              if (!next) setCounterTxForIdx(null);
            }}
            target={matchAcct ? { id: matchAcct.id, name: matchAcct.name } : null}
            anchor={{
              id: tx.id,
              amountCents: matchPart ? partSignedCents(tx.amountCents, Math.abs(matchPart.amountCents)) : tx.amountCents,
              date: tx.date,
            }}
            rows={allTxs ?? []}
            onCreate={!matchBankFed ? clearPick : undefined}
            onWait={matchBankFed ? clearPick : undefined}
            onPick={(pickedId) => {
              if (counterTxForIdx === null) return;
              const index = counterTxForIdx;
              const stage = () => patchPart(index, { transferPeerId: pickedId });
              if (onPickExisting) onPickExisting(stage);
              else stage();
            }}
          />
        );
      })()}
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
          <EventPickList
            events={activeEvents}
            selectedId={eventFor === null ? null : parts[eventFor]?.eventId}
            testIdPrefix="deck-event-"
            onPick={(id) => {
              if (eventFor !== null) patchPart(eventFor, { eventId: id });
              setEventFor(null);
            }}
          />
          <button
            data-testid="deck-event-create"
            onClick={() => {
              setEventCreateFor(eventFor);
              setEventFor(null);
            }}
            className="m-tap flex w-full items-center gap-3 px-1 py-3 text-left text-[14px] font-medium text-accent-deep"
          >
            <Icon name="plus" size={18} />
            {t('events.new')}
          </button>
        </div>
      </Sheet>
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
              <RecurringVisual rec={rec} size={18} />
              <span className="min-w-0 flex-1 truncate">{rec.name}</span>
              {recFor !== null && parts[recFor]?.recurringId === rec.id && (
                <Icon name="check" size={17} color="var(--m-accent-deep)" />
              )}
            </button>
          ))}
          <button
            data-testid="deck-rec-create"
            onClick={() => {
              setRecCreateFor(recFor);
              setRecFor(null);
            }}
            className="m-tap flex w-full items-center gap-3 px-1 py-3 text-left text-[14px] font-medium text-accent-deep"
          >
            <Icon name="plus" size={18} />
            {t('recurring.add')}
          </button>
        </div>
      </Sheet>
      {recCreateFor !== null && (
        <RecurringFormSheet
          initial={partRecurringPrefill(tx, parts[recCreateFor])}
          onSaved={(id) => patchPart(recCreateFor, { recurringId: id })}
          onClose={() => setRecCreateFor(null)}
        />
      )}
      {eventCreateFor !== null && (
        <EventFormSheet
          initial="new"
          onSaved={(id) => patchPart(eventCreateFor, { eventId: id })}
          onClose={() => setEventCreateFor(null)}
        />
      )}
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
        includePct
        excludeAccountId={tx.accountId}
        askDisabled={lockedKind}
        onApply={(entries) => {
          if (spreadFor !== null) patchPart(spreadFor, partCatsApplyPatch(partAt(parts, spreadFor), entries));
        }}
      />
    </div>
  );
}

// the prediction chain lives in domain/reviewSuggest.ts; #565 prepares it when the row lands, the card only reads it

function BulkTxPeek({ tx }: Readonly<{ tx: SpaceTx }>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const account = useSpaceAccount(tx.accountId);
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
  // an emptied selection gets its own line: "Also apply to 0 similar" read odd (#325)
  const countLine = selected.size === 0 ? t('review.bulkNoneSelected') : t('review.alsoApply', { n: selected.size });

  return (
    <div className="mt-3 overflow-hidden rounded-card border border-line bg-surface" data-testid="review-bulk">
      {/* the whole bar opens the sheet; the checkbox is the one carve-out: two sibling buttons, no nesting */}
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
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{countLine}</span>
          <span className="flex items-center gap-1 text-[12px] text-ink-3">
            {t('review.bulkViewAll')}
            <Icon name="chevron-right" size={15} />
          </span>
        </button>
      </div>

      <Sheet open={open} onOpenChange={setOpen} title={countLine} height={760} dragHandle>
        <SelectAllRow
          total={similar.length}
          selected={similar.filter((s) => selected.has(s.id)).length}
          onChange={(next) => onChange(next ? new Set(similar.map((s) => s.id)) : new Set())}
          testId="review-bulk-select-all"
          className="mb-1"
        />
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
                <div className="flex min-w-0 flex-1 items-center gap-1" data-testid={`review-bulk-open-${item.id}`}>
                  <div className="min-w-0 flex-1">
                    {/* every row here is unreviewed by definition — the badge is noise */}
                    <TxRow tx={item} showDate hideUnreviewed onClick={() => setDetailId(item.id)} />
                  </div>
                  <Icon name="chevron-right" size={15} color="var(--m-ink-4)" />
                </div>
              </div>
            );
          })}
        </div>
      </Sheet>

      {/* shorter than the list sheet so its top edge stays visible against the parent (the stacked-sheet cue) */}
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

/** disabled where the filing takes no recurring cost: a debt payment (the counter row names the loan, #236) */
function DebtOrRecurringRow({
  enabled,
  recMatch,
  linkRecurring,
  manualRec,
  amountCents,
  currency,
  onEdit,
}: Readonly<{
  enabled: boolean;
  recMatch: RecurringRow | undefined;
  linkRecurring: boolean;
  manualRec: RecurringRow | undefined;
  amountCents: number;
  currency: string;
  onEdit: () => void;
}>) {
  const { t, lang } = useLang();
  const delta = recMatch ? Math.abs(Math.abs(amountCents) - recMatch.amountCents) : 0;
  const linked = recMatch && linkRecurring ? recMatch : manualRec;
  const chosen = enabled && chosenRecurringId(recMatch, linkRecurring, manualRec?.id ?? null) ? linked : undefined;
  return (
    <>
      <button
        data-testid="review-recurring-row"
        onClick={onEdit}
        disabled={!enabled}
        aria-disabled={!enabled}
        className={`m-tap flex w-full items-center gap-2.5 border-none bg-transparent px-4 py-2.5 text-left text-[14px] text-ink${rowOff(enabled)}`}
      >
        {chosen ? (
          <span data-testid="review-recurring-visual" className="flex shrink-0 items-center justify-center">
            <RecurringVisual rec={chosen} size={18} />
          </span>
        ) : (
          <Icon name="autorenew" size={18} color="var(--m-ink-3)" />
        )}
        <span className="min-w-0 flex-1 truncate">{enabled ? recurringRowLabel(recMatch, linkRecurring, manualRec, t) : t('recurring.linkNone')}</span>
        <span className="text-[11px] text-ink-4">{t('recurring.linkTitle')}</span>
        {enabled && <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />}
      </button>
      {enabled && recMatch && linkRecurring && delta >= 50 && (
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

function chosenRecurringId(recMatch: RecurringRow | undefined, linkRecurring: boolean, manualRecId: string | null): string | undefined {
  if (recMatch) return linkRecurring ? recMatch.id : undefined;
  return manualRecId ?? undefined;
}

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

const loanCounterOf = (counter: { type: string; name: string } | undefined): { name: string } | undefined =>
  counter && ['loan', 'mortgage'].includes(counter.type) ? { name: counter.name } : undefined;

/** every ask pins its default (the ATM pair pins the cash wallet, not the default bank account) and narrows to the
 *  account types the category can mean (#133, #221) */
const askDefaultFamily = (catId: string | null): DefaultFamily | undefined =>
  catId ? (defaultFamilyFor(catId) ?? undefined) : undefined;
const askCounterTypes = (catId: string | null): readonly AccountType[] | undefined =>
  (catId ? counterTypesFor(catId) : undefined) ?? undefined;

export function ReviewScreen() {
  const { t, lang } = useLang();
  const { store, repo, spaceId } = useData();
  const cats = useCategories();
  const allTxs = useSpaceTransactions();
  const transform = useTxTransform();
  const recurrings = useRecurrings();
  const recurringOps = useRecurringOps();
  // #505 (user): a space this identity only reads shows its cards, never confirms them
  const canEdit = useCanEdit();
  const readOnlyRegion = canEdit ? undefined : true;

  const [splitOpen, setSplitOpen] = useState(false);
  // the category chip opens the split-categories editor (the row's own spread); the split doors open the parts editor (#211)
  const [catsOpen, setCatsOpen] = useState(false);
  const [partsAttention, setPartsAttention] = useState(false);
  const [counterRequired, setCounterRequired] = useState(false);
  const [catRequired, setCatRequired] = useState(false);
  // splitting resets the card's own decisions, so staged edits get a warning first; continue only ARMS the reset,
  // the split editor's Done lands it and cancelling keeps everything (#330)
  const [splitResetOpen, setSplitResetOpen] = useState(false);
  const splitResetArmed = useRef(false);
  const requestSplit = () => {
    // warn on the FIRST press: the card's shown story (row/prediction fills included) is what the split resets (#330)
    const wouldReset = splitWouldReset({
      draft,
      staged: stagedDraft,
      recurringId: chosenRecurringId(recMatch, linkRecurring, manualRecId),
      eventPick,
      note: noteDraft ?? tx?.notes ?? '',
    });
    if (wouldReset) {
      setSplitResetOpen(true);
      return;
    }
    setSplitOpen(true);
  };
  const confirmSplitReset = () => {
    splitResetArmed.current = true;
    setSplitResetOpen(false);
    setSplitOpen(true);
  };
  // a user-picked transfer requires a counterparty: dismissing the picker without a choice rolls the kind back
  // the ask is keyed by the picked category: its default pin and account types derive from the bijection (#133, #221)
  const [counterAskCat, setCounterAskCat] = useState<string | null>(null);
  const [counterOpen, setCounterOpen] = useState(false);
  const counterFallback = useRef<ReviewDraft | null>(null);
  const counterChosen = useRef(false);
  // a pick of an existing row is specific to this card: the bulk offer stands down, the warning asks first (#237)
  const [pickedPeer, setPickedPeer] = useState<{ txId: string; linkedId: string } | null>(null);
  // the create/wait door on a STORED pair means release it: the card shows the default again until confirm
  const [releaseStored, setReleaseStored] = useState(false);
  const [pickWarn, setPickWarn] = useState<{ n: number; stage: () => void } | null>(null);
  const [counterBulk, setCounterBulk] = useState<{
    items: SpaceTx[];
    draft: ReviewDraft;
    recurringId?: string;
    eventId?: string;
    note?: string;
    target: { id: string; name: string };
  } | null>(null);
  // the bulk siblings' receipts walk after the counter queue (only the siblings it settled), else at once (#495)
  const [receiptBulk, setReceiptBulk] = useState<SpaceTx[] | null>(null);
  const pendingReceiptBulk = useRef<SpaceTx[] | null>(null);
  const counterSettled = useRef(new Set<string>());
  // the deck must not advance behind the counter queue: the just-confirmed card stays frozen until it is done (#268)
  const [heldTx, setHeldTx] = useState<SpaceTx | null>(null);
  const [counterTxOpen, setCounterTxOpen] = useState(false);
  // per-visit only: leaving review and coming back starts the deck from the top; the exception is the
  // create-category detour, whose stash restores the skipped set (#275)
  const returnState = useRef(takeReviewReturn());
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set(returnState.current?.skippedIds ?? []));
  // user edits live here, only Confirm writes; null = untouched, follow tx + prediction live
  const [stagedDraft, setStagedDraft] = useState<ReviewDraft | null>(null);
  const [descExpanded, setDescExpanded] = useState(false);
  // null = untouched: the field shows the row's own note (#324)
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [bulkSelected, setBulkSelected] = useState<ReadonlySet<string>>(new Set());
  // only ARMED on Confirm; the flight starts with the swap, else the ghost and the card flew in two flights
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [leavingHtml, setLeavingHtml] = useState<string | null>(null);
  const armedLeaving = useRef<{ html: string; fromId: string } | null>(null);
  const ghostTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureLeaving = () => {
    if (!cardRef.current) return;
    const fromId = cardRef.current.dataset.cardId ?? '';
    // strip testids so the decorative ghost never doubles a live element
    armedLeaving.current = { html: cardRef.current.innerHTML.replaceAll(/data-testid="[^"]*"/g, ''), fromId };
  };
  // a second tap while the confirm's writes run must not re-enter (it re-armed the ghost and wrote twice)
  const confirming = useRef(false);
  const [linkRecurring, setLinkRecurring] = useState(true);
  const [manualRecId, setManualRecId] = useState<string | null>(null);
  const [recPickOpen, setRecPickOpen] = useState(false);
  const [eventPick, setEventPick] = useState<string | null>(null);
  const [eventPickOpen, setEventPickOpen] = useState(false);
  // #161: the user's own event gesture outranks the memory's offer
  const eventTouched = useRef(false);
  const [recCreating, setRecCreating] = useState(false);
  const [eventCreating, setEventCreating] = useState(false);
  const [initialCount, setInitialCount] = useState<number | null>(null);

  // prepared when the row lands (application/reviewSuggestions); the deck waits for the map so nothing pops in later (#565)
  const suggestions = useReviewSuggestions();
  const suggestionsReady = suggestions !== undefined;

  const queue = useMemo(
    () => (suggestionsReady ? allTxs?.filter((item) => item.needsReview === 1).sort((a, b) => a.date.localeCompare(b.date)) : undefined),
    [allTxs, suggestionsReady],
  );
  useReviewedSettle(queue?.length);
  // a row nobody prepared, or one changed since (e.g. sent back by a heal), asks the pass, never the card; once per state
  const askedFor = useRef(new Set<string>());
  useEffect(() => {
    if (askOnce(askedFor.current, unpreparedStates(queue, suggestions))) requestReviewSuggestions(spaceId);
  }, [queue, suggestions, spaceId]);
  useEffect(() => {
    if (queue && initialCount === null) setInitialCount(queue.length || 1);
  }, [queue, initialCount]);

  const remaining = useMemo(() => queue?.filter((item) => !skipped.has(item.id)), [queue, skipped]);
  const tx = shownCard(heldTx, remaining);
  const heldDeck = heldDeckProps(!!counterBulk || !!receiptBulk);
  // the armed ghost takes off only when another card is up
  const shownId = tx?.id;
  useEffect(() => {
    const armed = armedLeaving.current;
    if (!armed || armed.fromId === shownId) return;
    armedLeaving.current = null;
    setLeavingHtml(armed.html);
    if (ghostTimer.current) clearTimeout(ghostTimer.current);
    ghostTimer.current = setTimeout(() => setLeavingHtml(null), 260);
  }, [shownId]);
  useEffect(
    () => () => {
      if (ghostTimer.current) clearTimeout(ghostTimer.current);
    },
    [],
  );
  useEffect(() => {
    const back = returnState.current;
    if (!back || tx?.id !== back.txId) return;
    returnState.current = null;
    if (back.reopenCats) setCatsOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx?.id]);

  const suggestion = useCardSuggestion(tx, suggestions);

  const cardAccount = useSpaceAccount(tx?.accountId);
  // the row's account stamps its type: the kind row locks and a counterparty pick keeps the stamp (R1)
  const ownStamp = accountStamp(cardAccount?.type);
  const spaceAccounts = useSpaceAccounts();
  // a row nobody prepared shows its own facts; a remembered counterparty still files the category its kind means
  const spreadDraft = useMemo(
    () => (tx ? (suggestion?.draft ?? fileRememberedCounter(initDraft(tx, undefined, cats), spaceAccounts, cats, tx.amountCents, ownStamp)) : null),
    [tx, suggestion, cats, spaceAccounts, ownStamp],
  );
  const receiptEntry = useTxReceiptEntry(tx?.id);
  const receiptProposals = useProposedMatches();
  const attachableReceipts = useAttachableReceipts();
  // one attached elsewhere says so under its row and stays pickable: several payments can share one receipt
  const receiptElsewhere = useMemo(() => attachedElsewhere(attachableReceipts?.attachedTo, tx?.id ?? ''), [attachableReceipts, tx?.id]);
  const describeReceiptTx = useMemo(() => describeTxFor(allTxs, lang, tx?.currency ?? 'EUR'), [allTxs, lang, tx?.currency]);
  const receiptOps = useReceiptOps();
  const [receiptPickOpen, setReceiptPickOpen] = useState(false);
  // the eye's receipt is kept apart from the open flag: it outlives the close (#496)
  const [receiptLook, setReceiptLook] = useState<ReceiptRow | null>(null);
  const [receiptLookOpen, setReceiptLookOpen] = useState(false);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptStage, setReceiptStage] = useState<ReceiptStage>(AUTO_STAGE);
  const attachedReceipt = receiptEntry?.data ?? null;
  const receiptProposal = useMemo(
    () => (attachedReceipt ? undefined : (receiptProposals ?? []).find((l) => l.proposedTxId === tx?.id)),
    [attachedReceipt, receiptProposals, tx?.id],
  );
  // the suggestions come from the unmatched receipts, never one taken off this transaction (#496)
  const receiptCandidates = useMemo(
    () => (tx ? candidatesFor(tx, attachableReceipts, receiptProposal?.receiptId) : []),
    [tx, attachableReceipts, receiptProposal?.receiptId],
  );
  // a receipt that lands while the card is up joins it: the card only checks the prepared best fit is still free (#565)
  const preparedReceiptId = suggestionFor(suggestions, tx)?.receiptId ?? suggestion?.receiptId;
  const autoReceipt = useMemo(
    () =>
      tx && !receiptProposal && !attachedReceipt && preparedReceiptId
        ? (receiptCandidates.find((r) => r.id === preparedReceiptId) ?? null)
        : null,
    [tx, receiptProposal, attachedReceipt, receiptCandidates, preparedReceiptId],
  );
  const filingReceipt = useMemo(
    () => cardReceipt(receiptStage, attachedReceipt, receiptProposal, autoReceipt),
    [receiptStage, attachedReceipt, receiptProposal, autoReceipt],
  );
  const receiptFiled = useReceiptFiled(tx, spreadDraft, stagedDraft, filingReceipt, cats);
  const draft = stagedDraft ?? receiptFiled?.draft ?? spreadDraft;
  const receiptRow = tx ? receiptRowFor({ attached: attachedReceipt, proposal: receiptProposal, stage: receiptStage, auto: autoReceipt }, tx.currency, lang, t) : null;
  const lookAtReceipt = (receipt: ReceiptRow) => {
    setReceiptLook(receipt);
    setReceiptLookOpen(true);
  };
  /** #542: a photo captured on the card attaches at once (Skip must not throw it away), in the attached receipt's place */
  const attachReceiptPhoto = async (file: File) => {
    if (!tx) return;
    setReceiptBusy(true);
    try {
      await receiptOps.attachPhoto(tx, file);
      if (receiptEntry) await dropAttached(receiptOps, receiptEntry, tx.id);
      setReceiptStage(AUTO_STAGE);
      setReceiptPickOpen(false);
    } finally {
      setReceiptBusy(false);
    }
  };
  const draftCounter = useSpaceAccount(draft?.linkedAccountId);
  // a loan/mortgage counterparty makes it a DEBT payment: the account IS the loan, so the recurring row retires —
  // a payoff transfer is not a recurring cost
  const isLoanCounter = loanCounterOf(draftCounter) !== undefined;
  const counterAcct = spaceAccounts?.find((a) => a.id === draft?.linkedAccountId);
  const counterBankFed = (counterAcct?.source ?? 'manual') !== 'manual';
  const peerFaceRow = useMemo(
    () => {
      const standingPeerId = pickedPeer?.txId ?? (releaseStored ? undefined : tx?.transferPeerId);
      return standingPeerId ? allTxs?.find((r) => r.id === standingPeerId) : undefined;
    },
    [tx?.transferPeerId, pickedPeer, releaseStored, allTxs],
  );
  const counterTxRow = counterTxDescriptor(tx, counterAcct, peerFaceRow, counterBankFed, lang, t, () => setCounterTxOpen(true));
  const events = useEvents();
  const activeEvents = useMemo(() => (events ?? []).filter((e) => e.archived !== 1), [events]);
  const pickedEvent = (events ?? []).find((e) => e.id === eventPick);
  // the row's own event stands (archived or not); else the memory's offer, an ACTIVE event of this space only,
  // until the user touches the event row (#161)
  const predictedEventId = useMemo(() => {
    if (tx?.eventId) return tx.eventId;
    const offered = suggestion?.eventId;
    return offered && activeEvents.some((e) => e.id === offered) ? offered : null;
  }, [tx?.eventId, suggestion?.eventId, activeEvents]);
  useEffect(() => {
    if (!eventTouched.current) setEventPick(predictedEventId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [predictedEventId, tx?.id]);
  const cat = cats.byId(draft?.catId);
  const parentColor = cat.parentId ? cats.byId(cat.parentId).color : cat.color;
  const multiPart = (draft?.splits?.filter((s) => s.catId !== REIMBURSED_ID).length ?? 0) > 1;

  // the recurring the row is linked to (the auto-linker's, kept while paused), else the one prepared for it (#565)
  const recMatch = useMemo(() => {
    const stored = tx?.recurringId || undefined;
    const id = stored ?? suggestion?.recurringId;
    return id ? recurrings?.find((r) => r.id === id && (r.id === stored || r.active === 1)) : undefined;
  }, [tx?.recurringId, suggestion?.recurringId, recurrings]);
  const activeRecs = useMemo(() => (recurrings ?? []).filter((r) => r.active === 1), [recurrings]);
  const manualRec = activeRecs.find((r) => r.id === manualRecId);

  // SP5: an incoming amount exactly matching an open split settlement to me is likely that person paying back
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

  // absolute partitions only fit exact twins (same amount); percentage ones scale to any amount (#211)
  const draftSplits = draft?.splits;
  const draftCats = draft?.cats;
  const similar = useMemo(() => {
    // a filing made from this card's receipt is this payment's alone: similar payments have receipts of their own
    if (!tx || !queue || receiptFiled) return [] as SpaceTx[];
    const key = merchantKey(tx.merchant);
    const mustMatchAmount =
      (!!draftSplits?.length && !splitsArePct(draftSplits)) ||
      (!!draftCats?.length && !draftCats.every((e) => e.pct != null));
    // skipped cards left the deck on purpose: bulk must not drag them back in
    return queue.filter(
      (item) =>
        item.id !== tx.id &&
        !skipped.has(item.id) &&
        // forward only (#268): the deck walks oldest to newest, so an older row syncing in mid-card never joins a decision
        item.date >= tx.date &&
        // decisions are sign-bound: a -€1000 sibling must never inherit a "received reimbursement" decision made on +€1000
        Math.sign(item.amountCents) === Math.sign(tx.amountCents) &&
        merchantKey(item.merchant) === key &&
        (!mustMatchAmount || item.amountCents === tx.amountCents),
    );
  }, [tx, queue, draftSplits, draftCats, skipped, receiptFiled]);

  // runs during render (prev-id ref), not in an effect: a late flush could undo input that landed right after the card swap
  useFreshCardReset(tx?.id, () => {
    setStagedDraft(null);
    setReceiptStage(AUTO_STAGE);
    setReceiptPickOpen(false);
    setReceiptLookOpen(false);
    setLinkRecurring(true);
    setManualRecId(null);
    setEventPick(null);
    setNoteDraft(null);
    setDescExpanded(false);
    setPartsAttention(false);
    setCounterRequired(false);
    setCatRequired(false);
    setSplitResetOpen(false);
    splitResetArmed.current = false;
    setPickedPeer(null);
    setReleaseStored(false);
    setPickWarn(null);
    setCounterTxOpen(false);
    eventTouched.current = false;
  });
  // the pick is bound to ITS counter account: re-picking or detaching the counterparty drops it
  useEffect(() => {
    if (pickedPeer && draft?.linkedAccountId !== pickedPeer.linkedId) setPickedPeer(null);
  }, [draft?.linkedAccountId, pickedPeer]);
  useEffect(() => {
    if (draft?.linkedAccountId) setCounterRequired(false);
  }, [draft?.linkedAccountId]);
  // keyed on MEMBERSHIP, not array identity: the native SQL backend re-emits unchanged rows every sync cycle and
  // an identity reset re-armed boxes the user had cleared; new arrivals join checked, unchecks survive only within
  // the same card: a NEW card starts at select-all (#340)
  const similarKey = useMemo(() => similar.map((s) => s.id).sort((a, b) => a.localeCompare(b)).join(','), [similar]);
  const prevSimilar = useRef<{ cardId: string | null; ids: ReadonlySet<string> }>({ cardId: null, ids: new Set() });
  useEffect(() => {
    const ids = similarKey ? similarKey.split(',') : [];
    const prev = prevSimilar.current;
    const cardId = tx?.id ?? null;
    prevSimilar.current = { cardId, ids: new Set(ids) };
    const sameCard = prev.cardId === cardId;
    setBulkSelected((sel) => new Set(ids.filter((id) => (sameCard && prev.ids.has(id) ? sel.has(id) : true))));
  }, [similarKey, tx?.id]);

  // quick-creating the counterparty mid-review: the card stages title, currency, payment, due day and a monthly plan (#326)
  useEffect(() => {
    if (!tx) return undefined;
    setChooserLoanPrefill({
      name: txTitle(tx),
      currency: tx.currency,
      paymentCents: Math.abs(tx.amountCents),
      paymentDay: Math.min(28, Number(tx.date.slice(8, 10)) || 1),
      paymentEvery: guessCadence([tx.date, ...similar.map((s) => s.date)]),
    });
    return () => setChooserLoanPrefill(null);
    // similarKey stands in for the similar array's identity churn
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx?.id, similarKey]);

  // the recurring owns the category: linking one stages it, and the editor then only offers it or expected reimbursement
  const debtFiled = isLoanCounter || specialCatType(draft?.catId) === 'debtPayment';
  const moneyIn = !!tx && !canBeRecurringCost(tx.amountCents);
  const chosenRec = useMemo(() => {
    if (debtFiled || moneyIn) return undefined; // neither a debt payment nor money coming in carries a recurring link
    const id = chosenRecurringId(recMatch, linkRecurring, manualRecId);
    return id ? (recurrings ?? []).find((r) => r.id === id) : undefined;
  }, [recMatch, linkRecurring, manualRecId, recurrings, debtFiled, moneyIn]);
  useEffect(() => {
    if (!chosenRec?.catId || !draft) return;
    // a split container never takes the recurring's category: the parts own theirs
    if (multiPartSplits(draft)) return;
    if (draft.catId === chosenRec.catId || draft.catId === EXPECTED_REIMBURSE_ID) return;
    // the recurring owns ONE category: a staged spread steps aside too
    setStagedDraft(withCategory(withSplits({ ...draft, cats: undefined }, undefined), chosenRec.catId, cats));
    // once per selection — the pick itself is the trigger, not the draft
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenRec?.id, chosenRec?.catId]);
  const recurringAllowedCats = chosenRec?.catId ? [chosenRec.catId, EXPECTED_REIMBURSE_ID] : undefined;

  const catChosen = !!draft?.catId && draft.catId !== UNCATEGORIZED_ID;
  const gates = cardRowGates(draft, { recurringOwnsCategory: !!recurringAllowedCats, loanCounter: isLoanCounter, moneyIn });
  const counterRowDoors = buildCounterRowDoors({
    draft,
    locked: !gates.counter,
    amountCents: tx?.amountCents,
    cats,
    setCounterAskCat,
    counterFallback,
    setCounterOpen,
    counterChosen,
    setStagedDraft,
  });

  const showReason = !!tx && !stagedDraft && !!suggestion?.source && suggestion.predictedCatId === draft?.catId;
  const reasonLine = cardReason(!!receiptFiled, showReason ? suggestion : undefined, t);

  // the cats editor spreads the NET money: a settled `reimbursed` entry is held aside, re-attached on stage (#211)
  const spreadRowCount = draft?.cats?.filter((e) => e.catId !== REIMBURSED_ID).length ?? 0;
  const settledCatEntry = draft?.cats?.find((e) => e.catId === REIMBURSED_ID);
  const settledCatsCents = settledCatEntry?.amountCents ?? 0;

  const settledCatsFor = (catId: string) =>
    settledCatEntry
      ? [
          ...(Math.abs(tx?.amountCents ?? 0) - settledCatsCents > 0
            ? [{ catId, amountCents: Math.abs(tx?.amountCents ?? 0) - settledCatsCents }]
            : []),
          settledCatEntry,
        ]
      : undefined;

  /** the armed split reset lands at the editor's Done: drops staged event/recurring/note picks, returns the baseline (#330) */
  const takeSplitResetBase = (): ReviewDraft | null => {
    if (!splitResetArmed.current) return null;
    splitResetArmed.current = false;
    eventTouched.current = true; // a conscious reset — the offer stays down
    setEventPick(null);
    setManualRecId(null);
    setNoteDraft(null);
    return spreadDraft;
  };

  const stageSingleCategory = (catId: string, from?: ReviewDraft | null) => {
    const src = from ?? draft;
    if (!src) return;
    const family = specialCatType(catId);
    // a Transfer pick stages NOTHING yet: the mandatory counterparty answers it (dismiss = rollback); an unlinked transfer
    // is unrepresentable (#133)
    if (family === 'transfer' && !ownStamp) {
      counterFallback.current = src;
      setCounterAskCat(catId);
      setCounterOpen(true);
      return;
    }
    const next = { ...withCategory(withSplits(src, undefined), catId, cats), cats: settledCatsFor(catId) };
    // a REGULAR pick ends any movement story: the counterparty clears with it (#228)
    setStagedDraft(family || ownStamp ? next : { ...next, linkedAccountId: undefined });
    // a family pick asks the counterparty right away (bare is legal; Confirm links the default, #221); Funding asks
    // WHICH funding account, its shared pot pinned (#152)
    if (family && family !== 'transfer' && !next.linkedAccountId && !ownStamp) {
      setCounterAskCat(catId);
      counterFallback.current = null;
      setCounterOpen(true);
    }
  };

  /** the editor answered its counterparty already; a BARE entry clears the row link too (#218, #228) */
  const stageSingleEntry = (entry: CatsApplyEntry) => {
    if (!draft) return;
    const next = { ...withCategory(withSplits(draft, undefined), entry.catId, cats), cats: settledCatsFor(entry.catId) };
    setStagedDraft({ ...next, linkedAccountId: entry.linkedAccountId });
  };

  const pointAtBlocker = (blocked: ReviewDraft) => {
    if (multiPartSplits(blocked)) setPartsAttention(true);
    else if (!catChosen) setCatRequired(true);
    else setCounterRequired(true);
  };

  const settleReceipt = async () => {
    if (!tx || multiPart) return;
    const plan = receiptSettlement(receiptStage, attachedReceipt, receiptProposal, autoReceipt);
    if (plan.kind === 'accept') await receiptOps.acceptMatch(plan.proposal);
    else if (plan.kind === 'reject') await receiptOps.rejectMatch(plan.proposal);
    else if (plan.kind === 'pick') {
      if (plan.reject) await receiptOps.rejectMatch(plan.reject);
      await applyPick(receiptOps, tx.id, receiptEntry ?? null, plan.receipt);
    }
    await keepFiledPicks(receiptOps, spaceId, tx.id, receiptFiled, { receiptId: attachedReceipt?.id, linkId: receiptEntry?.linkId });
  };

  /** the counter queue first: the receipt walk then takes the siblings it settled (#268, #495) */
  const startBulkWalks = (queued: ReturnType<typeof queuedCounterBulk>, receiptWalk: SpaceTx[]) => {
    if (queued) {
      counterSettled.current = new Set();
      pendingReceiptBulk.current = receiptWalk.length > 0 ? receiptWalk : null;
      setCounterBulk(queued);
    } else if (receiptWalk.length > 0) setReceiptBulk(receiptWalk);
  };

  // one 'review.confirm' span carries every write, so a slow Confirm shows in GlitchTip's Performance view with its waterfall
  const runConfirm = async () => {
    // a held deck accepts no further confirms (#268), nor a space read-only to this identity (#505)
    if (!tx || !draft || counterBulk || receiptBulk || confirming.current || !canEdit) return;
    if (!draftReady(draft)) {
      pointAtBlocker(draft);
      return;
    }
    // a movement category REQUIRES its counterparty, a debt payment its loan: no silent default (#309, #555)
    if (isMovementCat(draft.catId) && !draft.linkedAccountId && !draft.cats?.length && !draft.splits?.length) {
      setCounterRequired(true);
      return;
    }
    // a split container carries no recurring/event of its own: the parts do
    const container = !multiPartSplits(draft);
    // a pick on any PART is specific to this transaction: bulk stands down; a ROW-level pick keeps bulk (#237, #268)
    const partPeers = (draft.splits ?? []).filter((s) => s.transferPeerId && s.catId !== REIMBURSED_ID);
    const bulk = partPeers.length > 0 ? [] : similar.filter((s) => bulkSelected.has(s.id));
    // a disabled row writes nothing (#565)
    const recurringId = container && gates.recurring ? chosenRecurringId(recMatch, linkRecurring, manualRecId) : undefined;
    const eventId = container && gates.event ? (eventPick ?? undefined) : undefined;
    const note = stagedNoteFor(noteDraft, container, tx.notes);
    const queued = queuedCounterBulk(pickedPeer, bulk, draft, spaceAccounts, recurringId, eventId, note);
    // read now, while the siblings' review flag still stands (#495)
    const receiptWalk = container ? receiptsToVerify(bulk, attachableReceipts, receiptProposals) : [];
    // a coming queue freezes the deck on this card; the exit flight plays when it finishes (#268)
    if (queued || receiptWalk.length > 0) setHeldTx(tx);
    else captureLeaving();
    confirming.current = true;
    try {
      // the gate above guarantees every movement confirm carries its picked link (#309); a stored pair re-pointed,
      // released or orphaned lets its peer leg go first, else a stale peer keeps collapsing the pair in the list
      const { releasePeer, pairNew } = pairReleasePlan(tx, draft, pickedPeer, releaseStored);
      // the confirm's writes are one burst, so the screens refresh once when all has landed (Confirm took 3–4 s)
      await repo.batch(async () => {
        if (releasePeer) await releasePeerLeg(store, repo, spaceId, tx, allTxs);
        await writeConfirmation({
          tx,
          draft,
          recurringId,
          eventId,
          note,
          bulk: pickedPeer ? [] : bulk,
          transform,
          pairPeerId: pickedPeer?.txId,
          releasePeer: releasePeer && !pickedPeer,
        });
        await pairReviewPicks({ store, repo, spaceId }, tx, pairNew, partPeers);
        await settleReceipt();
      });
      startBulkWalks(queued, receiptWalk);
      // other billing cycles of a linked recurring adopt the link in an idle moment, off the tap's path (#554)
      if (recurringId || draft.splits?.some((s) => !!s.recurringId)) runWhenIdle(() => void recurringOps.reconcile().catch(() => undefined));
      // what this card taught reaches the cards still waiting: no stored input shows that the memory moved
      if ((queue?.length ?? 0) > 1) requestReviewSuggestions(spaceId);
      logConfirmActivity({ store, repo, spaceId }, tx, !!pickedPeer, bulk.length);
      hapticNotify('SUCCESS');
    } finally {
      confirming.current = false;
    }
  };
  const confirm = () => measure('review.confirm', runConfirm);

  const resolveCounterBulk = async (item: SpaceTx, peerId: string | null) => {
    if (!counterBulk) return;
    await transform(
      item,
      {
        ...bulkFieldsFor(item, counterBulk.draft, counterBulk.recurringId, counterBulk.eventId, counterBulk.note),
        ...(peerId ? { transferPeerId: peerId } : {}),
      },
      null,
    );
    if (peerId) await pairWithExistingRow(store, repo, spaceId, item, peerId, allTxs);
    counterSettled.current.add(item.id);
  };

  const { progress, sub } = progressState(initialCount, queue?.length, skipped.size);

  const emptyBecauseSkipped = queue && queue.length > 0 && remaining?.length === 0;

  // desktop: Enter confirms, ←/→ skips — never while a sheet is open or the focus sits in an input
  useEffect(() => {
    if (!tx) return;
    const onKey = (e: KeyboardEvent) => {
      if (counterBulk || receiptBulk) return;
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
      <div className="h-0.5 shrink-0 bg-bg-2">
        <div className="h-full bg-accent transition-[width]" style={{ width: `${progress * 100}%` }} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-6">
        {/* the first-time nudge comes BEFORE the user works the deck; one dismissible line, never returns */}
        <IntroCard tourId="review" />
        <ReadOnlyNote className="mt-3" testId="review-readonly-note" />
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
          /* desktop starts where the SIDEBAR does (md), not lg: 900px kept the mobile bottom-pinned buttons;
          TOP-anchored, since vertical centering floated the card mid-screen (#151) */
          <div
            /* a held deck is inert: the queue sheet owns the screen (#268) */
            className={`relative flex min-h-0 flex-1 flex-col md:mx-auto md:w-[520px] md:flex-none md:pb-10${heldDeck.inertCls}`}
          >
            {leavingHtml && (
              <div
                aria-hidden
                className="m-card-out pointer-events-none absolute inset-x-0 top-0 z-10"
                // our own just-rendered markup, snapshotted for the exit flight
                dangerouslySetInnerHTML={{ __html: leavingHtml }} // NOSONAR
              />
            )}
            {/* #666: beside the sidebar the buttons hang under the card, so every card would move them: a description line
                more, the bulk strip coming or going. The room of a full card is kept, and they stand still */}
            <div key={`card-${tx.id}`} ref={cardRef} data-card-id={tx.id} data-testid="review-card-room" className={`m-card-in ${CARD_ROOM_MD}`}>
            <div
              className="mt-4 overflow-hidden rounded-card border border-line bg-surface"
              data-testid="review-card"
              data-held={heldDeck.marker}
            >
              <div className="px-4 pt-3 pb-2.5">
                <div className="text-[11px] text-ink-4" data-testid="review-card-meta">
                  {new Intl.DateTimeFormat(LOCALES[lang], { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(tx.date))}
                  {cardAccount && <span> · {cardAccount.name}</span>}
                </div>
                {/* the title wraps instead of truncating; the amount stays aligned to the first line (#339) */}
                <div className="mt-0.5 flex items-start justify-between gap-3">
                  <span className="min-w-0 flex-1 text-[16px] leading-snug font-semibold break-words text-ink" data-testid="review-card-title">
                    {txTitle(tx)}
                    <TitleSearchButton query={txTitle(tx)} testId="review-search-web" />
                  </span>
                  <span className="m-num shrink-0 text-[18px] leading-snug text-ink">{fmtCents(tx.amountCents, tx.currency, lang, { sign: true })}</span>
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

              {/* multi-part: these rows vanish, each part carries its own story (#126); inert where the space is read-only (#505) */}
              <div data-testid="review-cats" inert={readOnlyRegion}>
                {!multiPart && (
                  <button
                    data-testid="review-split-row"
                    onClick={requestSplit}
                    className="m-tap flex w-full items-center gap-2.5 border-none bg-transparent px-4 py-2.5 text-left text-[14px] text-ink"
                  >
                    <Icon name="call-split" size={18} color="var(--m-ink-3)" />
                    <span className="min-w-0 flex-1 truncate">{t('split.title')}</span>
                    <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />
                  </button>
                )}

                <CardCategoryRows
                  draft={draft}
                  fallbackCat={cat}
                  fallbackColor={parentColor}
                  currency={tx.currency}
                  onOpenCategories={() => setCatsOpen(true)}
                  onEditCounter={counterRowDoors.onEdit}
                  counterRequired={counterRequired}
                  counterTx={counterTxRow}
                />
                <FormBlockerNote show={catRequired && !catChosen} text={t('review.catRequired')} testId="review-cat-required" className="px-4 pb-2" />

                {/* rows stand on every card, disabled where the filing cannot use them (#565); recurring is open pre-category (#525) */}
                {!multiPart && (
                  <DebtOrRecurringRow
                    enabled={gates.recurring}
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
                    disabled={!gates.event}
                    aria-disabled={!gates.event}
                    className={`m-tap flex w-full items-center gap-2.5 border-none bg-transparent px-4 py-2.5 text-left text-[14px] text-ink${rowOff(gates.event)}`}
                  >
                    <Icon name="party-popper" size={18} color="var(--m-ink-3)" />
                    <span className="min-w-0 flex-1 truncate">{(gates.event ? pickedEvent?.name : undefined) ?? t('events.linkNone')}</span>
                    <span className="text-[11px] text-ink-4">{t('events.linkTitle')}</span>
                    {gates.event && <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />}
                  </button>
                )}

                {!multiPart && receiptRow && (
                  <ReviewReceiptRow
                    row={receiptRow}
                    onLook={lookAtReceipt}
                    onAsk={() => setReceiptPickOpen(true)}
                  />
                )}
                <EntryReviewRow tx={tx} />

                {!multiPart && (
                  <div className="flex w-full items-start gap-2.5 px-4 py-2.5">
                    <Icon name="note-text-outline" size={18} color="var(--m-ink-3)" style={{ marginTop: 8 }} />
                    <textarea
                      data-testid="review-notes"
                      value={noteDraft ?? tx.notes ?? ''}
                      onChange={(e) => {
                        setNoteDraft(e.target.value);
                        autoGrowNotes(e.currentTarget);
                      }}
                      placeholder={t('tx.notesPlaceholder')}
                      rows={1}
                      className="min-w-0 flex-1 resize-none rounded-input border border-line bg-surface px-3 py-2 text-[14px] leading-snug text-ink outline-none placeholder:text-ink-4"
                    />
                    <span className="text-[11px] text-ink-4" style={{ marginTop: 10 }}>{t('tx.notes')}</span>
                  </div>
                )}

              </div>

              {/* no "between your own accounts" chip: the category row names the link, detaching lives in the ask (#219, #218) */}
              {settleMatch && draft && (
                <div className="px-4 pb-3" inert={readOnlyRegion}>
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

            <div inert={readOnlyRegion}>
            {draft && (
              <ReviewPartDeck
                key={tx.id}
                splits={draft.splits}
                rowType={draft.txType}
                tx={tx}
                activeEvents={events ?? []}
                // parts pick freely: a split confirm never carries the recurring link (container-only) (#289)
                allowedCatIds={undefined}
                lockedKind={!!ownStamp}
                recurrings={activeRecs}
                attention={partsAttention}
                onOpenValues={() => setSplitOpen(true)}
                onSplits={(next) => setStagedDraft(withSplits(draft, next))}
                onPickExisting={(stage) => stageWithBulkWarning(similar.length, stage, setPickWarn)}
              />
            )}

            {/* a PART-level pick silences the bulk offer; a row-level pick keeps it (#237, #268) */}
            {!(draft?.splits ?? []).some((s) => s.transferPeerId) && (
              <BulkConfirmSection similar={similar} selected={bulkSelected} onChange={setBulkSelected} />
            )}
            </div>
            </div>

            {/* mobile: pinned to the thumb at the bottom; md+: attached to the card */}
            <div className="mt-auto flex gap-3 pt-4 md:mt-0">
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
                // stays TAPPABLE: the tap marks what blocks (#410); never where the space is read-only (#505)
                disabled={!draft || !canEdit}
                onClick={() => void confirm()}
              >
                <span className="truncate">
                  {draft?.catId && !draft.splits?.length && spreadRowCount <= 1
                    ? t('review.confirmAs', { name: catName(cat, t) })
                    : t('review.confirm')}
                </span>
              </Button>
            </div>
          </div>
        )}
      </div>

      {tx && draft && (
        <SplitEditorSheet
          open={splitOpen}
          // closing without Done stands the armed reset down (#330)
          onOpenChange={(next) => {
            setSplitOpen(next);
            if (!next) splitResetArmed.current = false;
          }}
          tx={tx}
          // empty value: the editor seeds the current category with the full amount plus one fresh row
          value={draft.splits}
          seedSingle
          seedCatId={draft.catId}
          onApply={(splits) => {
            setStagedDraft(withSplits(takeSplitResetBase() ?? draft, splits ?? undefined));
          }}
          onApplySingle={(catId) => stageSingleCategory(catId, takeSplitResetBase())}
        />
      )}
      {/* a spread drops the row-level link; a lone ◆ pick asks its counterparty inside the editor (#211, #228) */}
      {tx && draft && (
        <CatsSheet
          open={catsOpen}
          onOpenChange={setCatsOpen}
          subject={{
            id: tx.id,
            label: txTitle(tx),
            catId: draft.catId,
            // the FULL partition rides in: the sheet pins settled bookkeeping read-only and nets the gross (#228)
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
          // the create-category detour stashes the deck's place and returns to this card with the editor reopened (#275)
          onCreateCustomNav={() => setReviewReturn({ skippedIds: [...skipped], txId: tx.id, reopenCats: true })}
          // pick-by-counter: counter-able accounts as filter chips (#339)
          counterPickAccounts={(spaceAccounts ?? [])
            .filter((a) => a.id !== tx.accountId && !a.archived && COUNTERABLE_ACCOUNT_TYPES.has(a.type))
            .map((a) => ({ id: a.id, name: a.name, type: a.type }))}
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
      {/* splitting resets the card's own decisions: a conscious continue, never a silent drop */}
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
      {/* pointing at an EXISTING counter transaction turns bulk off: the siblings' counterparts can't be predicted (#237) */}
      <Sheet
        open={pickWarn !== null}
        onOpenChange={(next) => {
          if (!next) setPickWarn(null);
        }}
        title={t('review.pickBulkTitle')}
        size="form"
      >
        <p className="pb-4 text-[13px] leading-relaxed text-ink-2" data-testid="review-pick-warn">
          {t('review.pickBulkBody', { n: pickWarn?.n ?? 0 })}
        </p>
        <div className="flex flex-col gap-2">
          <Button
            data-testid="review-pick-continue"
            onClick={() => {
              pickWarn?.stage();
              setPickWarn(null);
            }}
          >
            {t('review.pickBulkGo')}
          </Button>
          <Button variant="outline" data-testid="review-pick-cancel" onClick={() => setPickWarn(null)}>
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
          amountCents={tx.amountCents}
          defaultFamily={askDefaultFamily(counterAskCat)}
          counterTypes={askCounterTypes(counterAskCat)}
          // ONE tap, no fork sheet after the pick: the Counter-transaction row owns the leg question (#237)
          onChoose={(account) => {
            counterChosen.current = true;
            setStagedDraft(withLinkedAccount(draft, account, cats, tx?.amountCents, ownStamp));
          }}
          // removal resets the pick: the counterparty and the category are one fact (#228)
          onDetach={counterRowDoors.onDetach}
        />
      )}
      {/* picker shared with the transaction detail; a pick stages it for the confirm; a photo attaches at once (#542) */}
      {tx && (
        <ReceiptPickSheet
          open={receiptPickOpen}
          onOpenChange={setReceiptPickOpen}
          title={t('receipt.title')}
          testIdPrefix="review-receipt"
          proposal={receiptProposal}
          candidates={suggestionsFor(attachedReceipt, receiptCandidates)}
          all={attachableReceipts?.rows ?? []}
          selectedId={markedReceiptId(receiptStage, attachedReceipt?.id, autoReceipt?.id)}
          attachedId={attachedReceipt?.id ?? null}
          noneSelected={receiptStage.kind === 'none'}
          currency={tx.currency}
          attachedTo={receiptElsewhere}
          describeTx={describeReceiptTx}
          onAccept={(link) => { void receiptOps.acceptMatch(link); setReceiptPickOpen(false); }}
          onReject={(link) => { void receiptOps.rejectMatch(link); setReceiptPickOpen(false); }}
          onPick={(row) => { setReceiptStage(row ? { kind: 'picked', receipt: row } : { kind: 'none' }); setReceiptPickOpen(false); }}
        >
          <ReceiptCaptureRungs testIdPrefix="review-receipt" busy={receiptBusy} onFile={(file) => void attachReceiptPhoto(file)} />
        </ReceiptPickSheet>
      )}
      <ReceiptPeekSheet
        open={receiptLookOpen}
        onOpenChange={setReceiptLookOpen}
        receipt={receiptLook}
        currency={tx?.currency ?? 'EUR'}
        testIdPrefix="review-receipt-look"
      />
      {/* a held deck folds it away: the queue's own match sheet is the only one on screen (#268) */}
      {tx && counterAcct && !counterBulk && (
        <CounterMatchSheet
          open={counterTxOpen}
          onOpenChange={setCounterTxOpen}
          target={{ id: counterAcct.id, name: counterAcct.name }}
          anchor={{ id: tx.id, amountCents: tx.amountCents, date: tx.date }}
          rows={allTxs ?? []}
          onCreate={resetPickDoor(counterBankFed, false, () => { setPickedPeer(null); setReleaseStored(!!tx.transferPeerId); })}
          onWait={resetPickDoor(counterBankFed, true, () => { setPickedPeer(null); setReleaseStored(!!tx.transferPeerId); })}
          onPick={(pickedId) => {
            setReleaseStored(false);
            setPickedPeer({ txId: pickedId, linkedId: counterAcct.id });
          }}
        />
      )}
      {counterBulk && (
        <BulkCounterQueue
          queue={counterBulk.items}
          target={counterBulk.target}
          rows={allTxs ?? []}
          onResolve={(item, peerId) => void resolveCounterBulk(item as SpaceTx, peerId)}
          onDone={(resolved) => {
            if (resolved > 0) void logActivity(store, repo, spaceId, 'review', `+${resolved}`);
            setCounterBulk(null);
            // the receipt walk follows over the siblings the queue settled; the hold stays (#495)
            const walk = (pendingReceiptBulk.current ?? []).filter((item) => counterSettled.current.has(item.id));
            pendingReceiptBulk.current = null;
            if (walk.length > 0) {
              setReceiptBulk(walk);
              return;
            }
            // release the hold: the deferred exit flight plays now and the deck advances (#268)
            captureLeaving();
            setHeldTx(null);
          }}
        />
      )}
      {receiptBulk && (
        <BulkReceiptQueue
          queue={receiptBulk}
          onDone={() => {
            captureLeaving();
            setReceiptBulk(null);
            setHeldTx(null);
          }}
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
            // the auto-match keeps toggle semantics: picking it re-arms the link, "no link" disarms; anything else is a manual pick
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
      {/* onSaved carries the new id: sniffing the live-query list after close was a lost race, so "create" never attached */}
      {recCreating && tx && (
        <RecurringFormSheet
          initial={{ ...formFromTx(tx), catId: stagedRealCatId(draft?.catId) }}
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
                eventTouched.current = true;
                setEventPick(null);
                setEventPickOpen(false);
              }}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink-2"
            >
              <Icon name="close-circle-outline" size={18} color="var(--m-ink-4)" />
              <span className="min-w-0 flex-1 truncate">{t('events.linkNone')}</span>
              {!eventPick && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
            </button>
            <EventPickList
              events={events ?? []}
              selectedId={eventPick}
              testIdPrefix="review-event-"
              onPick={(id) => {
                eventTouched.current = true;
                setEventPick(id);
                setEventPickOpen(false);
              }}
            />
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
          onSaved={(id) => {
            eventTouched.current = true;
            setEventPick(id);
          }}
          onClose={() => setEventCreating(false)}
        />
      )}
    </div>
  );
}
