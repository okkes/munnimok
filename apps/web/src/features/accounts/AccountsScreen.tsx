import { useEffect, useMemo, useRef, useState } from 'react';
import { useGlobalAccounts } from '@/application/accounts';
import type { GlobalAccount } from '@/application/accounts';
import { parseStatement } from '@/lib/statements/parseStatement';
import type { ParsedStatement } from '@/lib/statements/parseStatement';
import { getApiCapabilities } from '@/lib/api';
import { useSession } from '@/app/session';
import { importCamtStatements, statementCoverageEnd } from './importCamt';
import { linkAllCounterparties } from '@/application/counterLink';
import { linkTransferPairs } from '@/application/transferMatch';
import { applyTitleMemory } from '@/application/titleMemory';
import { linkPaypalFunding } from '@/application/paypalLink';
import type { ImportResult } from './importCamt';
import { apiFeedGateway, fetchMyFeedIds } from './feedGateway';
import { AttachSheet } from './AttachSheet';
import { EditAccountSheet } from './EditAccountSheet';
import { ReconcileSheet } from './ReconcileSheet';
import { normalizeIban } from '@/domain/feedIds';
import { attachFeedToSpace } from '@/application/accountAttach';
import { DEFAULT_HISTORY_MONTHS, isoMonthsAgo } from '@/features/spaces/spaceDefaults';
import { useQuery } from '@/db/useQuery';
import { AddAccountChooser } from './AddAccountChooser';
import { BankConnectSheet } from './BankConnect';
import { useInstitutionLogos } from './useInstitutionLogos';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { logActivity } from '@/application/activity';
import { fmtCents } from '@/lib/money';
import { fmtTimeAgo } from '@/lib/text';
import type { AccountRow } from '@/db/types';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

import { typeDef, isLiability } from './accountTypes';

/** whole days between a yyyy-mm-dd date and now; 0 when absent */
const daysSince = (date?: string | null): number =>
  date ? Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000) : 0;

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
          account.iban && <span className="block truncate font-mono text-[11px] text-ink-4 select-text">{account.iban}</span>
        )}
        {/* when the account last heard from its bank/statement (user request) */}
        {account.lastSyncedAt && (
          <span className="block truncate text-[11px] text-ink-4" data-testid={`account-synced-${account.id}`}>
            {t('acct.lastSynced', { when: fmtTimeAgo(account.lastSyncedAt, lang) })}
          </span>
        )}
        {/* export-vs-upload insight (user request): a recent import of an
            OLD export leaves a silent hole — say where the data ends */}
        {account.source !== 'gocardless' && daysSince(account.dataThroughDate) > 14 && (
          <span className="block truncate text-[11px] text-warning" data-testid={`account-datathrough-${account.id}`}>
            {t('acct.dataThrough', { when: fmtTimeAgo(account.dataThroughDate!, lang) })}
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
  const fileRef = useRef<HTMLInputElement>(null);
  const [importPreview, setImportPreview] = useState<ParsedStatement[] | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState(false);
  const [runFailed, setRunFailed] = useState(false);
  const [importing, setImporting] = useState(false);
  // export-steps hint per format before the file dialog (user request)
  const [importPickOpen, setImportPickOpen] = useState(false);
  const identity = useSession((s) => s.identity);

  // GoCardless accounts arrive via sync, so there is no local "account
  // created" moment to hook — reconcile whenever this screen opens
  // instead (idempotent; rows with links are skipped)
  useEffect(() => {
    void linkAllCounterparties(store, repo, spaceId).catch(() => undefined);
    void linkPaypalFunding(store, repo, spaceId).catch(() => undefined);
    void applyTitleMemory(store, repo, spaceId).catch(() => undefined);
  }, [store, repo, spaceId]);
  const [gcAvailable, setGcAvailable] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [myFeedIds, setMyFeedIds] = useState<ReadonlySet<string> | undefined>(undefined);
  const [attaching, setAttaching] = useState<GlobalAccount | null>(null);

  useEffect(() => {
    if (identity?.kind !== 'user') return;
    void getApiCapabilities().then((caps) => setGcAvailable(caps.gocardless));
    // ownership source of truth for the global overview (offline: the
    // undefined set classifies every local feed as mine, which is right
    // for a single-user device until the fetch lands)
    void fetchMyFeedIds().then(setMyFeedIds).catch(() => undefined);
  }, [identity?.kind]);

  const onFilePicked = async (files: FileList | null) => {
    const picked = [...(files ?? [])];
    if (picked.length === 0) return;
    setImportError(false);
    setImportResult(null);
    try {
      // several exports in one go (user request): parse each file and
      // pool the statements — dedupe refs make overlaps import cleanly
      const statements: ParsedStatement[] = [];
      for (const file of picked) {
        statements.push(...parseStatement(await file.text(), file.name));
      }
      setImportPreview(statements);
    } catch {
      setImportPreview(null);
      setImportError(true);
      setImportPreview([]); // open the sheet to show the error
    }
  };

  const runImport = async () => {
    if (!importPreview?.length || importing) return; // double-taps fired PARALLEL imports (user report 2026-07-25)
    setImporting(true);
    // syncing identities import into feed spaces (shared-accounts model);
    // demo/offline keep everything merged in the current space
    const feeds = identity?.kind === 'user' ? apiFeedGateway(identity.sub) : undefined;
    try {
      setImportResult(await importCamtStatements(repo, store, spaceId, importPreview, feeds));
    } catch {
      // a failed run (feed registration, server away) must SAY so —
      // a silently unchanged screen reads as "the app is broken"
      // (user report 2026-07-24); the preview stays for a retry
      setRunFailed(true);
      return;
    } finally {
      setImporting(false);
    }
    setRunFailed(false);
    void logActivity(store, repo, spaceId, 'importRun', `${importPreview.length}`);
    // a just-imported account may BE the counterparty of older rows
    // (and vice versa) — retro-link them (user rule)
    await linkAllCounterparties(store, repo, spaceId).catch(() => undefined);
    await linkPaypalFunding(store, repo, spaceId).catch(() => undefined);
    await linkTransferPairs(store, repo).catch(() => undefined);
    await applyTitleMemory(store, repo, spaceId).catch(() => undefined);
    // the import may have registered new feeds — refresh ownership so the
    // new accounts classify under MINE, not "shared with me"
    if (feeds) void fetchMyFeedIds().then(setMyFeedIds).catch(() => undefined);
  };

  const closeImport = () => {
    setRunFailed(false);
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
  // reconcile pairing spans BOTH pools: a manual/imported row inside a
  // space can be the twin of a global bank connection
  const suggestionPool = useMemo(
    () => [...mine, ...(global?.spaceScoped ?? []).flatMap((s) => s.accounts).filter((e) => !e.account.archived)],
    [mine, global],
  );

  // master plan (answer 3, auto-suggest): an account fed by BOTH a bank
  // connection and statement uploads — or a same-IBAN pair of a linked
  // and an imported account — offers a reconcile pass (linked = truth)
  const sourcesByAccount = useQuery(store, async () => {
    const { isImportedRow, isLinkedRow } = await import('@/domain/reconcile');
    const byAccount = new Map<string, { linked: boolean; imported: number }>();
    for (const tx of await store.allRows('transaction')) {
      if (tx.deleted !== 0 || !tx.importRef) continue;
      const entry = byAccount.get(tx.accountId) ?? { linked: false, imported: 0 };
      if (isLinkedRow(tx)) entry.linked = true;
      else if (isImportedRow(tx)) entry.imported++;
      byAccount.set(tx.accountId, entry);
    }
    return byAccount;
  }, []);
  const [reconcileIds, setReconcileIds] = useState<string[] | null>(null);
  const reconcileSuggestions = useMemo(() => {
    if (!sourcesByAccount) return [];
    const out: { name: string; imported: number; accountIds: string[] }[] = [];
    const claimed = new Set<string>();
    for (const entry of suggestionPool) {
      const own = sourcesByAccount.get(entry.account.id);
      if (own?.linked && own.imported > 0) {
        out.push({ name: entry.account.name, imported: own.imported, accountIds: [entry.account.id] });
        claimed.add(entry.account.id);
        continue;
      }
      // same-IBAN pair: this imported account has a linked twin
      if (!own?.imported || !entry.account.iban || claimed.has(entry.account.id)) continue;
      const iban = normalizeIban(entry.account.iban);
      const twin = suggestionPool.find(
        (other) =>
          other.account.id !== entry.account.id &&
          !!other.account.iban &&
          normalizeIban(other.account.iban) === iban &&
          sourcesByAccount.get(other.account.id)?.linked,
      );
      if (twin) {
        out.push({ name: twin.account.name, imported: own.imported, accountIds: [twin.account.id, entry.account.id] });
        claimed.add(entry.account.id);
        claimed.add(twin.account.id);
      }
    }
    return out;
  }, [suggestionPool, sourcesByAccount]);

  // AE2: feed accounts attached to NO space (fresh bank connect, or a
  // consent flow that broke mid-return) get a one-tap attach offer for
  // the active space — the user never hunts for the attach button for
  // the account they literally just created
  const activeSpace = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const offerDismissed = useQuery(
    store,
    async () => ((await store.metaGet('attachOfferDismissed'))?.value as string[] | undefined) ?? [],
    [],
  );
  const unattached = useMemo(
    () =>
      mine.flatMap((e) =>
        e.feedSpaceId && !e.sharedVia.some((v) => !v.archived) && !(offerDismissed ?? []).includes(e.account.id)
          ? [{ accountId: e.account.id, feedSpaceId: e.feedSpaceId }]
          : [],
      ),
    [mine, offerDismissed],
  );
  const acceptAttachOffer = async () => {
    const historyFrom = activeSpace?.historyStartDate ?? isoMonthsAgo(DEFAULT_HISTORY_MONTHS);
    for (const entry of unattached) {
      await attachFeedToSpace(store, repo, spaceId, entry.feedSpaceId, entry.accountId, historyFrom).catch(() => undefined);
    }
  };
  const dismissAttachOffer = async () => {
    await store.metaPut('attachOfferDismissed', [...(offerDismissed ?? []), ...unattached.map((e) => e.accountId)]);
  };

  const openEntry = (entry: GlobalAccount) => {
    if (entry.feedSpaceId) setAttaching(entry); // bank feed: manage attachments
    else setEditing(entry.account); // manual/legacy row: EditAccountSheet
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
              onClick={() => setImportPickOpen(true)}
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
        multiple
        hidden
        data-testid="accounts-import-input"
        onChange={(e) => void onFilePicked(e.target.files)}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {identity?.kind === 'user' && unattached.length > 0 && activeSpace && (
          <div className="mt-3 rounded-card border border-accent/40 bg-accent-soft px-4 py-3" data-testid="attach-offer">
            <p className="text-[13px] font-medium text-ink">{t('acct.attachOfferTitle', { n: unattached.length })}</p>
            <p className="mt-0.5 text-[12px] text-ink-2">{t('acct.attachOfferBody', { space: activeSpace.name })}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" data-testid="attach-offer-accept" onClick={() => void acceptAttachOffer()}>
                {t('acct.attachOfferAccept', { space: activeSpace.name })}
              </Button>
              <Button size="sm" variant="outline" data-testid="attach-offer-dismiss" onClick={() => void dismissAttachOffer()}>
                {t('acct.attachOfferLater')}
              </Button>
            </div>
          </div>
        )}
        {global && mine.length === 0 && global.sharedWithMe.length === 0 && global.spaceScoped.length === 0 ? (
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
            {reconcileSuggestions.map((suggestion) => (
              <button
                key={suggestion.accountIds.join('+')}
                data-testid={`account-reconcile-${suggestion.accountIds[suggestion.accountIds.length - 1]}`}
                onClick={() => setReconcileIds(suggestion.accountIds)}
                className="m-tap mb-2 flex w-full items-center gap-2.5 rounded-card border border-accent bg-accent-soft px-4 py-3 text-left text-[13px] font-medium text-accent-deep"
              >
                <Icon name="bank-check" size={18} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{suggestion.name}</span>
                  <span className="block text-[11px] font-normal">{t('reconcile.suggest', { n: suggestion.imported })}</span>
                </span>
                <Icon name="chevron-right" size={16} />
              </button>
            ))}
            {/* GLOBAL first (user ruling 2026-07-28): bank connections
                and statement imports are user-level; manual accounts
                live inside their space and list under it below */}
            <AccountSection title={t('acct.assets')} list={assets} lang={lang} onOpen={openEntry} />
            <AccountSection title={t('acct.liabilities')} list={liabilities} lang={lang} onOpen={openEntry} />
            <SharedWithMeSection list={global?.sharedWithMe ?? []} lang={lang} />
            {(global?.spaceScoped ?? []).map((segment) => (
              <div key={segment.spaceId} data-testid={`accounts-space-${segment.spaceId}`}>
                <AccountSection
                  title={`${segment.spaceName} · ${t('acct.spaceScopedCap')}`}
                  list={segment.accounts.filter((e) => !e.account.archived)}
                  lang={lang}
                  onOpen={openEntry}
                />
              </div>
            ))}
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

      {/* which export is this? each row explains how to get the file */}
      <Sheet open={importPickOpen} onOpenChange={setImportPickOpen} title={t('import.pickFormat')} size="form">
        <div className="flex flex-col gap-2 pt-1" data-testid="import-format-pick">
          {(
            [
              ['import-format-camt', 'file-xml-box', 'import.formatCamt', 'import.formatCamtSub'],
              ['import-format-ing', 'file-delimited-outline', 'import.formatIng', 'import.formatIngSub'],
            ] as const
          ).map(([testId, icon, titleKey, subKey]) => (
            <button
              key={testId}
              data-testid={testId}
              onClick={() => {
                setImportPickOpen(false);
                fileRef.current?.click();
              }}
              className="m-tap flex items-start gap-3 rounded-card border border-line bg-surface p-4 text-left"
            >
              <Icon name={icon} size={22} color="var(--m-accent)" />
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold text-ink">{t(titleKey)}</span>
                <span className="block pt-0.5 text-[12px] leading-snug text-ink-3">{t(subKey)}</span>
              </span>
            </button>
          ))}
        </div>
      </Sheet>

      {/* AE1: the ONE Add-account chooser (intent-routed). Manual is a
          DOOR here: this screen is the global overview, and manual
          accounts live inside a space (user ruling 2026-07-28) */}
      <AddAccountChooser
        open={addOpen}
        onOpenChange={setAddOpen}
        gcAvailable={gcAvailable}
        hideManual
        onConnect={() => setConnectOpen(true)}
        onImport={() => setImportPickOpen(true)}
      />

      <BankConnectSheet open={connectOpen} onOpenChange={setConnectOpen} />
      <ReconcileSheet open={reconcileIds !== null} onOpenChange={(next) => !next && setReconcileIds(null)} accountIds={reconcileIds ?? []} />

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
            {runFailed && (
              <div className="flex items-center gap-2 rounded-card bg-negative-soft px-4 py-3 text-[14px] text-negative" data-testid="import-run-error">
                <Icon name="alert-circle-outline" size={18} />
                {t('import.runFailed')}
              </div>
            )}
            {(importPreview ?? []).map((stmt, i) => {
              const iban = stmt.iban.replace(/\s/g, '').toUpperCase();
              // IBAN matching spans BOTH pools — an existing manual
              // account (space-scoped) is a match exactly like a feed
              const match = suggestionPool.find((e) => e.account.iban?.replace(/\s/g, '').toUpperCase() === iban)?.account;
              return (
                // key by index: monthly exports repeat the same IBAN per statement
                <div key={`${stmt.iban}-${i}`} className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3">
                  <Icon name={match ? 'bank-check' : 'bank-plus'} size={22} color="var(--m-accent)" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-ink">
                      {match?.name ?? t('import.newAccount')}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-ink-4">{stmt.iban}</span>
                    {/* export-vs-upload insight: an old export imports
                        fine and silently misses everything after it —
                        warn BEFORE the import, when a fresh export is
                        one download away */}
                    {(() => {
                      const through = statementCoverageEnd(stmt);
                      if (!through) return null;
                      const stale = daysSince(through) > 7;
                      return (
                        <span
                          className={`block truncate text-[11px] ${stale ? 'text-warning' : 'text-ink-4'}`}
                          data-testid={`import-through-${i}`}
                        >
                          {t(stale ? 'import.throughStale' : 'import.through', { when: fmtTimeAgo(through, lang) })}
                        </span>
                      );
                    })()}
                    {/* rows before the space's start import fine — say
                        NOW that they will sit stored-but-hidden (arc 5) */}
                    {(() => {
                      const start = activeSpace?.historyStartDate;
                      const preStart = start ? stmt.entries.filter((e) => e.date < start).length : 0;
                      if (preStart === 0) return null;
                      return (
                        <span className="block truncate text-[11px] text-ink-4" data-testid={`import-prestart-${i}`}>
                          {t('import.preStart', { n: preStart })}
                        </span>
                      );
                    })()}
                  </span>
                  <span className="text-[12px] text-ink-3">
                    {stmt.entries.length === 1
                      ? t('import.txCountOne')
                      : t('import.txCount', { n: stmt.entries.length })}
                  </span>
                </div>
              );
            })}
            <Button data-testid="import-run" onClick={() => void runImport()} disabled={!importPreview?.length || importing}>
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
            {(() => {
              const start = activeSpace?.historyStartDate;
              const preStart = start
                ? (importPreview ?? []).reduce((sum, stmt) => sum + stmt.entries.filter((e) => e.date < start).length, 0)
                : 0;
              if (preStart === 0) return null;
              return (
                <p className="text-[12px] text-ink-4" data-testid="import-result-prestart">
                  {t('import.preStart', { n: preStart })}
                </p>
              );
            })()}
            <Button variant="outline" data-testid="import-close" onClick={closeImport}>
              {t('action.done')}
            </Button>
          </div>
        )}
      </Sheet>

      <EditAccountSheet account={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
