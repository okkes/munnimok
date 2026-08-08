import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { TransactionRow, TxMetaRow, TxSplit } from '@/db/types';
import { writeTxTransform } from '@/db/joined';
import { isMovementCat, specialCatType } from '@/domain/categories';
import { accountStamp } from '@/domain/txType';
import { ensureDefaultAccount } from './defaultAccounts';
import type { DefaultFamily } from './defaultAccounts';

/**
 * #133 ruling 3 (user 2026-08-08): bare MOVEMENT rows — a ◆ movement
 * category (set aside, loan repayment, …) with no counterparty — migrate
 * onto the space's lazy-minted DEFAULT account for that family. The link
 * runs through the ONE write choke, so the mirror lifecycle mints the
 * pot's leg and moves real balances, exactly as approved ("migrate…
 * balances then move"). Split PARTS with bare movement categories get
 * the same treatment through the part-mirror machinery.
 *
 * Idempotent: meta marker + deterministic default-account and mirror
 * ids; late-syncing old-device rows are healed by the NEXT device that
 * boots after they arrive (the marker is per device, the ids converge).
 * Interest/fees categories are value stories, not movements — untouched.
 * Funding stays counterparty-less (ruling 5). Rows ON special accounts
 * are the pot's own ledger and never link (their stamp guards them).
 */
export async function migrateBareSpecialRows(store: StorageBackend, repo: Repo): Promise<number> {
  const markerKey = 'txCategoryModel_v1';
  if (await store.metaGet(markerKey)) return 0;

  const accounts = new Map((await store.allRows('account')).map((a) => [a.id, a]));
  const stampOf = (accountId: string) => accountStamp(accounts.get(accountId)?.type);

  let touched = 0;

  const migrateRow = async (
    raw: TransactionRow,
    meta: TxMetaRow | undefined,
    spaceId: string,
    feedSpaceId: string | undefined,
  ): Promise<void> => {
    if (stampOf(raw.accountId)) return; // the pot's own ledger — never links
    const catId = meta?.catId ?? raw.catId;
    const linkedAccountId = meta?.linkedAccountId ?? raw.linkedAccountId;
    const transferPeerId = meta?.transferPeerId ?? raw.transferPeerId;
    const splits = meta?.splits ?? raw.splits;
    const tx = {
      id: raw.id,
      spaceId,
      feedSpaceId,
      txType: meta?.txType ?? raw.txType,
      needsReview: meta?.needsReview ?? raw.needsReview,
      amountCents: raw.amountCents,
      date: raw.date,
      linkedAccountId,
      transferPeerId,
    };

    // split containers migrate PART BY PART (the container is a vessel)
    const parts = (splits ?? []).filter((s) => s.catId !== 'reimbursed');
    if (parts.length > 1) {
      const barePart = (s: TxSplit) => isMovementCat(s.catId) && !s.linkedAccountId && !s.transferPeerId;
      if (!parts.some(barePart)) return;
      const next: TxSplit[] = [];
      for (const slice of splits ?? []) {
        if (!barePart(slice)) {
          next.push(slice);
          continue;
        }
        const family = specialCatType(slice.catId) as DefaultFamily;
        next.push({ ...slice, linkedAccountId: await ensureDefaultAccount(store, repo, spaceId, family) });
      }
      await writeTxTransform(repo, tx, { splits: next });
      touched++;
      return;
    }

    if (!isMovementCat(catId) || linkedAccountId || transferPeerId) return;
    const family = specialCatType(catId) as DefaultFamily;
    const targetId = await ensureDefaultAccount(store, repo, spaceId, family);
    // the choke derives the compat txType: a DEFAULT counter keeps the
    // row wearing its special category (the user's counterparty rule)
    await writeTxTransform(repo, tx, { linkedAccountId: targetId });
    touched++;
  };

  // feed rows live in their FEED space and carry user decisions on txMeta
  // — the raw loop takes only LOCAL rows, the meta loop the feed overlays
  const feedSpaceIds = new Set((await store.allRows('accountLink')).map((link) => link.feedSpaceId));
  for (const raw of await store.allRows('transaction')) {
    if (raw.deleted !== 0 || feedSpaceIds.has(raw.spaceId)) continue;
    await migrateRow(raw, undefined, raw.spaceId, undefined);
  }
  for (const meta of await store.allRows('txMeta')) {
    if (meta.deleted !== 0) continue;
    const raw = await store.get('transaction', meta.txId);
    if (raw?.deleted !== 0) continue;
    await migrateRow(raw, meta, meta.spaceId, raw.spaceId);
  }

  await store.metaPut(markerKey, Date.now());
  return touched;
}
