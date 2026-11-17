import { isLiability } from '@/features/accounts/accountTypes';
import { writeTxTransform } from '@/db/joined';
import { isMintedLeg, txMetaId } from '@/domain/feedIds';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { AccountRow } from '@/db/types';

// linking to a MANUAL loan moves its balance; bank-fed loans are the bank's, mirrored pairs carried it at creation
// balanceAsOf = the date the balance was last known TRUE (creation, every manual edit)
// a row dated before it is presumed inside that number, unless deliberately counted in (countPreAnchorTx)

interface LinkableTx {
  amountCents: number;
  date: string;
  transferPeerId?: string;
  loanCounted?: 1;
}

/** the loan-side effect of this row: an outflow (−) pays the loan down (+) */
const loanDelta = (tx: LinkableTx): number => -tx.amountCents;

/** STRICTLY newer than the anchor: a same-day payment is almost always inside the typed balance (it double-moved) */
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

export async function applyLoanLinkDelta(
  store: StorageBackend,
  repo: Repo,
  tx: LinkableTx,
  prevLinkedId: string | undefined,
  nextLinkedId: string | undefined,
): Promise<void> {
  if (prevLinkedId === nextLinkedId) return;
  // mirrored pairs: the mirror row on the loan account carried the balance at creation; moving it again double-counts
  if (tx.transferPeerId) return;
  for (const [accountId, sign] of [
    [prevLinkedId, -1],
    [nextLinkedId, 1],
  ] as const) {
    const account = await adjustableLoan(store, accountId);
    if (!account || !countsTowardLoan(account, tx)) continue;
    // balanceAsOf is not re-stamped: a link is no declaration, and re-stamping would lock the row out of its own unlink refund
    await repo.upsert('account', account.spaceId, account.id, {
      balanceCents: account.balanceCents + sign * loanDelta(tx),
    });
  }
}

// one-shot: the loanCounted marker on the row stops a second tap or another device from applying it twice
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

// #509: a loan typed with balance == original amount holds no payment yet: every linked payment moves it, no cut-off date
export const isPristineLoan = (account: Pick<AccountRow, 'originalCents' | 'balanceCents'>): boolean =>
  !!account.originalCents && account.originalCents > 0 && Math.abs(account.balanceCents) === account.originalCents;

async function legSource(store: StorageBackend, spaceId: string, sourceId: string) {
  const raw = await store.get('transaction', sourceId);
  if (raw?.deleted !== 0) return null;
  if (raw.spaceId === spaceId) return { id: raw.id, spaceId, needsReview: raw.needsReview, loanCounted: raw.loanCounted };
  const meta = await store.get('txMeta', txMetaId(spaceId, raw.id));
  return { id: raw.id, spaceId, feedSpaceId: raw.spaceId, needsReview: meta?.needsReview ?? raw.needsReview, loanCounted: meta?.loanCounted };
}

// #509: a pristine manual loan with a cut-off date (made before the rule) counts in the payments the date left out, drops it
// only when the ledger holds nothing but generated legs and balance minus the counted legs is the original
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
