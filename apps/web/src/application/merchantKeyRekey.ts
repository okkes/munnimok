import { readSessionIdentity } from '@/app/session';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { RecurringDismissRow } from '@/db/types';
import { recurringDismissId } from '@/domain/feedIds';
import { merchantKey, merchantKeyBefore578, merchantKeyBefore674, merchantKeyBeforeBrands } from '@/domain/merchantKey';
import { LAST_SYNC_KEY } from '@/sync/engine';

export const MERCHANT_KEY_REKEY_MARKER = 'merchantKeyRekey:578';
export const MERCHANT_KEY_REKEY_674_MARKER = 'merchantKeyRekey:674';
export const MERCHANT_KEY_REKEY_BRANDS_MARKER = 'merchantKeyRekey:674-brands';

// one step per change of spelling, oldest first; each runs once per device and lands on TODAY's key, so a device
// that missed an older step is brought up to date by it and finds nothing left to do in the next
const STEPS: readonly { marker: string; before: (merchant: string) => string }[] = [
  { marker: MERCHANT_KEY_REKEY_MARKER, before: merchantKeyBefore578 },
  { marker: MERCHANT_KEY_REKEY_674_MARKER, before: merchantKeyBefore674 },
  { marker: MERCHANT_KEY_REKEY_BRANDS_MARKER, before: merchantKeyBeforeBrands },
];

type Votes = Map<string, Map<string, number>>;

async function votesByOldKey(store: StorageBackend, before: (merchant: string) => string): Promise<Votes> {
  const votes: Votes = new Map();
  for (const tx of await store.allRows('transaction')) {
    if (tx.deleted !== 0 || !tx.merchant) continue;
    const old = before(tx.merchant);
    const next = merchantKey(tx.merchant);
    const tally = votes.get(old) ?? new Map<string, number>();
    tally.set(next, (tally.get(next) ?? 0) + 1);
    votes.set(old, tally);
  }
  return votes;
}

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

// #578: the key cuts a card line's place-and-time tail; #674: it drops an order code, then reads a supported shop's
// spellings as one. Stored keys are rewritten once per
// change, each through its transactions (an old spelling lost what the new one reads, so the key alone cannot say what
// it becomes). Deterministic: every device lands the same.
export async function rekeyMerchantKeys(store: StorageBackend, repo: Repo): Promise<number> {
  let moved = 0;
  for (const step of STEPS) moved += await rekeyStep(store, repo, step.marker, step.before);
  return moved;
}

async function rekeyStep(store: StorageBackend, repo: Repo, marker: string, before: (merchant: string) => string): Promise<number> {
  if ((await store.metaGet(marker))?.value) return 0;
  // before a first full round the rows the keys are read through are not all here: running now would settle on nothing
  if (readSessionIdentity()?.kind === 'user' && !(await store.metaGet(LAST_SYNC_KEY))?.value) return 0;
  const recurrings = (await store.allRows('recurring')).filter((r) => r.deleted === 0 && !!r.merchantKey);
  const accounts = (await store.allRows('account')).filter((a) => a.deleted === 0 && !!a.merchantKey);
  const dismissals = (await store.allRows('recurringDismiss')).filter((d) => d.deleted === 0 && !!d.merchantKey);
  let moved = 0;
  if (recurrings.length + accounts.length + dismissals.length > 0) {
    const votes = await votesByOldKey(store, before);
    moved += await rekeyInPlace(repo, 'recurring', recurrings, votes);
    moved += await rekeyInPlace(repo, 'account', accounts, votes);
    moved += await rekeyDismissals(repo, dismissals, votes);
  }
  await store.metaPut(marker, true);
  return moved;
}
