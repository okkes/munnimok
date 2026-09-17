import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { TransactionRow, TxMetaRow, TxSplit } from '@/db/types';
import { visibleAccounts, writeTxTransform } from '@/db/joined';
import type { SpaceAccount, TxTransformFields } from '@/db/joined';
import { UNCATEGORIZED_ID, isMovementCat, specialCatType } from '@/domain/categories';
import { matchCounterAccount } from '@/domain/counterClue';
import type { ClueTx } from '@/domain/counterClue';
import { defaultFamilyFor } from '@/domain/defaultAccounts';
import type { DefaultFamily } from '@/domain/defaultAccounts';
import { standardTypeFor } from '@/domain/txKind';
import { accountStamp, movementCatFor } from '@/domain/txType';
import { ensureDefaultAccount } from './defaultAccounts';

/** the row's clue text for the transfer matcher (#228 r3) — the user's
 *  rename counts as a title clue too */
const clueOf = (raw: TransactionRow, meta: TxMetaRow | undefined): ClueTx => ({
  merchant: raw.merchant,
  titleOverride: meta?.titleOverride ?? raw.titleOverride,
  description: raw.description,
  counterIban: raw.counterIban,
});

/** a bare movement part's family, null when the part needs no fold */
const barePartFamily = (s: TxSplit): DefaultFamily | null =>
  isMovementCat(s.catId) && !s.linkedAccountId && !s.transferPeerId ? defaultFamilyFor(s.catId) : null;

/** #228 r3: the row-level bare transfer's outcome — a clue-matched
 *  counterparty (the bijection refiles the category from its kind), or
 *  the stand-down to Uncategorized + review */
function resolveBareTransfer(
  clue: ClueTx,
  candidates: readonly SpaceAccount[],
  accountId: string,
  amountCents: number,
): TxTransformFields {
  const match = matchCounterAccount(clue, candidates, accountId);
  if (match) return { linkedAccountId: match.id, catId: movementCatFor(match.type, amountCents) };
  return { catId: UNCATEGORIZED_ID, txType: standardTypeFor(amountCents), needsReview: 1 };
}

/** the part-level twin: link the matched account, or the part goes
 *  uncategorized (its stale stored txType drops) and the container
 *  returns to review */
function resolveBareTransferPart(
  slice: TxSplit,
  clue: ClueTx,
  candidates: readonly SpaceAccount[],
  accountId: string,
  amountCents: number,
): { part: TxSplit; sendBack?: boolean } {
  const match = matchCounterAccount(clue, candidates, accountId);
  if (match) {
    const catId = movementCatFor(match.type, amountCents);
    return { part: { ...slice, linkedAccountId: match.id, catId, txType: specialCatType(catId) ?? slice.txType } };
  }
  const { txType: _stale, ...rest } = slice;
  return { part: { ...rest, catId: UNCATEGORIZED_ID }, sendBack: true };
}

/** the splits arm of the bare-row fold (S3776: out of migrateRow): pot
 *  families take their default, transfer parts resolve by clue or stand
 *  the container back to review (#228 r3). Null = nothing to fold. */
async function foldBareParts(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  raw: TransactionRow,
  meta: TxMetaRow | undefined,
  candidatesFor: (spaceId: string) => Promise<SpaceAccount[]>,
  splits: readonly TxSplit[] | undefined,
): Promise<(TxTransformFields & { splits: TxSplit[] }) | null> {
  if (!(splits ?? []).some((s) => !!barePartFamily(s))) return null;
  const clue = clueOf(raw, meta);
  const next: TxSplit[] = [];
  let sendBack = false;
  for (const slice of splits ?? []) {
    const family = barePartFamily(slice);
    if (!family) {
      next.push(slice);
      continue;
    }
    if (family === 'transfer') {
      const folded = resolveBareTransferPart(slice, clue, await candidatesFor(spaceId), raw.accountId, raw.amountCents);
      next.push(folded.part);
      sendBack ||= !!folded.sendBack;
      continue;
    }
    next.push({ ...slice, linkedAccountId: await ensureDefaultAccount(store, repo, spaceId, family) });
  }
  return { splits: next, ...(sendBack ? { needsReview: 1 as const } : {}) };
}

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
 *
 * #228 r3 (user rule): the TRANSFER family never folds onto its default
 * — the bank text must name a real tracked account (the clue-matcher);
 * without a clue the row stands down to Uncategorized and goes back to
 * review. Its default account remains a manual pick only.
 */
export async function migrateBareSpecialRows(store: StorageBackend, repo: Repo): Promise<number> {
  const accounts = new Map((await store.allRows('account')).map((a) => [a.id, a]));
  const stampOf = (accountId: string) => accountStamp(accounts.get(accountId)?.type);

  // the transfer clue-matcher's pool, per space (lazy — most boots never need it)
  const candidatesBySpace = new Map<string, SpaceAccount[]>();
  const candidatesFor = async (spaceId: string): Promise<SpaceAccount[]> => {
    const cached = candidatesBySpace.get(spaceId);
    if (cached) return cached;
    const fresh = await visibleAccounts(store, spaceId);
    candidatesBySpace.set(spaceId, fresh);
    return fresh;
  };

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
    if ((splits ?? []).length > 1) {
      const folded = await foldBareParts(store, repo, spaceId, raw, meta, candidatesFor, splits);
      if (folded) {
        await writeTxTransform(repo, tx, folded);
        touched++;
      }
      return;
    }

    if (!isMovementCat(catId) || linkedAccountId || transferPeerId) return;
    const family = defaultFamilyFor(catId);
    if (!family) return;
    if (family === 'transfer') {
      // #228 r3: clue-matched real account, or Uncategorized + review
      await writeTxTransform(repo, tx, resolveBareTransfer(clueOf(raw, meta), await candidatesFor(spaceId), raw.accountId, raw.amountCents));
      touched++;
      return;
    }
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
