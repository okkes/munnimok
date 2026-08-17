import { useMemo, useRef, useState } from 'react';
import type { UIEvent } from 'react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useSpaceTransactions } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { useLang } from '@/i18n';
import { fmtCents, parseCents } from '@/lib/money';
import { cleanBankText } from '@/lib/text';
import { filterTxs } from '@/domain/txFilter';
import { clampReimbursement, creditPartGivenCents, creditRemainingCents, givenCents, remainingCents } from '@/domain/reimbursement';
import { reimbEarmarkCents, suggestCounterparts } from '@/domain/reimburseMatch';
import { useReimburseLinks } from './useReimburseLinks';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { TxRow } from '@/ui/TxRow';
import { TxPartRow } from '@/ui/TxPartRow';
import { SearchField } from '@/ui/SearchField';
import { REIMBURSED_ID } from '@/domain/categories';
import type { TxSplit } from '@/db/types';

const toText = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

/** #197: what a split expense's PART still expects back — its magnitude
 *  minus the links already targeting it */
const partOpenCents = (row: SpaceTx, part: TxSplit): number =>
  Math.max(
    0,
    Math.abs(part.amountCents) -
      (row.reimbursements ?? []).filter((r) => r.partId === part.id).reduce((sum, r) => sum + r.amountCents, 0),
  );

/** #197 (both directions): a split row offers its PARTS to link against
 *  — the root container is never a target. The caller supplies the
 *  side's own open-value math. Module-level for S3776. */
function ReimbPartRows({
  row,
  testId,
  hint,
  money,
  openOf,
  onPick,
}: Readonly<{
  row: SpaceTx;
  testId: string;
  hint?: string;
  money: (cents: number) => string;
  /** the part's linkable value on THIS side (expense: still expected;
   *  credit: still giveable) */
  openOf: (row: SpaceTx, part: TxSplit) => number;
  onPick: (row: SpaceTx, part: TxSplit, openCents: number) => void;
}>) {
  const parts = (row.splits ?? []).map((part, idx) => ({ part, idx })).filter((e) => e.part.catId !== REIMBURSED_ID);
  const sign = row.amountCents < 0 ? -1 : 1;
  return (
    <div key={`${testId}-${row.id}`}>
      {parts.map((e, ordinal) => {
        const open = openOf(row, e.part);
        if (open <= 0) return null;
        return (
          <div key={e.part.id ?? e.idx} data-testid={`${testId}-${row.id}-part-${e.idx}`}>
            <TxPartRow
              tx={row}
              part={e.part}
              index={ordinal}
              showDate
              amountText={money(sign * open)}
              onClick={() => onPick(row, e.part, open)}
            />
          </div>
        );
      })}
      {hint && <div className="-mt-1 px-1 pb-1.5 text-[11px] text-accent-deep">{hint}</div>}
    </div>
  );
}

/**
 * Full-screen counterpart picker for reimbursement links (user redesign
 * 2026-07-28, replaces the cramped sheet): searchable like the main
 * transactions list (title + amount, with highlight), with a "suggested"
 * segment on top — the 1–2 rows scoring highest on timing, P2P repayment
 * wording, reimbursement bookkeeping and size. Tapping a row opens the
 * amount sheet; the prefill follows the row's reimbursement EARMARK when
 * it has one (the expected/received slice value), else its open value.
 */
export function ReimburseLinkScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { txId } = useParams({ strict: false }) as { txId: string };
  // #126 r5: opened from a part page → the link targets that part
  const { part: partId } = useSearch({ strict: false }) as { part?: string };
  const allTxs = useSpaceTransactions();
  const tx = useMemo(() => allTxs?.find((row) => row.id === txId), [allTxs, txId]);
  const { link, giveableCents } = useReimburseLinks(allTxs);

  const [query, setQuery] = useState('');
  // #197: picking a PART carries its id — the link lands on that part,
  // never on the root container (partId = expense side, creditPartId =
  // the split credit's funding part)
  const [chosen, setChosen] = useState<{ row: SpaceTx; partId?: string; creditPartId?: string } | null>(null);
  const [amount, setAmount] = useState('');

  // the search bar rides along: it scrolls away with the content and a
  // DELIBERATE upward scroll brings it back — one search-field's worth of
  // travel, not a single jittery pixel (user tuning 2026-07-31); iOS
  // rubber-band frames must never fake that gesture
  const [searchShown, setSearchShown] = useState(true);
  const lastScrollTop = useRef(0);
  const upTravel = useRef(0);
  // the wrapper's real height: h-11 input (44) + pt-1 (4) + pb-2 (8)
  const SEARCH_H = 56;
  const onListScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const top = el.scrollTop;
    const delta = lastScrollTop.current - top; // > 0 → upward
    lastScrollTop.current = top;
    const maxTop = el.scrollHeight - el.clientHeight;
    // rubber-band guard: overscroll runs scrollTop past [0, maxTop] and
    // the spring-back frames read as "upward" — near the edges nothing
    // counts, in either direction
    if (top < 0 || top > maxTop - SEARCH_H) {
      upTravel.current = 0;
      return;
    }
    if (delta > 0) upTravel.current += delta;
    else if (delta < 0) upTravel.current = 0; // any downward move re-arms
    setSearchShown(upTravel.current >= SEARCH_H || top < SEARCH_H);
  };

  const anchorIsExpense = (tx?.amountCents ?? 0) < 0;
  const givenOf = (id: string) => givenCents(allTxs ?? [], id);

  // an expense looks at credits with value left; a credit looks at
  // expenses still open — the same space-scoped pools the section used
  const candidates = useMemo(() => {
    if (!tx) return [];
    const pool = (allTxs ?? []).filter((row) => row.id !== tx.id);
    return anchorIsExpense
      ? pool.filter((row) => row.amountCents > 0 && creditRemainingCents(row, givenOf(row.id)) > 0)
      : pool.filter((row) => row.amountCents < 0 && remainingCents(row) > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTxs, tx?.id, anchorIsExpense]);

  const suggested = useMemo(
    () => (tx ? suggestCounterparts(tx, candidates, givenOf) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tx, candidates],
  );

  const listed = useMemo(() => {
    const matched = filterTxs(candidates, { query });
    return [...matched].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 100);
  }, [candidates, query]);

  const openValueOf = (row: SpaceTx): number =>
    row.amountCents > 0 ? giveableCents(row) : remainingCents(row);

  const pick = (row: SpaceTx) => {
    const expense = anchorIsExpense ? tx! : row;
    const credit = anchorIsExpense ? row : tx!;
    // the prefill follows the EARMARK side of the pair: what the credit
    // can fund, clamped by what the expense still expects back (its own
    // expected-reimbursement slice when it carries one)
    const expected = reimbEarmarkCents(expense);
    const need = expected === null ? remainingCents(expense) : Math.min(remainingCents(expense), Math.max(0, expected - (expense.reimbursements ?? []).reduce((s, r) => s + r.amountCents, 0)));
    const prefill = clampReimbursement(expense, giveableCents(credit), Math.max(need, 0) || giveableCents(credit));
    setChosen({ row });
    setAmount(toText(prefill));
  };

  // #197: an EXPENSE part pick (credit anchor) — the prefill is the
  // part's open value, clamped by what this credit can still give
  const pickPart = (row: SpaceTx, part: TxSplit, openCents: number) => {
    const prefill = clampReimbursement(row, giveableCents(tx!), Math.min(openCents, giveableCents(tx!)) || openCents);
    setChosen({ row, partId: part.id });
    setAmount(toText(prefill));
  };

  // #197 (the other side): a CREDIT part pick (expense anchor) — the
  // prefill is what that part can still fund, clamped by the expense
  const pickCreditPart = (row: SpaceTx, part: TxSplit, openCents: number) => {
    const prefill = clampReimbursement(tx!, openCents, Math.min(openCents, remainingCents(tx!)) || openCents);
    setChosen({ row, creditPartId: part.id });
    setAmount(toText(prefill));
  };

  // #197: what ONE part of a split credit can still give — its own
  // magnitude minus the links naming it, never more than the whole
  // credit has left
  const creditPartOpen = (row: SpaceTx, part: TxSplit): number =>
    Math.min(
      giveableCents(row),
      Math.max(0, Math.abs(part.amountCents) - (part.id ? creditPartGivenCents(allTxs ?? [], row.id, part.id) : 0)),
    );

  const confirm = () => {
    if (!tx || !chosen) return;
    const cents = parseCents(amount) ?? 0;
    if (cents > 0) {
      // the part target lives on the EXPENSE side's split — from the
      // expense anchor it rides the ?part param; the CREDIT part rides
      // the pick (expense anchor) or the ?part param (credit anchor's
      // own part page, #197)
      if (anchorIsExpense) link(tx, chosen.row, cents, partId, chosen.creditPartId);
      else link(chosen.row, tx, cents, chosen.partId, partId);
    }
    setChosen(null);
    // REPLACE, not back: pressing back on the detail afterwards must not
    // resurface a stale picker — a part-born link returns to its part
    void navigate({ to: '/transactions/$txId', params: { txId }, search: partId ? { part: partId } : {}, replace: true });
  };

  const rowFor = (row: SpaceTx, testId: string, hint?: string) => {
    // #197 (both directions): a split row offers its PARTS, never the
    // root — expenses their still-expected parts, credits their
    // still-giveable ones
    const rowParts = (row.splits ?? []).filter((s) => s.catId !== REIMBURSED_ID);
    if (rowParts.length > 1) {
      return (
        <ReimbPartRows
          key={`${testId}-${row.id}`}
          row={row}
          testId={testId}
          hint={hint}
          money={(cents) => fmtCents(cents, row.currency, lang)}
          openOf={anchorIsExpense ? creditPartOpen : partOpenCents}
          onPick={anchorIsExpense ? pickCreditPart : pickPart}
        />
      );
    }
    return (
      <div key={`${testId}-${row.id}`} data-testid={`${testId}-${row.id}`}>
        <TxRow
          tx={row}
          showDate
          hideUnreviewed
          highlight={query}
          amountOverrideCents={row.amountCents > 0 ? openValueOf(row) : -openValueOf(row)}
          onClick={() => pick(row)}
        />
        {hint && <div className="-mt-1 px-1 pb-1.5 text-[11px] text-accent-deep">{hint}</div>}
      </div>
    );
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-reimb-link">
      <AppBar
        title={t(anchorIsExpense ? 'reimb.link' : 'reimb.linkOut')}
        leading={
          <IconButton label={t('action.back')} testId="reimb-link-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
      />
      {/* the origin transaction stays PINNED above the list (user
          request 2026-07-31) — the one fact the whole screen is about */}
      {tx && (
        <div className="shrink-0 border-b border-line-2 px-5 pb-2 text-[12px] text-ink-3" data-testid="reimb-link-anchor">
          {cleanBankText(tx.merchant)} · {fmtCents(tx.amountCents, tx.currency, lang, { sign: true })}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6" onScroll={onListScroll}>
        <div
          className="sticky top-0 z-10 -mx-5 bg-bg px-5 pt-1 pb-2 transition-all duration-200 ease-out"
          style={searchShown ? undefined : { transform: 'translateY(-110%)', opacity: 0, pointerEvents: 'none' }}
        >
          <SearchField
            testId="reimb-link-search"
            value={query}
            onChange={setQuery}
            placeholder={t('tx.searchPlaceholder')}
          />
        </div>

        {/* the smart segment stands down while the user searches */}
        {!query && suggested.length > 0 && (
          <>
            <div className="m-cap mt-2 mb-1 flex items-center gap-1.5 px-1 text-accent-deep">
              <Icon name="lightbulb-outline" size={13} />
              {t('reimb.suggested')}
            </div>
            <div className="mb-3 divide-y divide-line-2 overflow-hidden rounded-card border border-accent/40 bg-surface px-3" data-testid="reimb-link-suggested">
              {suggested.map(({ tx: row }) => rowFor(row, 'reimb-suggest', t('reimb.suggestedWhy')))}
            </div>
          </>
        )}

        <div className="m-cap mt-2 mb-1 px-1">{t(anchorIsExpense ? 'reimb.allCredits' : 'reimb.allExpenses')}</div>
        <div className="divide-y divide-line-2 overflow-hidden rounded-card border border-line bg-surface px-3" data-testid="reimb-link-list">
          {listed.map((row) => rowFor(row, 'reimb-pick'))}
          {listed.length === 0 && <div className="px-1 py-4 text-center text-[12px] text-ink-4">—</div>}
        </div>
      </div>

      {/* the amount sheet: how much of the pair actually links */}
      <Sheet open={chosen !== null} onOpenChange={(next) => !next && setChosen(null)} title={chosen ? cleanBankText(chosen.row.merchant) : ''} size="form">
        <div className="flex flex-col gap-3 pt-1" data-testid="reimb-confirm">
          <input
            data-testid="reimb-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder={t('reimb.amountLabel')}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none"
          />
          <Button data-testid="reimb-save" onClick={confirm}>
            {t('action.save')}
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
