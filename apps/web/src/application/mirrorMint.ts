import { autoSubFor, stampMovementSub } from '@/domain/categories';
import { mirrorTxId } from '@/domain/feedIds';
import { accountStamp, movementCatFor } from '@/domain/txType';
import { isLiability } from '@/features/accounts/accountTypes';
import { countsTowardLoan } from './loanBalance';
import { asSpaceAccount } from '@/db/joined';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { AccountRow } from '@/db/types';

// mint-on-link: linking a MANUAL account as counterparty mints the mirror row on it; its lifecycle carries the balance.
// Bank-fed counterparts mint nothing: their real row arrives and the pair matcher links it. The mirror id is
// deterministic (mirrorTxId), so devices converge via LWW; liability balances keep the loans-v2 balanceAsOf cutoff.

export interface MirrorSource {
  id: string;
  accountId: string;
  amountCents: number;
  date: string;
  time?: string;
  currency: string;
  merchant: string;
  loanCounted?: 1;
}

// the space's own MANUAL account, never a funding pot (#152: funding shows no transactions, a leg would be invisible)
async function mintableCounter(store: StorageBackend, accountId: string | undefined): Promise<AccountRow | null> {
  if (!accountId) return null;
  const account = await store.get('account', accountId);
  if (account?.deleted !== 0 || account.source !== 'manual' || account.type === 'funding') return null;
  return account;
}

const balanceMoves = (account: AccountRow, source: MirrorSource): boolean =>
  !isLiability(account.type) || countsTowardLoan(account, source);

async function planResizeStep(
  store: StorageBackend,
  source: MirrorSource,
  linkedId: string,
  mid: string,
): Promise<((repo: Repo) => Promise<void>) | null> {
  const account = await mintableCounter(store, linkedId);
  const mirror = await store.get('transaction', mid);
  const mirrorAmount = -source.amountCents;
  if (!account || mirror?.deleted !== 0 || mirror.accountId !== account.id || mirror.amountCents === mirrorAmount) {
    return null;
  }
  const delta = mirrorAmount - mirror.amountCents;
  return async (repo) => {
    await repo.upsert('transaction', account.spaceId, mid, { amountCents: mirrorAmount });
    if (balanceMoves(account, source)) {
      const fresh = await store.get('account', account.id);
      if (fresh?.deleted === 0) {
        await repo.upsert('account', fresh.spaceId, fresh.id, { balanceCents: fresh.balanceCents + delta });
      }
    }
  };
}

export interface MirrorPlan {
  sourceFields: { transferPeerId?: string | null };
  execute: (repo: Repo) => Promise<void>;
}

// reads fresh state, never the caller's snapshot (stale-peer lesson); `incomingPeer` = the caller pairs an existing row
export async function planMirrorChange(
  store: StorageBackend,
  source: MirrorSource,
  prevLinkedId: string | undefined,
  nextLinkedId: string | undefined,
  currentPeerId: string | undefined,
  incomingPeer: string | null | undefined,
): Promise<MirrorPlan> {
  const steps: Array<(repo: Repo) => Promise<void>> = [];
  const sourceFields: MirrorPlan['sourceFields'] = {};
  const mid = mirrorTxId(source.id);

  // the old link loses OUR mint only: unpairing a picked/bank row is the unpair button's job
  if (prevLinkedId && prevLinkedId !== nextLinkedId && currentPeerId === mid) {
    const prevAccount = await mintableCounter(store, prevLinkedId);
    const mirror = await store.get('transaction', mid);
    if (prevAccount && mirror?.deleted === 0 && mirror.accountId === prevAccount.id) {
      steps.push(async (repo) => {
        await repo.remove('transaction', prevAccount.spaceId, mid);
        if (balanceMoves(prevAccount, source)) {
          const fresh = await store.get('account', prevAccount.id);
          if (fresh?.deleted === 0) {
            await repo.upsert('account', fresh.spaceId, fresh.id, {
              balanceCents: fresh.balanceCents - -source.amountCents,
            });
          }
        }
      });
      sourceFields.transferPeerId = null;
    }
  }

  // same link, new money: only OUR mint moves; a picked/bank peer is a real row
  if (prevLinkedId && prevLinkedId === nextLinkedId && currentPeerId === mid) {
    const resize = await planResizeStep(store, source, nextLinkedId, mid);
    if (resize) steps.push(resize);
  }

  if (nextLinkedId && nextLinkedId !== prevLinkedId && !incomingPeer) {
    const nextAccount = await mintableCounter(store, nextLinkedId);
    // an existing live mirror (same deterministic id) means another device already minted: adopt it
    const existing = await store.get('transaction', mid);
    const alreadyMinted = existing?.deleted === 0 && existing.accountId === nextAccount?.id;
    if (nextAccount && (currentPeerId === undefined || currentPeerId === mid || sourceFields.transferPeerId === null)) {
      const stamp = accountStamp(nextAccount.type);
      // #133 r5: an unstamped mirror files by its counter's kind, as the mint's space reads it (#536: an attached account's type)
      const sourceType = (await asSpaceAccount(store, nextAccount.spaceId, await store.get('account', source.accountId)))?.type;
      const mirrorAmount = -source.amountCents;
      steps.push(async (repo) => {
        if (!alreadyMinted) {
          await repo.upsert('transaction', nextAccount.spaceId, mid, {
            accountId: nextAccount.id,
            date: source.date,
            ...(source.time ? { time: source.time } : {}),
            amountCents: mirrorAmount,
            currency: source.currency,
            merchant: source.merchant,
            catId:
              (stamp ? stampMovementSub(stamp, mirrorAmount) : undefined) ??
              (sourceType ? movementCatFor(sourceType, mirrorAmount) : autoSubFor('transfer', mirrorAmount)),
            // born reviewed: no bank row, nobody predicted it; the source row is what the deck reviews
            needsReview: 0 as const,
            linkedAccountId: source.accountId,
            transferPeerId: source.id,
          });
          if (balanceMoves(nextAccount, source)) {
            const fresh = await store.get('account', nextAccount.id);
            if (fresh?.deleted === 0) {
              await repo.upsert('account', fresh.spaceId, fresh.id, {
                balanceCents: fresh.balanceCents + mirrorAmount,
              });
            }
          }
        }
        // balanceAsOf is deliberately not stamped: a link consequence is no balance declaration
      });
      sourceFields.transferPeerId = mid;
    }
  }

  return {
    sourceFields,
    execute: async (repo) => {
      for (const step of steps) await step(repo);
    },
  };
}

// heal for rows linked before the mint engine existed, or whose mirror was deleted
export async function mintMirrorForExistingLink(
  store: StorageBackend,
  repo: Repo,
  source: MirrorSource,
  linkedAccountId: string | undefined,
  currentPeerId: string | undefined,
): Promise<string | null> {
  if (!linkedAccountId) return null;
  const plan = await planMirrorChange(store, source, undefined, linkedAccountId, currentPeerId, undefined);
  const peer = plan.sourceFields.transferPeerId;
  if (typeof peer !== 'string') return null;
  await plan.execute(repo);
  return peer;
}

// call BEFORE removing the source: the merged row must still be readable
export async function removeMirrorForDeletedSource(
  store: StorageBackend,
  repo: Repo,
  source: MirrorSource,
  linkedAccountId: string | undefined,
): Promise<void> {
  const plan = await planMirrorChange(store, source, linkedAccountId, undefined, mirrorTxId(source.id), undefined);
  await plan.execute(repo);
}
