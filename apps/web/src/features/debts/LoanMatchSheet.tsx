import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { useSpaceAccounts, useSpaceHistoryTransactions, useTxTransform } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { countsTowardLoan } from '@/application/loanBalance';
import { REIMBURSED_ID, autoSubFor } from '@/domain/categories';
import { normalizeIban } from '@/domain/feedIds';
import type { AccountRow } from '@/db/types';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import { TxRow } from '@/ui/TxRow';

/** matching knobs — amounts within 10% (or 50 cents) read as "the payment" */
const AMOUNT_TOLERANCE = (paymentCents: number) => Math.max(50, Math.round(paymentCents * 0.1));
const MAX_SHOWN = 20;

export interface Scored {
  tx: SpaceTx;
  score: number;
  /** dated before the loan's known-true balance — linking won't move it */
  preAnchor: boolean;
}

/** the loan fields the matcher reads — a fresh store.get row satisfies it */
type MatchAccount = Pick<AccountRow, 'id' | 'name' | 'iban' | 'paymentCents' | 'balanceAsOf'>;

/**
 * #286 r2: the WHOLE candidate derivation as one module joint — the
 * sheet's memo renders from it, and the DebtsScreen host asks it BEFORE
 * auto-opening (zero hits = the sheet never shows at all).
 */
export function loanMatchCandidates(
  account: MatchAccount,
  txs: readonly SpaceTx[],
  spaceAccounts: readonly Pick<AccountRow, 'id' | 'defaultFor'>[],
): Scored[] {
  // #221: a link onto the space's DEFAULT pot is provisional — those
  // rows stay candidates, and applying RELINKS them (the choke moves
  // the minted leg from the pot to this loan)
  const defaultIds = new Set(spaceAccounts.filter((a) => a.defaultFor).map((a) => a.id));
  const provisional = (tx: SpaceTx) => !!tx.linkedAccountId && defaultIds.has(tx.linkedAccountId);
  const ctx = {
    iban: account.iban ? normalizeIban(account.iban) : null,
    tokens: account.name
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 3),
    paymentCents: account.paymentCents,
  };
  const scored: Scored[] = [];
  for (const tx of txs) {
    if (tx.deleted !== 0 || tx.accountId === account.id) continue;
    if ((tx.linkedAccountId || tx.transferPeerId) && !provisional(tx)) continue;
    // #143: a split container never links wholesale — its parts carry
    // their own loan legs (linked from their part pages)
    if ((tx.splits ?? []).filter((s) => s.catId !== REIMBURSED_ID).length > 1) continue;
    const score = scoreCandidate(tx, ctx);
    if (score >= 2) scored.push({ tx, score, preAnchor: !countsTowardLoan(account, tx) });
  }
  scored.sort((a, b) => b.score - a.score || b.tx.date.localeCompare(a.tx.date));
  return scored.slice(0, MAX_SHOWN);
}

/** additive evidence: counter-IBAN is near-proof, the debt-payment
 *  label is strong, amount and name keywords corroborate (S3776: the
 *  branches live out of the component) */
function scoreCandidate(
  tx: SpaceTx,
  ctx: { iban: string | null; tokens: readonly string[]; paymentCents?: number },
): number {
  let score = 0;
  if (ctx.iban && tx.counterIban && normalizeIban(tx.counterIban) === ctx.iban) score += 4;
  if (tx.txType === 'debtPayment') score += 3;
  if (ctx.paymentCents && Math.abs(Math.abs(tx.amountCents) - ctx.paymentCents) <= AMOUNT_TOLERANCE(ctx.paymentCents)) score += 2;
  const hay = `${tx.merchant} ${tx.description ?? ''}`.toLowerCase();
  if (ctx.tokens.some((token) => hay.includes(token))) score += 1;
  return score;
}

/**
 * "Found these payments" (user request 2026-08-01, the event-suggest
 * idea for loans): right after a loan is created — or any time from its
 * detail — the full stored history is searched by counter-IBAN, the
 * debt-payment label, the payment amount and name keywords. The user
 * picks which rows to link; rows older than the loan's balance date are
 * flagged and only move the balance when their "count" chip is on.
 */
export function LoanMatchSheet({ accountId, onClose }: Readonly<{ accountId: string | null; onClose: () => void }>) {
  const { t } = useLang();
  const { store } = useData();
  const transform = useTxTransform();
  const txs = useSpaceHistoryTransactions();
  const spaceAccounts = useSpaceAccounts();
  const account = useQuery(store, async () => (accountId ? store.get('account', accountId) : undefined), [accountId]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [counted, setCounted] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const candidates = useMemo<Scored[]>(
    () => (account && txs ? loanMatchCandidates(account, txs, spaceAccounts ?? []) : []),
    [account, txs, spaceAccounts],
  );
  // #286 r2: "nothing found" is only true once the queries answered —
  // while they load, the sheet shows the hint, never a false empty line
  const ready = !!account && !!txs && !!spaceAccounts;
  const empty = ready && candidates.length === 0;

  // strong matches arrive pre-checked ONCE per loan; live-query
  // re-emissions must never clobber the user's pruning (review finding)
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!accountId) {
      seededFor.current = null;
      return;
    }
    if (seededFor.current === accountId || candidates.length === 0) return;
    seededFor.current = accountId;
    setPicked(new Set(candidates.filter((c) => c.score >= 3).map((c) => c.tx.id)));
    setCounted(new Set());
  }, [accountId, candidates]);

  const toggle = (set: ReadonlySet<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const apply = async () => {
    if (!accountId || busy) return;
    setBusy(true);
    try {
      for (const { tx } of candidates) {
        if (!picked.has(tx.id)) continue;
        // a loan link IS a debt payment (review finding: leaving the
        // spending category would double-count consumption). #133 r5
        // bijection: the source leg files the DEBT story by its
        // counter's kind — "Loan payment", not a blanket transfer; the
        // loan's own ledger gets the minted mirror (typed by its stamp)
        // from the choke point, and the count-it marker rides the SAME
        // write so a pre-anchor mint moves the balance when opted in.
        await transform(
          tx,
          {
            linkedAccountId: accountId,
            txType: 'debtPayment',
            catId: autoSubFor('debtPayment', tx.amountCents),
            ...(counted.has(tx.id) ? { loanCounted: 1 as const } : {}),
          },
          'txLink',
        );
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    // #286 r2 (user): a manual open with nothing to offer collapses to
    // the title plus ONE quiet line — no hint paragraph, compact height
    // (the auto-open host skips the sheet entirely on zero candidates)
    <Sheet open={accountId !== null} onOpenChange={(next) => !next && onClose()} title={t('debts.matchTitle')} size={empty ? 'compact' : 'tall'}>
      {!empty && (
        <p className="pb-2 text-[12px] leading-snug text-ink-3" data-testid="loanmatch-hint">
          {t('debts.matchHint')}
        </p>
      )}
      {empty && (
        <p className="px-1 py-6 text-center text-[13px] text-ink-4" data-testid="loanmatch-empty">
          {t('debts.matchNone')}
        </p>
      )}
      {/* #286 (user): the pre-anchor story told ONCE above the list —
          the per-row warning text + floating amount badge read messy */}
      {candidates.some((c) => c.preAnchor) && (
        <p className="pb-2 text-[11px] leading-snug text-ink-4" data-testid="loanmatch-old-caption">
          {t('debts.matchOldCaption')}
        </p>
      )}
      <div className="flex flex-col" data-testid="loanmatch-list">
        {candidates.map(({ tx, preAnchor }) => (
          <div key={tx.id} className="flex items-center gap-2 border-b border-line-2 py-1 last:border-0">
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <input
                data-testid={`loanmatch-pick-${tx.id}`}
                type="checkbox"
                checked={picked.has(tx.id)}
                onChange={() => setPicked((prev) => toggle(prev, tx.id))}
                className="h-5 w-5 shrink-0 accent-[var(--m-accent)]"
              />
              <span className="min-w-0 flex-1">
                <TxRow tx={tx} showDate />
              </span>
            </label>
            {/* #286: ONE clear trailing control, standard row anatomy —
                left the payment's face, right the counts-toward switch */}
            {preAnchor && picked.has(tx.id) && (
              <label className="flex shrink-0 flex-col items-center gap-1 pr-1 text-[10px] font-medium text-ink-4">
                <input
                  data-testid={`loanmatch-count-${tx.id}`}
                  type="checkbox"
                  checked={counted.has(tx.id)}
                  onChange={() => setCounted((prev) => toggle(prev, tx.id))}
                  className="h-5 w-5 accent-[var(--m-accent)]"
                />
                {t('debts.matchCounts')}
              </label>
            )}
          </div>
        ))}
      </div>
      {candidates.length > 0 && (
        <Button className="mt-3 w-full" data-testid="loanmatch-apply" disabled={busy || picked.size === 0} onClick={() => void apply()}>
          {t('debts.matchApply', { n: picked.size })}
        </Button>
      )}
    </Sheet>
  );
}
