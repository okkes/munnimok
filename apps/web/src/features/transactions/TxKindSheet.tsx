import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSpaceAccounts, useSpaceTransactions } from '@/application/transactions';
import { useRecurrings } from '@/application/recurring';
import { useData } from '@/app/data';
import { accountTail, counterPlanOf, planFits } from '@/domain/counterPlan';
import { cadenceLabel } from '@/features/recurring/RecurringVisual';
import { typeDef } from '@/features/accounts/accountTypes';
import { AddAccountChooser } from '@/features/accounts/AddAccountChooser';
import { TX_KINDS, kindOf } from '@/domain/txKind';
import type { TxKind } from '@/domain/txKind';
import { accountStamp, typeForLinkedAccount } from '@/domain/txType';
import { counterDuplicates, counterOpenRows, counterSameSignCandidates } from '@/domain/counterMatch';
import { cashWalletId, ensureCashWallet } from '@/application/defaultAccounts';
import type { DefaultFamily } from '@/application/defaultAccounts';
import type { AccountType, TransactionRow, TxType } from '@/db/types';
import { LOCALES, useLang } from '@/i18n';
import { fmtCents } from '@/lib/money';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { txTitle } from '@/lib/text';
import { Icon } from '@/ui/Icon';
import { InfoHint } from '@/ui/InfoHint';
import { JumpToDateButton, useJumpToDate } from '@/ui/JumpToDate';
import { MoreRows, PAGE_ROWS } from '@/ui/MoreRows';
import { SearchField } from '@/ui/SearchField';
import { Pill } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { TxRow } from '@/ui/TxRow';

export const TX_KIND_VISUAL: Record<TxKind, { icon: string; color: string }> = {
  standard: { icon: 'cash-multiple', color: '#27AE60' },
  transfer: { icon: 'swap-horizontal', color: '#2980B9' },
  adjustment: { icon: 'tune-variant', color: '#7F8C8D' },
};

/** plain transfers and adjustments add no detail: the kind already says it */
export function kindDetail(txType: TxType): TxType | null {
  const kind = kindOf(txType);
  if (kind === 'standard') return txType;
  if (kind === 'transfer' && txType !== 'transfer') return txType;
  return null;
}

/** adjustment is a manual-bookkeeping tool: offered only on hand-entered rows, bank rows are never corrections */
export function TxKindSheet({
  open,
  onOpenChange,
  current,
  allowAdjustment,
  onPick,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: TxKind;
  allowAdjustment: boolean;
  onPick: (kind: TxKind) => void;
}>) {
  const { t } = useLang();
  const kinds = TX_KINDS.filter((k) => k !== 'adjustment' || allowAdjustment);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('tx.kindTitle')} size="form">
      <div className="flex flex-col" data-testid="txkind-options">
        {kinds.map((kind) => (
          <button
            key={kind}
            data-testid={`txkind-${kind}`}
            onClick={() => {
              onPick(kind);
              onOpenChange(false);
            }}
            className="m-tap flex items-start gap-3 border-none bg-transparent px-1 py-3 text-left"
          >
            <span
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
              style={{ background: `color-mix(in srgb, ${TX_KIND_VISUAL[kind].color} 14%, transparent)` }}
            >
              <Icon name={TX_KIND_VISUAL[kind].icon} size={17} color={TX_KIND_VISUAL[kind].color} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium text-ink">{t(`tx.kind.${kind}`)}</span>
              <span className="block text-[12px] leading-snug text-ink-3">{t(`tx.kind.${kind}Sub`)}</span>
            </span>
            {current === kind && <Icon name="check" size={18} color="var(--m-accent)" />}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/** #133: the ATM pair's ask pins the space's cash wallet on top (#546); a bank-fed pick means Transfer,
 *  a manual pick forks: mint the counterpart or point at the row already there */
export function CounterpartySheet({
  open,
  onOpenChange,
  excludeAccountId,
  currentLinkedId,
  onChoose,
  defaultFamily,
  counterTypes,
  anchor,
  onDetach,
  amountCents,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  excludeAccountId: string;
  currentLinkedId?: string;
  // `peer` = an EXISTING row the user pointed at: carried in the same write (no mint);
  // the caller pairs it via pairWithExistingRow
  onChoose: (account: { id: string; type: AccountType }, peer?: { txId: string }) => void;
  defaultFamily?: DefaultFamily;
  /** #133: the asking category's side of the bijection ("Set aside" lists savings only); undefined = every account */
  counterTypes?: readonly AccountType[];
  anchor?: { id: string; amountCents: number; date: string };
  /** #218: the caller clears the link; a transfer category resets, since an unlinked transfer is unrepresentable */
  onDetach?: () => void;
  /** #556: the signed money being linked; an account whose payment it is leads the list */
  amountCents?: number;
}>) {
  const { t, lang } = useLang();
  const { fmtSensitive } = useDisplayMoney();
  const { store, repo, spaceId } = useData();
  const allAccounts = useSpaceAccounts();
  const allTxs = useSpaceTransactions();
  const recurrings = useRecurrings();
  const [chooserOpen, setChooserOpen] = useState(false);
  const [forkFor, setForkFor] = useState<CounterForkTarget | null>(null);

  const pinsWallet = defaultFamily === 'cash';
  const candidates = useMemo(
    // the cash wallet never lists as an ordinary row: the pinned entry is its one face
    () =>
      (allAccounts ?? []).filter(
        (a) => a.id !== excludeAccountId && !a.archived && !a.defaultFor && (!counterTypes || counterTypes.includes(a.type)),
      ),
    [allAccounts, excludeAccountId, counterTypes],
  );
  // #556: what each account is regularly paid tells look-alikes apart; the one whose payment THIS is leads
  const rows = useMemo(() => {
    const money = amountCents ?? anchor?.amountCents;
    const withPlans = candidates.map((account) => {
      const plan = counterPlanOf(account, recurrings ?? []);
      return { account, plan, fits: !!plan && money !== undefined && planFits(plan, money) };
    });
    return [...withPlans.filter((r) => r.fits), ...withPlans.filter((r) => !r.fits)];
  }, [candidates, recurrings, amountCents, anchor?.amountCents]);

  const choose = (account: { id: string; type: AccountType }, peer?: { txId: string }) => {
    onChoose(account, peer);
    setForkFor(null);
    onOpenChange(false);
  };

  const pickWallet = async () => {
    const id = await ensureCashWallet(store, repo, spaceId);
    choose({ id, type: 'cash' });
  };

  // #237: a MANUAL counter always opens the match sheet (no silent mints); a bank-fed one only with something to offer,
  // else the link awaits the feed; funding pots and a missing anchor (create form) choose directly
  const tap = (account: { id: string; type: AccountType; name: string; source?: string }) => {
    const target = counterForkTarget(account, anchor, allTxs ?? []);
    if (target) setForkFor(target);
    else choose({ id: account.id, type: account.type });
  };

  return (
    <>
    <Sheet open={open} onOpenChange={onOpenChange} title={t('tx.counterparty')} size="form">
      <p className="pb-2 text-[12px] text-ink-3">
        {t(counterTypes?.length === 1 && counterTypes[0] === 'funding' ? 'tx.counterFundingHint' : 'tx.counterAccountHint')}
      </p>
      {pinsWallet && (
        <button
          data-testid="counter-default"
          onClick={() => void pickWallet()}
          className="m-tap mb-2 flex w-full items-center gap-3 rounded-card border border-accent/40 bg-accent-soft/20 px-4 py-3 text-left"
        >
          <Icon name={typeDef('cash').icon} size={18} color="var(--m-accent-deep)" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium text-ink">
              {allAccounts?.find((a) => a.id === cashWalletId(spaceId))?.name ?? t('acct.defaultCash')}
            </span>
            <span className="block text-[11px] text-ink-4">{t('tx.counterDefaultSub')}</span>
          </span>
          {currentLinkedId === cashWalletId(spaceId) && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
        </button>
      )}
      <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="counter-accounts">
          {rows.map(({ account, plan, fits }) => (
            <button
              key={account.id}
              data-testid={`counter-pick-${account.id}`}
              onClick={() => tap(account)}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0"
            >
              <Icon name={typeDef(account.type).icon} size={18} color="var(--m-ink-2)" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-ink">{account.name}</span>
                {/* what the counter ledger will record: a funding pot records funding, not transfer (#152) */}
                <span className="block text-[11px] text-ink-4">
                  {t(`tx.type.${accountStamp(account.type) ?? typeForLinkedAccount(account.type)}`)}
                  {accountTail(account) && <span data-testid={`counter-tail-${account.id}`}> · •••• {accountTail(account)}</span>}
                </span>
                {plan && (
                  <span className="block truncate text-[11px] text-ink-3" data-testid={`counter-plan-${account.id}`}>
                    {fmtCents(plan.cents, account.currency, lang)} · {cadenceLabel(plan, t)}
                  </span>
                )}
              </span>
              {fits && (
                <Pill tone="accent" testId={`counter-plan-fits-${account.id}`}>
                  {t('tx.counterPlanFits')}
                </Pill>
              )}
              {/* a bank-fed pick means Transfer: the real arriving row on the other side pairs with it */}
              {account.source !== 'manual' && <Pill tone="info">{t('tx.counterBankBadge')}</Pill>}
              <span className="m-num text-[12px] text-ink-3">{fmtSensitive(account.balanceCents, account.currency, { asRecorded: true })}</span>
              {currentLinkedId === account.id && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
            </button>
          ))}
          {candidates.length === 0 && (
            <p className="px-4 py-3 text-[13px] text-ink-4" data-testid="counter-empty">
              {t('tx.counterNoMatch')}
            </p>
          )}
        </div>
      {onDetach && currentLinkedId && (
        <button
          data-testid="counter-detach"
          onClick={() => {
            onDetach();
            onOpenChange(false);
          }}
          className="m-tap mt-2 flex w-full items-center gap-2 rounded-card border border-line bg-transparent px-4 py-3 text-left text-[14px] font-medium text-negative"
        >
          <Icon name="link-off" size={18} />
          {t('tx.counterDetach')}
        </button>
      )}
      <button
        data-testid="counter-full-setup"
        onClick={() => setChooserOpen(true)}
        className="m-tap mt-2 flex w-full items-center gap-2 rounded-card border border-dashed border-line bg-transparent px-4 py-3 text-left text-[14px] font-medium text-accent-deep"
      >
        <Icon name="plus-circle-outline" size={18} />
        {t('tx.counterFullSetup')}
      </button>
      <p className="px-1 pt-2 text-[12px] leading-snug text-ink-4" data-testid="counter-special-hint">
        {t('tx.counterSpecialHint')}
      </p>
    </Sheet>
    {/* #241: SIBLINGS, not children: nested sheets portal before their parent and paint below it */}
    <AddAccountChooser
      open={chooserOpen}
      onOpenChange={setChooserOpen}
      onCreated={(account) => choose(account)}
    />
    {anchor && (
      <CounterMatchSheet
        open={forkFor !== null}
        onOpenChange={(next) => {
          if (!next) setForkFor(null);
        }}
        target={forkFor}
        anchor={anchor}
        rows={allTxs ?? []}
        onCreate={forkFor?.createAllowed ? () => choose({ id: forkFor.id, type: forkFor.type }) : undefined}
        onWait={forkFor?.bankFed ? () => choose({ id: forkFor.id, type: forkFor.type }) : undefined}
        onPick={(txId) => {
          if (forkFor) choose({ id: forkFor.id, type: forkFor.type }, { txId });
        }}
      />
    )}
    </>
  );
}

export interface CounterForkTarget {
  id: string;
  type: AccountType;
  name: string;
  createAllowed: boolean;
  bankFed: boolean;
}

/** #237: null = choose directly: funding pots, bank-fed counters with nothing to offer (the feed delivers), no anchor yet */
export function counterForkTarget(
  account: { id: string; type: AccountType; name: string; source?: string },
  anchor: { id: string; amountCents: number; date: string } | undefined,
  rows: readonly TransactionRow[],
): CounterForkTarget | null {
  if (!anchor) return null;
  const bankFed = (account.source ?? 'manual') !== 'manual';
  const createAllowed = !bankFed && account.type !== 'funding';
  if (bankFed) {
    const offerable =
      counterDuplicates(rows, account.id, anchor).length > 0 ||
      counterSameSignCandidates(rows, account.id, anchor).length > 0;
    if (!offerable) return null;
  } else if (!createAllowed) {
    return null;
  }
  return { id: account.id, type: account.type, name: account.name, createAllowed, bankFed };
}

// #237: 1-3 suggestions on top (near twins; the wallet's same-sign rows when no twin),
// the rest of the open rows scrollable below
export function CounterMatchSheet({
  open,
  onOpenChange,
  target,
  anchor,
  rows,
  onCreate,
  onWait,
  onPick,
  contextRow,
  progress,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: { id: string; name: string } | null;
  /** the row looking for its other leg; its accountId lets the mirror row on the counter side qualify */
  anchor: { id: string; amountCents: number; date: string; accountId?: string };
  rows: readonly TransactionRow[];
  onCreate?: () => void;
  onWait?: () => void;
  onPick: (txId: string) => void;
  contextRow?: TransactionRow;
  progress?: string;
}>) {
  const { t, lang } = useLang();
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);
  const near = target ? counterDuplicates(rows, target.id, anchor) : [];
  const sameSign = target && near.length === 0 ? counterSameSignCandidates(rows, target.id, anchor) : [];
  const allSuggested = [...near, ...sameSign].slice(0, 3);
  const listed = new Set(allSuggested.map((row) => row.id));
  // paged as it scrolls (#502: the old cap of 50 left an older day out of reach)
  const allRest = target ? counterOpenRows(rows, target.id, anchor, Number.POSITIVE_INFINITY).filter((row) => !listed.has(row.id)) : [];
  const matches = (row: TransactionRow): boolean => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    if (txTitle(row).toLowerCase().includes(needle)) return true;
    let sign = 0;
    if (needle.startsWith('+')) sign = 1;
    else if (needle.startsWith('-')) sign = -1;
    if (sign !== 0 && Math.sign(row.amountCents) !== sign) return false;
    const bare = sign === 0 ? needle : needle.slice(1).trim();
    return (Math.abs(row.amountCents) / 100).toFixed(2).includes(bare.replace(',', '.'));
  };
  const suggested = allSuggested.filter(matches);
  const rest = allRest.filter(matches);
  const [shownRows, setShownRows] = useState(PAGE_ROWS);
  useEffect(() => {
    setShownRows(PAGE_ROWS);
  }, [open, query]);
  const showMore = useCallback(() => setShownRows((n) => n + PAGE_ROWS), []);
  const { scrollerRef, jump, jumpedId } = useJumpToDate(rest, (index) => setShownRows((n) => Math.max(n, index + 40)));
  const shownRest = rest.slice(0, shownRows);
  // the browse view is full height so its list reaches the bottom; the short shape only for a sheet with nothing to browse
  const size = allRest.length > 0 ? 'full' : 'form';
  const pick = (txId: string) => {
    onPick(txId);
    onOpenChange(false);
  };
  const door = (testId: string, icon: string, title: string, sub: string, onTap: () => void) => (
    <button
      data-testid={testId}
      onClick={() => {
        onTap();
        onOpenChange(false);
      }}
      className="m-tap mb-2 flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left"
    >
      <Icon name={icon} size={18} color="var(--m-accent-deep)" />
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium text-ink">{title}</span>
        <span className="block text-[11px] leading-snug text-ink-4">{sub}</span>
      </span>
    </button>
  );
  const rowList = (items: readonly TransactionRow[], prefix: string, accent = false) => (
    <div
      className={`divide-y divide-line-2 overflow-hidden rounded-card border bg-surface px-3 ${accent ? 'border-accent/40' : 'border-line'}`}
    >
      {items.map((row) => (
        <div
          key={row.id}
          data-testid={`${prefix}-${row.id}`}
          data-jump-id={row.id}
          className={`transition-colors ${jumpedId === row.id ? 'bg-accent-soft' : ''}`}
        >
          <TxRow tx={row} showDate hideUnreviewed highlight={query} onClick={() => pick(row.id)} />
        </div>
      ))}
    </div>
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={target?.name ?? ''} size={size}>
      {target && (
        <div className="flex h-full min-h-0 flex-col pt-1" data-testid="counter-fork">
          {contextRow && (
            <div className="mb-2 rounded-card border border-accent/40 bg-accent-soft/30 px-3 py-2" data-testid="counter-queue-context">
              <div className="m-cap flex flex-wrap items-center gap-1 pb-0.5 text-accent-deep">
                <span>
                  {t('tx.counterQueueFor')}
                  {progress ? ` · ${progress}` : ''}
                </span>
                {/* #268: the picked counter row is spoken for, so each sibling needs its own pick (or links and waits) */}
                <InfoHint text={t('tx.counterQueueWhy')} testId="counter-queue-why" />
              </div>
              <p className="truncate text-[13px] font-medium text-ink">{txTitle(contextRow)}</p>
              <p className="text-[12px] text-ink-3">
                {new Date(contextRow.date).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' })}
                {' · '}
                {fmtCents(contextRow.amountCents, contextRow.currency, lang, { sign: true })}
              </p>
            </div>
          )}
          {onCreate && door('counter-fork-create', 'plus-circle-outline', t('tx.counterForkCreate'), t('tx.counterForkCreateSub'), onCreate)}
          {/* #255: "link and wait" is the one honest exit; a separate None door confused more than it solved */}
          {onWait && door('counter-fork-wait', 'clock-outline', t('tx.counterForkWait'), t('tx.counterForkWaitSub'), onWait)}
          {(allSuggested.length > 0 || allRest.length > 0) && (
            <SearchField
              testId="counter-match-search"
              value={query}
              onChange={setQuery}
              placeholder={t('tx.counterSearchPlaceholder')}
              height="h-10"
              textSize="text-[13px]"
              className="mb-1"
            />
          )}
          {suggested.length > 0 && (
            <>
              <div className="m-cap mt-2 mb-1 flex items-center gap-1.5 px-1 text-accent-deep">
                <Icon name="lightbulb-outline" size={13} />
                {t('tx.counterForkPickHint')}
              </div>
              {sameSign.length > 0 && (
                <p className="px-1 pb-1 text-[12px] leading-snug text-ink-4" data-testid="counter-samesign-hint">
                  {t('tx.counterSameSignHint')}
                </p>
              )}
              {rowList(suggested, 'counter-dup', true)}
            </>
          )}
          {rest.length > 0 && (
            <>
              <div className="m-cap mt-3 mb-1 flex items-center gap-2 px-1">
                <span>{t('tx.counterAllRows')}</span>
                <JumpToDateButton date={anchor.date} onJump={() => jump(anchor.date)} testId="counter-jump" />
              </div>
              <div
                ref={scrollerRef}
                className="min-h-[200px] flex-1 overflow-y-auto overscroll-contain pb-2"
                data-testid="counter-all-list"
                data-sheet-no-drag
              >
                {rowList(shownRest, 'counter-open')}
                {rest.length > shownRest.length && (
                  <MoreRows rootRef={scrollerRef} remaining={rest.length - shownRest.length} onMore={showMore} testId="counter-open-more" />
                )}
              </div>
            </>
          )}
          {suggested.length === 0 && rest.length === 0 && (
            <p className="px-1 pt-2 text-[13px] text-ink-4" data-testid="counter-fork-empty">
              {t(query ? 'tx.counterSearchNoHit' : 'tx.counterForkNoRows')}
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}

// #268: a bulk apply with a specific counter pick cannot copy it: each sibling gets its own
// match sheet; dismissing stops the queue
export function BulkCounterQueue({
  queue,
  target,
  rows,
  onResolve,
  onDone,
}: Readonly<{
  queue: readonly TransactionRow[];
  target: { id: string; name: string } | null;
  rows: readonly TransactionRow[];
  /** peerId = the picked existing row; null = link-and-wait */
  onResolve: (tx: TransactionRow, peerId: string | null) => void;
  /** fires once — queue exhausted or dismissed early */
  onDone: (resolved: number) => void;
}>) {
  const [index, setIndex] = useState(0);
  const resolvedRef = useRef(0);
  // a pick closes the inner sheet — that close must not read as dismiss
  const advancingRef = useRef(false);
  const current = queue[index];
  if (!current) return null;
  const advance = () => {
    advancingRef.current = true;
    resolvedRef.current += 1;
    if (index + 1 >= queue.length) onDone(resolvedRef.current);
    else setIndex(index + 1);
  };
  return (
    <CounterMatchSheet
      key={current.id}
      open
      onOpenChange={(next) => {
        if (!next && !advancingRef.current) onDone(resolvedRef.current);
        advancingRef.current = false;
      }}
      target={target}
      anchor={{ id: current.id, amountCents: current.amountCents, date: current.date }}
      rows={rows}
      contextRow={current}
      progress={`${index + 1}/${queue.length}`}
      onWait={() => {
        onResolve(current, null);
        advance();
      }}
      onPick={(txId) => {
        onResolve(current, txId);
        advance();
      }}
    />
  );
}
