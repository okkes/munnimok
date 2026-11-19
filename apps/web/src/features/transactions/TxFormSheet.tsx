import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { useSpaceAccounts, useSpaceTransactions } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { useEvents } from '@/application/events';
import { EventPickList } from '@/features/events/EventPickList';
import { AppBar, IconButton } from '@/ui/AppBar';
import { useDiscardGuard } from '@/ui/DiscardGuard';
import { REIMBURSED_ID, UNCATEGORIZED_ID, autoSubFor, isMovementCat, specialCatType, stampMovementSub } from '@/domain/categories';
import { canCountInBalance } from '@/domain/entryMatch';
import { scaleCatsTo } from '@/domain/txSlices';
import { accountStamp, familyForCounter, movementCatFor } from '@/domain/txType';
import { defaultFamilyFor } from '@/domain/defaultAccounts';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useCanEdit } from '@/app/useCanEdit';
import { useQuery } from '@/db/useQuery';
import { logActivity } from '@/application/activity';
import { bankFitFor, linkEntry } from '@/application/entryLink';
import type { BankRowRef } from '@/application/entryLink';
import { ReadOnlyNote } from '@/features/spaces/ReadOnlyNote';
import { setSpaceAddAccountIntent } from '@/features/spaces/spaceAccountsHandoff';
import { applyHistoryMove } from '@/application/historyStart';
import { catName, useCategories } from '@/features/categories/useCategories';
import { localToday, useRecurrings } from '@/application/recurring';
import { fmtCents, parseCents } from '@/lib/money';
import { cleanBankText } from '@/lib/text';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { Chip } from '@/ui/primitives';
import { focusEntryMode, nextAmountEntry } from '@/lib/amountRegister';
import type { AmountEntryMode } from '@/lib/amountRegister';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { AccountRow, RecurringRow, TransactionRow, TxSplitCat, TxType } from '@/db/types';
import { RecurringVisual } from '@/features/recurring/RecurringVisual';
import { typeDef } from '@/features/accounts/accountTypes';
import { Button } from '@/ui/Button';
import { FormBlockerNote, blockerRing } from '@/ui/FormBlockerNote';
import { Icon } from '@/ui/Icon';
import { InfoHint } from '@/ui/InfoHint';
import { Sheet } from '@/ui/Sheet';
import { CatsSheet } from './PartCatsSheet';
import { ReimburseLinkPicker } from './ReimburseLinkScreen';
import type { PickedLink } from './ReimburseLinkScreen';
import { useReimburseLinks } from './useReimburseLinks';
import { minaSuggestedTx } from '@/features/mina/steps';
import { CounterpartySheet } from './TxKindSheet';

interface TxFormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tx?: TransactionRow;
  /** the debt detail's "add payment" door: the form opens as a transfer onto this counterparty */
  prefill?: { linkedAccountId: string; merchant?: string };
}

/** the dirty guard compares it to the seeded baseline; JSON keeps null and undefined distinct */
const formFingerprint = (state: Record<string, unknown>): string =>
  JSON.stringify([
    state.amount, state.isExpense, state.merchant, state.date, state.accountId, state.catId,
    state.adjustment, state.linkedAccountId, state.recurringId, state.cats, state.notes, state.eventId,
  ]);

type BalanceAccount = { id: string; source: string; balanceCents: number };

// manual accounts keep a live balance: every manual write adjusts the touched accounts; bank balances stay the bank's
function manualBalanceDeltas(
  accounts: readonly BalanceAccount[] | undefined,
  tx: TransactionRow | undefined,
  targetId: string,
  signed: number,
): Array<{ account: BalanceAccount; delta: number }> {
  const deltas = new Map<string, number>();
  if (tx) deltas.set(tx.accountId, -tx.amountCents);
  deltas.set(targetId, (deltas.get(targetId) ?? 0) + signed);

  const out: Array<{ account: BalanceAccount; delta: number }> = [];
  for (const [id, delta] of deltas) {
    const account = accounts?.find((a) => a.id === id);
    if (account?.source === 'manual' && delta !== 0) out.push({ account, delta });
  }
  return out;
}

function applyManualBalanceDeltas(
  repo: { upsert: (entity: 'account', spaceId: string, id: string, fields: { balanceCents: number }) => Promise<unknown> },
  spaceId: string,
  entries: ReturnType<typeof manualBalanceDeltas>,
): void {
  for (const { account, delta } of entries) {
    void repo.upsert('account', spaceId, account.id, { balanceCents: account.balanceCents + delta }).catch(() => undefined);
  }
}

function CounterAdjustRows({
  counterName,
  locked = false,
  disabled = false,
  adjustment,
  counterBlocker,
  onCounter,
  onToggleAdjustment,
  noAdjustment = false,
}: Readonly<{
  /** #547: a bank fills the account — its balance is the bank's, there is nothing to correct by hand */
  noAdjustment?: boolean;
  counterName: string | undefined;
  /** R1: a stamped account owns its rows' meaning */
  locked?: boolean;
  /** #348: an ordinary category has no other side: the row stands inert until the category makes it a movement */
  disabled?: boolean;
  adjustment: boolean;
  counterBlocker?: string;
  onCounter: () => void;
  onToggleAdjustment: () => void;
}>) {
  const { t } = useLang();
  return (
    <>
      <button
        data-testid="txform-counter"
        onClick={locked || disabled ? undefined : onCounter}
        disabled={disabled}
        aria-disabled={disabled}
        className={`m-tap flex w-full items-center gap-3 rounded-input border border-line bg-surface px-4 py-3 text-left text-[15px] text-ink${blockerRing(!!counterBlocker)}${disabled ? ' opacity-50' : ''}`}
      >
        <Icon name="bank-transfer" size={20} color={counterBlocker ? 'var(--m-negative)' : 'var(--m-ink-3)'} />
        <span className={`flex-1${counterBlocker ? ' text-negative' : ''}`}>{counterName ?? t('tx.counterNone')}</span>
        <span className="text-xs text-ink-4">{t('tx.counterparty')}</span>
        <Icon name={locked ? 'lock-outline' : 'chevron-right'} size={locked ? 14 : 18} color="var(--m-ink-4)" />
      </button>
      <FormBlockerNote show={!!counterBlocker} text={counterBlocker ?? ''} testId="txform-save-blocker" />
      {!noAdjustment && (
        <button
          data-testid="txform-adjustment"
          onClick={onToggleAdjustment}
          className="m-tap flex w-full items-center gap-3 rounded-input border border-line bg-surface px-4 py-2.5 text-left text-[13px] text-ink-2"
        >
          <Icon name="tune-variant" size={18} color="var(--m-ink-3)" />
          <span className="flex-1">{t('txform.adjustment')}</span>
          <Icon name={adjustment ? 'checkbox-marked' : 'checkbox-blank-outline'} size={18} color={adjustment ? 'var(--m-accent-deep)' : 'var(--m-ink-4)'} />
        </button>
      )}
    </>
  );
}

function initialFormState(tx: TransactionRow | undefined, prefill?: TxFormSheetProps['prefill']) {
  if (!tx) {
    // Mina's demo suggestion pre-fills, category included; the act accepts any values
    const suggested = minaSuggestedTx();
    return {
      amount: suggested?.amount ?? '',
      isExpense: true,
      merchant: prefill?.merchant ?? suggested?.merchant ?? '',
      date: localToday(),
      accountId: null,
      catId: suggested?.catId ?? UNCATEGORIZED_ID,
      adjustment: false,
      linkedAccountId: prefill?.linkedAccountId ?? null,
      recurringId: null,
    };
  }
  return {
    amount: (Math.abs(tx.amountCents) / 100).toFixed(2).replace('.', ','),
    isExpense: tx.amountCents < 0,
    merchant: tx.merchant,
    date: tx.date,
    accountId: tx.accountId,
    catId: tx.catId ?? UNCATEGORIZED_ID,
    adjustment: tx.adjustment === 1,
    linkedAccountId: tx.linkedAccountId ?? null,
    recurringId: tx.recurringId ?? null,
  };
}

/** a split container owns no category: the row states the parts and stays inert (#211) */
function FormCategoryRow({
  tx,
  cat,
  cats,
  stagedCats,
  onOpen,
}: Readonly<{
  tx: TransactionRow | undefined;
  cat: ReturnType<ReturnType<typeof useCategories>['byId']>;
  cats: ReturnType<typeof useCategories>;
  stagedCats: TxSplitCat[] | null;
  onOpen: () => void;
}>) {
  const { t } = useLang();
  if (tx?.splits?.length) {
    return (
      <div
        data-testid="txform-category-parts"
        className="flex w-full items-center gap-3 rounded-input border border-line bg-surface px-4 py-3 text-left text-[15px] text-ink-3"
      >
        <Icon name="call-split" size={20} color="var(--m-ink-4)" />
        <span className="flex-1">
          {t('split.partsSection')} · {tx.splits.filter((s) => s.catId !== REIMBURSED_ID).length}
        </span>
      </div>
    );
  }
  return (
    <button
      data-testid="txform-category"
      onClick={onOpen}
      className="m-tap flex w-full items-center gap-3 rounded-input border border-line bg-surface px-4 py-3 text-left text-[15px] text-ink"
    >
      <Icon name={cat.icon} size={20} color={cat.color ?? cats.byId(cat.parentId).color} />
      <span className="flex-1">
        {stagedCats && stagedCats.length > 1
          ? stagedCats.map((entry) => catName(cats.byId(entry.catId), t)).join(' · ')
          : catName(cat, t)}
      </span>
      <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
    </button>
  );
}

// #309: adjustments carry no counterparty, and the debt family keeps its bare story:
// the unassigned-payments bucket collects loan rows until a real loan claims them
const movementCounterMissing = (adjustment: boolean, catId: string | null, linkedAccountId: string | null): boolean =>
  !adjustment && !!catId && isMovementCat(catId) && specialCatType(catId) !== 'debtPayment' && !linkedAccountId;

const askDefaultFamily = (catId: string | null) =>
  catId && specialCatType(catId) ? (defaultFamilyFor(catId) ?? undefined) : undefined;

const fieldBlocker = (field: string, current: string, text: string): string | undefined =>
  current === field ? text : undefined;

const amountMissing = (cents: number | null, zeroCounts: boolean): boolean => cents === null || (cents === 0 && !zeroCounts);

/** #619: a correction that names the balance to land on — the one amount that may be 0 */
const landsOnBalance = (adjustment: boolean, adjustTarget: boolean): boolean => adjustment && adjustTarget;

const isValidManualTx = (args: {
  merchant: string;
  cents: number | null;
  /** #619: a balance to land on may be 0; a transaction's value may not */
  zeroCounts: boolean;
  account: string | null;
  date: string;
  counterMissing: boolean;
  beforeStart: boolean;
  /** #547: an entry on a bank account is today's or older */
  futureOnBank: boolean;
}): boolean =>
  !!args.merchant.trim() &&
  !amountMissing(args.cents, args.zeroCounts) &&
  !!args.account &&
  !!args.date &&
  !args.counterMissing &&
  !args.beforeStart &&
  !args.futureOnBank;

/** explicit nulls clear previously set links on edit: undefined would drop out of the op and leave the old value */
function manualTxFields(args: {
  tx: TransactionRow | undefined;
  accountId: string;
  date: string;
  signed: number;
  currency: string;
  merchant: string;
  catId: string;
  txType: TxType;
  stagedCats: TxSplitCat[] | null;
  linkedAccountId: string | null;
  recurringId: string | null;
  /** #348: absent on the edit sheet, which leaves them to the detail's own rows */
  story?: { notes: string; eventId: string | null };
}): Partial<Omit<TransactionRow, 'id' | 'spaceId'>> {
  // an uncategorized transfer-family row files under the family's sign-picked sub, not the hidden placeholder
  const familySub = args.catId === UNCATEGORIZED_ID && !args.stagedCats?.length ? autoSubFor(args.txType, args.signed) : undefined;
  // #211: a staged spread is rescaled if the amount moved after spreading: the partition must sum to the gross
  const cats = args.stagedCats?.length ? rescaledCats(args.stagedCats, Math.abs(args.signed)) : undefined;
  return {
    accountId: args.accountId,
    date: args.date,
    amountCents: args.signed,
    currency: args.currency,
    merchant: args.merchant.trim(),
    catId: familySub ?? args.catId,
    // the row's own stored flag marks a manual correction; the view derives the adjustment type from it (#133)
    adjustment: (args.txType === 'adjustment' ? 1 : 0) as 0 | 1,
    needsReview: 0 as const,
    ...(cats || args.tx?.cats?.length ? { cats: cats ?? (null as never) } : {}),
    ...(args.linkedAccountId || args.tx?.linkedAccountId ? { linkedAccountId: args.linkedAccountId ?? (null as never) } : {}),
    ...(args.recurringId || args.tx?.recurringId ? { recurringId: args.recurringId ?? (null as never) } : {}),
    ...storyFields(args.tx, args.story),
  };
}

function storyFields(
  tx: TransactionRow | undefined,
  story: { notes: string; eventId: string | null } | undefined,
): Partial<Pick<TransactionRow, 'notes' | 'eventId'>> {
  if (!story) return {};
  const notes = story.notes.trim();
  return {
    ...(notes || tx?.notes ? { notes: notes || (null as never) } : {}),
    ...(story.eventId || tx?.eventId ? { eventId: story.eventId ?? (null as never) } : {}),
  };
}

function rescaledCats(entries: TxSplitCat[], targetAbs: number): TxSplitCat[] | undefined {
  const sum = entries.reduce((total, e) => total + e.amountCents, 0);
  if (sum === targetAbs) return entries;
  const scaled = scaleCatsTo(entries, targetAbs);
  return scaled?.length ? scaled : undefined;
}

const optionRow = (selected: boolean, onClick: () => void, content: React.ReactNode, testId: string) => (
  <button
    key={testId}
    data-testid={testId}
    onClick={onClick}
    className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0"
  >
    {content}
    {selected && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
  </button>
);

function RecurringPickSheet({
  open,
  onOpenChange,
  recurrings,
  recurringId,
  onPick,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recurrings: readonly Pick<RecurringRow, 'id' | 'name' | 'logo' | 'icon' | 'kind'>[];
  recurringId: string | null;
  onPick: (id: string | null) => void;
}>) {
  const { t } = useLang();
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('recurring.linkTitle')} size="form" dragHandle>
      <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="txform-recurring-options">
        {optionRow(
          !recurringId,
          () => onPick(null),
          <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{t('recurring.linkNone')}</span>,
          'txform-recurring-none',
        )}
        {recurrings.map((r) =>
          optionRow(
            recurringId === r.id,
            () => onPick(r.id),
            <span className="flex min-w-0 flex-1 items-center gap-2.5">
              <RecurringVisual rec={r} size={16} active={false} />
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{r.name}</span>
            </span>,
            `txform-recurring-${r.id}`,
          ),
        )}
      </div>
    </Sheet>
  );
}

function AccountPickSheet({
  open,
  onOpenChange,
  accounts,
  selectedId,
  onPick,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: readonly AccountRow[];
  selectedId: string | null;
  onPick: (id: string) => void;
}>) {
  const { t } = useLang();
  const { fmtSensitive } = useDisplayMoney();
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('txform.account')} size="form" dragHandle>
      <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="txform-account-options">
        {accounts.map((account) => (
          <button
            key={account.id}
            data-testid={`txform-account-${account.id}`}
            onClick={() => {
              onPick(account.id);
              onOpenChange(false);
            }}
            className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0"
          >
            <Icon name={typeDef(account.type).icon} size={18} color="var(--m-ink-2)" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] text-ink">{account.name}</span>
              <span className="block truncate text-[11px] text-ink-4">
                {t(typeDef(account.type).labelKey)}
                {account.iban ? ` · …${account.iban.slice(-4)}` : ''}
              </span>
            </span>
            <span className="m-num text-[12px] text-ink-3">{fmtSensitive(account.balanceCents, account.currency, { asRecorded: true })}</span>
            {selectedId === account.id && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/** the single real manual account picks itself; the #348 cash wallet is a choice that must not break that self-pick */
const soleAccountId = (writable: readonly AccountRow[]): string | null => {
  const real = writable.filter((a) => !a.defaultFor);
  if (real.length === 1) return real[0].id;
  if (real.length === 0 && writable.length === 1) return writable[0].id;
  return null;
};

/** #228: removing the counterparty resets a special category */
const detachedCatFor = (catId: string): string => (specialCatType(catId) ? UNCATEGORIZED_ID : catId);

/** #133: the same derivation order as the choke: adjustment > stamp > diamond category > counterparty > sign */
function formEffectiveType(
  adjustment: boolean,
  ownStamp: TxType | undefined,
  catId: string,
  linkedAccount: AccountRow | undefined,
  isExpense: boolean,
): TxType {
  if (adjustment) return 'adjustment';
  const linkedType = linkedAccount ? familyForCounter(linkedAccount.type) : undefined;
  return ownStamp ?? specialCatType(catId) ?? linkedType ?? (isExpense ? 'expense' : 'income');
}

/** such a row would vanish behind the display gate once saved, so a truthy return blocks save (arc 5) */
const blockingStartDate = (space: { historyStartDate?: string } | undefined, date: string): string | undefined =>
  space?.historyStartDate && date && date < space.historyStartDate ? space.historyStartDate : undefined;

function AccountFieldRow({ account, onOpen, bad = false }: Readonly<{ account: AccountRow | undefined; onOpen: () => void; bad?: boolean }>) {
  const { t } = useLang();
  return (
    <button
      data-testid="txform-account"
      onClick={onOpen}
      // S6811: buttons take no aria-invalid; the ring and this flag signal the field instead
      data-invalid={bad || undefined}
      className={`m-tap flex w-full items-center gap-3 rounded-input border border-line bg-surface px-4 py-3 text-left text-[15px] text-ink${blockerRing(bad)}`}
    >
      <Icon name={account ? typeDef(account.type).icon : 'bank-outline'} size={20} color="var(--m-ink-3)" />
      <span className={`min-w-0 flex-1 truncate ${account ? '' : 'text-warning'}`}>{account?.name ?? t('txform.pickAccount')}</span>
      <span className="text-xs text-ink-4">{t('txform.account')}</span>
      <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
    </button>
  );
}

function signedManualCents(adjustment: boolean, adjustTarget: boolean, cents: number, adjustBase: number, isExpense: boolean): number {
  if (adjustment && adjustTarget) return Math.abs(cents) - adjustBase;
  return isExpense ? -Math.abs(cents) : Math.abs(cents);
}

function adjustDeltaFor(adjustment: boolean, adjustTarget: boolean, cents: number | null, adjustBase: number, isExpense: boolean): number | null {
  if (!adjustment || amountMissing(cents, adjustTarget)) return null;
  return signedManualCents(adjustment, adjustTarget, cents ?? 0, adjustBase, isExpense);
}

function manualBlockerFor(args: {
  attempted: boolean;
  valid: boolean;
  merchant: string;
  amountMissing: boolean;
  adjustNoop: boolean;
  effectiveAccount: string | null;
  counterMissing: boolean;
  startGateBlocking: string | undefined;
  futureOnBank: boolean;
  stagedOver?: string;
  t: ReturnType<typeof useLang>['t'];
}): [string, string] {
  const { t } = args;
  if (!args.attempted || args.valid) return ['', ''];
  if (!args.merchant.trim()) return ['merchant', t('form.needName')];
  if (args.amountMissing) return ['amount', t('form.needAmount')];
  if (args.adjustNoop) return ['amount', t('txform.adjustNoop')];
  if (!args.effectiveAccount) return ['account', t('form.needAccount')];
  if (args.futureOnBank) return ['date', t('txform.futureDate')];
  if (args.counterMissing) return ['counter', t('review.counterRequired')];
  if (args.stagedOver) return ['reimb', t('txform.reimbOver', { amount: args.stagedOver })];
  if (args.startGateBlocking) return ['form', t('form.fixErrors')];
  return ['form', t('form.needFields')];
}

function AdjustmentPanel({
  show,
  adjustTarget,
  onMode,
  adjustDelta,
  adjustBase,
  currency,
}: Readonly<{
  show: boolean;
  adjustTarget: boolean;
  onMode: (target: boolean) => void;
  adjustDelta: number | null;
  adjustBase: number;
  currency: string;
}>) {
  const { t, lang } = useLang();
  // #530: the balance before and after hides with the sensitive figures; the change itself is the row
  const { fmtSensitive } = useDisplayMoney();
  if (!show) return null;
  return (
    <div className="flex flex-col gap-2 rounded-card border border-line bg-bg-2 px-4 py-3" data-testid="txform-adjust-panel">
      <div className="flex gap-1.5">
        <Chip testId="txform-adjust-mode-delta" selected={!adjustTarget} onClick={() => onMode(false)}>
          {t('txform.adjustModeDelta')}
        </Chip>
        <Chip testId="txform-adjust-mode-target" selected={adjustTarget} onClick={() => onMode(true)}>
          {t('txform.adjustModeTarget')}
        </Chip>
      </div>
      <p className="text-[12px] text-ink-3" data-testid="txform-adjust-impact">
        {adjustDelta === null
          ? t('txform.adjustImpactIdle')
          : t('txform.adjustImpact', {
              from: fmtSensitive(adjustBase, currency, { asRecorded: true }),
              to: fmtSensitive(adjustBase + adjustDelta, currency, { asRecorded: true }),
              delta: fmtCents(adjustDelta, currency, lang, { sign: true }),
            })}
      </p>
    </div>
  );
}

function FormCategorySlot({
  adjustment,
  tx,
  cat,
  cats,
  stagedCats,
  onOpen,
}: Readonly<{
  adjustment: boolean;
  tx: TransactionRow | undefined;
  cat: ReturnType<ReturnType<typeof useCategories>['byId']>;
  cats: ReturnType<typeof useCategories>;
  stagedCats: TxSplitCat[] | null;
  onOpen: () => void;
}>) {
  const { t } = useLang();
  if (!adjustment) return <FormCategoryRow tx={tx} cat={cat} cats={cats} stagedCats={stagedCats} onOpen={onOpen} />;
  return (
    <div
      className="flex w-full items-center gap-3 rounded-input border border-line bg-surface px-4 py-3 text-[15px] text-ink-3"
      data-testid="txform-adjust-cat"
    >
      <Icon name="scale-balance" size={20} color="var(--m-ink-3)" />
      <span className="flex-1">{catName(cats.byId('balanceAdjustment'), t)}</span>
      <Icon name="lock-outline" size={14} color="var(--m-ink-4)" />
    </div>
  );
}

function RecurringLinkRow({
  adjustment,
  moneyIn,
  recurrings,
  recurringId,
  onOpen,
}: Readonly<{
  adjustment: boolean;
  /** #649: money coming in is no recurring cost */
  moneyIn: boolean;
  recurrings: readonly Pick<RecurringRow, 'id' | 'name'>[] | undefined;
  recurringId: string | null;
  onOpen: () => void;
}>) {
  const { t } = useLang();
  if (adjustment || moneyIn || (recurrings?.length ?? 0) === 0) return null;
  return (
    <button
      data-testid="txform-recurring"
      onClick={onOpen}
      className="m-tap flex w-full items-center gap-3 rounded-input border border-line bg-surface px-4 py-3 text-left text-[15px] text-ink"
    >
      <Icon name="autorenew" size={20} color="var(--m-ink-3)" />
      <span className={`flex-1 ${recurringId ? '' : 'text-ink-4'}`}>
        {recurrings?.find((r) => r.id === recurringId)?.name ?? t('recurring.linkNone')}
      </span>
      <span className="text-xs text-ink-4">{t('recurring.linkTitle')}</span>
      <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
    </button>
  );
}

interface TxFormHost {
  open: boolean;
  tx?: TransactionRow;
  prefill?: NonNullable<TxFormSheetProps['prefill']>;
  extended?: boolean;
  onClose: () => void;
  onSaved: (rowId: string) => void;
  /** #348: the reimbursement picker opens over the form; the picks wait on the form until Add */
  onLinkReimb?: () => void;
}

function bankEntryFacts(account: AccountRow | undefined, date: string): { onBank: boolean; futureOnBank: boolean; canCount: boolean } {
  if (!account || account.source === 'manual') return { onBank: false, futureOnBank: false, canCount: false };
  return { onBank: true, futureOnBank: !!date && date > localToday(), canCount: canCountInBalance(date, account) };
}

function entryFieldsFor(onBank: boolean, tx: TransactionRow | undefined, counts: boolean, apart: string | undefined): Partial<TransactionRow> {
  if (!onBank) return {};
  return { enteredAt: tx?.enteredAt ?? new Date().toISOString(), inBalance: counts ? 1 : 0, ...(apart ? { noBankTxIds: [apart] } : {}) };
}

async function linkSavedEntry(store: StorageBackend, repo: Repo, spaceId: string, rowId: string, link: BankRowRef | undefined): Promise<void> {
  if (!link) return;
  const row = await store.get('transaction', rowId);
  if (row) await linkEntry(store, repo, spaceId, row, link, false);
}

function newEntryDraft(isNewEntry: boolean, accountId: string | null, date: string, isExpense: boolean, cents: number | null, merchant: string) {
  if (!isNewEntry || !accountId || cents === null) return null;
  return { accountId, date, amountCents: isExpense ? -cents : cents, merchant: merchant.trim() };
}

function BankEntryNote({
  canCount,
  balanceAsOf,
  countIn,
  onCountIn,
}: Readonly<{ canCount: boolean; balanceAsOf: string | undefined; countIn: boolean; onCountIn: (on: boolean) => void }>) {
  const { t } = useLang();
  return (
    <div className="flex flex-col gap-2 rounded-card bg-bg-2 px-3 py-2.5" data-testid="txform-bank-note">
      <p className="flex flex-wrap items-start gap-1.5 text-[12px] leading-snug text-ink-2">
        <span className="min-w-0 flex-1">{t('txform.bankNote')}</span>
        <InfoHint text={t('txform.bankHelp')} testId="txform-bank-help" />
      </p>
      <div className={`flex items-start gap-2 text-[12px] leading-snug ${canCount ? 'text-ink-2' : 'text-ink-4'}`}>
        <input
          id="txform-in-balance"
          type="checkbox"
          data-testid="txform-in-balance"
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--m-accent)]"
          checked={canCount && countIn}
          disabled={!canCount}
          aria-describedby="txform-in-balance-note"
          onChange={(e) => onCountIn(e.target.checked)}
        />
        <span className="min-w-0 flex-1">
          <label htmlFor="txform-in-balance" className="block">
            {t('txform.inBalance')}
          </label>
          <span id="txform-in-balance-note" className="block text-[11px] text-ink-4" data-testid="txform-in-balance-note">
            {canCount ? t('txform.inBalanceSub') : t('txform.inBalanceLocked', { date: balanceAsOf ?? '' })}
          </span>
        </span>
      </div>
    </div>
  );
}

function LinkAskSheet({ bank, onAnswer, onClose }: Readonly<{ bank: BankRowRef | null; onAnswer: (link: boolean) => void; onClose: () => void }>) {
  const { t, lang } = useLang();
  return (
    <Sheet open={bank !== null} onOpenChange={(next) => !next && onClose()} title={t('txform.linkAskTitle')} size="form">
      {bank && (
        <div className="flex flex-col gap-3 pt-1" data-testid="txform-link-ask">
          <p className="text-[13px] leading-snug text-ink-2">
            {t('txform.linkAskBody', { amount: fmtCents(bank.raw.amountCents, bank.raw.currency, lang), date: bank.raw.date, title: bank.raw.merchant })}
          </p>
          <Button data-testid="txform-link-yes" onClick={() => onAnswer(true)}>
            {t('txform.linkAskYes')}
          </Button>
          <Button variant="outline" data-testid="txform-link-no" onClick={() => onAnswer(false)}>
            {t('txform.linkAskNo')}
          </Button>
        </div>
      )}
    </Sheet>
  );
}

const DRAFT_TX_ID = 'tx:being-typed';

interface TypedTx {
  accountId: string | null;
  date: string;
  cents: number | null;
  isExpense: boolean;
  currency: string;
  merchant: string;
  catId: string;
  cats: TxSplitCat[] | null;
}

function reimbAnchorFor(active: boolean, spaceId: string, typed: TypedTx, fallbackTitle: string): SpaceTx | null {
  if (!active || !typed.cents) return null;
  return {
    id: DRAFT_TX_ID,
    spaceId,
    accountId: typed.accountId ?? '',
    date: typed.date,
    amountCents: typed.isExpense ? -typed.cents : typed.cents,
    currency: typed.currency,
    merchant: typed.merchant.trim() || fallbackTitle,
    catId: typed.catId,
    ...(typed.cats ? { cats: typed.cats } : {}),
    needsReview: 0,
    deleted: 0,
  } as unknown as SpaceTx;
}

/** #348: picks wait here and are written with the row on Add; a flipped sign drops them, a lowered amount blocks the save */
function useStagedReimbursements(args: {
  extended: boolean;
  adjustment: boolean;
  canEdit: boolean;
  resetKey: string;
  spaceId: string;
  typed: TypedTx;
  onOpen?: () => void;
}) {
  const { t, lang } = useLang();
  const [staged, setStaged] = useState<PickedLink[]>([]);
  const [asked, setAsked] = useState(false);
  const active = args.extended && !args.adjustment;
  const allTxs = useSpaceTransactions(active);
  const { linkMany } = useReimburseLinks(allTxs);
  useEffect(() => {
    setStaged([]);
    setAsked(false);
  }, [args.resetKey]);
  const held = active ? staged : [];
  const cents = held.reduce((sum, link) => sum + link.cents, 0);
  const anchor = reimbAnchorFor(active, args.spaceId, args.typed, t('txform.addTitle'));
  return {
    /** false where nothing may be saved, and where no host opens the picker (the edit sheet) */
    offered: args.canEdit && !!args.onOpen,
    staged: held,
    setStaged,
    allTxs,
    anchor,
    over: cents > (args.typed.cents ?? 0) ? fmtCents(cents, args.typed.currency, lang) : undefined,
    needsAmount: asked && !anchor ? t('txform.reimbNeedsAmount') : '',
    open: () => {
      setAsked(!anchor);
      if (anchor) args.onOpen?.();
    },
    unstage: (key: string) => setStaged((picks) => picks.filter((link) => link.key !== key)),
    /** a link runs from an expense to the money that pays it back: the other direction has other counterparts */
    onSign: (expense: boolean) => {
      if (expense !== args.typed.isExpense) setStaged([]);
    },
    write: (saved: SpaceTx) => {
      if (held.length === 0) return;
      const expense = saved.amountCents < 0;
      linkMany(
        held.map((link) =>
          expense
            ? { expense: saved, credit: link.row, cents: link.cents, creditPartId: link.creditPartId }
            : { expense: link.row, credit: saved, cents: link.cents, partId: link.partId },
        ),
      );
    },
  };
}

function useTxForm({ open, tx, prefill, extended = false, onClose, onSaved, onLinkReimb }: TxFormHost) {
  const { t } = useLang();
  const navigate = useNavigate();
  const { store, repo, spaceId } = useData();
  const canEdit = useCanEdit();
  const cats = useCategories();
  const events = useEvents();
  const [notes, setNotes] = useState('');
  const [eventId, setEventId] = useState<string | null>(null);
  const [eventOpen, setEventOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [amountEntryMode, setAmountEntryMode] = useState<AmountEntryMode>('register');
  const [isExpense, setIsExpense] = useState(true);
  const [merchant, setMerchant] = useState('');
  const [date, setDate] = useState(localToday());
  const [accountId, setAccountId] = useState<string | null>(null);
  const [catId, setCatId] = useState<string>(UNCATEGORIZED_ID);
  // #211: a spread stays ONE transaction; real splits are the detail's flow
  const [catsSheetOpen, setCatsSheetOpen] = useState(false);
  const [stagedCats, setStagedCats] = useState<TxSplitCat[] | null>(null);
  const [adjustment, setAdjustment] = useState(false);
  // #269: what the typed number means while Adjustment is on: the transaction's value (default) or the balance to land on
  const [adjustTarget, setAdjustTarget] = useState(false);
  const [linkedAccountId, setLinkedAccountId] = useState<string | null>(null);
  const [recurringId, setRecurringId] = useState<string | null>(null);
  const [counterOpen, setCounterOpen] = useState(false);
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [countIn, setCountIn] = useState(true);
  const [linkAsk, setLinkAsk] = useState<{ bank: BankRowRef } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const baselineRef = useRef('');
  // the host stays up until the saved row's page is there: a second tap must not write the row again
  const saving = useRef(false);

  const allAccounts = useSpaceAccounts();
  const accounts = useMemo(() => allAccounts?.filter((a) => !a.archived), [allAccounts]);
  // manual rows before the space's history start would vanish behind the display gate (arc 5)
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  // #547: bank-filled accounts take hand entries too; #221: default accounts are system-managed, never a target,
  // except the cash wallet (#348)
  const writable = useMemo(
    () => (accounts ?? []).filter((a) => (a.source === 'manual' ? !a.defaultFor || a.defaultFor === 'cash' : a.type !== 'funding')),
    [accounts],
  );
  const recurrings = useRecurrings();

  // keyed on the row id, not the object: on the native SQL backend background writes re-emit the same row as a
  // fresh object, and an identity-keyed reseed overwrote what the user was typing
  useEffect(() => {
    if (!open) return;
    const initial = initialFormState(tx, prefill);
    setAmount(initial.amount);
    setIsExpense(initial.isExpense);
    setMerchant(initial.merchant);
    setDate(initial.date);
    setAccountId(initial.accountId);
    setCatId(initial.catId);
    setAdjustment(initial.adjustment);
    setLinkedAccountId(initial.linkedAccountId);
    setRecurringId(initial.recurringId);
    setStagedCats(tx?.cats ?? null);
    setNotes(tx?.notes ?? '');
    setEventId(tx?.eventId ?? null);
    setAttempted(false);
    setCountIn(tx ? tx.inBalance !== 0 : true);
    setLinkAsk(null);
    saving.current = false;
    baselineRef.current = formFingerprint({
      amount: initial.amount, isExpense: initial.isExpense, merchant: initial.merchant, date: initial.date,
      accountId: initial.accountId, catId: initial.catId, adjustment: initial.adjustment,
      linkedAccountId: initial.linkedAccountId, recurringId: initial.recurringId,
      cats: tx?.cats ?? null, notes: tx?.notes ?? '', eventId: tx?.eventId ?? null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tx?.id]);

  const cat = cats.byId(catId);
  // the account that picks itself is a hand-kept one: a bank account is a choice, never a default
  const effectiveAccount = accountId ?? soleAccountId(writable.filter((a) => a.source === 'manual'));
  const selectedAccount = writable.find((a) => a.id === effectiveAccount);
  const { onBank, futureOnBank, canCount } = bankEntryFacts(selectedAccount, date);
  const cents = parseCents(amount);
  const linkedAccount = (accounts ?? []).find((a) => a.id === linkedAccountId);
  // R1: a stamped account types its rows; R3: a special category pulls its type onto a standard row;
  // R2: a tracked counterparty = plain transfer
  const ownStamp = accountStamp(selectedAccount?.type);
  const effectiveType = formEffectiveType(adjustment, ownStamp, catId, linkedAccount, isExpense);
  const startGateBlocking = blockingStartDate(space, date);
  const adjustBase = selectedAccount?.balanceCents ?? 0;
  const adjustDelta = adjustDeltaFor(adjustment, adjustTarget, cents, adjustBase, isExpense);
  const adjustNoop = adjustTarget && adjustDelta === 0;
  const counterMissing = movementCounterMissing(adjustment, catId, linkedAccountId);
  const zeroCounts = landsOnBalance(adjustment, adjustTarget);
  const noAmount = amountMissing(cents, zeroCounts);
  const formCurrency = accounts?.find((a) => a.id === effectiveAccount)?.currency ?? 'EUR';
  const reimb = useStagedReimbursements({
    extended,
    adjustment,
    canEdit,
    resetKey: `${open}:${tx?.id ?? ''}`,
    spaceId,
    typed: { accountId: effectiveAccount, date, cents, isExpense, currency: formCurrency, merchant, catId, cats: stagedCats },
    onOpen: onLinkReimb,
  });
  const valid =
    isValidManualTx({ merchant, cents, zeroCounts, account: effectiveAccount, date, counterMissing, beforeStart: !!startGateBlocking, futureOnBank }) &&
    !adjustNoop &&
    !reimb.over;
  const [blockerField, blockerText] = manualBlockerFor({
    attempted, valid, merchant, amountMissing: noAmount, adjustNoop, effectiveAccount, counterMissing, startGateBlocking, futureOnBank, t,
    stagedOver: reimb.over,
  });

  const save = (bank?: { link?: BankRowRef; apart?: string }) => {
    if (!valid || !effectiveAccount || cents === null || saving.current) return;
    saving.current = true;
    const signed = signedManualCents(adjustment, adjustTarget, cents, adjustBase, isExpense);
    const rowId = tx?.id ?? repo.newId();
    // Q8: a stamped row naming a counterparty is a movement: the category is forced from the special account's own side
    const forcedCat = ownStamp && (linkedAccountId || catId === UNCATEGORIZED_ID) ? stampMovementSub(ownStamp, signed) : undefined;
    applyManualBalanceDeltas(repo, spaceId, manualBalanceDeltas(accounts, tx, effectiveAccount, signed));
    const prevLinked = tx?.linkedAccountId ?? undefined;
    const nextLinked = (adjustment ? null : linkedAccountId) ?? undefined; // mirrors manualTxFields' write
    void logActivity(store, repo, spaceId, tx ? 'txEdit' : 'txAdd', merchant.trim());
    // the form writes the raw row, not through writeTxTransform, so the mirror-mint lifecycle must ride here too
    void (async () => {
      const fields = manualTxFields({
        tx,
        accountId: effectiveAccount,
        date,
        signed,
        currency: formCurrency,
        merchant: merchant.trim(),
        // #269: an adjustment is its category: no spreads, counter or recurring
        catId: adjustment ? 'balanceAdjustment' : (forcedCat ?? catId),
        txType: effectiveType,
        stagedCats: adjustment ? null : stagedCats,
        linkedAccountId: adjustment ? null : linkedAccountId,
        recurringId: adjustment || !isExpense ? null : recurringId,
        ...(extended ? { story: { notes, eventId: adjustment ? null : eventId } } : {}),
      });
      await repo.upsert('transaction', spaceId, rowId, { ...fields, ...entryFieldsFor(onBank, tx, canCount && countIn, bank?.apart) });
      await linkSavedEntry(store, repo, spaceId, rowId, bank?.link);
      reimb.write({ ...fields, id: rowId, spaceId, deleted: 0, needsReview: 0 } as unknown as SpaceTx);
      if (prevLinked !== nextLinked) {
        const { planMirrorChange } = await import('@/application/mirrorMint');
        const plan = await planMirrorChange(
          store,
          {
            id: rowId,
            accountId: effectiveAccount,
            amountCents: signed,
            date,
            currency: formCurrency,
            merchant: merchant.trim(),
            ...(tx?.loanCounted === 1 ? { loanCounted: 1 as const } : {}),
          },
          prevLinked,
          nextLinked,
          tx?.transferPeerId,
          undefined,
        );
        if (Object.hasOwn(plan.sourceFields, 'transferPeerId')) {
          await repo.upsert('transaction', spaceId, rowId, { transferPeerId: (plan.sourceFields.transferPeerId ?? null) as never });
        }
        await plan.execute(repo);
      }
    })().catch(() => {
      saving.current = false;
    });
    onSaved(rowId);
  };

  // #179: until the seed effect stamps a baseline the form is not dirty: a ref set in an effect
  // left '' on a blank new form (no re-render, false discard ask)
  const dirty =
    open &&
    baselineRef.current !== '' &&
    formFingerprint({ amount, isExpense, merchant, date, accountId, catId, adjustment, linkedAccountId, recurringId, cats: stagedCats, notes, eventId }) !==
      baselineRef.current;
  // #348: the counterparty opens once the category makes the row a movement (or one is set)
  const counterRelevant = !!linkedAccountId || !!specialCatType(catId) || !!stagedCats?.some((e) => specialCatType(e.catId));
  const empty = writable.length === 0 && !tx;
  const pickedEvent = events?.find((e) => e.id === eventId);
  const trySave = () => {
    if (!canEdit) return;
    if (!valid) {
      setAttempted(true);
      return;
    }
    // #547: the bank may already hold what is being typed: ask before it counts twice
    const draft = newEntryDraft(onBank && !tx, effectiveAccount, date, isExpense, cents, merchant);
    if (!draft) {
      save();
      return;
    }
    void bankFitFor(store, spaceId, draft)
      .catch(() => null)
      .then((fit) => (fit ? setLinkAsk({ bank: fit }) : save()));
  };
  const answerLinkAsk = (link: boolean) => {
    const asked = linkAsk;
    if (!asked) return;
    setLinkAsk(null);
    save(link ? { link: asked.bank } : { apart: asked.bank.raw.id });
  };

  const flipSign = (expense: boolean) => {
    reimb.onSign(expense);
    setIsExpense(expense);
  };

  const saveButton = (
    <>
      <FormBlockerNote show={blockerField === 'form'} text={blockerText} testId="txform-save-blocker" />
      <Button data-testid="txform-save" className="w-full" onClick={() => trySave()}>
        {tx ? t('action.save') : t('action.add')}
      </Button>
    </>
  );

  const fields = empty ? (
    <div className="flex flex-col items-center gap-3 px-4 pt-8 text-center" data-testid="txform-no-accounts">
      <Icon name="bank-plus" size={40} color="var(--m-ink-4)" />
      <p className="text-[15px] font-medium text-ink">{t('txform.noAccountsTitle')}</p>
      <p className="text-[13px] leading-relaxed text-ink-3">{t('txform.noAccountsBody')}</p>
      <Button
        className="mt-2 w-full"
        data-testid="txform-add-account"
        onClick={() => {
          onClose();
          // #179: straight to the space's accounts screen with the add sheet opening on arrival
          setSpaceAddAccountIntent();
          void navigate({ to: '/spaces/$spaceId/accounts', params: { spaceId } });
        }}
      >
        {t('txform.noAccountsCta')}
      </Button>
    </div>
  ) : (
        <>
          <div className="flex gap-2">
            {/* #327: halves own their corners so the inset focus ring follows the group's rounding */}
            <div className="flex overflow-hidden rounded-input border border-line">
              <button
                data-testid="txform-expense"
                onClick={() => flipSign(true)}
                className={`m-tap rounded-l-input border-none px-3 text-[13px] font-medium ${isExpense ? 'bg-negative-soft text-negative' : 'bg-surface text-ink-3'}`}
              >
                −
              </button>
              <button
                data-testid="txform-income"
                onClick={() => flipSign(false)}
                className={`m-tap rounded-r-input border-none px-3 text-[13px] font-medium ${isExpense ? 'bg-surface text-ink-3' : 'bg-accent-soft text-accent-deep'}`}
              >
                +
              </button>
            </div>
            <input
              data-testid="txform-amount"
              value={amount}
              onFocus={() => setAmountEntryMode(focusEntryMode(amount))}
              onChange={(e) => {
                const next = nextAmountEntry(amountEntryMode, amount, e.target.value);
                setAmountEntryMode(next.mode);
                setAmount(next.text);
              }}
              inputMode="decimal"
              placeholder={`${t('txform.amount')} (EUR)`}
              aria-invalid={attempted && noAmount}
              className={`h-12 min-w-0 flex-1 rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4${blockerRing(attempted && noAmount)}`}
            />
          </div>
          <FormBlockerNote show={blockerField === 'amount'} text={blockerText} testId="txform-save-blocker" />

          <input
            data-testid="txform-merchant"
            value={merchant}
            onChange={(e) => setMerchant(e.target.value)}
            placeholder={t('txform.merchant')}
            aria-invalid={attempted && !merchant.trim()}
            className={`h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4${blockerRing(attempted && !merchant.trim())}`}
          />
          <FormBlockerNote show={blockerField === 'merchant'} text={blockerText} testId="txform-save-blocker" />

          {/* the webview's date-picker indicator sat misaligned: hidden, our chevron drawn instead */}
          <div className="relative">
            <input
              data-testid="txform-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-12 w-full appearance-none rounded-input border border-line bg-surface px-4 pr-10 text-[15px] text-ink outline-none [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:opacity-0"
            />
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2">
              <Icon name="chevron-down" size={18} color="var(--m-ink-4)" />
            </span>
          </div>
          <FormBlockerNote show={blockerField === 'date'} text={blockerText} testId="txform-save-blocker" />
          {startGateBlocking && (
            <div className="flex flex-col gap-2 rounded-card border border-line bg-bg-2 px-4 py-3" data-testid="txform-before-start">
              <p className="text-[12px] text-negative">{t('txform.beforeStart', { date: startGateBlocking })}</p>
              <Button
                size="sm"
                variant="outline"
                data-testid="txform-move-start"
                onClick={() => {
                  // #259: the full move: every attachment's gate follows the space date (a bare space write left links behind)
                  void applyHistoryMove(store, repo, spaceId, date);
                }}
              >
                {t('txform.moveStart')}
              </Button>
            </div>
          )}

          {writable.length > 0 && (
            <AccountFieldRow account={selectedAccount} onOpen={() => setAccountOpen(true)} bad={attempted && !effectiveAccount} />
          )}
          <FormBlockerNote show={blockerField === 'account'} text={blockerText} testId="txform-save-blocker" />
          {onBank && <BankEntryNote canCount={canCount} balanceAsOf={selectedAccount?.balanceAsOf} countIn={countIn} onCountIn={setCountIn} />}
          {writable.length === 0 && (
            <p className="px-1 text-[12px] text-ink-4" data-testid="txform-no-manual-account">
              {t('txform.manualOnly')}
            </p>
          )}

          <FormCategorySlot adjustment={adjustment} tx={tx} cat={cat} cats={cats} stagedCats={stagedCats} onOpen={() => setCatsSheetOpen(true)} />

          {/* a manual counter's leg is always minted: the special account's ledger is the record */}
          <CounterAdjustRows
            counterName={linkedAccount?.name}
            locked={!!ownStamp || adjustment}
            disabled={!counterRelevant && !ownStamp && !adjustment}
            adjustment={adjustment}
            counterBlocker={fieldBlocker('counter', blockerField, blockerText)}
            noAdjustment={onBank}
            onCounter={() => setCounterOpen(true)}
            onToggleAdjustment={() => {
              setAdjustment((v) => !v);
              setAdjustTarget(false);
            }}
          />

          <AdjustmentPanel
            show={adjustment && !!selectedAccount}
            adjustTarget={adjustTarget}
            onMode={setAdjustTarget}
            adjustDelta={adjustDelta}
            adjustBase={adjustBase}
            currency={formCurrency}
          />

          <RecurringLinkRow adjustment={adjustment} moneyIn={!isExpense} recurrings={recurrings} recurringId={recurringId} onOpen={() => setRecurringOpen(true)} />

          {extended && !adjustment && (
            <StoryRows
              eventName={pickedEvent?.name}
              onEvent={() => setEventOpen(true)}
              notes={notes}
              onNotes={setNotes}
              credit={!isExpense}
              canLinkReimb={reimb.offered}
              onLinkReimb={reimb.open}
              staged={reimb.staged}
              onUnstage={reimb.unstage}
              currency={formCurrency}
              blocker={[blockerField, blockerText]}
              needsAmount={reimb.needsAmount}
            />
          )}
        </>
      );

  const sheets = (
    <>
      <CounterpartySheet
        open={counterOpen}
        onOpenChange={setCounterOpen}
        excludeAccountId={effectiveAccount ?? ''}
        currentLinkedId={linkedAccountId ?? undefined}
        defaultFamily={askDefaultFamily(catId)}
        onChoose={(picked) => {
          setLinkedAccountId(picked.id);
          // #133/#228: a movement category follows the picked counter's kind; an uncategorized row fills
          // its special category, a deliberate plain one is left alone
          if (specialCatType(catId) || catId === UNCATEGORIZED_ID) {
            setCatId(movementCatFor(picked.type, isExpense ? -1 : 1));
          }
        }}
        onDetach={() => {
          setLinkedAccountId(null);
          setCatId(detachedCatFor(catId));
        }}
      />

      <LinkAskSheet bank={linkAsk?.bank ?? null} onAnswer={answerLinkAsk} onClose={() => setLinkAsk(null)} />

      <AccountPickSheet
        open={accountOpen}
        onOpenChange={setAccountOpen}
        accounts={writable}
        selectedId={effectiveAccount}
        onPick={(id) => setAccountId(id)}
      />

      <RecurringPickSheet
        open={recurringOpen}
        onOpenChange={setRecurringOpen}
        recurrings={recurrings ?? []}
        recurringId={recurringId}
        onPick={(id) => {
          setRecurringId(id);
          setRecurringOpen(false);
        }}
      />

      {/* #228: a lone diamond pick asks its counterparty inside the editor */}
      <CatsSheet
        open={catsSheetOpen}
        onOpenChange={setCatsSheetOpen}
        subject={{
          id: tx?.id ?? 'new',
          label: merchant.trim() || undefined,
          catId,
          cats: stagedCats ?? undefined,
          amountCents: Math.abs(cents ?? 0),
          linkedAccountId: linkedAccountId ?? undefined,
        }}
        currency={formCurrency}
        direction={isExpense ? 'debit' : 'credit'}
        // #256: the resolved type gates the picker like the detail screen's: a brokerage row stops offering Groceries
        txType={effectiveType}
        title={t('split.catsTitle')}
        includePct
        excludeAccountId={effectiveAccount ?? ''}
        askDisabled={!!ownStamp}
        onApply={(entries) => {
          if (entries.length === 1) {
            setStagedCats(null);
            setCatId(entries[0].catId);
            // a single entry's link IS the row's counterparty; a bare entry clears it (#218)
            setLinkedAccountId(entries[0].linkedAccountId ?? null);
            return;
          }
          setStagedCats(entries);
          const primary = entries.reduce((best, e) => (e.amountCents > best.amountCents ? e : best), entries[0]);
          setCatId(primary.catId);
          // the entries own their counterparties now: the whole-row link moved into its entry when the spread was seeded
          setLinkedAccountId(null);
        }}
      />

      <Sheet open={eventOpen} onOpenChange={setEventOpen} title={t('events.linkTitle')} size="form">
        <div className="pt-1" data-testid="txform-event-list">
          <button
            data-testid="txform-event-none"
            onClick={() => {
              setEventId(null);
              setEventOpen(false);
            }}
            className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink-2"
          >
            <Icon name="close-circle-outline" size={18} color="var(--m-ink-4)" />
            <span className="min-w-0 flex-1 truncate">{t('events.linkNone')}</span>
            {!eventId && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
          </button>
          <EventPickList
            events={events ?? []}
            selectedId={eventId}
            testIdPrefix="txform-event-"
            onPick={(id) => {
              setEventId(id);
              setEventOpen(false);
            }}
          />
        </div>
      </Sheet>
    </>
  );

  return { fields, saveButton, sheets, dirty, empty, reimbAnchor: reimb.anchor, staged: reimb.staged, setStaged: reimb.setStaged, allTxs: reimb.allTxs };
}

function StoryRows({
  eventName,
  onEvent,
  notes,
  onNotes,
  credit,
  canLinkReimb,
  onLinkReimb,
  staged,
  onUnstage,
  currency,
  blocker,
  needsAmount,
}: Readonly<{
  eventName: string | undefined;
  onEvent: () => void;
  notes: string;
  onNotes: (notes: string) => void;
  credit: boolean;
  canLinkReimb: boolean;
  onLinkReimb: () => void;
  staged: readonly PickedLink[];
  onUnstage: (key: string) => void;
  currency: string;
  blocker: readonly [string, string];
  needsAmount: string;
}>) {
  const { t, lang } = useLang();
  const stagedCents = staged.reduce((sum, link) => sum + link.cents, 0);
  const note = blocker[0] === 'reimb' ? blocker[1] : needsAmount;
  return (
    <>
      <button
        data-testid="txform-event"
        onClick={onEvent}
        className="m-tap flex w-full items-center gap-3 rounded-input border border-line bg-surface px-4 py-3 text-left text-[15px] text-ink"
      >
        <Icon name="party-popper" size={20} color="var(--m-ink-3)" />
        <span className={`min-w-0 flex-1 truncate ${eventName ? '' : 'text-ink-4'}`}>{eventName ?? t('events.linkNone')}</span>
        <span className="text-xs text-ink-4">{t('events.linkTitle')}</span>
        <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
      </button>
      <textarea
        data-testid="txform-notes"
        value={notes}
        onChange={(e) => onNotes(e.target.value)}
        placeholder={t('tx.notesPlaceholder')}
        rows={3}
        className="w-full resize-none rounded-input border border-line bg-surface px-4 py-3 text-[15px] text-ink outline-none placeholder:text-ink-4"
      />
      {canLinkReimb && (
        <div className="overflow-hidden rounded-input border border-line bg-surface" data-testid="txform-reimb">
          <button
            data-testid="txform-link-reimb"
            onClick={onLinkReimb}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3 text-left text-[15px] text-ink"
          >
            <Icon name="cash-refund" size={20} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{t(credit ? 'txform.reimbCredit' : 'txform.reimbExpense')}</span>
              <span className="block truncate text-[11px] text-ink-4" data-testid="txform-reimb-sub">
                {staged.length > 0 ? t('txform.reimbStaged', { n: staged.length, amount: fmtCents(stagedCents, currency, lang) }) : t('txform.reimbOnAdd')}
              </span>
            </span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
          {staged.map((link) => (
            <div key={link.key} className="flex items-center gap-2 border-t border-line-2 py-1.5 pr-1 pl-12 text-[13px] text-ink-2" data-testid={`txform-reimb-staged-${link.row.id}`}>
              <span className="min-w-0 flex-1 truncate">{cleanBankText(link.row.merchant)}</span>
              <span className="m-num shrink-0">{fmtCents(link.cents, currency, lang)}</span>
              <IconButton label={t('txform.reimbUnstage', { name: cleanBankText(link.row.merchant) })} testId={`txform-reimb-unstage-${link.row.id}`} onClick={() => onUnstage(link.key)}>
                <Icon name="close" size={16} color="var(--m-ink-4)" />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      <FormBlockerNote show={canLinkReimb && !!note} text={note} testId="txform-reimb-note" />
    </>
  );
}

export function TxFormSheet({ open, onOpenChange, tx, prefill }: TxFormSheetProps) {
  const { t } = useLang();
  const form = useTxForm({ open, tx, prefill, onClose: () => onOpenChange(false), onSaved: () => onOpenChange(false) });
  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} title={tx ? t('txform.editTitle') : t('txform.addTitle')} size="tall" dirty={form.dirty}>
        {form.empty ? (
          form.fields
        ) : (
          <div className="flex flex-col gap-3 pt-1">
            {form.fields}
            {form.saveButton}
          </div>
        )}
      </Sheet>
      {form.sheets}
    </>
  );
}

// #348: creating is a screen of its own, a sheet was too cramped;
// a caller may stage a payment onto a counterparty (?counter=&title=)
export function TxCreateScreen() {
  const { t } = useLang();
  const navigate = useNavigate();
  const canEdit = useCanEdit();
  const search = useSearch({ strict: false }) as { counter?: string; title?: string; link?: string };
  const prefill = useMemo(
    () => (search.counter ? { linkedAccountId: search.counter, merchant: search.title } : undefined),
    [search.counter, search.title],
  );
  const form = useTxForm({
    open: true,
    prefill,
    extended: true,
    onClose: () => undefined,
    onSaved: (rowId) => {
      // the new row's own page replaces this screen; back returns to the opener
      void navigate({ to: '/transactions/$txId', params: { txId: rowId }, replace: true });
    },
    // #348: the picker is a history entry of its own: the form stays as typed beneath, and Back returns with nothing saved
    onLinkReimb: () => void navigate({ to: '/transactions/new', search: { ...search, link: '1' } }),
  });
  const { guardedBack, sheet: discardSheet } = useDiscardGuard(form.dirty, () => window.history.back());
  const linking = search.link === '1' && !!form.reimbAnchor;
  const router = useRouter();
  return (
    <>
      {linking && form.reimbAnchor && (
        <ReimburseLinkPicker
          tx={form.reimbAnchor}
          allTxs={form.allTxs}
          initial={form.staged}
          onConfirm={(picks) => {
            form.setStaged(picks);
            router.history.back();
          }}
          onBack={() => router.history.back()}
        />
      )}
    <div className={linking ? 'hidden' : 'm-fade flex h-full flex-col'} data-testid="screen-tx-create">
      <AppBar
        title={t('txform.addTitle')}
        leading={
          <IconButton label={t('action.back')} testId="txform-back" onClick={guardedBack}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="flex flex-col gap-3 pt-1">{form.fields}</div>
      </div>
      {!form.empty && (
        <div className="shrink-0 border-t border-line-2 bg-bg px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))]">
          {/* #505: a space this identity only reads takes no new transaction */}
          {canEdit ? form.saveButton : <ReadOnlyNote testId="txform-readonly-note" />}
        </div>
      )}
      {form.sheets}
      {discardSheet}
    </div>
    </>
  );
}
