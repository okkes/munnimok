import { ScrollRow } from '@/ui/ScrollRow';
import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { minaSuggestedAccountName } from '@/features/mina/steps';
import { setCatalogueIntent } from '@/features/connectors/catalogueIntent';
import { StatementImportFlow } from './StatementImportFlow';
import { useLang } from '@/i18n';
import { useQuery } from '@/db/useQuery';
import { useData } from '@/app/data';
import { useCanEdit } from '@/app/useCanEdit';
import { useSession } from '@/app/session';
import { ReadOnlyNote } from '@/features/spaces/ReadOnlyNote';
import { logActivity } from '@/application/activity';
import { isPristineLoan } from '@/application/loanBalance';
import { CURRENCIES } from '@/domain/countries';
import { evalAmountCents, parseCents } from '@/lib/money';
import type { AccountRow, AccountType, RecurringEvery } from '@/db/types';
import { ACCOUNT_TYPES, isLiability, manualBalanceDate, typeDef } from './accountTypes';
import { Button } from '@/ui/Button';
import { FormBlockerNote, blockerRing } from '@/ui/FormBlockerNote';
import { Chip } from '@/ui/primitives';
import { isCustomCadence, LoanCadenceControl, NoFixedPaymentToggle, offersNoPlan, parsedDueDay } from './LoanCadenceControl';
import { Icon } from '@/ui/Icon';
import { InfoHint } from '@/ui/InfoHint';
import { Sheet } from '@/ui/Sheet';
import { DecimalInput } from '@/ui/DecimalInput';

// the ONE "Add an account" entry, routing by intent; the manual form is embedded and liability types add the debt story
const anyManualFieldFilled = (fields: readonly string[]): boolean => fields.some((field) => field !== '');

// #326: hosts that cannot pass props (the counterparty ask's Create door) stage a prefill here; review clears it on leave
// the chooser drinks it on open without a `prefill` prop; loan-plan fields apply once a liability type is picked
export interface ChooserLoanPrefill {
  name?: string;
  currency?: string;
  paymentCents?: number;
  paymentDay?: number;
  paymentEvery?: RecurringEvery;
}
let stagedLoanPrefill: ChooserLoanPrefill | null = null;
export const setChooserLoanPrefill = (next: ChooserLoanPrefill | null): void => {
  stagedLoanPrefill = next;
};

const prefillPaymentText = (cents: number | undefined): string => (cents ? (cents / 100).toFixed(2) : '');
const prefillPayDayText = (day: number | undefined): string => (day ? String(day) : '');

function chooserRings(attempted: boolean, nameMissing: boolean, balanceMissing: boolean) {
  if (!attempted) return { nameBad: false, balanceBad: false };
  return { nameBad: nameMissing, balanceBad: balanceMissing };
}

export function AddAccountChooser({
  open,
  onOpenChange,
  onConnect,
  onImport,
  onCreated,
  hideManual,
  initialStep,
  manualTypes,
  loanFlavor,
  prefill,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** hosts without an in-place bank connect go to All accounts with its bank picker open (#527) */
  onConnect?: () => void;
  /** hosts with an in-place import flow pass it; others get the door */
  onImport?: () => void;
  onCreated?: (account: { id: string; type: AccountType }) => void;
  /** manual accounts live inside a space, so the global accounts screen points at the space instead */
  hideManual?: boolean;
  initialStep?: 'intent' | 'manual';
  manualTypes?: readonly AccountType[];
  /** the Debts "+" flavor: titled "New loan", the note says the loan is stored as an account behind the scenes */
  loanFlavor?: boolean;
  prefill?: { name?: string; paymentCents?: number; paymentEvery?: RecurringEvery; paymentDay?: number; merchantKey?: string };
}>) {
  const { t } = useLang();
  const { store, repo, spaceId } = useData();
  const canEdit = useCanEdit(); // #505
  const navigate = useNavigate();
  const syncing = useSession((s) => s.identity?.kind === 'user');
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const [step, setStep] = useState<'intent' | 'manual'>(initialStep ?? 'intent');
  // #326: drink the staged one-shot prefill on open: hosts that mount the chooser themselves cannot pass `prefill`
  useEffect(() => {
    if (!open || prefill) return;
    const staged = stagedLoanPrefill;
    if (!staged) return;
    if (staged.name) setName(staged.name);
    if (staged.currency) setCurrency(staged.currency);
    if (staged.paymentCents) setPayment(prefillPaymentText(staged.paymentCents));
    if (staged.paymentDay) setPayDay(prefillPayDayText(staged.paymentDay));
    if (staged.paymentEvery) {
      setPayEvery(staged.paymentEvery);
      setPayCustom(isCustomCadence(staged.paymentEvery, 1));
    }
    // one-shot per open — the staged facts are the OPEN's starting point
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // no in-place import host: the flow embeds itself (the old door bounced to the global overview mid-flow)
  const [importOpen, setImportOpen] = useState(false);
  const [newType, setNewType] = useState<AccountType | null>(null);
  const [name, setName] = useState(prefill?.name ?? '');
  const [balance, setBalance] = useState('');
  // liabilities default to negative but may be positive (an overpaid credit card)
  const [negative, setNegative] = useState(false);
  const [currency, setCurrency] = useState<string | null>(null);
  const [iban, setIban] = useState('');
  const [original, setOriginal] = useState('');
  const [apr, setApr] = useState('');
  const [payment, setPayment] = useState(prefillPaymentText(prefill?.paymentCents));
  // #190: the due day says which period a payment belongs to
  const [payDay, setPayDay] = useState(prefillPayDayText(prefill?.paymentDay));
  const [payEvery, setPayEvery] = useState<RecurringEvery>(prefill?.paymentEvery ?? 'month');
  const [payEveryN, setPayEveryN] = useState(1);
  const [payCustom, setPayCustom] = useState(isCustomCadence(prefill?.paymentEvery, 1));
  const [noPlan, setNoPlan] = useState(false);
  const [note, setNote] = useState('');
  const [attempted, setAttempted] = useState(false);
  const effectiveCurrency = currency ?? space?.currency ?? 'EUR';

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setStep(initialStep ?? 'intent');
      setNewType(null);
      setName('');
      setBalance('');
      setNegative(false);
      setCurrency(null);
      setIban('');
      setOriginal('');
      setApr('');
      setPayment('');
      setPayEvery('month');
      setPayEveryN(1);
      setPayCustom(false);
      setNoPlan(false);
      setNote('');
      setAttempted(false);
    }
  };

  // #308: connect and import create global accounts and never auto-attach; the shared-space heads-up lives at the attach step

  // Mina suggests the demo account's name; the user still presses Add
  useEffect(() => {
    if (step === 'manual' && newType && !name) setName(minaSuggestedAccountName() ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, newType]);

  // amount fields evaluate small arithmetic ("3*250+100") on blur
  const evalField = (raw: string, set: (next: string) => void) => {
    if (!/[+*/]|.-/.test(raw)) return; // plain numbers pass through
    const cents = evalAmountCents(raw);
    if (cents !== null) set((cents / 100).toFixed(2));
  };

  // a loan/mortgage tracks what is owed: its current value is required, no zero default
  const balanceRequired = newType === 'loan' || newType === 'mortgage';
  const nameMissing = !name.trim();
  const balanceMissing = balanceRequired && parseCents(balance) === null;
  const saveDisabled = nameMissing || balanceMissing;
  const { nameBad, balanceBad } = chooserRings(attempted, nameMissing, balanceMissing);

  const noPlanOffered = offersNoPlan(newType);
  const paymentPlanFields = (): Partial<AccountRow> => {
    if (noPlanOffered && noPlan) return { paymentCents: 0 };
    const paymentCents = parseCents(payment);
    if (!paymentCents || paymentCents <= 0) return {};
    return {
      paymentCents,
      paymentEvery: payEvery,
      ...(payEveryN > 1 ? { paymentEveryN: payEveryN } : {}),
      // #190: weekly plans have no day-of-month
      ...(payEvery !== 'week' && parsedDueDay(payDay) ? { paymentDay: parsedDueDay(payDay) } : {}),
    };
  };

  /** the debt story a liability account carries; blank fields stay off the row */
  const liabilityFields = (): Partial<AccountRow> => {
    const originalCents = parseCents(original);
    const aprNumber = Number.parseFloat(apr.replace(',', '.'));
    return {
      ...(iban.trim() ? { iban: iban.trim() } : {}),
      ...(originalCents && originalCents > 0 ? { originalCents } : {}),
      // 0% is a real answer; only the EMPTY field means "remind me"
      ...(Number.isFinite(aprNumber) && aprNumber >= 0 ? { interestPctYear: aprNumber } : {}),
      ...paymentPlanFields(),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(prefill?.merchantKey ? { merchantKey: prefill.merchantKey } : {}),
    };
  };

  const createManual = () => {
    // #342: funding pots always start at zero — the field is not shown
    const cents = newType === 'funding' ? 0 : parseCents(balance || '0');
    if (!newType || saveDisabled || cents === null) return;
    const id = repo.newId();
    const balanceCents = negative ? -Math.abs(cents) : Math.abs(cents);
    const story: Partial<AccountRow> = isLiability(newType) ? liabilityFields() : {};
    void repo.upsert('account', spaceId, id, {
      name: name.trim(),
      type: newType,
      source: 'manual',
      currency: effectiveCurrency,
      balanceCents,
      // #509: a loan typed at its original amount holds no payment yet: no cut-off date, every linked payment counts
      ...(isPristineLoan({ originalCents: story.originalCents, balanceCents }) ? {} : { balanceAsOf: manualBalanceDate() }),
      ...story,
    });
    void logActivity(store, repo, spaceId, 'accountAdd', name.trim());
    onCreated?.({ id, type: newType });
    close(false);
  };

  // a filled manual form asks "discard?" before a stray backdrop tap drops it; the intent step never asks
  const manualDirty = step === 'manual' && newType !== null && anyManualFieldFilled([name.trim(), balance, iban, original, apr, payment, note, noPlan ? 'on' : '']);

  return (
    <>
    <Sheet open={open} onOpenChange={close} title={t(loanFlavor ? 'debts.new' : 'acct.addAccount')} size="tall" dirty={manualDirty}>
      {step === 'intent' && (
        <div className="flex flex-col gap-2 pt-1" data-testid="add-account-chooser">
          {syncing && (
            <IntentRow
              testId="chooser-connect"
              icon="bank-transfer"
              accent
              title={t('chooser.connect')}
              sub={t('chooser.connectSub')}
              onClick={() => {
                close(false);
                if (onConnect) {
                  onConnect();
                  return;
                }
                // #527: banks are connected on All accounts — its bank
                // picker opens right away, the choice already made here
                setCatalogueIntent();
                void navigate({ to: '/accounts' });
              }}
            />
          )}
          {/* #505: an import and a manual account land in THIS space — not one this identity only reads */}
          <ReadOnlyNote testId="chooser-readonly-note" />
          {canEdit && (
            <IntentRow
              testId="chooser-import"
              icon="file-upload-outline"
              title={t('chooser.import')}
              sub={t('chooser.importSub')}
              onClick={() => {
                close(false);
                if (onImport) onImport();
                else setImportOpen(true);
              }}
            />
          )}
          {canEdit && hideManual && (
            <button
              data-testid="chooser-manual-door"
              onClick={() => {
                close(false);
                void navigate({ to: '/spaces/$spaceId/accounts', params: { spaceId } });
              }}
              className="m-tap flex items-center gap-3 rounded-card border border-dashed border-line bg-transparent p-4 text-left"
            >
              <Icon name="pencil-plus-outline" size={24} color="var(--m-ink-4)" />
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold text-ink-2">{t('chooser.manual')}</span>
                <span className="block text-[12px] text-ink-4">{t('chooser.manualSpaceDoor', { space: space?.name ?? '' })}</span>
              </span>
              <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
            </button>
          )}
          {canEdit && !hideManual && (
            <IntentRow
              testId="chooser-manual"
              icon="pencil-plus-outline"
              title={t('chooser.manual')}
              sub={t('chooser.manualSub', { space: space?.name ?? '' })}
              onClick={() => setStep('manual')}
            />
          )}
        </div>
      )}

      {step === 'manual' && (
        <div className="flex flex-col gap-3 pt-1" data-testid="chooser-manual-form">
          {/* #283: the scope/storage story folds behind a hint: the visible paragraph shouted over the form */}
          <div className="m-cap flex flex-wrap items-center gap-1.5">
            {t('acct.manual')}
            <InfoHint
              text={loanFlavor ? t('debts.chooserNote') : t('acct.spaceScopedNote', { space: space?.name ?? '' })}
              testId="chooser-hint"
            />
          </div>
          {newType ? (
            <>
              <div className="flex items-center gap-2 text-[13px] text-ink-3">
                <Icon name={typeDef(newType).icon} size={16} />
                {t(typeDef(newType).labelKey)} · {t('acct.manual')}
              </div>
              <input
                data-testid="chooser-acctform-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('acct.accountName')}
                aria-invalid={nameBad}
                className={`h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4${blockerRing(nameBad)}`}
              />
              <FormBlockerNote show={nameBad} text={t('form.needName')} testId="chooser-acctform-save-blocker" />
              {/* #342: a funding pot counts nowhere and starts at zero: no balance field */}
              {newType !== 'funding' && (
              <div className="flex gap-2">
                {/* #327: each half owns its corners of the clipping frame so the inset focus ring hugs the visible shape */}
                <div className="flex overflow-hidden rounded-input border border-line">
                  <button
                    data-testid="chooser-acctform-neg"
                    onClick={() => setNegative(true)}
                    className={`m-tap rounded-l-input border-none px-3 text-[13px] font-medium ${negative ? 'bg-negative-soft text-negative' : 'bg-surface text-ink-3'}`}
                  >
                    −
                  </button>
                  <button
                    data-testid="chooser-acctform-pos"
                    onClick={() => setNegative(false)}
                    className={`m-tap rounded-r-input border-none px-3 text-[13px] font-medium ${negative ? 'bg-surface text-ink-3' : 'bg-accent-soft text-accent-deep'}`}
                  >
                    +
                  </button>
                </div>
                <input
                  data-testid="chooser-acctform-balance"
                  value={balance}
                  onChange={(e) => setBalance(e.target.value)}
                  onBlur={() => evalField(balance, setBalance)}
                  inputMode="decimal"
                  // a liability's balance is what is owed right now: "Initial balance" beside "Original amount" read as the same thing twice
                  placeholder={`${t(isLiability(newType) ? 'debts.current' : 'acct.initialBalance')} (${effectiveCurrency})`}
                  aria-invalid={balanceBad}
                  className={`h-12 min-w-0 flex-1 rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4${blockerRing(balanceBad)}`}
                />
              </div>
              )}
              <FormBlockerNote show={!nameBad && balanceBad} text={t('form.needAmount')} testId="chooser-acctform-save-blocker" />
              <div className="m-cap px-1">{t('space.currency')}</div>
              <ScrollRow>
                {CURRENCIES.map((c) => (
                  <Chip key={c} className="font-mono" testId={`chooser-currency-${c}`} selected={effectiveCurrency === c} onClick={() => setCurrency(c)}>
                    {c}
                  </Chip>
                ))}
              </ScrollRow>
              {isLiability(newType) && (
                <>
                  <div className="m-cap px-1 pt-1">{t('debts.loanDetails')}</div>
                  <input
                    data-testid="chooser-acctform-iban"
                    value={iban}
                    onChange={(e) => setIban(e.target.value)}
                    placeholder={t('debts.iban')}
                    className="h-11 w-full rounded-input border border-line bg-surface px-4 font-mono text-[13px] text-ink outline-none placeholder:text-ink-4"
                  />
                  <div className="flex gap-2">
                    <label className="min-w-0 flex-1 text-[12px] text-ink-3">
                      {t('debts.original')}
                      <input
                        data-testid="chooser-acctform-original"
                        inputMode="decimal"
                        value={original}
                        onChange={(e) => setOriginal(e.target.value)}
                        onBlur={() => evalField(original, setOriginal)}
                        placeholder="0.00"
                        className="mt-1 h-11 w-full rounded-input border border-line bg-surface px-3 font-mono text-[14px] text-ink outline-none placeholder:text-ink-4"
                      />
                    </label>
                    <label className="min-w-0 flex-1 text-[12px] text-ink-3">
                      {t('debts.apr')}
                      <DecimalInput
                        data-testid="chooser-acctform-apr"
                        value={apr}
                        onValue={setApr}
                        placeholder="0.0"
                        className="mt-1 h-11 w-full rounded-input border border-line bg-surface px-3 font-mono text-[14px] text-ink outline-none placeholder:text-ink-4"
                      />
                    </label>
                  </div>
                  {noPlanOffered && <NoFixedPaymentToggle checked={noPlan} onChange={setNoPlan} testId="chooser-acctform-no-plan" />}
                  {!(noPlanOffered && noPlan) && (
                    <>
                      <div className="flex gap-2">
                        <label className="min-w-0 flex-[2] text-[12px] text-ink-3">
                          {t('debts.payment')}
                          <input
                            data-testid="chooser-acctform-payment"
                            inputMode="decimal"
                            value={payment}
                            onChange={(e) => setPayment(e.target.value)}
                            onBlur={() => evalField(payment, setPayment)}
                            placeholder="0.00"
                            className="mt-1 h-11 w-full rounded-input border border-line bg-surface px-3 font-mono text-[14px] text-ink outline-none placeholder:text-ink-4"
                          />
                        </label>
                      </div>
                      {/* #377: the due day is asked after the rhythm (inside the control), like recurring */}
                      <LoanCadenceControl
                        value={{ every: payEvery, everyN: payEveryN }}
                        custom={payCustom}
                        onChange={(next, isCustom) => {
                          setPayEvery(next.every);
                          setPayEveryN(next.everyN);
                          setPayCustom(isCustom);
                        }}
                        dueDay={payDay}
                        onDueDay={setPayDay}
                        testIdPrefix="chooser-acctform"
                      />
                    </>
                  )}
                  <textarea
                    data-testid="chooser-acctform-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={t('debts.note')}
                    rows={2}
                    className="w-full resize-none rounded-input border border-line bg-surface px-4 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-4"
                  />
                </>
              )}
              <Button
                data-testid="chooser-acctform-save"
                onClick={() => {
                  if (saveDisabled) {
                    setAttempted(true);
                    return;
                  }
                  createManual();
                }}
              >
                {t('action.add')}
              </Button>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {ACCOUNT_TYPES.filter((def) => !manualTypes || manualTypes.includes(def.type)).map((def) => (
                <button
                  key={def.type}
                  data-testid={`chooser-accttype-${def.type}`}
                  onClick={() => {
                    setNewType(def.type);
                    setNegative(isLiability(def.type));
                  }}
                  className="m-tap flex flex-col items-start gap-2 rounded-card border border-line bg-surface p-4 text-left"
                >
                  <Icon name={def.icon} size={22} color="var(--m-accent)" />
                  <span className="text-[13px] font-medium text-ink">{t(def.labelKey)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Sheet>
    {/* only for hosts without their own onImport (no duplicate mount); beside the sheet so it survives its close */}
    {!onImport && (
      <StatementImportFlow
        open={importOpen}
        onOpenChange={setImportOpen}
        note={t('chooser.importGlobalNote', { space: space?.name ?? '' })}
      />
    )}
    </>
  );
}

function IntentRow({
  testId,
  icon,
  title,
  sub,
  accent,
  onClick,
}: Readonly<{ testId: string; icon: string; title: string; sub: string; accent?: boolean; onClick: () => void }>) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      className={`m-tap flex items-center gap-3 rounded-card border p-4 text-left ${accent ? 'border-accent bg-accent-soft' : 'border-line bg-surface'}`}
    >
      <Icon name={icon} size={24} color={accent ? 'var(--m-accent-deep)' : 'var(--m-accent)'} />
      <span className="min-w-0 flex-1">
        <span className={`block text-[14px] font-semibold ${accent ? 'text-accent-deep' : 'text-ink'}`}>{title}</span>
        <span className="block text-[12px] text-ink-3">{sub}</span>
      </span>
      <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
    </button>
  );
}
