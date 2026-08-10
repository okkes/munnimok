import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { AccountType } from '@/db/types';
import { getCurrentLang } from '@/i18n';
import { en } from '@/i18n/en';
import { nl } from '@/i18n/nl';
import { tr } from '@/i18n/tr';

/**
 * #133 (user ruling 1): the DEFAULT special accounts are LAZY — nothing
 * exists until the user (or the migration) first accepts "default" as a
 * counterparty; then the space's pot for that family is minted
 * automatically. Deterministic ids make two devices converge by LWW
 * instead of duplicating (the loans-v2 fold lesson). Transfer needs a
 * REAL account and funding stays counterparty-less — neither has a
 * default (rulings 4/5).
 */
export type DefaultFamily = 'saving' | 'debtPayment' | 'investment';

export const FAMILY_ACCOUNT_TYPE: Record<DefaultFamily, AccountType> = {
  saving: 'savings',
  debtPayment: 'loan',
  investment: 'brokerage',
};

export const NAME_KEYS: Record<DefaultFamily, 'acct.defaultSaving' | 'acct.defaultLoan' | 'acct.defaultInvest'> = {
  saving: 'acct.defaultSaving',
  debtPayment: 'acct.defaultLoan',
  investment: 'acct.defaultInvest',
};

const DICTS = { en, nl, tr } as const;

export const defaultAccountId = (spaceId: string, family: DefaultFamily): string =>
  `defaultacct_${family}_${spaceId}`;

/** the family's default pot, minted on first use (idempotent) */
export async function ensureDefaultAccount(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  family: DefaultFamily,
): Promise<string> {
  const id = defaultAccountId(spaceId, family);
  const existing = await store.get('account', id);
  if (existing?.deleted === 0) return existing.id;
  const space = await store.get('space', spaceId);
  const lang = getCurrentLang();
  await repo.upsert('account', spaceId, id, {
    name: DICTS[lang]?.[NAME_KEYS[family]] ?? en[NAME_KEYS[family]],
    type: FAMILY_ACCOUNT_TYPE[family],
    source: 'manual',
    currency: space?.currency ?? 'EUR',
    balanceCents: 0,
    defaultFor: family,
  });
  return id;
}
