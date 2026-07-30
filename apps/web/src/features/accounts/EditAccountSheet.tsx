import { useState } from 'react';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { logActivity } from '@/application/activity';
import { parseCents } from '@/lib/money';
import type { AccountRow } from '@/db/types';
import { BrandIconPicker } from '@/features/recurring/BrandIconPicker';
import { Button } from '@/ui/Button';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { SOURCE_KEYS } from './AttachSheet';
import { isLiability, manualBalanceDate, typeDef } from './accountTypes';

/**
 * The one editing surface for a manual/legacy account — name, balance
 * (with an explicit −/+ sign: an overpaid credit card IS positive, user
 * ruling 2026-07-31), icon, delete. Extracted from the global accounts
 * screen so the space-scoped screen offers the same door (user ss:
 * manual accounts were view-only there). Writes target the ACCOUNT's own
 * space — the active space may be a different one on the global screen.
 */
export function EditAccountSheet({ account, onClose }: Readonly<{ account: AccountRow | null; onClose: () => void }>) {
  const { t } = useLang();
  const { store, repo } = useData();
  const [seedId, setSeedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [balance, setBalance] = useState('');
  const [negative, setNegative] = useState(false);
  const [logo, setLogo] = useState<string | undefined>(undefined);
  const [logoOpen, setLogoOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // seed during render, keyed on the account id (house rule: no effect —
  // a late flush could clobber typing that landed right after the open)
  if (account && account.id !== seedId) {
    setSeedId(account.id);
    setName(account.name);
    setBalance((Math.abs(account.balanceCents) / 100).toFixed(2));
    setNegative(account.balanceCents < 0 || (account.balanceCents === 0 && isLiability(account.type)));
    setLogo(account.logo || undefined);
  }
  if (!account && seedId !== null) setSeedId(null); // reopening reseeds

  const save = () => {
    if (!account || !name.trim()) return;
    const cents = parseCents(balance || '');
    const changes: { name: string; balanceCents?: number; balanceAsOf?: string } = { name: name.trim() };
    if (cents !== null) {
      const signed = negative ? -Math.abs(cents) : Math.abs(cents);
      if (signed !== account.balanceCents) {
        changes.balanceCents = signed;
        changes.balanceAsOf = manualBalanceDate();
      }
    }
    void repo.upsert('account', account.spaceId, account.id, changes);
    void logActivity(store, repo, account.spaceId, 'accountEdit', name.trim());
    onClose();
  };

  const remove = () => {
    if (!account) return;
    void repo.remove('account', account.spaceId, account.id);
    void logActivity(store, repo, account.spaceId, 'accountRemove', account.name);
    setConfirmRemove(false);
    onClose();
  };

  return (
    <>
      <Sheet open={!!account} onOpenChange={(open) => !open && onClose()} title={t('acct.editAccount')} size="form">
        <div className="flex flex-col gap-3 pt-1">
          <input
            data-testid="acctedit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none"
          />
          <div className="flex gap-2">
            <div className="flex overflow-hidden rounded-input border border-line">
              <button
                data-testid="acctedit-neg"
                onClick={() => setNegative(true)}
                className={`m-tap border-none px-3 text-[13px] font-medium ${negative ? 'bg-negative-soft text-negative' : 'bg-surface text-ink-3'}`}
              >
                −
              </button>
              <button
                data-testid="acctedit-pos"
                onClick={() => setNegative(false)}
                className={`m-tap border-none px-3 text-[13px] font-medium ${negative ? 'bg-surface text-ink-3' : 'bg-accent-soft text-accent-deep'}`}
              >
                +
              </button>
            </div>
            <input
              data-testid="acctedit-balance"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              inputMode="decimal"
              placeholder={`${t('acct.balanceNow')} (${account?.currency ?? 'EUR'})`}
              className="h-12 min-w-0 flex-1 rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
            />
          </div>
          <button
            data-testid="acctedit-change-icon"
            onClick={() => setLogoOpen(true)}
            className="m-tap flex w-full items-center gap-3 rounded-input border border-line bg-surface px-4 py-3 text-left text-[15px] text-ink"
          >
            {logo ? (
              <img src={logo} alt="" className="h-6 w-6 rounded object-contain" />
            ) : (
              <Icon name={account ? typeDef(account.type).icon : 'bank-outline'} size={20} color="var(--m-ink-3)" />
            )}
            <span className="flex-1">{t('acct.changeIcon')}</span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
          {account && (
            <div className="flex items-center justify-between px-1 text-[12px]" data-testid="acctedit-source">
              <span className="text-ink-4">{t('acct.source')}</span>
              <span className="text-ink-2">{t(SOURCE_KEYS[account.source])}</span>
            </div>
          )}
          <Button data-testid="acctedit-save" onClick={save} disabled={!name.trim()}>
            {t('action.save')}
          </Button>
          <Button variant="danger" data-testid="acctedit-delete" onClick={() => setConfirmRemove(true)}>
            {t('action.delete')}
          </Button>
        </div>
      </Sheet>
      <BrandIconPicker
        open={logoOpen}
        onOpenChange={setLogoOpen}
        initialQuery={account?.name ?? ''}
        onPick={({ logo: picked }) => {
          if (account) {
            void repo.upsert('account', account.spaceId, account.id, { logo: picked ?? (null as never) });
            void logActivity(store, repo, account.spaceId, 'accountEdit', account.name);
            setLogo(picked ?? undefined);
          }
          setLogoOpen(false);
        }}
      />
      {/* aligned destructive confirm (user request): one-tap deletes are
          gone everywhere — sheet + cooldown, same as space/store/bank */}
      <DangerConfirmSheet
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t('acct.deleteConfirmTitle')}
        body={t('acct.deleteManualBody')}
        onConfirm={remove}
        testId="acctedit-remove"
      />
    </>
  );
}
