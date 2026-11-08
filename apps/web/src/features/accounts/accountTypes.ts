import type { TranslationKey } from '@/i18n';
import type { AccountType } from '@/db/types';

/** manual account types (shared by the global and space-level add flows);
 *  the order is the order of the space's account segments (#550) */
export const ACCOUNT_TYPES: { type: AccountType; labelKey: TranslationKey; groupKey: TranslationKey; icon: string; liability?: boolean }[] = [
  { type: 'checking', labelKey: 'acct.bank', groupKey: 'acct.group.checking', icon: 'bank-outline' },
  { type: 'savings', labelKey: 'acct.saving', groupKey: 'acct.group.savings', icon: 'piggy-bank-outline' },
  { type: 'cash', labelKey: 'acct.cashWallet', groupKey: 'acct.group.cash', icon: 'wallet-outline' },
  { type: 'brokerage', labelKey: 'acct.brokerage', groupKey: 'acct.group.brokerage', icon: 'chart-line' },
  { type: 'credit', labelKey: 'acct.creditCard', groupKey: 'acct.group.credit', icon: 'credit-card-outline', liability: true },
  { type: 'mortgage', labelKey: 'acct.mortgage', groupKey: 'acct.group.mortgage', icon: 'home-percent-outline', liability: true },
  { type: 'loan', labelKey: 'acct.loan', groupKey: 'acct.group.loan', icon: 'hand-coin-outline', liability: true },
  // #152: a shared pot you fund (family/friends account) — its
  // transactions never show in the space, its balance counts nowhere
  { type: 'funding', labelKey: 'acct.funding', groupKey: 'acct.group.funding', icon: 'account-group-outline' },
];
export const typeDef = (type: AccountType) => ACCOUNT_TYPES.find((d) => d.type === type) ?? ACCOUNT_TYPES[0];
export const isLiability = (type: AccountType) => !!typeDef(type).liability;

/** #550 (user): a space's accounts in one segment per type, the segments in
 *  ACCOUNT_TYPES order and empty ones left out — each keeps its own order */
export function groupByAccountType<T extends { type: AccountType }>(items: readonly T[]): { type: AccountType; items: T[] }[] {
  return ACCOUNT_TYPES.map((def) => ({ type: def.type, items: items.filter((item) => typeDef(item.type).type === def.type) })).filter(
    (group) => group.items.length > 0,
  );
}

/** manual balances are statements of "true today" — date them so a
 *  statement import can tell whether its balance is newer (importCamt) */
export const manualBalanceDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
