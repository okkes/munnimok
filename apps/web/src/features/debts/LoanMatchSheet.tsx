import { SelectAllRow } from '@/ui/SelectAllRow';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { useSpaceHistoryTransactions, useTxTransform } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { countsTowardLoan } from '@/application/loanBalance';
import { REIMBURSED_ID, autoSubFor } from '@/domain/categories';
import { normalizeIban } from '@/domain/feedIds';
import type { AccountRow } from '@/db/types';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
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

type MatchAccount = Pick<AccountRow, 'id' | 'name' | 'iban' | 'paymentCents' | 'balanceAsOf'>;

// one joint: the sheet renders from it and DebtsScreen asks it before auto-opening (zero hits: no sheet) (#286)
export function loanMatchCandidates(account: MatchAccount, txs: readonly SpaceTx[]): Scored[] {
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
    // a row that names its counterparty already is spoken for (#546: no default pot holds rows provisionally any more)
    if (tx.linkedAccountId || tx.transferPeerId) continue;
    // #143: a split container never links wholesale — its parts carry
    // their own loan legs (linked from their part pages)
    if ((tx.splits ?? []).filter((s) => s.catId !== REIMBURSED_ID).length > 1) continue;
    const score = scoreCandidate(tx, ctx);
    if (score >= 2) scored.push({ tx, score, preAnchor: !countsTowardLoan(account, tx) });
  }
  scored.sort((a, b) => b.score - a.score || b.tx.date.localeCompare(a.tx.date));
  return scored.slice(0, MAX_SHOWN);
}

// additive evidence: counter-IBAN is near-proof, the debt-payment label strong, amount and name keywords corroborate
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

const toggle = (set: ReadonlySet<string>, id: string): Set<string> => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

/** does this candidate subtract from the loan when applied? Post-anchor
 *  rows always do; pre-anchor rows only with their deduct switch on */
const rowDeducts = (candidate: Scored, counted: ReadonlySet<string>): boolean =>
  candidate.preAnchor ? counted.has(candidate.tx.id) : true;

// only picked rows that deduct move the number (a payment is negative: subtracting it moves the balance toward zero)
function deductTotals(
  candidates: readonly Scored[],
  picked: ReadonlySet<string>,
  counted: ReadonlySet<string>,
  balanceCents: number,
): { deductSumCents: number; newBalanceCents: number } {
  let sum = 0;
  for (const candidate of candidates) {
    if (picked.has(candidate.tx.id) && rowDeducts(candidate, counted)) sum += candidate.tx.amountCents;
  }
  return { deductSumCents: sum, newBalanceCents: balanceCents - sum };
}

// strong matches arrive pre-picked; original == |balance| means nothing was deducted upfront,
// so every pre-anchor deduct switch starts ON
function seedSelections(
  candidates: readonly Scored[],
  account: Pick<AccountRow, 'balanceCents' | 'originalCents'>,
): { picked: Set<string>; counted: Set<string> } {
  const picked = new Set(candidates.filter((c) => c.score >= 3).map((c) => c.tx.id));
  const autoDeduct = !!account.originalCents && account.originalCents === Math.abs(account.balanceCents);
  const counted = new Set<string>(autoDeduct ? candidates.filter((c) => c.preAnchor).map((c) => c.tx.id) : []);
  return { picked, counted };
}

// every pick links as a debt payment: the #133 r5 bijection files the source leg, the choke point mints the loan mirror
// a pre-anchor opt-in carries loanCounted on the same write so its mint moves the balance
async function applyLinks(
  transform: ReturnType<typeof useTxTransform>,
  accountId: string,
  candidates: readonly Scored[],
  picked: ReadonlySet<string>,
  counted: ReadonlySet<string>,
): Promise<void> {
  for (const { tx, preAnchor } of candidates) {
    if (!picked.has(tx.id)) continue;
    await transform(
      tx,
      {
        linkedAccountId: accountId,
        catId: autoSubFor('debtPayment', tx.amountCents),
        ...(preAnchor && counted.has(tx.id) ? { loanCounted: 1 as const } : {}),
      },
      'txLink',
    );
  }
}

// disabled renders muted and inert, never absent, so the layout never jumps between rows
function Switch({
  on,
  disabled = false,
  label,
  testId,
  onToggle,
}: Readonly<{ on: boolean; disabled?: boolean; label: string; testId: string; onToggle: () => void }>) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-disabled={disabled || undefined}
      aria-label={label}
      data-testid={testId}
      onClick={() => {
        if (!disabled) onToggle();
      }}
      className={`flex h-5 w-9 shrink-0 items-center rounded-full border-none p-0.5 transition-colors ${
        on ? 'justify-end bg-accent' : 'justify-start bg-bg-2'
      } ${disabled ? 'opacity-40' : 'cursor-pointer'}`}
    >
      <span className="h-4 w-4 rounded-full bg-surface shadow" />
    </button>
  );
}

// TxRow's own button carries the tap: a wrapping label stopped at it, so face taps did nothing
function MatchRow({
  candidate,
  picked,
  deducts,
  onPick,
  onDeduct,
}: Readonly<{ candidate: Scored; picked: boolean; deducts: boolean; onPick: () => void; onDeduct: () => void }>) {
  const { t } = useLang();
  const { tx, preAnchor } = candidate;
  return (
    <div className="flex items-stretch gap-2 border-b border-line-2 py-1 last:border-0">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <input
          data-testid={`loanmatch-pick-${tx.id}`}
          type="checkbox"
          checked={picked}
          onChange={onPick}
          className="h-5 w-5 shrink-0 accent-[var(--m-accent)]"
        />
        <span className="min-w-0 flex-1">
          <TxRow tx={tx} showDate onClick={onPick} />
        </span>
      </div>
      {/* post-anchor rows always deduct: their switch shows ON and disabled, never absent (no layout jump) */}
      <div className="flex w-12 shrink-0 flex-col items-center justify-center gap-1 border-l border-line-2 pl-2 text-center text-[10px] font-medium text-ink-4">
        <Switch
          on={deducts}
          disabled={!preAnchor}
          label={t('debts.matchDeduct')}
          testId={`loanmatch-count-${tx.id}`}
          onToggle={onDeduct}
        />
        {t('debts.matchDeduct')}
      </div>
    </div>
  );
}

// the master deduct switch reads ON only when every togglable row deducts, and is disabled when none is togglable
function BulkBar({
  candidates,
  picked,
  counted,
  onPicked,
  onCounted,
}: Readonly<{
  candidates: readonly Scored[];
  picked: ReadonlySet<string>;
  counted: ReadonlySet<string>;
  onPicked: (next: Set<string>) => void;
  onCounted: (next: Set<string>) => void;
}>) {
  const { t } = useLang();
  const preIds = candidates.filter((c) => c.preAnchor).map((c) => c.tx.id);
  // vacuously true with nothing togglable — matches the rows' disabled-ON
  const allDeduct = preIds.every((id) => counted.has(id));
  return (
    <div className="mb-1 flex items-center justify-between gap-2 border-b border-line pb-2">
      <SelectAllRow
        total={candidates.length}
        selected={picked.size}
        onChange={(next) => onPicked(next ? new Set(candidates.map((c) => c.tx.id)) : new Set())}
        testId="loanmatch-pick-all"
        divider={false}
        className="min-w-0 flex-1"
      />
      <span className="flex items-center gap-2 text-[11px] font-medium text-ink-3">
        {t('debts.matchDeductAll')}
        <Switch
          on={allDeduct}
          disabled={preIds.length === 0}
          label={t('debts.matchDeductAll')}
          testId="loanmatch-deduct-all"
          onToggle={() => onCounted(allDeduct ? new Set() : new Set(preIds))}
        />
      </span>
    </div>
  );
}

function MatchFooter({
  count,
  deductSumCents,
  balanceCents,
  newBalanceCents,
  currency,
  busy,
  onApply,
}: Readonly<{
  count: number;
  deductSumCents: number;
  balanceCents: number;
  newBalanceCents: number;
  currency: string;
  busy: boolean;
  onApply: () => void;
}>) {
  const { t } = useLang();
  const { fmt, fmtSensitive } = useDisplayMoney();
  return (
    <div className="flex flex-col gap-1.5" data-testid="loanmatch-summary">
      {/* plain UI-font label, m-num value: a whole-row m-num made the two halves read as two styles */}
      <div className="flex items-baseline justify-between text-[12px] text-ink-3">
        <span>{t('debts.matchSelected', { n: count })}</span>
        <span className="m-num font-medium text-ink" data-testid="loanmatch-deduct-sum">
          {t('debts.matchDeductTotal', { sum: fmt(deductSumCents, currency) })}
        </span>
      </div>
      <div className="flex items-baseline justify-between text-[12px] text-ink-3">
        <span>{t('debts.matchNewBalance')}</span>
        <span className="m-num font-medium text-ink" data-testid="loanmatch-new-balance">
          {fmtSensitive(balanceCents, currency)} → {fmtSensitive(newBalanceCents, currency)}
        </span>
      </div>
      <Button className="mt-1 w-full" data-testid="loanmatch-apply" disabled={busy || count === 0} onClick={onApply}>
        {t('debts.matchApply', { n: count })}
      </Button>
    </div>
  );
}

// searches the full history by counter-IBAN, debt-payment label, amount and name keywords
// rows older than the balance date move it only with deduct on
export function LoanMatchSheet({ accountId, onClose }: Readonly<{ accountId: string | null; onClose: () => void }>) {
  const { t } = useLang();
  const { store } = useData();
  const transform = useTxTransform();
  const txs = useSpaceHistoryTransactions();
  const account = useQuery(store, async () => (accountId ? store.get('account', accountId) : undefined), [accountId]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [counted, setCounted] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const candidates = useMemo<Scored[]>(
    () => (account && txs ? loanMatchCandidates(account, txs) : []),
    [account, txs],
  );
  // "nothing found" is true only once the queries answered; while loading, show the hint
  const ready = !!account && !!txs;
  const empty = ready && candidates.length === 0;

  // strong matches pre-check once per loan: live-query re-emissions must not clobber the user's pruning
  // an untouched loan (original == |current|) also seeds every deduct switch ON
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!accountId) {
      seededFor.current = null;
      return;
    }
    if (seededFor.current === accountId || !account || candidates.length === 0) return;
    seededFor.current = accountId;
    const seeded = seedSelections(candidates, account);
    setPicked(seeded.picked);
    setCounted(seeded.counted);
  }, [accountId, account, candidates]);

  const apply = async () => {
    if (!accountId || busy) return;
    setBusy(true);
    try {
      await applyLinks(transform, accountId, candidates, picked, counted);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const totals = deductTotals(candidates, picked, counted, account?.balanceCents ?? 0);

  return (
    // a manual open with nothing to offer collapses to the title plus one quiet line (#286)
    <Sheet
      open={accountId !== null}
      onOpenChange={(next) => !next && onClose()}
      title={t('debts.matchTitle')}
      size={empty ? 'compact' : 'tall'}
      // closing with candidates asks first (the Sheet's discard guard); apply's programmatic close skips it
      dirty={candidates.length > 0}
      // the list scrolls inside the fixed-height sheet while this footer stays pinned
      footer={
        candidates.length > 0 && account ? (
          <MatchFooter
            count={picked.size}
            deductSumCents={totals.deductSumCents}
            balanceCents={account.balanceCents}
            newBalanceCents={totals.newBalanceCents}
            currency={account.currency}
            busy={busy}
            onApply={() => void apply()}
          />
        ) : undefined
      }
    >
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
      {candidates.some((c) => c.preAnchor) && (
        <p className="pb-2 text-[11px] leading-snug text-ink-4" data-testid="loanmatch-old-caption">
          {t('debts.matchDeductCaption')}
        </p>
      )}
      {candidates.length > 0 && (
        <BulkBar candidates={candidates} picked={picked} counted={counted} onPicked={setPicked} onCounted={setCounted} />
      )}
      <div className="flex flex-col" data-testid="loanmatch-list">
        {candidates.map((candidate) => (
          <MatchRow
            key={candidate.tx.id}
            candidate={candidate}
            picked={picked.has(candidate.tx.id)}
            deducts={rowDeducts(candidate, counted)}
            onPick={() => setPicked((prev) => toggle(prev, candidate.tx.id))}
            onDeduct={() => setCounted((prev) => toggle(prev, candidate.tx.id))}
          />
        ))}
      </div>
    </Sheet>
  );
}
