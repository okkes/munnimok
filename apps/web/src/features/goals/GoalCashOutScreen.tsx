import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useCanEdit } from '@/app/useCanEdit';
import { ReadOnlyNote } from '@/features/spaces/ReadOnlyNote';
import { useQuery } from '@/db/useQuery';
import { useGoalOps, useGoals } from '@/application/goals';
import { localToday } from '@/application/recurring';
import { useSpaceAccounts, useSpaceTransactions } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { cashOutCandidates, poolAfterCashOut, purchaseCandidates } from '@/domain/goals';
import { filterTxs } from '@/domain/txFilter';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { MoreRows, PAGE_ROWS } from '@/ui/MoreRows';
import { SearchField } from '@/ui/SearchField';
import { TxRow } from '@/ui/TxRow';

/** the spending list opens short: what a goal bought is recent and the search finds the rest */
const FIRST_PURCHASE_ROWS = 20;

const toggled = (set: ReadonlySet<string>, id: string): Set<string> => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

/** one row of a pick list: the tick and the transaction, either one toggles */
function PickRow({ tx, checked, testId, onToggle }: Readonly<{ tx: SpaceTx; checked: boolean; testId: string; onToggle: () => void }>) {
  return (
    <div className="flex items-center gap-2">
      <button
        data-testid={testId}
        aria-label={tx.merchant}
        aria-pressed={checked}
        onClick={onToggle}
        className={`m-tap ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
          checked ? 'border-accent bg-accent text-white' : 'border-line bg-surface'
        }`}
      >
        {checked && <Icon name="check" size={12} />}
      </button>
      <div className="min-w-0 flex-1">
        <TxRow tx={tx} showDate hideCategory={false} onClick={onToggle} />
      </div>
    </div>
  );
}

/**
 * #455 (user): "cash out and select the transaction(s)". A full screen
 * like attaching to an event: the money that left the savings pool lines
 * up, newest first, nothing ticked — the person names what paid for the
 * goal. Cashing out archives the goal; the picked rows stay in the history
 * but leave the saving of their period, and what the goal held beyond them
 * is back in the savings pool.
 *
 * User 2026-11-12: any time, reached or not; ticking more than the goal
 * held says what that does to the unallocated savings (no other goal is
 * touched); and a second, optional pick names what the money bought — real
 * spending the plan files under the goal and a graph can leave out. A goal
 * already cashed out opens on that second pick alone.
 */
export function GoalCashOutScreen() {
  const { t } = useLang();
  const navigate = useNavigate();
  const { store, spaceId } = useData();
  const { goalId } = useParams({ strict: false }) as { goalId: string };
  const goals = useGoals();
  const accounts = useSpaceAccounts();
  const txs = useSpaceTransactions();
  const ops = useGoalOps();
  const canEdit = useCanEdit(); // #505
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  // null = untouched: a cashed-out goal starts from the purchase it names
  const [boughtPick, setBoughtPick] = useState<ReadonlySet<string> | null>(null);
  const [query, setQuery] = useState('');
  const [shownRows, setShownRows] = useState(FIRST_PURCHASE_ROWS);
  const showMore = useCallback(() => setShownRows((n) => n + PAGE_ROWS), []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const { fmt, fmtSensitive } = useDisplayMoney();

  const goal = goals?.find((g) => g.id === goalId);
  // cashed out already: the money that paid for it is settled, what it bought can still be named
  const naming = !!goal?.cashOut;
  // a goal deleted meanwhile, or archived without a cash-out: nothing to pick here
  useEffect(() => {
    if (!goals) return;
    if (!goal) void navigate({ to: '/goals', replace: true });
    else if (goal.archived === 1 && !goal.cashOut) void navigate({ to: '/goals/$goalId', params: { goalId }, replace: true });
  }, [goals, goal, goalId, navigate]);

  const candidates = useMemo(
    () => (txs && accounts && goals ? cashOutCandidates(txs, accounts, space, goals, localToday()) : undefined),
    [txs, accounts, goals, space],
  );
  const purchases = useMemo(
    () => (txs && accounts && goals ? purchaseCandidates(txs, accounts, space, goals, localToday(), goalId) : undefined),
    [txs, accounts, goals, space, goalId],
  );
  // the search only narrows what is LISTED: a pick a later search hides still counts
  const listed = useMemo(() => (purchases && query ? filterTxs(purchases, { query }) : (purchases ?? [])), [purchases, query]);
  if (!goal) return <div className="h-full" data-testid="screen-goal-cashout" />;

  const currency = space?.currency ?? 'EUR';
  const money = (cents: number) => fmt(cents, currency);
  // #530: what the goal holds and what goes back hide with the sensitive figures; the picked spending stays
  const balance = (cents: number) => fmtSensitive(cents, currency);
  const selected = (candidates ?? []).filter((tx) => picked.has(tx.id));
  const selectedCents = selected.reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0);
  const leftover = goal.allocatedCents - selectedCents;
  const poolAfter = poolAfterCashOut(goal, goals ?? [], accounts ?? [], space);

  const bought: ReadonlySet<string> = boughtPick ?? new Set(goal.cashOut?.purchaseTxIds ?? []);
  // only rows still on offer are kept: a deleted purchase drops out of the goal's story
  const boughtTxs = (purchases ?? []).filter((tx) => bought.has(tx.id));
  const boughtCents = boughtTxs.reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0);
  const shown = listed.slice(0, shownRows);
  const remaining = listed.length - shown.length;

  const confirm = async () => {
    if (!naming && selected.length === 0) return;
    setBusy(true);
    try {
      const purchaseIds = boughtTxs.map((tx) => tx.id);
      if (naming) await ops.namePurchases(goal, purchaseIds);
      else await ops.cashOut(goal, selected.map((tx) => tx.id), purchaseIds);
      // replace: back from the goal leaves it, not into a finished pick
      void navigate({ to: '/goals/$goalId', params: { goalId: goal.id }, replace: true });
    } finally {
      setBusy(false);
    }
  };

  const figures: [string, string, string][] = [
    ['saved', t('goals.cashOutSaved'), balance(goal.allocatedCents)],
    ['selected', t('goals.cashOutSelected'), money(selectedCents)],
    ['back', t('goals.cashOutBack'), balance(Math.max(0, leftover))],
  ];

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-goal-cashout" data-mode={naming ? 'bought' : 'cashout'}>
      <AppBar
        title={t(naming ? 'goals.boughtScreenTitle' : 'goals.cashOutTitle', { name: goal.name })}
        leading={
          <IconButton label={t('action.back')} testId="goalcashout-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
      />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {!naming && (
          <>
            <p className="px-1 pb-3 text-[12px] leading-snug text-ink-3">{t('goals.cashOutIntro', { name: goal.name })}</p>
            <div className="grid grid-cols-3 gap-3 rounded-card border border-line bg-surface p-4" data-testid="goalcashout-summary">
              {figures.map(([id, label, text]) => (
                <div key={id} data-testid={`goalcashout-fig-${id}`}>
                  <div className="text-[10px] font-semibold tracking-wide text-ink-4 uppercase">{label}</div>
                  <div className="m-num mt-0.5 text-[15px] font-semibold text-ink">{text}</div>
                </div>
              ))}
            </div>
            {leftover < 0 && (
              <p
                className="mt-2 flex items-start gap-2 rounded-card bg-warning-soft p-3 text-[12px] leading-snug text-ink-2"
                data-testid="goalcashout-over"
                data-negative={poolAfter < 0}
              >
                <Icon name="alert-outline" size={16} color="var(--m-warning)" />
                <span>{t(poolAfter < 0 ? 'goals.cashOutOverNegative' : 'goals.cashOutOver', { amount: balance(-leftover), pool: balance(poolAfter) })}</span>
              </p>
            )}
            <div className="m-cap mt-5 mb-1 px-1">{t('goals.cashOutPick')}</div>
            <div className="divide-y divide-line-2 rounded-card border border-line bg-surface px-3 py-1" data-testid="goalcashout-list">
              {(candidates ?? []).map((tx) => (
                <PickRow
                  key={tx.id}
                  tx={tx}
                  checked={picked.has(tx.id)}
                  testId={`goalcashout-pick-${tx.id}`}
                  onToggle={() => setPicked(toggled(picked, tx.id))}
                />
              ))}
              {candidates?.length === 0 && (
                <p className="px-1 py-4 text-[12px] leading-snug text-ink-4" data-testid="goalcashout-empty">
                  {t('goals.cashOutNone')}
                </p>
              )}
            </div>
          </>
        )}

        <div className={`m-cap mb-1 flex items-baseline justify-between gap-2 px-1 ${naming ? '' : 'mt-6'}`}>
          <span>{t('goals.boughtPick')}</span>
          {boughtCents > 0 && (
            <span className="m-num font-normal normal-case text-ink-3" data-testid="goalcashout-bought-total">
              {money(boughtCents)}
            </span>
          )}
        </div>
        <p className="mb-2 px-1 text-[12px] leading-snug text-ink-3">{t('goals.boughtIntro')}</p>
        <SearchField
          testId="goalcashout-search"
          value={query}
          onChange={(value) => {
            setQuery(value);
            setShownRows(FIRST_PURCHASE_ROWS);
          }}
          placeholder={t('tx.searchPlaceholder')}
        />
        <div className="mt-2 divide-y divide-line-2 rounded-card border border-line bg-surface px-3 py-1" data-testid="goalcashout-bought-list">
          {shown.map((tx) => (
            <PickRow
              key={tx.id}
              tx={tx}
              checked={bought.has(tx.id)}
              testId={`goalcashout-buy-${tx.id}`}
              onToggle={() => setBoughtPick(toggled(bought, tx.id))}
            />
          ))}
          {shown.length === 0 && (
            <p className="px-1 py-4 text-[12px] leading-snug text-ink-4" data-testid="goalcashout-bought-empty">
              {t(query ? 'tx.emptyFiltered' : 'goals.boughtNone')}
            </p>
          )}
        </div>
        {remaining > 0 && <MoreRows rootRef={scrollRef} remaining={remaining} onMore={showMore} testId="goalcashout-bought-more" />}
      </div>
      <div className="shrink-0 border-t border-line-2 bg-bg px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))]">
        <ReadOnlyNote className="mb-2" testId="goalcashout-readonly-note" />
        <Button
          className="w-full"
          data-testid="goalcashout-confirm"
          disabled={busy || !canEdit || (!naming && selected.length === 0)}
          onClick={() => void confirm()}
        >
          {naming ? t('action.save') : t('goals.cashOutConfirm', { amount: money(selectedCents) })}
        </Button>
      </div>
    </div>
  );
}
