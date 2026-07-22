import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSpaceAccounts } from '@/application/transactions';
import { UNCATEGORIZED_ID } from '@/domain/categories';
import { typeForLinkedAccount } from '@/domain/txType';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { catName, useCategories } from '@/features/categories/useCategories';
import { useRecurrings } from '@/application/recurring';
import { parseCents } from '@/lib/money';
import type { TransactionRow, TxType } from '@/db/types';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { CategoryPicker } from '@/features/categories/CategoryPicker';
import { TX_TYPE_VISUAL } from './TxTypeSheet';

interface TxFormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** present = edit an existing (manual) transaction */
  tx?: TransactionRow;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

type BalanceAccount = { id: string; source: string; balanceCents: number };

/**
 * Manual accounts keep a LIVE balance (user bug: it froze at the stated
 * amount): every manual write adjusts the touched account(s) by the
 * row's delta. Bank-linked balances stay the bank's; CAMT gets
 * corrected on import.
 */
function manualBalanceDeltas(
  accounts: readonly BalanceAccount[] | undefined,
  tx: TransactionRow | undefined,
  targetId: string,
  signed: number,
): Array<{ account: BalanceAccount; delta: number }> {
  // merge per account id: an edit on the SAME account collapses into
  // one net delta, a moved row touches two accounts
  const deltas = new Map<string, number>();
  if (tx) deltas.set(tx.accountId, -tx.amountCents);
  deltas.set(targetId, (deltas.get(targetId) ?? 0) + signed);

  const out: Array<{ account: BalanceAccount; delta: number }> = [];
  for (const [id, delta] of deltas) {
    const account = accounts?.find((a) => a.id === id);
    if (account?.source !== 'gocardless' && account && delta !== 0) out.push({ account, delta });
  }
  return out;
}

/** write the deltas through the repo — kept out of the component (S3776) */
function applyManualBalanceDeltas(
  repo: { upsert: (entity: 'account', spaceId: string, id: string, fields: { balanceCents: number }) => Promise<unknown> },
  spaceId: string,
  entries: ReturnType<typeof manualBalanceDeltas>,
): void {
  for (const { account, delta } of entries) {
    void repo.upsert('account', spaceId, account.id, { balanceCents: account.balanceCents + delta });
  }
}

const TX_TYPES = Object.keys(TX_TYPE_VISUAL) as TxType[];

/**
 * Create or edit a manual transaction. Bank-imported rows (importRef set)
 * never reach this sheet — their amount/date are the bank's truth — and
 * automatically synced accounts (open banking) never take manual rows:
 * the bank feed is their single source of truth (user rule).
 */
export function TxFormSheet({ open, onOpenChange, tx }: TxFormSheetProps) {
  const { t } = useLang();
  const navigate = useNavigate();
  const { repo, spaceId } = useData();
  const cats = useCategories();
  const [amount, setAmount] = useState('');
  const [isExpense, setIsExpense] = useState(true);
  const [merchant, setMerchant] = useState('');
  const [date, setDate] = useState(todayIso());
  const [accountId, setAccountId] = useState<string | null>(null);
  const [catId, setCatId] = useState<string>(UNCATEGORIZED_ID);
  const [pickerOpen, setPickerOpen] = useState(false);
  // the quiet extras (user request): explicit type, counter account,
  // recurring link — each hidden while it has nothing to offer
  const [txType, setTxType] = useState<TxType | null>(null);
  const [linkedAccountId, setLinkedAccountId] = useState<string | null>(null);
  const [recurringId, setRecurringId] = useState<string | null>(null);
  const [typeOpen, setTypeOpen] = useState(false);
  const [counterOpen, setCounterOpen] = useState(false);
  const [recurringOpen, setRecurringOpen] = useState(false);

  const allAccounts = useSpaceAccounts();
  const accounts = useMemo(() => allAccounts?.filter((a) => !a.archived), [allAccounts]);
  // manual rows belong on manually maintained accounts only — open
  // banking feeds are the bank's, not ours to append to
  const writable = useMemo(() => (accounts ?? []).filter((a) => a.source !== 'gocardless'), [accounts]);
  const recurrings = useRecurrings();

  // (re)fill when opened
  useEffect(() => {
    if (!open) return;
    if (tx) {
      setAmount((Math.abs(tx.amountCents) / 100).toFixed(2).replace('.', ','));
      setIsExpense(tx.amountCents < 0);
      setMerchant(tx.merchant);
      setDate(tx.date);
      setAccountId(tx.accountId);
      setCatId(tx.catId ?? UNCATEGORIZED_ID);
      setTxType(tx.txType);
      setLinkedAccountId(tx.linkedAccountId ?? null);
      setRecurringId(tx.recurringId ?? null);
    } else {
      setAmount('');
      setIsExpense(true);
      setMerchant('');
      setDate(todayIso());
      setAccountId(null);
      setCatId(UNCATEGORIZED_ID);
      setTxType(null);
      setLinkedAccountId(null);
      setRecurringId(null);
    }
  }, [open, tx]);

  const cat = cats.byId(catId);
  const effectiveAccount = accountId ?? writable[0]?.id ?? null;
  const cents = parseCents(amount);
  const valid = !!merchant.trim() && cents !== null && cents > 0 && !!effectiveAccount && !!date;
  // untouched type follows the category, exactly as before
  const effectiveType: TxType = txType ?? cat.txTypes[0] ?? (isExpense ? 'expense' : 'income');
  const typeVisual = TX_TYPE_VISUAL[effectiveType];
  // counter candidates: every visible account except the owning one
  const counterCandidates = useMemo(
    () => (accounts ?? []).filter((a) => a.id !== effectiveAccount),
    [accounts, effectiveAccount],
  );
  const linkedAccount = counterCandidates.find((a) => a.id === linkedAccountId);

  const pickCounter = (id: string | null) => {
    setLinkedAccountId(id);
    // the account suggests the type (same rule as the detail screen);
    // clearing the link leaves the type as-is
    if (id) {
      const account = counterCandidates.find((a) => a.id === id);
      if (account) setTxType(typeForLinkedAccount(account.type));
    }
    setCounterOpen(false);
  };

  const save = () => {
    if (!valid || !effectiveAccount || cents === null) return;
    const signed = isExpense ? -Math.abs(cents) : Math.abs(cents);
    applyManualBalanceDeltas(repo, spaceId, manualBalanceDeltas(accounts, tx, effectiveAccount, signed));
    void repo.upsert('transaction', spaceId, tx?.id ?? repo.newId(), {
      accountId: effectiveAccount,
      date,
      amountCents: signed,
      currency: accounts?.find((a) => a.id === effectiveAccount)?.currency ?? 'EUR',
      merchant: merchant.trim(),
      catId,
      txType: effectiveType,
      needsReview: 0,
      // explicit null clears a previously set link on edit (undefined
      // would drop out of the op and leave the old value standing)
      ...(linkedAccountId || tx?.linkedAccountId ? { linkedAccountId: linkedAccountId ?? (null as never) } : {}),
      ...(recurringId || tx?.recurringId ? { recurringId: recurringId ?? (null as never) } : {}),
    });
    onOpenChange(false);
  };

  const optionRow = (
    selected: boolean,
    onClick: () => void,
    content: React.ReactNode,
    testId: string,
  ) => (
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

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={onOpenChange}
        title={tx ? t('txform.editTitle') : t('txform.addTitle')}
        size="tall"
      >
        {/* no manual account yet: explain WHY the form can't work and
            hand over a one-tap path to fix it (user UX request) */}
        {writable.length === 0 && !tx ? (
          <div className="flex flex-col items-center gap-3 px-4 pt-8 text-center" data-testid="txform-no-accounts">
            <Icon name="bank-plus" size={40} color="var(--m-ink-4)" />
            <p className="text-[15px] font-medium text-ink">{t('txform.noAccountsTitle')}</p>
            <p className="text-[13px] leading-relaxed text-ink-3">{t('txform.noAccountsBody')}</p>
            <Button
              className="mt-2 w-full"
              data-testid="txform-add-account"
              onClick={() => {
                onOpenChange(false);
                void navigate({ to: '/accounts' });
              }}
            >
              {t('txform.noAccountsCta')}
            </Button>
          </div>
        ) : (
        <div className="flex flex-col gap-3 pt-1">
          {/* direction + amount */}
          <div className="flex gap-2">
            <div className="flex overflow-hidden rounded-input border border-line">
              <button
                data-testid="txform-expense"
                onClick={() => setIsExpense(true)}
                className={`m-tap border-none px-3 text-[13px] font-medium ${isExpense ? 'bg-negative-soft text-negative' : 'bg-surface text-ink-3'}`}
              >
                −
              </button>
              <button
                data-testid="txform-income"
                onClick={() => setIsExpense(false)}
                className={`m-tap border-none px-3 text-[13px] font-medium ${isExpense ? 'bg-surface text-ink-3' : 'bg-accent-soft text-accent-deep'}`}
              >
                +
              </button>
            </div>
            <input
              data-testid="txform-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder={`${t('txform.amount')} (EUR)`}
              className="h-12 min-w-0 flex-1 rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
            />
          </div>

          <input
            data-testid="txform-merchant"
            value={merchant}
            onChange={(e) => setMerchant(e.target.value)}
            placeholder={t('txform.merchant')}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
          />

          {/* the webview's own picker indicator sat misaligned (user
              report) — hide it and draw our chevron where it belongs */}
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

          {/* account chips — open-banking accounts are not offered */}
          <div className="flex flex-wrap gap-2">
            {writable.map((a) => (
              <Chip key={a.id} testId={`txform-account-${a.id}`} selected={effectiveAccount === a.id} onClick={() => setAccountId(a.id)}>
                {a.name}
              </Chip>
            ))}
          </div>
          {writable.length === 0 && (
            <p className="px-1 text-[12px] text-ink-4" data-testid="txform-no-manual-account">
              {t('txform.manualOnly')}
            </p>
          )}

          {/* category row */}
          <button
            data-testid="txform-category"
            onClick={() => setPickerOpen(true)}
            className="m-tap flex w-full items-center gap-3 rounded-input border border-line bg-surface px-4 py-3 text-left text-[15px] text-ink"
          >
            <Icon name={cat.icon} size={20} color={cat.color ?? cats.byId(cat.parentId).color} />
            <span className="flex-1">{catName(cat, t)}</span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>

          {/* type row (follows the category until explicitly set) */}
          <button
            data-testid="txform-type"
            onClick={() => setTypeOpen(true)}
            className="m-tap flex w-full items-center gap-3 rounded-input border border-line bg-surface px-4 py-3 text-left text-[15px] text-ink"
          >
            <Icon name={typeVisual.icon} size={20} color={typeVisual.color} />
            <span className="flex-1">{t(`tx.type.${effectiveType}`)}</span>
            <span className="text-xs text-ink-4">{t('tx.type')}</span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>

          {/* counter account (only when there is another account to point at) */}
          {counterCandidates.length > 0 && (
            <button
              data-testid="txform-counter"
              onClick={() => setCounterOpen(true)}
              className="m-tap flex w-full items-center gap-3 rounded-input border border-line bg-surface px-4 py-3 text-left text-[15px] text-ink"
            >
              <Icon name="swap-horizontal" size={20} color="var(--m-ink-3)" />
              <span className={`flex-1 ${linkedAccount ? '' : 'text-ink-4'}`}>
                {linkedAccount?.name ?? t('tx.counterAccountPick')}
              </span>
              <span className="text-xs text-ink-4">{t('tx.counterparty')}</span>
              <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
            </button>
          )}

          {/* recurring link (only when the space has recurring costs) */}
          {(recurrings?.length ?? 0) > 0 && (
            <button
              data-testid="txform-recurring"
              onClick={() => setRecurringOpen(true)}
              className="m-tap flex w-full items-center gap-3 rounded-input border border-line bg-surface px-4 py-3 text-left text-[15px] text-ink"
            >
              <Icon name="autorenew" size={20} color="var(--m-ink-3)" />
              <span className={`flex-1 ${recurringId ? '' : 'text-ink-4'}`}>
                {recurrings?.find((r) => r.id === recurringId)?.name ?? t('recurring.linkNone')}
              </span>
              <span className="text-xs text-ink-4">{t('recurring.linkTitle')}</span>
              <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
            </button>
          )}

          <Button data-testid="txform-save" onClick={save} disabled={!valid}>
            {tx ? t('action.save') : t('action.add')}
          </Button>
        </div>
        )}
      </Sheet>

      {/* stacked: transaction type */}
      <Sheet open={typeOpen} onOpenChange={setTypeOpen} title={t('tx.type')} size="form">
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="txform-type-options">
          {TX_TYPES.map((type) =>
            optionRow(
              effectiveType === type,
              () => {
                setTxType(type);
                setTypeOpen(false);
              },
              <>
                <Icon name={TX_TYPE_VISUAL[type].icon} size={20} color={TX_TYPE_VISUAL[type].color} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{t(`tx.type.${type}`)}</span>
              </>,
              `txform-type-${type}`,
            ),
          )}
        </div>
      </Sheet>

      {/* stacked: counter account */}
      <Sheet open={counterOpen} onOpenChange={setCounterOpen} title={t('tx.counterparty')} size="form">
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="txform-counter-options">
          {optionRow(
            !linkedAccountId,
            () => pickCounter(null),
            <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{t('recurring.linkNone')}</span>,
            'txform-counter-none',
          )}
          {counterCandidates.map((a) =>
            optionRow(
              linkedAccountId === a.id,
              () => pickCounter(a.id),
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{a.name}</span>,
              `txform-counter-${a.id}`,
            ),
          )}
        </div>
      </Sheet>

      {/* stacked: recurring cost */}
      <Sheet open={recurringOpen} onOpenChange={setRecurringOpen} title={t('recurring.linkTitle')} size="form">
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="txform-recurring-options">
          {optionRow(
            !recurringId,
            () => {
              setRecurringId(null);
              setRecurringOpen(false);
            },
            <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{t('recurring.linkNone')}</span>,
            'txform-recurring-none',
          )}
          {(recurrings ?? []).map((r) =>
            optionRow(
              recurringId === r.id,
              () => {
                setRecurringId(r.id);
                setRecurringOpen(false);
              },
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{r.name}</span>,
              `txform-recurring-${r.id}`,
            ),
          )}
        </div>
      </Sheet>

      <CategoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        selectedId={catId}
        onPick={setCatId}
        direction={isExpense ? 'debit' : 'credit'}
      />
    </>
  );
}
