import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { AccountRow, SpaceRow } from '@/db/types';
import { cashWalletId, isRetiredDefault } from '@/domain/defaultAccounts';
import type { DefaultFamily } from '@/domain/defaultAccounts';
import { isMintedLeg } from '@/domain/feedIds';
import { getCurrentLang } from '@/i18n';
import { en } from '@/i18n/en';
import { nl } from '@/i18n/nl';
import { tr } from '@/i18n/tr';
import { releaseAccountReferences } from './accountRelease';

/**
 * #546 (user 2026-10-22): the cash wallet is the one default account a
 * space keeps — minted with the space, the ATM pair's counterparty. The
 * other family defaults of #221 retire: nothing mints them any more and
 * the boot's retire pass folds the stored ones away. The id math lives in
 * domain/defaultAccounts.
 */
export { cashWalletId, defaultAccountId } from '@/domain/defaultAccounts';
export type { DefaultFamily } from '@/domain/defaultAccounts';

const DICTS = { en, nl, tr } as const;

/** #348: the cash default's pre-rename dict names (all languages) */
const OLD_CASH_NAMES = new Set(['Default cash', 'Standaard contant', 'Varsayılan nakit']);

/** the space's cash wallet, minted idempotently — the deterministic id lets
 *  two devices converge by LWW; an explicit pick revives a deleted one */
export async function ensureCashWallet(store: StorageBackend, repo: Repo, spaceId: string): Promise<string> {
  const id = cashWalletId(spaceId);
  const existing = await store.get('account', id);
  const freshName = DICTS[getCurrentLang()]?.['acct.defaultCash'] ?? en['acct.defaultCash'];
  if (existing?.deleted === 0) {
    // #348: pre-rename cash wallets heal to the new name — but only
    // when the row still wears an old DICT name (a user rename stands)
    if (OLD_CASH_NAMES.has(existing.name) && existing.name !== freshName) {
      await repo.upsert('account', spaceId, id, { name: freshName });
    }
    return existing.id;
  }
  const space = await store.get('space', spaceId);
  await repo.upsert('account', spaceId, id, {
    name: freshName,
    type: 'cash',
    source: 'manual',
    currency: space?.currency ?? 'EUR',
    balanceCents: 0,
    defaultFor: 'cash',
  });
  return id;
}

/** the wallet an AUTOMATIC link may use (#348): a live one, or one the space
 *  never had — a deliberately deleted wallet stays deleted; null then */
export async function walletForAutoLink(store: StorageBackend, repo: Repo, spaceId: string): Promise<string | null> {
  const existing = await store.get('account', cashWalletId(spaceId));
  if (existing && existing.deleted !== 0) return null;
  return ensureCashWallet(store, repo, spaceId);
}

/** the names the retired defaults were minted with (#221, every language) —
 *  a pot still wearing one is a pot nobody renamed */
const MINTED_NAMES: Record<Exclude<DefaultFamily, 'cash'>, readonly string[]> = {
  saving: ['Default savings', 'Standaard sparen', 'Varsayılan birikim'],
  debtPayment: ['Default loan', 'Standaard lening', 'Varsayılan kredi'],
  investment: ['Default investments', 'Standaard beleggingen', 'Varsayılan yatırım'],
  transfer: ['Default bank account', 'Standaard bankrekening', 'Varsayılan banka hesabı'],
  funding: ['Default shared pot', 'Standaard pot', 'Varsayılan ortak kasa'],
};

/** a retired default the person made their own: renamed, or holding rows of
 *  their own (a typed balance, an entry — munni's generated legs don't count)
 *  or a position */
async function madeOwn(store: StorageBackend, account: AccountRow): Promise<boolean> {
  const family = account.defaultFor as Exclude<DefaultFamily, 'cash'>;
  if (!MINTED_NAMES[family]?.includes(account.name)) return true;
  const rows = await store.bySpace('transaction', account.spaceId);
  if (rows.some((row) => row.deleted === 0 && row.accountId === account.id && !isMintedLeg(row))) return true;
  return (await store.bySpace('holding', account.spaceId)).some((h) => h.deleted === 0 && h.accountId === account.id);
}

/** the space's account lists drop a retired default (pool, goals, balance band) */
async function dropFromSpaceLists(store: StorageBackend, repo: Repo, spaceId: string, accountId: string): Promise<void> {
  const space = await store.get('space', spaceId);
  if (space?.deleted !== 0) return;
  const lists = ['planPoolAccountIds', 'goalPoolAccountIds', 'balanceBandAccounts'] as const;
  const patch: Partial<SpaceRow> = {};
  for (const key of lists) {
    const ids = space[key];
    if (ids?.includes(accountId)) patch[key] = ids.filter((id) => id !== accountId);
  }
  if (Object.keys(patch).length > 0) await repo.upsert('space', spaceId, spaceId, patch);
}

/**
 * #546 (user 2026-10-22: "just cleanup those default accounts — none of us
 * leans on them"): the retired family defaults leave their spaces. One the
 * person made their own stays as an ordinary account. Every other one lets
 * go of the rows that named it — they keep their category and go back to
 * the review, which asks for the real account (#555) — its generated legs
 * leave with those links, and it is deleted. Every boot, idempotent: a
 * default this device pulls later retires on the boot after.
 */
export async function retireDefaultAccounts(store: StorageBackend, repo: Repo): Promise<number> {
  // a deleted space's debris is nobody's to fold (#295: it renders nowhere)
  const liveSpaces = new Set((await store.allRows('space')).filter((s) => s.deleted === 0).map((s) => s.id));
  const retired = (await store.allRows('account')).filter((a) => a.deleted === 0 && isRetiredDefault(a) && liveSpaces.has(a.spaceId));
  for (const account of retired) {
    if (await madeOwn(store, account)) {
      await repo.upsert('account', account.spaceId, account.id, { defaultFor: null as never });
      continue;
    }
    await releaseAccountReferences(store, repo, account.spaceId, account.id);
    for (const row of await store.bySpace('transaction', account.spaceId)) {
      if (row.deleted === 0 && row.accountId === account.id) await repo.remove('transaction', account.spaceId, row.id);
    }
    await dropFromSpaceLists(store, repo, account.spaceId, account.id);
    await repo.remove('account', account.spaceId, account.id);
  }
  return retired.length;
}
