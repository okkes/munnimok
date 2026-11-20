import { visibleAccounts, visibleTransactions, writeTxTransform } from '@/db/joined';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import { normalizeIban } from '@/domain/feedIds';
import { accountStamp, applyTypeChange, familyForCounter } from '@/domain/txType';
import { buildCatalog, visibleCategoryRows } from '@/domain/catalog';
import { cachedCatalog } from '@/sync/catalogSync';

// retroactive: a new account links every transaction whose counterparty IBAN is its own; linked rows and
// deliberate types survive, category conflicts resolve like a manual link (applyTypeChange)
export async function linkAllCounterparties(store: StorageBackend, repo: Repo, spaceId: string): Promise<number> {
  const accounts = await visibleAccounts(store, spaceId);
  const byIban = new Map<string, (typeof accounts)[number]>();
  for (const account of accounts) {
    if (account.iban) byIban.set(normalizeIban(account.iban), account);
  }
  if (byIban.size === 0) return 0;
  const typeOf = new Map(accounts.map((a) => [a.id, a.type]));

  const allSpaces = (await store.allRows('space')).filter((s) => s.deleted === 0);
  const allCats = (await store.allRows('category')).filter((c) => c.deleted === 0);
  const visible = visibleCategoryRows(allSpaces, allCats, spaceId);
  const catalog = buildCatalog(visible.rows, visible.sharedScope, visible.hiddenMains, await cachedCatalog(store));

  let linked = 0;
  for (const tx of await visibleTransactions(store, spaceId)) {
    if (!tx.counterIban || tx.linkedAccountId) continue;
    const account = byIban.get(normalizeIban(tx.counterIban));
    if (!account || account.id === tx.accountId) continue;
    const keepType = tx.txType !== 'expense' && tx.txType !== 'income';
    const ownStamp = accountStamp(typeOf.get(tx.accountId));
    // #133 r5: the counter's kind names the family: a savings IBAN files the saving story, not a blanket transfer
    const nextType = ownStamp ?? (keepType ? tx.txType : familyForCounter(account.type));
    const fields = applyTypeChange({
      nextType,
      linkedAccountId: account.id,
      currentCatId: tx.catId,
      catTxTypes: catalog.byId(tx.catId).txTypes,
      amountCents: tx.amountCents,
      ownStamp,
    });
    await writeTxTransform(repo, tx, fields);
    linked++;
  }
  return linked;
}
