import { useEffect, useMemo, useRef, useState } from 'react';
import { useGlobalAccounts } from '@/application/accounts';
import type { GlobalAccount } from '@/application/accounts';
import { parseStatement } from '@/lib/statements/parseStatement';
import type { ParsedStatement } from '@/lib/statements/parseStatement';
import { getApiCapabilities } from '@/lib/api';
import { useSession } from '@/app/session';
import { importCamtStatements } from './importCamt';
import { linkAllCounterparties } from '@/application/counterLink';
import type { ImportResult } from './importCamt';
import { apiFeedGateway, fetchMyFeedIds } from './feedGateway';
import { AttachSheet, SOURCE_KEYS } from './AttachSheet';
import { BrandIconPicker } from '@/features/recurring/BrandIconPicker';
import { BankConnectSheet } from './BankConnect';
import { useInstitutionLogos } from './useInstitutionLogos';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { useData } from '@/app/data';
import { fmtCents, parseCents } from '@/lib/money';
import { fmtTimeAgo } from '@/lib/text';
import type { AccountRow, AccountType } from '@/db/types';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
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

function AccountRowButton({
  entry,
  lang,
  onOpen,
}: {
  entry: GlobalAccount;
  lang: ReturnType<typeof useLang>['lang'];
  onOpen: (entry: GlobalAccount) => void;
}) {
  const { t } = useLang();
  const logos = useInstitutionLogos();
  const { account, feedSpaceId, sharedVia } = entry;
  // the user's own pick wins over the institution logo (user request)
  const bankLogo = account.logo ?? (account.bankId ? logos.get(account.bankId) : undefined);
  const active = sharedVia.filter((v) => !v.archived);
  const archivedOnly = sharedVia.length > 0 && active.length === 0;
  let feedSubtitle = t('acct.notAttached');
  if (active.length > 0) feedSubtitle = `${t('acct.sharedVia')} ${active.map((v) => v.spaceName).join(', ')}`;
  else if (archivedOnly) feedSubtitle = t('acct.archivedEverywhere');
  return (
    <button
      data-testid={`account-row-${account.id}`}
      onClick={() => onOpen(entry)}
      className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left"
    >
      {bankLogo ? (
        <img
          src={bankLogo}
          alt=""
          className="h-7 w-7 shrink-0 rounded-lg object-contain"
          loading="lazy"
          data-testid={`account-logo-${account.id}`}
          onError={(e) => {
            e.currentTarget.style.display = 'none';
            e.currentTarget.nextElementSibling?.classList.remove('hidden');
          }}
        />
      ) : null}
      <span className={bankLogo ? 'hidden' : ''}>
        <Icon name={typeDef(account.type).icon} size={22} color={account.color ?? 'var(--m-ink-3)'} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] text-ink">{account.name}</span>
        {feedSpaceId ? (
          <span className="block truncate text-[11px] text-ink-4" data-testid={`account-via-${account.id}`}>
            {feedSubtitle}
          </span>
        ) : (
          account.iban && <span className="block truncate font-mono text-[11px] text-ink-4">{account.iban}</span>
        )}
        {/* when the account last heard from its bank/statement (user request) */}
        {account.lastSyncedAt && (
          <span className="block truncate text-[11px] text-ink-4" data-testid={`account-synced-${account.id}`}>
            {t('acct.lastSynced', { when: fmtTimeAgo(account.lastSyncedAt, lang) })}
          </span>
        )}
      </span>
      {archivedOnly && <Icon name="archive-outline" size={16} color="var(--m-warning)" />}
      <span className="m-num text-[15px] font-semibold text-ink">
        {fmtCents(account.balanceCents, account.currency, lang)}
      </span>
    </button>
  );
}

function AccountSection({
  title,
  list,
  lang,
  onOpen,
}: {
  title: string;
  list: GlobalAccount[];
  lang: ReturnType<typeof useLang>['lang'];
  onOpen: (entry: GlobalAccount) => void;
}) {
  if (list.length === 0) return null;
  return (
    <>
      <div className="m-cap mt-5 mb-1 px-1">{title}</div>
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {list.map((entry, i) => (
          <div key={entry.account.id}>
            {i > 0 && <div className="mx-4 h-px bg-line-2" />}
            <AccountRowButton entry={entry} lang={lang} onOpen={onOpen} />
          </div>
        ))}
      </div>
    </>
  );
}

/** accounts other people attached into spaces shared with me (read-only) */
function SharedWithMeSection({ list, lang }: { list: GlobalAccount[]; lang: ReturnType<typeof useLang>['lang'] }) {
  const { t } = useLang();
  if (list.length === 0) return null;
  return (
    <>
      <div className="m-cap mt-5 mb-1 px-1">{t('acct.sharedWithMe')}</div>
      <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="accounts-shared">
        {list.map(({ account, sharedVia }, i) => {
          const active = sharedVia.filter((v) => !v.archived);
          const first = active[0] ?? sharedVia[0];
          return (
            <div key={account.id}>
              {i > 0 && <div className="mx-4 h-px bg-line-2" />}
              <div className="flex items-center gap-3 px-4 py-3.5" data-testid={`shared-account-${account.id}`}>
                <Icon name={typeDef(account.type).icon} size={22} color="var(--m-ink-3)" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-ink">{account.name}</span>
                  <span className="block truncate text-[11px] text-ink-4">
                    {first?.attachedByName ? `${first.attachedByName} · ` : ''}
                    {t('acct.sharedVia')} {(active.length ? active : sharedVia).map((v) => v.spaceName).join(', ')}
                  </span>
                </span>
                {active.length === 0 && (
                  <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold text-ink-2">
                    {t('acct.archived')}
                  </span>
                )}
                <span className="m-num text-[15px] font-semibold text-ink">
                  {fmtCents(account.balanceCents, account.currency, lang)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}


export function AccountsScreen() {
  const { t, lang } = useLang();
  const { store, repo, spaceId } = useData();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<AccountRow | null>(null);
  const [newType, setNewType] = useState<AccountType | null>(null);
  const [name, setName] = useState('');
  const [balance, setBalance] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [importPreview, setImportPreview] = useState<ParsedStatement[] | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState(false);
  const identity = useSession((s) => s.identity);

  // GoCardless accounts arrive via sync, so there is no local "account
  // created" moment to hook — reconcile whenever this screen opens
  // instead (idempotent; rows with links are skipped)
  useEffect(() => {
    void linkAllCounterparties(store, repo, spaceId).catch(() => undefined);
  }, [store, repo, spaceId]);
  const [gcAvailable, setGcAvailable] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [myFeedIds, setMyFeedIds] = useState<ReadonlySet<string> | undefined>(undefined);
  const [attaching, setAttaching] = useState<GlobalAccount | null>(null);
  const [editLogoOpen, setEditLogoOpen] = useState(false);

  useEffect(() => {
    if (identity?.kind !== 'user') return;
    void getApiCapabilities().then((caps) => setGcAvailable(caps.gocardless));
    // ownership source of truth for the global overview (offline: the
    // undefined set classifies every local feed as mine, which is right
    // for a single-user device until the fetch lands)
    void fetchMyFeedIds().then(setMyFeedIds).catch(() => undefined);
  }, [identity?.kind]);

  const onFilePicked = async (file: File | undefined) => {
    if (!file) return;
    setImportError(false);
    setImportResult(null);
    try {
      setImportPreview(parseStatement(await file.text(), file.name));
    } catch {
      setImportPreview(null);
      setImportError(true);
      setImportPreview([]); // open the sheet to show the error
    }
  };

  const runImport = async () => {
    if (!importPreview?.length) return;
    // syncing identities import into feed spaces (shared-accounts model);
    // demo/offline keep everything merged in the current space
    const feeds = identity?.kind === 'user' ? apiFeedGateway(identity.sub) : undefined;
    setImportResult(await importCamtStatements(repo, store, spaceId, importPreview, feeds));
    // a just-imported account may BE the counterparty of older rows
    // (and vice versa) — retro-link them (user rule)
    await linkAllCounterparties(store, repo, spaceId).catch(() => undefined);
    // the import may have registered new feeds — refresh ownership so the
    // new accounts classify under MINE, not "shared with me"
    if (feeds) void fetchMyFeedIds().then(setMyFeedIds).catch(() => undefined);
  };

  const closeImport = () => {
    setImportPreview(null);
    setImportResult(null);
    setImportError(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  // GLOBAL overview (user decision): every account I own across all my
  // spaces and feeds, plus what others share with me via shared spaces
  const global = useGlobalAccounts(myFeedIds);
  const mine = useMemo(() => (global?.mine ?? []).filter((e) => !e.account.archived), [global]);
  const assets = mine.filter((e) => !isLiability(e.account.type));
  const liabilities = mine.filter((e) => isLiability(e.account.type));

  const openEntry = (entry: GlobalAccount) => {
    if (entry.feedSpaceId) setAttaching(entry); // bank feed: manage attachments
    else openEdit(entry.account); // manual/legacy row: edit name/balance
  };

  const closeAdd = () => {
    setAddOpen(false);
    setNewType(null);
    setName('');
    setBalance('');
  };

  // manual balances are statements of "true today" — date them so a
  // statement import can tell whether its balance is newer (see importCamt)
  const localToday = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
      balanceAsOf: localToday(),
    });
    closeAdd();
  };

  const saveEdit = () => {
    if (!editing || !name.trim()) return;
    const cents = parseCents(balance || '');
    let signed: number | null = null;
    if (cents !== null) signed = isLiability(editing.type) ? -Math.abs(cents) : cents;
    const balanceChanged = signed !== null && signed !== editing.balanceCents;
    void repo.upsert('account', spaceId, editing.id, {
      name: name.trim(),
      ...(balanceChanged ? { balanceCents: signed!, balanceAsOf: localToday() } : {}),
    });
    setEditing(null);
  };
  const removeAccount = () => {
    if (!editing) return;
    void repo.remove('account', spaceId, editing.id);
    setEditing(null);
  };

  const openEdit = (account: AccountRow) => {
    setEditing(account);
    setName(account.name);
    // liabilities store negative cents but are edited as positive amounts
    setBalance((Math.abs(account.balanceCents) / 100).toFixed(2));
  };

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
            <HelpButton tourId="accounts" />
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
        accept=".xml,.csv,text/xml,application/xml,text/csv"
        hidden
        data-testid="accounts-import-input"
        onChange={(e) => void onFilePicked(e.target.files?.[0])}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {global && mine.length === 0 && global.sharedWithMe.length === 0 ? (
          <EmptyState
            testId="accounts-empty"
            icon="bank-outline"
            text={t('acct.emptyList')}
            action={
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <Icon name="plus" size={16} />
                  {t('acct.addAccount')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                  <Icon name="file-upload-outline" size={16} />
                  {t('import.statement')}
                </Button>
              </div>
            }
          />
        ) : (
          <>
            <AccountSection title={t('acct.assets')} list={assets} lang={lang} onOpen={openEntry} />
            <AccountSection title={t('acct.liabilities')} list={liabilities} lang={lang} onOpen={openEntry} />
            <SharedWithMeSection list={global?.sharedWithMe ?? []} lang={lang} />
          </>
        )}
      </div>

      {/* attach one of my feed accounts to/from my spaces */}
      <AttachSheet
        open={!!attaching}
        onOpenChange={(open) => !open && setAttaching(null)}
        entry={attaching}
        canEdit={!!attaching && !global?.sharedWithMe.includes(attaching)}
      />

      {/* Add account: type grid, then form */}
      <Sheet open={addOpen} onOpenChange={(open) => !open && closeAdd()} title={newType ? t('acct.addAccount') : t('acct.selectType')} size="tall">
        {newType ? (
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
        ) : (
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
        )}
      </Sheet>

      <BankConnectSheet open={connectOpen} onOpenChange={setConnectOpen} />
      <BrandIconPicker
        open={editLogoOpen}
        onOpenChange={setEditLogoOpen}
        initialQuery={editing?.name ?? ''}
        onPick={({ logo }) => {
          if (editing) {
            void repo.upsert('account', spaceId, editing.id, { logo: logo ?? (null as never) });
            setEditing({ ...editing, logo: logo ?? undefined });
          }
          setEditLogoOpen(false);
        }}
      />

      {/* CAMT.053 import: preview then result */}
      <Sheet open={importPreview !== null} onOpenChange={(open) => !open && closeImport()} title={t('import.preview')} size="form">
        {importError && (
          <div className="flex items-center gap-2 rounded-card bg-negative-soft px-4 py-3 text-[14px] text-negative" data-testid="import-error">
            <Icon name="alert-circle-outline" size={18} />
            {t('import.invalidFile')}
          </div>
        )}
        {!importError && !importResult && (
          <div className="flex flex-col gap-3 pt-1" data-testid="import-preview">
            {(importPreview ?? []).map((stmt, i) => {
              const iban = stmt.iban.replace(/\s/g, '').toUpperCase();
              const match = mine.find((e) => e.account.iban?.replace(/\s/g, '').toUpperCase() === iban)?.account;
              return (
                // key by index: monthly exports repeat the same IBAN per statement
                <div key={`${stmt.iban}-${i}`} className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3">
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
      <Sheet open={!!editing} onOpenChange={(open) => !open && setEditing(null)} title={t('acct.editAccount')} size="form">
        <div className="flex flex-col gap-3 pt-1">
          <input
            data-testid="acctedit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none"
          />
          <input
            data-testid="acctedit-balance"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
            inputMode="decimal"
            placeholder={`${t('acct.balanceNow')} (${editing?.currency ?? 'EUR'})`}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
          />
          <button
            data-testid="acctedit-change-icon"
            onClick={() => setEditLogoOpen(true)}
            className="m-tap flex w-full items-center gap-3 rounded-input border border-line bg-surface px-4 py-3 text-left text-[15px] text-ink"
          >
            {editing?.logo ? (
              <img src={editing.logo} alt="" className="h-6 w-6 rounded object-contain" />
            ) : (
              <Icon name={editing ? typeDef(editing.type).icon : 'bank-outline'} size={20} color="var(--m-ink-3)" />
            )}
            <span className="flex-1">{t('acct.changeIcon')}</span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
          {editing && (
            <div className="flex items-center justify-between px-1 text-[12px]" data-testid="acctedit-source">
              <span className="text-ink-4">{t('acct.source')}</span>
              <span className="text-ink-2">{t(SOURCE_KEYS[editing.source])}</span>
            </div>
          )}
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
