import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
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
  gcAvailable,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** hosts with an in-place bank flow pass it; others get the door */
  onConnect?: () => void;
  /** hosts with an in-place import flow pass it; others get the door */
  onImport?: () => void;
  gcAvailable?: boolean;
}>) {
  const { t } = useLang();
  const { store, repo, spaceId } = useData();
  const navigate = useNavigate();
  const syncing = useSession((s) => s.identity?.kind === 'user');
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const [step, setStep] = useState<'intent' | 'manual'>('intent');
  const [newType, setNewType] = useState<AccountType | null>(null);
  const [name, setName] = useState('');
  const [balance, setBalance] = useState('');
  const [currency, setCurrency] = useState<string | null>(null);
  const effectiveCurrency = currency ?? space?.currency ?? 'EUR';

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setStep('intent');
      setNewType(null);
      setName('');
      setBalance('');
      setCurrency(null);
    }
  };

  const goGlobal = () => {
    close(false);
    void navigate({ to: '/accounts' });
  };

  const createManual = () => {
    const cents = parseCents(balance || '0');
    if (!newType || !name.trim() || cents === null) return;
    void repo.upsert('account', spaceId, repo.newId(), {
      name: name.trim(),
      type: newType,
      source: 'manual',
      currency: effectiveCurrency,
      balanceCents: isLiability(newType) ? -Math.abs(cents) : cents,
      balanceAsOf: manualBalanceDate(),
    });
    void logActivity(store, repo, spaceId, 'accountAdd', name.trim());
    close(false);
  };

  return (
    <Sheet open={open} onOpenChange={close} title={t('acct.addAccount')} size="tall">
      {step === 'intent' && (
        <div className="flex flex-col gap-2 pt-1" data-testid="add-account-chooser">
          {syncing && gcAvailable && (
            <IntentRow
              testId="chooser-connect"
              icon="bank-transfer"
              accent
              title={t('chooser.connect')}
              sub={t('chooser.connectSub')}
              onClick={() => {
                close(false);
                if (onConnect) onConnect();
                else void navigate({ to: '/accounts' });
              }}
            />
          )}
          <IntentRow
            testId="chooser-import"
            icon="file-upload-outline"
            title={t('chooser.import')}
            sub={t('chooser.importSub')}
            onClick={() => {
              if (onImport) {
                close(false);
                onImport();
              } else goGlobal();
            }}
          />
          <IntentRow
            testId="chooser-manual"
            icon="pencil-plus-outline"
            title={t('chooser.manual')}
            sub={t('chooser.manualSub', { space: space?.name ?? '' })}
            onClick={() => setStep('manual')}
          />
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
              <input
                data-testid="chooser-acctform-balance"
                value={balance}
                onChange={(e) => setBalance(e.target.value)}
                inputMode="decimal"
                placeholder={`${t('acct.initialBalance')} (${effectiveCurrency})`}
                className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
              />
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
                  onClick={() => setNewType(def.type)}
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
