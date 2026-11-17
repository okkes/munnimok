import { REIMBURSED_ID, UNCATEGORIZED_ID, autoSubFor, isMovementCat, stampMovementSub } from './categories';
import { defaultFamilyFor } from './defaultAccounts';
import { primaryCatId } from './splits';
import { standardTypeFor } from './txKind';
import type { TxKind } from './txKind';
import { categoryConflictsWithType, familyForCounter, movementCatFor } from './txType';
import type { AccountType, TxSplit, TxSplitCat, TxType } from '@/db/types';

// every control edits this staged draft; only Confirm writes. Every transition re-applies the coherence rules,
// so type and category never drift: a type change that invalidates the category asks again, clearing splits too
export interface ReviewDraft {
  catId?: string;
  txType: TxType;
  linkedAccountId?: string;
  /** #211: the row's own category spread; mutually exclusive with staged split parts */
  cats?: TxSplitCat[];
  splits?: TxSplit[];
}

export interface DraftCatalog {
  byId(id: string | undefined): { txTypes: TxType[] };
}

const conflicts = (catalog: DraftCatalog, catId: string | undefined, txType: TxType): boolean =>
  catId !== undefined && categoryConflictsWithType(catalog.byId(catId).txTypes, txType);

export function initDraft(
  tx: { catId?: string; txType: TxType; linkedAccountId?: string; cats?: TxSplitCat[]; splits?: TxSplit[] },
  predictedCatId: string | undefined,
  catalog: DraftCatalog,
): ReviewDraft {
  const existing = tx.catId && tx.catId !== UNCATEGORIZED_ID ? tx.catId : undefined;
  const base: ReviewDraft = {
    txType: tx.txType,
    linkedAccountId: tx.linkedAccountId,
    cats: tx.cats?.length ? tx.cats : undefined,
    splits: tx.splits?.length ? tx.splits : undefined,
  };
  // a row whose categories stand (spread or parts) but whose compat shadow is the placeholder must not open on
  // "Pick a category first": the partition's own primary names the card, and no prediction outranks it
  return withCategory(base, existing ?? partitionPrimary(base) ?? predictedCatId, catalog);
}

/** the settled `reimbursed` slice is bookkeeping, never the face */
function partitionPrimary(draft: ReviewDraft): string | undefined {
  if (draft.cats?.length) {
    const real = draft.cats.filter((c) => c.catId !== REIMBURSED_ID);
    const pool = real.length ? real : draft.cats;
    return pool.reduce((best, e) => (e.amountCents > best.amountCents ? e : best), pool[0]).catId;
  }
  if (draft.splits?.length) return primaryCatId(draft.splits);
  return undefined;
}

export function withCategory(draft: ReviewDraft, catId: string | undefined, catalog: DraftCatalog): ReviewDraft {
  if (!catId) return { ...draft, catId: undefined };
  const types = catalog.byId(catId).txTypes;
  const txType = types.length === 0 || types.includes(draft.txType) ? draft.txType : types[0];
  return { ...draft, catId, txType };
}

/** a now-invalid category (and partition, parts or spread) is cleared: ask again */
export function withType(draft: ReviewDraft, txType: TxType, catalog: DraftCatalog): ReviewDraft {
  const partitionConflict =
    [...(draft.splits ?? []), ...(draft.cats ?? [])].some((s) => conflicts(catalog, s.catId, txType));
  if (partitionConflict || conflicts(catalog, draft.catId, txType)) {
    return { ...draft, txType, catId: undefined, cats: undefined, splits: undefined };
  }
  return { ...draft, txType };
}

export function withKind(draft: ReviewDraft, kind: TxKind, amountCents: number, catalog: DraftCatalog): ReviewDraft {
  if (kind === 'standard') return withType({ ...draft, linkedAccountId: undefined }, standardTypeFor(amountCents), catalog);
  if (kind === 'adjustment') return withType({ ...draft, linkedAccountId: undefined }, 'adjustment', catalog);
  // an already-linked counterparty keeps its derived member; otherwise plain 'transfer' until the pick lands
  return withFamilyCategory(withType(draft, draft.linkedAccountId ? draft.txType : 'transfer', catalog), amountCents);
}

// a transfer-family draft without a real category files under the family's sign-picked locked sub
// a deliberate category is never touched
export function withFamilyCategory(draft: ReviewDraft, amountCents: number): ReviewDraft {
  if (draft.splits?.length || draft.cats?.length) return draft;
  const sub = autoSubFor(draft.txType, amountCents);
  if (!sub) return draft;
  if (draft.catId && draft.catId !== UNCATEGORIZED_ID) return draft;
  return { ...draft, catId: sub };
}

// #133: the counter account names the family (a savings counter means saving, not a blanket transfer);
// a conflicting or placeholder category files under the family's sign-picked sub
// a stamped row (R1) keeps its stamp: the movement sub is forced from the special account's side (Q8)
export function withLinkedAccount(
  draft: ReviewDraft,
  account: { id: string; type: AccountType } | null,
  catalog: DraftCatalog,
  amountCents?: number,
  ownStamp?: TxType,
): ReviewDraft {
  if (!account) return { ...draft, linkedAccountId: undefined };
  if (ownStamp) {
    return {
      ...draft,
      linkedAccountId: account.id,
      txType: ownStamp,
      ...(amountCents === undefined ? {} : { catId: stampMovementSub(ownStamp, amountCents) }),
    };
  }
  const next = withType({ ...draft, linkedAccountId: account.id }, familyForCounter(account.type), catalog);
  return amountCents === undefined ? next : withCounterCategory(next, account.type, amountCents);
}

// a placeholder category files the sub the counter's kind means (ATM pair for cash wallets)
// a deliberate category is never touched
function withCounterCategory(draft: ReviewDraft, accountType: AccountType, amountCents: number): ReviewDraft {
  if (draft.splits?.length || draft.cats?.length) return draft;
  if (draft.catId && draft.catId !== UNCATEGORIZED_ID) return draft;
  return { ...draft, catId: movementCatFor(accountType, amountCents) };
}

/** the largest slice represents the whole; a container owns no category spread (#211) */
export function withSplits(draft: ReviewDraft, splits: TxSplit[] | undefined): ReviewDraft {
  if (!splits?.length) return { ...draft, splits: undefined };
  return { ...draft, splits, cats: undefined, catId: primaryCatId(splits) };
}

/** #211: one entry collapses to the plain category; several keep the spread (largest = shadow); parts clear */
export function withCats(draft: ReviewDraft, entries: TxSplitCat[] | undefined): ReviewDraft {
  if (!entries || entries.length <= 1) {
    return { ...draft, cats: undefined, ...(entries?.length ? { catId: entries[0].catId } : {}) };
  }
  const primary = entries.reduce((best, e) => (e.amountCents > best.amountCents ? e : best), entries[0]);
  return { ...draft, cats: entries, splits: undefined, catId: primary.catId };
}

// Confirm needs a real category: never confirm Uncategorized, which review exists to fix
// transfers are the exception: they use the hidden 'uncategorized' builtin as a by-design placeholder
export const draftReady = (draft: ReviewDraft): boolean => {
  if (!draft.catId) return false;
  // R2: a transfer needs its tracked counter account; a movement category stays "ready" while bare so Confirm stays
  // tappable, but the tap refuses with "Counterparty required" (#309); no default account answers for the person (#546)
  if (draft.txType === 'transfer') {
    return !!draft.linkedAccountId || (isMovementCat(draft.catId) && defaultFamilyFor(draft.catId) !== 'transfer');
  }
  // adjustments are corrections, not spending (#152: a funding-pot counterparty derives the funding family)
  if (draft.txType === 'funding' || draft.txType === 'adjustment') return true;
  // #126: the only hold-back on a split is an uncategorized part; the deck badges it when Confirm is tried
  if (draft.catId === 'uncategorized') return false;
  return ![...(draft.splits ?? []), ...(draft.cats ?? [])].some((slice) => slice.catId === 'uncategorized');
};
