import type { AccountRow, TransactionRow } from '@/db/types';

/**
 * #547 (user 2026-11-09/11): a transaction typed by hand on an account the
 * bank or a statement fills — "your entry". It lives in the space, counts
 * until the bank's own transaction arrives, and is then linked to it: the
 * two read as one. This is the pairing rule and the balance rule; nothing
 * here reads or writes storage.
 */

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

/** how alike two titles are, 0..1: the words they share over the shorter title's words */
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

/** same account, same direction, the very same amount, the bank's date within two days of the entry's */
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

/** the one bank row an entry fits best; none when two fit equally well */
function bestFor(entry: Entry, bankRows: readonly BankTx[], taken: ReadonlySet<string>): Claim | null {
  const fits = bankRows
    .filter((bank) => bank.deleted === 0 && !taken.has(bank.id) && !refused(entry, bank) && fitsExactly(entry, bank))
    .map((bank) => ({ entryId: entry.id, bankId: bank.id, distance: distance(entry, bank) }))
    .sort((a, b) => a.distance - b.distance);
  if (fits.length === 0) return null;
  return fits.length > 1 && fits[1].distance === fits[0].distance ? null : fits[0];
}

/**
 * The links made without asking, entry → bank row: an unlinked entry and
 * the one bank row it fits exactly. Where two rows fit an entry equally
 * well, or two entries the same row, nothing is linked — the person picks.
 * `taken` are the bank rows other entries are linked to already; a pair a
 * person took apart is never made again.
 */
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

/** the bank rows a person could link an entry to by hand: the exact fits, then the wider ones, nearest first */
export function linkCandidates<B extends BankTx>(entry: Entry, bankRows: readonly B[], taken: ReadonlySet<string>): B[] {
  return bankRows
    .filter((bank) => bank.deleted === 0 && !taken.has(bank.id) && (fitsExactly(entry, bank) || fitsLoosely(entry, bank)))
    .sort((a, b) => Number(fitsExactly(entry, b)) - Number(fitsExactly(entry, a)) || distance(entry, a) - distance(entry, b));
}

/**
 * Whether the form's "count it in the balance" tick starts on (user
 * 2026-11-11): an entry dated on or after the bank's balance may be news
 * to it; one dated before it is in the bank's number already — off, and
 * it stays off.
 */
export const canCountInBalance = (date: string, account: Pick<AccountRow, 'balanceAsOf'>): boolean =>
  !account.balanceAsOf || date >= account.balanceAsOf;

/**
 * Does an entry count on top of the bank's balance right now? While the
 * person lets it, until the bank books it (a reserved amount is not in
 * the bank's balance yet), and until the bank's balance has clearly
 * passed it.
 */
export function countsInBalance(
  entry: Pick<TransactionRow, 'date' | 'inBalance'>,
  account: Pick<AccountRow, 'balanceAsOf'>,
  linked: Pick<TransactionRow, 'pending'> | null | undefined,
): boolean {
  if (entry.inBalance !== 1) return false;
  if (linked && linked.pending !== 1) return false;
  return !account.balanceAsOf || daysAfter(account.balanceAsOf, entry.date) <= PASSED_DAYS;
}

/**
 * A hand-typed transaction on an account the bank or a statement fills:
 * stored in the space, typed through the form (`enteredAt`), never an
 * imported row.
 */
export const isEntry = (
  row: Pick<TransactionRow, 'enteredAt' | 'importRef' | 'importBatchId'>,
  account: Pick<AccountRow, 'source'> | undefined,
): boolean => !!account && account.source !== 'manual' && !!row.enteredAt && !row.importRef && !row.importBatchId;
