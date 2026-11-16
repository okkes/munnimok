import { autoSubFor, isMovementCat, specialCatType } from './categories';
import type { AccountType, TxType } from '@/db/types';

// special accounts stamp every row's type (R1); credit is NOT stamped: its feed rows are purchases,
// its top-up legs stay transfers
export function accountStamp(accountType: AccountType | undefined): TxType | undefined {
  switch (accountType) {
    case 'savings':
      return 'saving';
    case 'mortgage':
    case 'loan':
      return 'debtPayment';
    case 'brokerage':
      return 'investment';
    default:
      return undefined;
  }
}

// R2: a row linked to ANY tracked counter-account is a TRANSFER; the special meaning lives on the counter leg,
// stamped by its own type
export function typeForLinkedAccount(accountType: AccountType): TxType {
  // #152: money to the shared funding pot is funding; the category family follows the counterparty
  return accountType === 'funding' ? 'funding' : 'transfer';
}

// #133: movement category, counterparty account type and money sign are the same fact;
// this is the family a counter account of this type means
export function familyForCounter(accountType: AccountType): TxType {
  return accountStamp(accountType) ?? typeForLinkedAccount(accountType);
}

// the ONE category an unstamped row files for a counter of this type (cash: the ATM pair, else the family's sign-picked sub)
export function movementCatFor(accountType: AccountType, amountCents: number): string {
  if (accountType === 'cash') return amountCents < 0 ? 'cashWithdraw' : 'cashDeposit';
  const sub = autoSubFor(familyForCounter(accountType), amountCents);
  return sub ?? (amountCents < 0 ? 'transferOut' : 'transferIn');
}

// #133: the special cats a row may pick by its account type and side; Interest/Fees exist only on the pot's own
// ledger, where the matrix runs sign-inverted
export function allowedSpecialCats(sourceType: AccountType | undefined, direction: 'debit' | 'credit'): ReadonlySet<string> {
  // a credit card is both a regular account and a debt: its ledger takes both families' cells (it is unstamped,
  // so purchases stay expenses)
  if (sourceType === 'credit') {
    return new Set([...allowedSpecialCats('loan', direction), ...allowedSpecialCats(undefined, direction)]);
  }
  const out = direction === 'debit';
  switch (sourceType === undefined ? undefined : accountStamp(sourceType)) {
    case 'saving':
      return new Set(out ? ['savingWithdraw', 'savingFees'] : ['savingDeposit', 'savingInterest']);
    case 'debtPayment':
      return new Set(out ? ['debtBorrowed', 'debtInterest', 'debtFees'] : ['loanRepayment']);
    case 'investment':
      // #252: the brokerage's own ledger adds Bought (-) and Sold (+) next to the movement pair and value stories
      return new Set(out ? ['investWithdraw', 'investBuy', 'investFees'] : ['investContribution', 'investSell', 'investDividend']);
    default:
      // #252: bank/cash/credit rows see only the movement pair (Invested/Withdrawn), never Bought/Sold
      return new Set(
        out
          ? ['savingDeposit', 'loanRepayment', 'investContribution', 'fundingOut', 'transferOut', 'cashWithdraw']
          : ['savingWithdraw', 'debtBorrowed', 'investWithdraw', 'fundingIn', 'transferIn', 'cashDeposit'],
      );
  }
}

const sameTypes = (a: readonly AccountType[] | undefined, b: readonly AccountType[] | undefined): boolean =>
  (a ?? []).join() === (b ?? []).join();

// #564: a suggested category obeys the picker's matrix: a wrong-side special becomes its single sibling here, else null
export function fitToMatrix(catId: string, sourceType: AccountType | undefined, direction: 'debit' | 'credit'): string | null {
  const family = specialCatType(catId);
  if (!family) return catId;
  const allowed = allowedSpecialCats(sourceType, direction);
  if (allowed.has(catId)) return catId;
  const siblings = [...allowed].filter(
    (other) =>
      specialCatType(other) === family &&
      isMovementCat(other) === isMovementCat(catId) &&
      sameTypes(counterTypesFor(other), counterTypesFor(catId)),
  );
  return siblings.length === 1 ? siblings[0] : null;
}

/** the account types a movement family's counterparty may offer: the bijection read the other way */
export function counterTypesForFamily(family: TxType): readonly AccountType[] | undefined {
  switch (family) {
    case 'saving':
      return ['savings'];
    case 'debtPayment':
      // #218: a credit card can take a debt payment too: the one counter kind in TWO families (transfer is the default)
      return ['loan', 'mortgage', 'credit'];
    case 'investment':
      return ['brokerage'];
    case 'funding':
      return ['funding'];
    case 'transfer':
      // #574: a cash counter is the ATM pair's alone: "Transfer out" to the wallet only repeated "Cash withdraw"
      return ['checking', 'credit'];
    default:
      return undefined;
  }
}

/** #339: account types that can be SOME family's counterparty; drives the pick-by-counter chips */
export const COUNTERABLE_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set([
  'savings',
  'loan',
  'mortgage',
  'credit',
  'brokerage',
  'funding',
  'checking',
  'cash',
]);

/** per-category read of the same table; undefined = no counterparty applies */
export function counterTypesFor(catId: string): readonly AccountType[] | undefined {
  if (catId === 'cashWithdraw' || catId === 'cashDeposit') return ['cash'];
  const family = specialCatType(catId);
  return family ? counterTypesForFamily(family) : undefined;
}

/** #218: with a counterparty picked, the categories narrow to what that counter's kind can mean (a credit card: two) */
export function movementCatsForCounter(counterType: AccountType, direction: 'debit' | 'credit'): ReadonlySet<string> {
  const cell = allowedSpecialCats(undefined, direction);
  return new Set([...cell].filter((catId) => counterTypesFor(catId)?.includes(counterType)));
}

export function categoryConflictsWithType(catTxTypes: TxType[], txType: TxType): boolean {
  return catTxTypes.length > 0 && !catTxTypes.includes(txType);
}

// nextType is the family the counter's kind means (nothing stores it); a conflicting category falls back to
// uncategorized + review, except with the sign known: the family's locked sub is truthful and needsReview stays untouched
export function applyTypeChange(options: {
  nextType: TxType;
  linkedAccountId: string | null;
  currentCatId: string | undefined;
  catTxTypes: TxType[];
  amountCents?: number;
}): { linkedAccountId?: string; catId?: string; needsReview?: 0 | 1 } {
  const conflict = categoryConflictsWithType(options.catTxTypes, options.nextType);
  const familySub = options.amountCents === undefined ? undefined : autoSubFor(options.nextType, options.amountCents);
  const placeholder = !options.currentCatId || options.currentCatId === 'uncategorized';
  if (familySub && (conflict || placeholder)) {
    return { linkedAccountId: options.linkedAccountId ?? undefined, catId: familySub };
  }
  return {
    linkedAccountId: options.linkedAccountId ?? undefined,
    ...(conflict ? { catId: 'uncategorized', needsReview: 1 as const } : {}),
  };
}
