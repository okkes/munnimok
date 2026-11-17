import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import { visibleTransactions, writeTxTransform } from '@/db/joined';
import { merchantKey } from '@/domain/merchantKey';

// like category memory: a rename teaches the app; the bank's merchant stays, the rename lives in the transformation overlay

/** merchantKey → the title the user most often renames this merchant to */
export function buildTitleMemory(
  txs: readonly { merchant: string; titleOverride?: string; deleted?: 0 | 1 }[],
): Map<string, string> {
  const votes = new Map<string, Map<string, number>>();
  for (const tx of txs) {
    const title = tx.titleOverride?.trim();
    if (!title || tx.deleted === 1) continue;
    const key = merchantKey(tx.merchant);
    if (!key) continue;
    const perTitle = votes.get(key) ?? new Map<string, number>();
    perTitle.set(title, (perTitle.get(title) ?? 0) + 1);
    votes.set(key, perTitle);
  }
  const memory = new Map<string, string>();
  for (const [key, perTitle] of votes) {
    const best = [...perTitle.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    memory.set(key, best[0]);
  }
  return memory;
}

/** idempotent: remembered renames land only on rows that have none; runs beside the counterparty/PayPal linkers */
export async function applyTitleMemory(store: StorageBackend, repo: Repo, spaceId: string): Promise<number> {
  const txs = await visibleTransactions(store, spaceId);
  const memory = buildTitleMemory(txs);
  if (memory.size === 0) return 0;
  let applied = 0;
  for (const tx of txs) {
    if (tx.deleted === 1 || tx.titleOverride) continue;
    const remembered = memory.get(merchantKey(tx.merchant));
    if (!remembered) continue;
    await writeTxTransform(repo, tx, { titleOverride: remembered });
    applied++;
  }
  return applied;
}
