import { UNCATEGORIZED_ID } from './categories';
import { primaryCatId } from './splits';
import { categoryConflictsWithType, typeForLinkedAccount } from './txType';
import type { AccountType, TxSplit, TxType } from '@/db/types';

/**
 * The review card's staged decision (review redesign, approved): every
 * control edits this DRAFT, only Confirm writes. Type ⇄ category can
 * never drift apart because every transition re-applies the coherence
 * rules — a type change that invalidates the category ASKS AGAIN
 * (user ruling #1), and splits are single-type (user ruling #2), so an
 * invalidating type change clears them together with the category.
 */
export interface ReviewDraft {
  catId?: string;
  txType: TxType;
  linkedAccountId?: string;
  splits?: TxSplit[];
}

export interface DraftCatalog {
  byId(id: string | undefined): { txTypes: TxType[] };
}

const conflicts = (catalog: DraftCatalog, catId: string | undefined, txType: TxType): boolean =>
  catId !== undefined && categoryConflictsWithType(catalog.byId(catId).txTypes, txType);

/** the card's starting point: the transaction's own state + the prediction */
export function initDraft(
  tx: { catId?: string; txType: TxType; linkedAccountId?: string; splits?: TxSplit[] },
  predictedCatId: string | undefined,
  catalog: DraftCatalog,
): ReviewDraft {
  const existing = tx.catId && tx.catId !== UNCATEGORIZED_ID ? tx.catId : undefined;
  const base: ReviewDraft = {
    txType: tx.txType,
    linkedAccountId: tx.linkedAccountId,
    splits: tx.splits?.length ? tx.splits : undefined,
  };
  return withCategory(base, existing ?? predictedCatId, catalog);
}

/** picking a category may pull the type along (to one the category speaks) */
export function withCategory(draft: ReviewDraft, catId: string | undefined, catalog: DraftCatalog): ReviewDraft {
  if (!catId) return { ...draft, catId: undefined };
  const types = catalog.byId(catId).txTypes;
  const txType = types.length === 0 || types.includes(draft.txType) ? draft.txType : types[0];
  return { ...draft, catId, txType };
}

/** picking a type clears a now-invalid category (and its splits) — ask again */
export function withType(draft: ReviewDraft, txType: TxType, catalog: DraftCatalog): ReviewDraft {
  const splitConflict = draft.splits?.some((s) => conflicts(catalog, s.catId, txType)) ?? false;
  if (splitConflict || conflicts(catalog, draft.catId, txType)) {
    return { ...draft, txType, catId: undefined, splits: undefined };
  }
  return { ...draft, txType };
}

/** the counter-account suggests its type; the suggestion runs through withType */
export function withLinkedAccount(
  draft: ReviewDraft,
  account: { id: string; type: AccountType } | null,
  catalog: DraftCatalog,
): ReviewDraft {
  if (!account) return { ...draft, linkedAccountId: undefined };
  return withType({ ...draft, linkedAccountId: account.id }, typeForLinkedAccount(account.type), catalog);
}

/** splits carry the category: the largest slice represents the whole */
export function withSplits(draft: ReviewDraft, splits: TxSplit[] | undefined): ReviewDraft {
  if (!splits?.length) return { ...draft, splits: undefined };
  return { ...draft, splits, catId: primaryCatId(splits) };
}

/** Confirm is only offered once a REAL category is decided (user rule:
 *  never confirm Uncategorized — that's what review exists to fix).
 *  Transfers are the one exception: they carry no spending category and
 *  use the hidden 'uncategorized' builtin as a by-design placeholder. */
export const draftReady = (draft: ReviewDraft): boolean => {
  if (!draft.catId) return false;
  if (draft.txType === 'transfer') return true;
  if (draft.catId === 'uncategorized') return false;
  return !draft.splits?.some((slice) => slice.catId === 'uncategorized');
};
