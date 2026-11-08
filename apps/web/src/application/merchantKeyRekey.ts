import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { RecurringDismissRow } from '@/db/types';
import { recurringDismissId } from '@/domain/feedIds';
import { merchantKey, merchantKeyBefore578 } from '@/domain/merchantKey';

/** the migration's marker: it ran on this database */
export const MERCHANT_KEY_REKEY_MARKER = 'merchantKeyRekey:578';

type Votes = Map<string, Map<string, number>>;

/** every stored transaction's old key → how often each of today's keys stands behind it */
async function votesByOldKey(store: StorageBackend): Promise<Votes> {
  const votes: Votes = new Map();
  for (const tx of await store.allRows('transaction')) {
    if (tx.deleted !== 0 || !tx.merchant) continue;
    const old = merchantKeyBefore578(tx.merchant);
    const next = merchantKey(tx.merchant);
    const tally = votes.get(old) ?? new Map<string, number>();
    tally.set(next, (tally.get(next) ?? 0) + 1);
    votes.set(old, tally);
  }
  return votes;
}

/** the key a stored old key becomes: what most of its transactions say today, else the key itself re-read */
function rekeyed(votes: Votes, old: string): string {
  const tally = votes.get(old);
  if (!tally?.size) return merchantKey(old) || old;
  return [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/** a dismissal may carry an amount band ("key@cents") — only the key part moves */
function rekeyedDismissal(votes: Votes, stored: string): string {
  const at = stored.lastIndexOf('@');
  if (at <= 0) return rekeyed(votes, stored);
  return `${rekeyed(votes, stored.slice(0, at))}${stored.slice(at)}`;
}

/** recurrings and loans keep their id: the key moves in place; how many moved (S3776) */
async function rekeyInPlace(
  repo: Repo,
  entity: 'recurring' | 'account',
  rows: ReadonlyArray<{ id: string; spaceId: string; merchantKey?: string }>,
  votes: Votes,
): Promise<number> {
  let moved = 0;
  for (const row of rows) {
    const next = rekeyed(votes, row.merchantKey!);
    if (next === row.merchantKey) continue;
    await repo.upsert(entity, row.spaceId, row.id, { merchantKey: next });
    moved++;
  }
  return moved;
}

/** a dismissal's id is its key: the new key gets its own row, the old one goes; how many moved */
async function rekeyDismissals(repo: Repo, dismissals: readonly RecurringDismissRow[], votes: Votes): Promise<number> {
  let moved = 0;
  for (const dismissal of dismissals) {
    const next = rekeyedDismissal(votes, dismissal.merchantKey);
    if (next === dismissal.merchantKey) continue;
    await repo.upsert('recurringDismiss', dismissal.spaceId, recurringDismissId(dismissal.spaceId, next), { merchantKey: next });
    if (recurringDismissId(dismissal.spaceId, next) !== dismissal.id) await repo.remove('recurringDismiss', dismissal.spaceId, dismissal.id);
    moved++;
  }
  return moved;
}

/**
 * #578: the merchant key learned to cut a card line's place-and-time tail
 * (">S-GRAVENH30.10.2026 1"), so the keys stored on recurrings, on loans
 * and on dismissed suggestions are rewritten once to today's spelling —
 * each through the transactions that carried it (the old spelling lost the
 * ">", so the key alone cannot say what it becomes). Deterministic, so
 * every device lands on the same keys; synced writes, like any heal.
 */
export async function rekeyMerchantKeys(store: StorageBackend, repo: Repo): Promise<number> {
  if ((await store.metaGet(MERCHANT_KEY_REKEY_MARKER))?.value) return 0;
  const recurrings = (await store.allRows('recurring')).filter((r) => r.deleted === 0 && !!r.merchantKey);
  const accounts = (await store.allRows('account')).filter((a) => a.deleted === 0 && !!a.merchantKey);
  const dismissals = (await store.allRows('recurringDismiss')).filter((d) => d.deleted === 0 && !!d.merchantKey);
  let moved = 0;
  if (recurrings.length + accounts.length + dismissals.length > 0) {
    const votes = await votesByOldKey(store);
    moved += await rekeyInPlace(repo, 'recurring', recurrings, votes);
    moved += await rekeyInPlace(repo, 'account', accounts, votes);
    moved += await rekeyDismissals(repo, dismissals, votes);
  }
  await store.metaPut(MERCHANT_KEY_REKEY_MARKER, true);
  return moved;
}
