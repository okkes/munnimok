import { isLiability } from '@/features/accounts/accountTypes';
import { writeTxTransform } from '@/db/joined';
import { isMintedLeg, txMetaId } from '@/domain/feedIds';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { AccountRow } from '@/db/types';

/**
 * Loans v2 balance coupling (user design 2026-08-01): linking a
 * transaction to a MANUAL loan moves the loan's balance — paying €100
 * toward it brings the (negative) balance €100 closer to zero, and a
 * further €50 draw pushes it €50 deeper. Bank-fed loans are the bank's
 * and never move here; mirrored manual pairs already carried their
 * balance at creation and are skipped.
 *
 * The smart cutoff: `balanceAsOf` is the date the balance was last
 * known TRUE (loan creation and every manual balance edit stamp it).
 * A linked row DATED BEFORE it is presumed already baked into that
 * number and does not move it — unless the user deliberately counts it
 * in (countPreAnchorTx below, one-shot via the loanCounted marker).
 */

interface LinkableTx {
  amountCents: number;
  date: string;
  transferPeerId?: string;
  loanCounted?: 1;
}

/** the loan-side effect of this row: an outflow (−) pays the loan down (+) */
const loanDelta = (tx: LinkableTx): number => -tx.amountCents;

/** does this row move the loan's balance when (un)linked right now?
 *  STRICTLY newer than the anchor: a payment dated the same day as the
 *  just-typed balance is almost always already inside that number
 *  (review finding: create → match double-moved today's payment) */
export function countsTowardLoan(account: Pick<AccountRow, 'balanceAsOf'>, tx: LinkableTx): boolean {
  if (tx.loanCounted === 1) return true;
  return !account.balanceAsOf || tx.date > account.balanceAsOf;
}

async function adjustableLoan(store: StorageBackend, accountId: string | undefined): Promise<AccountRow | null> {
  if (!accountId) return null;
  const account = await store.get('account', accountId);
  if (account?.deleted !== 0 || account.source !== 'manual' || !isLiability(account.type)) return null;
  return account;
}

/**
 * Applies the balance consequence of a linkedAccountId CHANGE on one
 * transaction: the old loan (if any) gives the amount back, the new
 * loan takes it — each only when the row counts toward it.
 */
export async function applyLoanLinkDelta(
  store: StorageBackend,
  repo: Repo,
  tx: LinkableTx,
  prevLinkedId: string | undefined,
  nextLinkedId: string | undefined,
): Promise<void> {
  if (prevLinkedId === nextLinkedId) return;
  // mirrored pairs: the mirror row on the loan account carried the
  // balance at creation — moving it again would double-count
  if (tx.transferPeerId) return;
  for (const [accountId, sign] of [
    [prevLinkedId, -1],
    [nextLinkedId, 1],
  ] as const) {
    const account = await adjustableLoan(store, accountId);
    if (!account || !countsTowardLoan(account, tx)) continue;
    // balanceAsOf deliberately NOT stamped: the anchor is "the user
    // declared this number true on that day" — a link consequence isn't
    // a declaration, and re-stamping would lock the just-linked row out
    // of its own refund on unlink
    await repo.upsert('account', account.spaceId, account.id, {
      balanceCents: account.balanceCents + sign * loanDelta(tx),
    });
  }
}

/**
 * The user's per-transaction override: count a PRE-anchor row into the
 * loan's balance after all ("this payment isn't part of the number I
 * typed"). One-shot — the loanCounted marker survives on the row so a
 * second tap (or another device replaying the same intent) can't apply
 * it twice, and applyLoanLinkDelta keeps honoring it on later moves.
 */
export async function countPreAnchorTx(
  store: StorageBackend,
  repo: Repo,
  tx: LinkableTx & { id: string; spaceId: string; feedSpaceId?: string; needsReview: 0 | 1 },
  writeMarker: () => Promise<void>,
): Promise<boolean> {
  const account = await adjustableLoan(store, (tx as { linkedAccountId?: string }).linkedAccountId);
  if (!account || tx.loanCounted === 1) return false;
  await repo.upsert('account', account.spaceId, account.id, {
    balanceCents: account.balanceCents + loanDelta(tx),
  });
  await writeMarker();
  return true;
}

/**
 * #509 (user): a loan typed with its current balance equal to its original
 * amount holds no payment yet — every payment linked to it moves its
 * balance, whatever its date, so it carries no cut-off date at all.
 */
export const isPristineLoan = (account: Pick<AccountRow, 'originalCents' | 'balanceCents'>): boolean =>
  !!account.originalCents && account.originalCents > 0 && Math.abs(account.balanceCents) === account.originalCents;

/** a generated leg's source row as its space holds it — the loanCounted
 *  marker sits on the row, or on the space's overlay for a feed row */
async function legSource(store: StorageBackend, spaceId: string, sourceId: string) {
  const raw = await store.get('transaction', sourceId);
  if (raw?.deleted !== 0) return null;
  if (raw.spaceId === spaceId) return { id: raw.id, spaceId, needsReview: raw.needsReview, loanCounted: raw.loanCounted };
  const meta = await store.get('txMeta', txMetaId(spaceId, raw.id));
  return { id: raw.id, spaceId, feedSpaceId: raw.spaceId, needsReview: meta?.needsReview ?? raw.needsReview, loanCounted: meta?.loanCounted };
}

/**
 * #509: a manual loan that was typed pristine but carries a cut-off date
 * (created before the rule) counts in every linked payment its date left
 * out, and drops the date. Only where the ledger can be read back for sure:
 * nothing on the loan but munni's generated legs (no typed balance, no hand
 * entry), and the balance minus the legs that counted is the original — so
 * the loan WAS typed pristine. Returns whether the loan changed.
 */
export async function settlePristineLoan(store: StorageBackend, repo: Repo, loanId: string): Promise<boolean> {
  const loan = await adjustableLoan(store, loanId);
  if (!loan?.balanceAsOf || !loan.originalCents) return false;
  const anchor = loan.balanceAsOf;
  const ledger = (await store.bySpace('transaction', loan.spaceId)).filter((t) => t.deleted === 0 && t.accountId === loan.id);
  if (ledger.some((t) => !isMintedLeg(t))) return false;
  const legs = await Promise.all(
    ledger.map(async (leg) => {
      // a part's leg points at "row:part" — parts carry no marker, their date decides
      const source = leg.transferPeerId!.includes(':') ? null : await legSource(store, loan.spaceId, leg.transferPeerId!);
      return { leg, source, counted: source?.loanCounted === 1 || leg.date > anchor };
    }),
  );
  const typed = loan.balanceCents - legs.filter((l) => l.counted).reduce((sum, l) => sum + l.leg.amountCents, 0);
  if (!isPristineLoan({ originalCents: loan.originalCents, balanceCents: typed })) return false;
  const uncounted = legs.filter((l) => !l.counted);
  await repo.upsert('account', loan.spaceId, loan.id, {
    balanceCents: loan.balanceCents + uncounted.reduce((sum, l) => sum + l.leg.amountCents, 0),
    balanceAsOf: null as never,
  });
  for (const { source } of uncounted) {
    if (source) await writeTxTransform(repo, source, { loanCounted: 1 });
  }
  return true;
}

/** #509: every manual loan settles once (the boot fold) — a settled loan has no date left to settle */
export async function settlePristineLoans(store: StorageBackend, repo: Repo): Promise<number> {
  let settled = 0;
  for (const account of await store.allRows('account')) {
    if (account.deleted === 0 && account.source === 'manual' && isLiability(account.type) && account.balanceAsOf && account.originalCents) {
      if (await settlePristineLoan(store, repo, account.id)) settled++;
    }
  }
  return settled;
}
