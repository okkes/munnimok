import { UNCATEGORIZED_ID, isMovementCat, specialCatType } from './categories';
import { matchCounterAccount } from './counterClue';
import type { ClueAccount, ClueTx } from './counterClue';
import { counterPlanOf, planFits } from './counterPlan';
import { defaultFamilyFor } from './defaultAccounts';
import { merchantKey } from './merchantKey';
import type { TxPrediction } from './predictCategory';
import { initDraft, withCategory, withCats, withLinkedAccount, withType } from './reviewDraft';
import type { DraftCatalog, ReviewDraft } from './reviewDraft';
import { resolveSplitsFor } from './splits';
import { standardTypeFor } from './txKind';
import { accountStamp } from './txType';
import type { AccountRow, AccountType, TxSplit, TxSplitCat, TxType } from '@/db/types';

/**
 * The review card's prefilled decision, composed from the row's own state
 * and what was learned about it (#565: prepared the moment the row lands,
 * never while the card opens — application/reviewSuggestions.ts runs it).
 * Pure: the same inputs give every device the same suggestion.
 */

/** the row facts the composition reads — a change to any of them outdates a prepared suggestion */
export interface SuggestTx extends ClueTx {
  id: string;
  accountId: string;
  amountCents: number;
  catId?: string;
  txType: TxType;
  linkedAccountId?: string;
  transferPeerId?: string;
  cats?: TxSplitCat[];
  splits?: TxSplit[];
}

/** a fingerprint of the stored facts the suggestion was composed on */
export const storyBasis = (tx: SuggestTx): string =>
  JSON.stringify([tx.catId ?? '', tx.txType, tx.linkedAccountId ?? '', tx.transferPeerId ?? '', tx.amountCents, tx.accountId, tx.titleOverride ?? '', tx.cats ?? null, tx.splits ?? null]);

/** #161: the remembered pct SPREAD applied onto an untouched draft — a
 *  resolved transfer, an own-counter default or the row's own partition
 *  must never be fragmented by it */
export function applyPredictedSpread(
  resolvedDraft: ReviewDraft | null,
  prediction: TxPrediction | null,
  tx: { amountCents: number } | undefined,
): ReviewDraft | null {
  if (!tx || !resolvedDraft || !prediction?.cats) return resolvedDraft;
  if (
    resolvedDraft.catId !== prediction.catId ||
    resolvedDraft.linkedAccountId ||
    resolvedDraft.cats?.length ||
    resolvedDraft.splits?.length
  )
    return resolvedDraft;
  const resolved = resolveSplitsFor(tx.amountCents, prediction.cats.map((e) => ({ catId: e.catId, amountCents: 0, pct: e.pct })));
  const entries = resolved.map((s) => ({ catId: s.catId, amountCents: Math.abs(s.amountCents), ...(s.pct !== undefined ? { pct: s.pct } : {}) }));
  const primary = entries.reduce((best, e) => (e.amountCents > best.amountCents ? e : best), entries[0]);
  return { ...withCats(resolvedDraft, entries), catId: primary.catId };
}

/** 2026-10-05 (user ss): a row that REMEMBERS its counterparty (the
 *  memory, an earlier device, a repaired overlay) but wears no category
 *  files the movement its counter's kind means — the bijection the pick
 *  itself applies. A deliberate category is never touched. */
export function fileRememberedCounter(
  draft: ReviewDraft | null,
  accounts: readonly { id: string; type: AccountType }[] | undefined,
  cats: DraftCatalog,
  amountCents: number,
  ownStamp?: TxType,
): ReviewDraft | null {
  if (!draft?.linkedAccountId || draft.splits?.length || draft.cats?.length) return draft;
  if (draft.catId && draft.catId !== UNCATEGORIZED_ID) return draft;
  const account = accounts?.find((a) => a.id === draft.linkedAccountId);
  if (!account) return draft;
  return withLinkedAccount(draft, { id: account.id, type: account.type }, cats, amountCents, ownStamp);
}

/** own-account counterparty pre-applies the link + suggested type; the
 *  hidden 'uncategorized' builtin keeps the confirm armed for transfers */
export function applyOwnCounterDefault(
  baseDraft: ReviewDraft | null,
  ownCounter: { id: string; type: AccountType } | undefined,
  cats: DraftCatalog,
  amountCents: number,
  ownStamp?: TxType,
): ReviewDraft | null {
  if (!baseDraft || !ownCounter || baseDraft.linkedAccountId) return baseDraft;
  const linked = withLinkedAccount(baseDraft, { id: ownCounter.id, type: ownCounter.type }, cats, amountCents, ownStamp);
  return linked.catId ? linked : withCategory(linked, 'uncategorized', cats);
}

/** #228 r3 (user rule): an AUTOMATIC transfer prediction must name a
 *  real counterparty or stand down. The bank text names one of the
 *  space's tracked accounts → pre-link it (the bijection files the
 *  category from the account's kind); no clue → the card opens
 *  Uncategorized and review asks the human. */
export function resolveTransferPrediction(
  draft: ReviewDraft | null,
  tx: (ClueTx & { accountId: string; amountCents: number }) | undefined,
  accounts: readonly ClueAccount[] | undefined,
  cats: DraftCatalog,
  ownStamp?: TxType,
): ReviewDraft | null {
  if (!draft || !tx || ownStamp) return draft;
  if (draft.linkedAccountId || draft.splits?.length || draft.cats?.length) return draft;
  if (defaultFamilyFor(draft.catId) !== 'transfer') return draft;
  const match = matchCounterAccount(tx, accounts ?? [], tx.accountId);
  if (match) return withLinkedAccount(draft, { id: match.id, type: match.type }, cats, tx.amountCents, ownStamp);
  return { ...withType({ ...draft, linkedAccountId: undefined }, standardTypeFor(tx.amountCents), cats), catId: UNCATEGORIZED_ID };
}

type LoanAccount = ClueAccount & Pick<AccountRow, 'merchantKey' | 'paymentCents' | 'paymentEvery' | 'paymentEveryN' | 'trackAsDebt'>;

const isDebtAccount = (a: LoanAccount): boolean =>
  a.type === 'loan' || a.type === 'mortgage' || (a.type === 'credit' && a.trackAsDebt === 1);

/**
 * #565 (user): the loan is part of what munni works out when a row lands —
 * a payment whose merchant a loan was taught (its merchant key), or a
 * predicted debt payment, links the loan whose payment it is: the one
 * payment plan this amount fits, the only loan the key names, or the loan
 * the bank text names (#556: three ING loans, one -€55.20). Ambiguity
 * stays a question for the person — #555: a debt payment never confirms
 * without its loan, and no default loan ever answers for it.
 */
export function suggestLoanCounter(
  draft: ReviewDraft | null,
  tx: (ClueTx & { accountId: string; amountCents: number }) | undefined,
  accounts: readonly LoanAccount[] | undefined,
  cats: DraftCatalog,
  ownStamp?: TxType,
): ReviewDraft | null {
  if (!draft || !tx || ownStamp) return draft;
  if (draft.linkedAccountId || draft.splits?.length || draft.cats?.length) return draft;
  const debtFiled = specialCatType(draft.catId) === 'debtPayment' && isMovementCat(draft.catId);
  // money coming IN is a loan's business only when it was filed as one
  if (tx.amountCents > 0 && !debtFiled) return draft;
  const loan = loanFor(tx, accounts ?? [], debtFiled);
  return loan ? withLinkedAccount(draft, { id: loan.id, type: loan.type }, cats, tx.amountCents, ownStamp) : draft;
}

/** the one loan a payment names: by its payment plan, its taught merchant or the bank text */
function loanFor<A extends LoanAccount>(
  tx: ClueTx & { accountId: string; amountCents: number },
  accounts: readonly A[],
  debtFiled: boolean,
): A | undefined {
  const loans = accounts.filter((a) => a.id !== tx.accountId && a.archived !== 1 && !a.defaultFor && isDebtAccount(a));
  const key = merchantKey(tx.merchant);
  // a loan with a payment plan takes only the payments that fit it
  const fits = (a: A): boolean | undefined => {
    const plan = counterPlanOf(a, []);
    return plan ? planFits(plan, tx.amountCents) : undefined;
  };
  const taught = loans.filter((a) => !!a.merchantKey && a.merchantKey === key && fits(a) !== false);
  if (taught.length === 0 && !debtFiled) return undefined;
  const pool = taught.length > 0 ? taught : loans;
  const fitting = pool.filter((a) => fits(a) === true);
  if (fitting.length === 1) return fitting[0];
  if (taught.length === 1) return taught[0];
  return matchCounterAccount(tx, pool, tx.accountId);
}

/** everything the composition needs besides the row */
export interface SuggestContext {
  cats: DraftCatalog;
  /** the space's accounts as the space sees them (its names and types) */
  accounts: readonly LoanAccount[];
  /** the row's own account type — a stamped ledger owns its rows' story */
  sourceType?: AccountType;
  /** the account the counterparty IBAN (or the PayPal pattern) names */
  ownCounter?: { id: string; type: AccountType };
  prediction: TxPrediction | null;
}

/** the card's starting point: the row, the prediction, the own-account
 *  counterparty, a named transfer counterparty, the loan, the spread */
export function suggestDraft(tx: SuggestTx, ctx: SuggestContext): ReviewDraft {
  const ownStamp = accountStamp(ctx.sourceType);
  // a remembered counterparty means a movement: an ordinary category the
  // prediction names would only stand beside it, so its kind files instead
  const ordinaryBesideCounter = !!tx.linkedAccountId && !!ctx.prediction && !specialCatType(ctx.prediction.catId);
  const base = initDraft(tx, ordinaryBesideCounter ? undefined : ctx.prediction?.catId, ctx.cats);
  const owned = applyOwnCounterDefault(base, ctx.ownCounter, ctx.cats, tx.amountCents, ownStamp);
  const resolved = fileRememberedCounter(resolveTransferPrediction(owned, tx, ctx.accounts, ctx.cats, ownStamp), ctx.accounts, ctx.cats, tx.amountCents, ownStamp);
  const withLoan = suggestLoanCounter(resolved, tx, ctx.accounts, ctx.cats, ownStamp);
  return applyPredictedSpread(withLoan, ctx.prediction, tx) ?? base;
}
