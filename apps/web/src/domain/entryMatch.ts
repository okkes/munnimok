import type { AccountRow, TransactionRow } from '@/db/types';

// #547: "your entry" is a hand-typed transaction on an account the bank or a statement fills: it counts until the bank's own
// transaction arrives, then links to it; nothing here reads or writes storage

type Entry = Pick<TransactionRow, 'id' | 'accountId' | 'date' | 'amountCents' | 'merchant' | 'titleOverride' | 'bankTxId' | 'noBankTxIds' | 'deleted'>;
type BankTx = Pick<TransactionRow, 'id' | 'accountId' | 'date' | 'amountCents' | 'merchant' | 'description' | 'deleted'>;

/** the bank's date may lie this many days from the entry's for the two to be linked without asking */
export const AUTO_LINK_DAYS = 2;
/** …and this many for the pair to be offered */
export const SUGGEST_DAYS = 7;
/** an offered pair may differ this share in amount (a tip, a rounded exchange rate) */
export const SUGGEST_AMOUNT_SHARE = 0.02;
/** a balance dated this many days past an entry has clearly passed it */
export const PASSED_DAYS = 2;

const DAY_MS = 86_400_000;
const daysApart = (a: string, b: string): number => Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / DAY_MS));
const daysAfter = (later: string, earlier: string): number => Math.round((Date.parse(later) - Date.parse(earlier)) / DAY_MS);

const wordsOf = (text: string | undefined): string[] =>
  (text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);

export function titleLikeness(a: string | undefined, b: string | undefined): number {
  const left = new Set(wordsOf(a));
  const right = new Set(wordsOf(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

const titleOf = (entry: Entry): string => entry.titleOverride || entry.merchant;
const bankTitle = (bank: BankTx): string => `${bank.merchant} ${bank.description ?? ''}`;
const sameWay = (a: number, b: number): boolean => a < 0 === b < 0;
const refused = (entry: Entry, bank: BankTx): boolean => entry.noBankTxIds?.includes(bank.id) === true;

export const fitsExactly = (entry: Entry, bank: BankTx): boolean =>
  entry.accountId === bank.accountId && entry.amountCents === bank.amountCents && daysApart(entry.date, bank.date) <= AUTO_LINK_DAYS;

/** a wider fit, only ever offered: within a week and within 2 % of the amount */
export const fitsLoosely = (entry: Entry, bank: BankTx): boolean =>
  entry.accountId === bank.accountId &&
  sameWay(entry.amountCents, bank.amountCents) &&
  daysApart(entry.date, bank.date) <= SUGGEST_DAYS &&
  Math.abs(entry.amountCents - bank.amountCents) <= Math.abs(entry.amountCents) * SUGGEST_AMOUNT_SHARE;

/** lower is closer: the days apart first, the title only to decide between rows as near */
const distance = (entry: Entry, bank: BankTx): number => daysApart(entry.date, bank.date) * 10 + (1 - titleLikeness(titleOf(entry), bankTitle(bank)));

interface Claim {
  entryId: string;
  bankId: string;
  distance: number;
}

function bestFor(entry: Entry, bankRows: readonly BankTx[], taken: ReadonlySet<string>): Claim | null {
  const fits = bankRows
    .filter((bank) => bank.deleted === 0 && !taken.has(bank.id) && !refused(entry, bank) && fitsExactly(entry, bank))
    .map((bank) => ({ entryId: entry.id, bankId: bank.id, distance: distance(entry, bank) }))
    .sort((a, b) => a.distance - b.distance);
  if (fits.length === 0) return null;
  return fits.length > 1 && fits[1].distance === fits[0].distance ? null : fits[0];
}

// where two rows fit an entry equally well, or two entries the same row, nothing is linked: the person picks;
// `taken` are bank rows already linked; a pair a person took apart is never made again
export function autoLinks(entries: readonly Entry[], bankRows: readonly BankTx[], taken: ReadonlySet<string>): Map<string, string> {
  const byBank = new Map<string, Claim[]>();
  for (const entry of entries) {
    if (entry.deleted !== 0 || entry.bankTxId) continue;
    const claim = bestFor(entry, bankRows, taken);
    if (claim) byBank.set(claim.bankId, [...(byBank.get(claim.bankId) ?? []), claim]);
  }
  const links = new Map<string, string>();
  for (const [bankId, claims] of byBank) {
    claims.sort((a, b) => a.distance - b.distance);
    if (claims.length > 1 && claims[1].distance === claims[0].distance) continue;
    links.set(claims[0].entryId, bankId);
  }
  return links;
}

export function linkCandidates<B extends BankTx>(entry: Entry, bankRows: readonly B[], taken: ReadonlySet<string>): B[] {
  return bankRows
    .filter((bank) => bank.deleted === 0 && !taken.has(bank.id) && (fitsExactly(entry, bank) || fitsLoosely(entry, bank)))
    .sort((a, b) => Number(fitsExactly(entry, b)) - Number(fitsExactly(entry, a)) || distance(entry, a) - distance(entry, b));
}

// the "count it in the balance" tick starts on for an entry dated on/after the bank's balance;
// an older one is in the bank's number already
export const canCountInBalance = (date: string, account: Pick<AccountRow, 'balanceAsOf'>): boolean =>
  !account.balanceAsOf || date >= account.balanceAsOf;

// counts until the bank books it (a reserved amount is not in the bank's balance yet) or the balance has clearly passed it
export function countsInBalance(
  entry: Pick<TransactionRow, 'date' | 'inBalance'>,
  account: Pick<AccountRow, 'balanceAsOf'>,
  linked: Pick<TransactionRow, 'pending'> | null | undefined,
): boolean {
  if (entry.inBalance !== 1) return false;
  if (linked && linked.pending !== 1) return false;
  return !account.balanceAsOf || daysAfter(account.balanceAsOf, entry.date) <= PASSED_DAYS;
}

/** typed through the form (`enteredAt`) on a bank/statement account, never an imported row */
export const isEntry = (
  row: Pick<TransactionRow, 'enteredAt' | 'importRef' | 'importBatchId'>,
  account: Pick<AccountRow, 'source'> | undefined,
): boolean => !!account && account.source !== 'manual' && !!row.enteredAt && !row.importRef && !row.importBatchId;
