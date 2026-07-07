import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { parseCamt053 } from '@/lib/camt053/parse';
import type { CamtStatement } from '@/lib/camt053/parse';
import { getApiCapabilities } from '@/lib/api';
import { useSession } from '@/app/session';
import { importCamtStatements } from './importCamt';
import type { ImportResult } from './importCamt';
import { BankConnectSheet } from './BankConnect';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { useData } from '@/app/data';
import { fmtCents, parseCents } from '@/lib/money';
import type { AccountRow, AccountType } from '@/db/types';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

const TYPES: { type: AccountType; labelKey: TranslationKey; icon: string; liability?: boolean }[] = [
  { type: 'checking', labelKey: 'acct.bank', icon: 'bank-outline' },
  { type: 'savings', labelKey: 'acct.saving', icon: 'piggy-bank-outline' },
  { type: 'cash', labelKey: 'acct.cashWallet', icon: 'wallet-outline' },
  { type: 'brokerage', labelKey: 'acct.brokerage', icon: 'chart-line' },
  { type: 'credit', labelKey: 'acct.creditCard', icon: 'credit-card-outline', liability: true },
  { type: 'mortgage', labelKey: 'acct.mortgage', icon: 'home-percent-outline', liability: true },
  { type: 'loan', labelKey: 'acct.loan', icon: 'hand-coin-outline', liability: true },
];
const typeDef = (type: AccountType) => TYPES.find((d) => d.type === type) ?? TYPES[0];
const isLiability = (type: AccountType) => !!typeDef(type).liability;


export function AccountsScreen() {
  const { t, lang } = useLang();
  const { db, repo, spaceId } = useData();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<AccountRow | null>(null);
  const [newType, setNewType] = useState<AccountType | null>(null);
  const [name, setName] = useState('');
  const [balance, setBalance] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [importPreview, setImportPreview] = useState<CamtStatement[] | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState(false);
  const identity = useSession((s) => s.identity);
  const [gcAvailable, setGcAvailable] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  useEffect(() => {
    if (identity?.kind !== 'user') return;
    void getApiCapabilities().then((caps) => setGcAvailable(caps.gocardless));
  }, [identity?.kind]);

  const onFilePicked = async (file: File | undefined) => {
    if (!file) return;
    setImportError(false);
    setImportResult(null);
    try {
      setImportPreview(parseCamt053(await file.text()));
    } catch {
      setImportPreview(null);
      setImportError(true);
      setImportPreview([]); // open the sheet to show the error
    }
  };

  const runImport = async () => {
    if (!importPreview?.length) return;
    setImportResult(await importCamtStatements(repo, db, spaceId, importPreview));
  };

  const closeImport = () => {
    setImportPreview(null);
    setImportResult(null);
    setImportError(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const accounts = useLiveQuery(
    () => db.accounts.where('spaceId').equals(spaceId).filter((a) => a.deleted === 0 && !a.archived).toArray(),
    [spaceId],
  );
  const assets = (accounts ?? []).filter((a) => !isLiability(a.type));
  const liabilities = (accounts ?? []).filter((a) => isLiability(a.type));

  const closeAdd = () => {
    setAddOpen(false);
    setNewType(null);
    setName('');
    setBalance('');
  };

  const createAccount = () => {
    const cents = parseCents(balance || '0');
    if (!newType || !name.trim() || cents === null) return;
    void repo.upsert('account', spaceId, repo.newId(), {
      name: name.trim(),
      type: newType,
      source: 'manual',
      currency: 'EUR',
      balanceCents: isLiability(newType) ? -Math.abs(cents) : cents,
    });
    closeAdd();
  };

  const saveEdit = () => {
    if (!editing || !name.trim()) return;
    void repo.upsert('account', spaceId, editing.id, { name: name.trim() });
    setEditing(null);
  };
  const removeAccount = () => {
    if (!editing) return;
    void repo.remove('account', spaceId, editing.id);
    setEditing(null);
  };

  const Row = ({ account }: { account: AccountRow }) => (
    <button
      data-testid={`account-row-${account.id}`}
      onClick={() => {
        setEditing(account);
        setName(account.name);
      }}
      className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left"
    >
      <Icon name={typeDef(account.type).icon} size={22} color={account.color ?? 'var(--m-ink-3)'} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] text-ink">{account.name}</span>
        {account.iban && <span className="block truncate font-mono text-[11px] text-ink-4">{account.iban}</span>}
      </span>
      <span className="m-num text-[15px] font-semibold text-ink">
        {fmtCents(account.balanceCents, account.currency, lang)}
      </span>
    </button>
  );

  const Section = ({ titleKey, list }: { titleKey: TranslationKey; list: AccountRow[] }) =>
    list.length === 0 ? null : (
      <>
        <div className="m-cap mt-5 mb-1 px-1">{t(titleKey)}</div>
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {list.map((a, i) => (
            <div key={a.id}>
              {i > 0 && <div className="mx-4 h-px bg-line-2" />}
              <Row account={a} />
            </div>
          ))}
        </div>
      </>
    );

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-accounts">
      <AppBar
        title={t('acct.financialAccounts')}
        leading={
          <IconButton label={t('action.back')} testId="accounts-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
        trailing={
          <>
            <IconButton
              label={t('import.statement')}
              testId="accounts-import"
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="file-upload-outline" size={21} />
            </IconButton>
            <IconButton label={t('acct.addAccount')} testId="accounts-add" onClick={() => setAddOpen(true)}>
              <Icon name="plus" size={22} />
            </IconButton>
          </>
        }
      />
      <input
        ref={fileRef}
        type="file"
        accept=".xml,text/xml,application/xml"
        hidden
        data-testid="accounts-import-input"
        onChange={(e) => void onFilePicked(e.target.files?.[0])}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <Section titleKey="acct.assets" list={assets} />
        <Section titleKey="acct.liabilities" list={liabilities} />
      </div>

      {/* Add account: type grid, then form */}
      <Sheet open={addOpen} onOpenChange={(open) => !open && closeAdd()} title={newType ? t('acct.addAccount') : t('acct.selectType')} height={520}>
        {!newType ? (
          <div className="grid grid-cols-2 gap-2 pt-1">
            {gcAvailable && (
              <button
                data-testid="acct-connect-bank"
                onClick={() => {
                  setAddOpen(false);
                  setConnectOpen(true);
                }}
                className="m-tap col-span-2 flex items-center gap-3 rounded-card border border-accent bg-accent-soft p-4 text-left"
              >
                <Icon name="bank-transfer" size={24} color="var(--m-accent-deep)" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold text-accent-deep">{t('gc.connect')}</span>
                  <span className="block text-[12px] text-ink-3">{t('gc.connectSub')}</span>
                </span>
              </button>
            )}
            {TYPES.map((def) => (
              <button
                key={def.type}
                data-testid={`accttype-${def.type}`}
                onClick={() => setNewType(def.type)}
                className="m-tap flex flex-col items-start gap-2 rounded-card border border-line bg-surface p-4 text-left"
              >
                <Icon name={def.icon} size={22} color="var(--m-accent)" />
                <span className="text-[13px] font-medium text-ink">{t(def.labelKey)}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-3 pt-1">
            <div className="flex items-center gap-2 text-[13px] text-ink-3">
              <Icon name={typeDef(newType).icon} size={16} />
              {t(typeDef(newType).labelKey)} · {t('acct.manual')}
            </div>
            <input
              data-testid="acctform-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('acct.accountName')}
              className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
            />
            <input
              data-testid="acctform-balance"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              inputMode="decimal"
              placeholder={`${t('acct.initialBalance')} (EUR)`}
              className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
            />
            <Button data-testid="acctform-save" onClick={createAccount} disabled={!name.trim()}>
              {t('action.add')}
            </Button>
          </div>
        )}
      </Sheet>

      <BankConnectSheet open={connectOpen} onOpenChange={setConnectOpen} />

      {/* CAMT.053 import: preview then result */}
      <Sheet open={importPreview !== null} onOpenChange={(open) => !open && closeImport()} title={t('import.preview')} height={420}>
        {importError && (
          <div className="flex items-center gap-2 rounded-card bg-negative-soft px-4 py-3 text-[14px] text-negative" data-testid="import-error">
            <Icon name="alert-circle-outline" size={18} />
            {t('import.invalidFile')}
          </div>
        )}
        {!importError && !importResult && (
          <div className="flex flex-col gap-3 pt-1" data-testid="import-preview">
            {(importPreview ?? []).map((stmt) => {
              const iban = stmt.iban.replace(/\s/g, '').toUpperCase();
              const match = (accounts ?? []).find((a) => a.iban?.replace(/\s/g, '').toUpperCase() === iban);
              return (
                <div key={stmt.iban} className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3">
                  <Icon name={match ? 'bank-check' : 'bank-plus'} size={22} color="var(--m-accent)" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-ink">
                      {match?.name ?? t('import.newAccount')}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-ink-4">{stmt.iban}</span>
                  </span>
                  <span className="text-[12px] text-ink-3">
                    {stmt.entries.length === 1
                      ? t('import.txCountOne')
                      : t('import.txCount', { n: stmt.entries.length })}
                  </span>
                </div>
              );
            })}
            <Button data-testid="import-run" onClick={() => void runImport()} disabled={!importPreview?.length}>
              {t('import.doImport')}
            </Button>
          </div>
        )}
        {importResult && (
          <div className="flex flex-col items-center gap-3 pt-4 text-center" data-testid="import-result">
            <Icon name="check-circle-outline" size={40} color="var(--m-accent)" />
            <p className="text-[14px] text-ink-2">
              {t('import.done', { n: importResult.imported, s: importResult.skipped })}
            </p>
            <Button variant="outline" data-testid="import-close" onClick={closeImport}>
              {t('action.done')}
            </Button>
          </div>
        )}
      </Sheet>

      {/* Edit account */}
      <Sheet open={!!editing} onOpenChange={(open) => !open && setEditing(null)} title={t('acct.editAccount')} height={340}>
        <div className="flex flex-col gap-3 pt-1">
          <input
            data-testid="acctedit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none"
          />
          <Button data-testid="acctedit-save" onClick={saveEdit} disabled={!name.trim()}>
            {t('action.save')}
          </Button>
          <Button variant="danger" data-testid="acctedit-delete" onClick={removeAccount}>
            {t('action.delete')}
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
