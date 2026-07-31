import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { minaSuggestedAccountName } from '@/features/mina/steps';
import { getApiCapabilities } from '@/lib/api';
import { BankConnectSheet } from './BankConnect';
import { StatementImportFlow } from './StatementImportFlow';
import { useLang } from '@/i18n';
import { useQuery } from '@/db/useQuery';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { logActivity } from '@/application/activity';
import { CURRENCIES } from '@/domain/countries';
import { parseCents } from '@/lib/money';
import type { AccountType } from '@/db/types';
import { ACCOUNT_TYPES, isLiability, manualBalanceDate, typeDef } from './accountTypes';
import { Button } from '@/ui/Button';
import { Chip } from '@/ui/primitives';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

/**
 * THE one "Add an account" entry (account-entry-flow plan, AE1): every
 * surface opens this chooser, which routes by INTENT and says where
 * the result lives. Vocabulary lock-in: Connect (bank) · Import
 * (statement) · Add (manual) · Attach/Detach (space visibility).
 * The manual form is embedded, so any host creates in place.
 */
export function AddAccountChooser({
  open,
  onOpenChange,
  onConnect,
  onImport,
  onCreated,
  hideManual,
  gcAvailable,
  initialStep,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** hosts with an in-place bank flow pass it; others get the door */
  onConnect?: () => void;
  /** hosts with an in-place import flow pass it; others get the door */
  onImport?: () => void;
  /** hosts that consume the fresh account (the transfer counterparty
   *  picker) get the manual creation reported back */
  onCreated?: (account: { id: string; type: AccountType }) => void;
  /** the GLOBAL accounts screen hides manual creation — manual accounts
   *  live inside a space, so it points at the space instead (user
   *  ruling 2026-07-28) */
  hideManual?: boolean;
  gcAvailable?: boolean;
  /** 'manual' opens straight on the type grid — the space screen's
   *  "Add a manual account" button (user redesign 2026-08-01) */
  initialStep?: 'intent' | 'manual';
}>) {
  const { t } = useLang();
  const { store, repo, spaceId } = useData();
  const navigate = useNavigate();
  const syncing = useSession((s) => s.identity?.kind === 'user');
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const [step, setStep] = useState<'intent' | 'manual' | 'shareWarn'>(initialStep ?? 'intent');
  // hosts that know pass gcAvailable; everyone else (the counterparty
  // picker's Create door, ss 2026-08-01: the bank option was missing
  // there) gets it resolved right here
  const [gcSelf, setGcSelf] = useState(false);
  useEffect(() => {
    if (!syncing || gcAvailable !== undefined) return;
    void getApiCapabilities()
      .then((caps) => setGcSelf(caps.gocardless))
      .catch(() => undefined);
  }, [syncing, gcAvailable]);
  const bankAvailable = gcAvailable ?? gcSelf;
  // no in-place import host? the flow itself embeds (user request: the
  // old door bounced to the global overview mid-flow)
  const [importOpen, setImportOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [newType, setNewType] = useState<AccountType | null>(null);
  const [name, setName] = useState('');
  const [balance, setBalance] = useState('');
  // liabilities DEFAULT to a negative balance but the user decides — an
  // overpaid credit card is legitimately positive (user rule 2026-07-31)
  const [negative, setNegative] = useState(false);
  const [currency, setCurrency] = useState<string | null>(null);
  // the action a shared-space warning is holding back (connect/import)
  const pendingRef = useRef<(() => void) | null>(null);
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
      pendingRef.current = null;
    }
  };

  // bank-connected and imported accounts become visible to every member
  // of a SHARED space — that deserves a conscious yes before the flow
  // starts; manual accounts are exempt (user rule 2026-07-28)
  const guarded = (action: () => void) => {
    if (space?.kind === 'shared') {
      pendingRef.current = action;
      setStep('shareWarn');
    } else {
      action();
    }
  };

  // Mina suggests the demo account's name; the user still presses Add
  useEffect(() => {
    if (step === 'manual' && newType && !name) setName(minaSuggestedAccountName() ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, newType]);

  const createManual = () => {
    const cents = parseCents(balance || '0');
    if (!newType || !name.trim() || cents === null) return;
    const id = repo.newId();
    void repo.upsert('account', spaceId, id, {
      name: name.trim(),
      type: newType,
      source: 'manual',
      currency: effectiveCurrency,
      balanceCents: negative ? -Math.abs(cents) : Math.abs(cents),
      balanceAsOf: manualBalanceDate(),
    });
    void logActivity(store, repo, spaceId, 'accountAdd', name.trim());
    onCreated?.({ id, type: newType });
    close(false);
  };

  return (
    <>
    <Sheet open={open} onOpenChange={close} title={t('acct.addAccount')} size="tall">
      {step === 'intent' && (
        <div className="flex flex-col gap-2 pt-1" data-testid="add-account-chooser">
          {syncing && bankAvailable && (
            <IntentRow
              testId="chooser-connect"
              icon="bank-transfer"
              accent
              title={t('chooser.connect')}
              sub={t('chooser.connectSub')}
              onClick={() =>
                guarded(() => {
                  close(false);
                  if (onConnect) onConnect();
                  else setConnectOpen(true);
                })
              }
            />
          )}
          <IntentRow
            testId="chooser-import"
            icon="file-upload-outline"
            title={t('chooser.import')}
            sub={t('chooser.importSub')}
            onClick={() =>
              guarded(() => {
                close(false);
                if (onImport) onImport();
                else setImportOpen(true);
              })
            }
          />
          {hideManual ? (
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
          ) : (
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

      {step === 'shareWarn' && (
        <div className="flex flex-col gap-3 pt-1" data-testid="chooser-share-warn">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-ink">
            <Icon name="account-group-outline" size={20} color="var(--m-warning)" />
            {t('chooser.shareWarnTitle')}
          </div>
          <p className="text-[13px] leading-relaxed text-ink-2">{t('chooser.shareWarnBody', { space: space?.name ?? '' })}</p>
          <Button
            data-testid="chooser-share-continue"
            onClick={() => {
              const action = pendingRef.current;
              pendingRef.current = null;
              action?.();
            }}
          >
            {t('chooser.shareWarnContinue')}
          </Button>
          <Button variant="outline" data-testid="chooser-share-cancel" onClick={() => setStep('intent')}>
            {t('action.cancel')}
          </Button>
        </div>
      )}

      {step === 'manual' && (
        <div className="flex flex-col gap-3 pt-1" data-testid="chooser-manual-form">
          <p className="text-[12px] leading-snug text-ink-4">{t('acct.spaceScopedNote', { space: space?.name ?? '' })}</p>
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
                className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
              />
              <div className="flex gap-2">
                <div className="flex overflow-hidden rounded-input border border-line">
                  <button
                    data-testid="chooser-acctform-neg"
                    onClick={() => setNegative(true)}
                    className={`m-tap border-none px-3 text-[13px] font-medium ${negative ? 'bg-negative-soft text-negative' : 'bg-surface text-ink-3'}`}
                  >
                    −
                  </button>
                  <button
                    data-testid="chooser-acctform-pos"
                    onClick={() => setNegative(false)}
                    className={`m-tap border-none px-3 text-[13px] font-medium ${negative ? 'bg-surface text-ink-3' : 'bg-accent-soft text-accent-deep'}`}
                  >
                    +
                  </button>
                </div>
                <input
                  data-testid="chooser-acctform-balance"
                  value={balance}
                  onChange={(e) => setBalance(e.target.value)}
                  inputMode="decimal"
                  placeholder={`${t('acct.initialBalance')} (${effectiveCurrency})`}
                  className="h-12 min-w-0 flex-1 rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
                />
              </div>
              <div className="m-cap px-1">{t('space.currency')}</div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {CURRENCIES.map((c) => (
                  <Chip key={c} className="font-mono" testId={`chooser-currency-${c}`} selected={effectiveCurrency === c} onClick={() => setCurrency(c)}>
                    {c}
                  </Chip>
                ))}
              </div>
              <Button data-testid="chooser-acctform-save" onClick={createManual} disabled={!name.trim()}>
                {t('action.add')}
              </Button>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {ACCOUNT_TYPES.map((def) => (
                <button
                  key={def.type}
                  data-testid={`chooser-accttype-${def.type}`}
                  onClick={() => {
                    setNewType(def.type);
                    setNegative(isLiability(def.type)); // default −, user can flip
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
    {/* embedded flows ONLY for hosts without their own (the counterparty
        picker's Create door) — a host that passes onImport/onConnect owns
        the flow and must not get a duplicate mount. Beside the chooser
        sheet so they survive its close. Imports are global but attach to
        THIS space — the note says so instead of bouncing to the overview */}
    {!onImport && (
      <StatementImportFlow
        open={importOpen}
        onOpenChange={setImportOpen}
        note={t('chooser.importGlobalNote', { space: space?.name ?? '' })}
      />
    )}
    {!onConnect && <BankConnectSheet open={connectOpen} onOpenChange={setConnectOpen} />}
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
