import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { TransactionRow, TxMetaRow, TxSplit } from '@/db/types';
import { writeTxTransform } from '@/db/joined';
import { isMovementCat } from '@/domain/categories';
import { defaultFamilyFor } from '@/domain/defaultAccounts';
import { accountStamp } from '@/domain/txType';
import { ensureDefaultAccount } from './defaultAccounts';

/**
 * #133 ruling 3, widened by #221: bare MOVEMENT rows — a ◆ movement
 * category (set aside, loan repayment, cash withdraw, …) with no
 * counterparty — link onto the space's DEFAULT account for that family.
 * The link runs through the ONE write choke, so the mirror lifecycle
 * mints the counter leg and moves real balances, exactly as approved
 * ("migrate… balances then move"). Split PARTS with bare movement
 * categories get the same treatment through the part-mirror machinery.
 *
 * EVERY BOOT now (#221, the marker retired): the server keeps writing
 * keyword-predicted movement categories with no counterparty (GcIngest),
 * so a one-shot migration can never stay ahead — each boot heals what
 * arrived since the last one. Idempotent: already-linked rows skip, and
 * deterministic default-account and mirror ids converge across devices.
 * Interest/fees categories are value stories, not movements — untouched.
 * Rows ON special accounts are the pot's own ledger and never link
 * (their stamp guards them). The ATM pair links the cash wallet, not
 * the default bank account (defaultFamilyFor).
 */
export async function migrateBareSpecialRows(store: StorageBackend, repo: Repo): Promise<number> {
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
        const family = barePart(slice) ? defaultFamilyFor(slice.catId) : null;
        if (!family) {
          next.push(slice);
          continue;
        }
        next.push({ ...slice, linkedAccountId: await ensureDefaultAccount(store, repo, spaceId, family) });
      }
      await writeTxTransform(repo, tx, { splits: next });
      touched++;
      return;
    }

    if (!isMovementCat(catId) || linkedAccountId || transferPeerId) return;
    const family = defaultFamilyFor(catId);
    if (!family) return;
    const targetId = await ensureDefaultAccount(store, repo, spaceId, family);
    // the choke derives the compat txType: a DEFAULT counter keeps the
    // row wearing its special category (the user's counterparty rule)
    await writeTxTransform(repo, tx, { linkedAccountId: targetId });
    touched++;
  };

  // cheap every-boot gate: only rows that could possibly be bare
  // movements (row cat or a split part) reach the merged read
  const candidate = (row: { catId?: string; linkedAccountId?: string; transferPeerId?: string; splits?: TxSplit[] }) =>
    (isMovementCat(row.catId) && !row.linkedAccountId && !row.transferPeerId) ||
    (row.splits ?? []).some((s) => isMovementCat(s.catId) && !s.linkedAccountId && !s.transferPeerId);

  // feed rows live in their FEED space and carry user decisions on txMeta
  // — the raw loop takes only LOCAL rows, the meta loop the feed overlays
  const feedSpaceIds = new Set((await store.allRows('accountLink')).map((link) => link.feedSpaceId));
  for (const raw of await store.allRows('transaction')) {
    if (raw.deleted !== 0 || feedSpaceIds.has(raw.spaceId) || !candidate(raw)) continue;
    await migrateRow(raw, undefined, raw.spaceId, undefined);
  }
  for (const meta of await store.allRows('txMeta')) {
    if (meta.deleted !== 0 || !candidate(meta)) continue;
    const raw = await store.get('transaction', meta.txId);
    if (raw?.deleted !== 0) continue;
    await migrateRow(raw, meta, meta.spaceId, raw.spaceId);
  }

  return touched;
}
