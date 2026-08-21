import { useEffect, useMemo, useState } from 'react';
import { useGlobalAccounts } from '@/application/accounts';
import type { GlobalAccount, SpaceScopedAccounts } from '@/application/accounts';
import { getApiCapabilities } from '@/lib/api';
import { useSession } from '@/app/session';
import { linkAllCounterparties } from '@/application/counterLink';
import { applyTitleMemory } from '@/application/titleMemory';
import { linkPaypalFunding } from '@/application/paypalLink';
import { fetchMyFeedIds } from './feedGateway';
import { AttachSheet } from './AttachSheet';
import { EditAccountSheet } from './EditAccountSheet';
import { ReconcileSheet } from './ReconcileSheet';
import { StatementImportFlow } from './StatementImportFlow';
import { normalizeIban } from '@/domain/feedIds';
import { takeAccountOpenHandoff } from './openHandoff';
import { useQuery } from '@/db/useQuery';
import { AddAccountChooser } from './AddAccountChooser';
import { BankConnectSheet } from './BankConnect';
import { institutionLogoUrl } from './useInstitutionLogos';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { fmtCents } from '@/lib/money';
import { fmtTimeAgo } from '@/lib/text';
import type { AccountRow } from '@/db/types';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
import { Icon } from '@/ui/Icon';

import { typeDef } from './accountTypes';

/** whole days between a yyyy-mm-dd date and now; 0 when absent */
const daysSince = (date?: string | null): number =>
  date ? Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000) : 0;

/** #227 r2: matches the m-row-flash animation in styles.css */
const FLASH_MS = 1600;
const flashTimers = new WeakMap<HTMLElement, number>();

/** #227 r2: the echo's jump scrolls to the real row AND pulses it —
 *  on a long list the smooth scroll alone left the eye searching */
function flashJumpTarget(accountId: string): void {
  const target = document.getElementById(`acct-row-${accountId}`);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const pending = flashTimers.get(target);
  if (pending !== undefined) window.clearTimeout(pending);
  delete target.dataset.flash;
  // reflow restarts the CSS animation on a re-tap mid-pulse
  void target.offsetWidth;
  target.dataset.flash = '1';
  flashTimers.set(
    target,
    window.setTimeout(() => {
      delete target.dataset.flash;
    }, FLASH_MS),
  );
}

function AccountRowButton({
  entry,
  lang,
  showType,
  onOpen,
}: {
  entry: GlobalAccount;
  lang: ReturnType<typeof useLang>['lang'];
  /** #212 r2: only SPACE-owned rows name a type — a global account is
   *  just an account; each space gives it its own reading at attach */
  showType?: boolean;
  onOpen: (entry: GlobalAccount) => void;
}) {
  const { t } = useLang();
  const { account, feedSpaceId, sharedVia } = entry;
  // the user's own pick wins over the institution logo (user request)
  const bankLogo = account.logo ?? institutionLogoUrl(account.bankId);
  const active = sharedVia.filter((v) => !v.archived);
  const archivedOnly = sharedVia.length > 0 && active.length === 0;
  // #248 (user): no auto-attach nag — the unattached state is a quiet
  // per-row badge instead (rendered below)
  const unattached = sharedVia.length === 0;
  return (
    <button
      data-testid={`account-row-${account.id}`}
      onClick={() => onOpen(entry)}
      className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left"
    >
      {/* #212: the TYPE icon rides as a corner badge when a bank logo
          owns the tile — space-owned rows only (r2) */}
      <span className="relative shrink-0">
        {bankLogo ? (
          <img
            src={bankLogo}
            alt=""
            className="h-7 w-7 rounded-lg object-contain"
            loading="lazy"
            data-testid={`account-logo-${account.id}`}
            onError={(e) => {
              e.currentTarget.style.display = 'none';
              e.currentTarget.nextElementSibling?.classList.remove('hidden');
            }}
          />
        ) : null}
        <span className={bankLogo ? 'hidden' : ''}>
          <Icon
            name={showType ? typeDef(account.type).icon : 'bank-outline'}
            size={22}
            color={account.color ?? 'var(--m-ink-3)'}
          />
        </span>
        {bankLogo && showType && (
          <span
            data-testid={`account-typebadge-${account.id}`}
            className="absolute -right-1.5 -bottom-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-bg-2 ring-2 ring-surface"
          >
            <Icon name={typeDef(account.type).icon} size={10} color="var(--m-ink-2)" />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] text-ink">{account.name}</span>
        {showType && (
          <span className="block truncate text-[11px] text-ink-4" data-testid={`account-type-${account.id}`}>
            {t(typeDef(account.type).labelKey)}
          </span>
        )}
        {/* #227: the "via space x, y" story moved into each space's own
            section (echo rows) — the top rows say the IBAN instead */}
        {feedSpaceId && unattached && (
          <span className="block truncate text-[11px] text-ink-4" data-testid={`account-via-${account.id}`}>
            <span
              className="inline-block rounded bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold text-ink-2"
              data-testid={`account-unattached-${account.id}`}
            >
              {t('acct.notAttached')}
            </span>
          </span>
        )}
        {feedSpaceId && archivedOnly && (
          <span className="block truncate text-[11px] text-ink-4" data-testid={`account-via-${account.id}`}>
            {t('acct.archivedEverywhere')}
          </span>
        )}
        {feedSpaceId && active.length > 0 && account.iban && (
          <span className="block truncate font-mono text-[11px] text-ink-4 select-text" data-testid={`account-via-${account.id}`}>
            {account.iban}
          </span>
        )}
        {!feedSpaceId && account.iban && (
          <span className="block truncate font-mono text-[11px] text-ink-4 select-text">{account.iban}</span>
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
        {/* #240 r3: "synced fine, zero rows" must say so — an empty
            answer from the bank is a fact, not a healthy silence */}
        {account.source === 'gocardless' && account.lastFetchReceived === 0 && (
          <span className="block truncate text-[11px] text-warning" data-testid={`account-syncempty-${account.id}`}>
            {t('acct.syncEmpty')}
          </span>
        )}
        {(account.lastFetchDropped ?? 0) > 0 && (
          <span className="block truncate text-[11px] text-warning" data-testid={`account-syncdropped-${account.id}`}>
            {t('acct.syncDropped', { n: account.lastFetchDropped ?? 0 })}
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
  showType,
  onOpen,
}: {
  title: string;
  list: GlobalAccount[];
  lang: ReturnType<typeof useLang>['lang'];
  showType?: boolean;
  onOpen: (entry: GlobalAccount) => void;
}) {
  if (list.length === 0) return null;
  return (
    <>
      <div className="m-cap mt-5 mb-1 px-1">{title}</div>
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {list.map((entry, i) => (
          // the DOM id is the echo rows' jump target (#227)
          <div key={entry.account.id} id={`acct-row-${entry.account.id}`}>
            {i > 0 && <div className="mx-4 h-px bg-line-2" />}
            <AccountRowButton entry={entry} lang={lang} showType={showType} onOpen={onOpen} />
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
          // #227: no "via space x, y" — who shared it, plus the IBAN
          const subtitle = [first?.attachedByName, account.iban].filter(Boolean).join(' · ');
          return (
            <div key={account.id} id={`acct-row-${account.id}`}>
              {i > 0 && <div className="mx-4 h-px bg-line-2" />}
              <div className="flex items-center gap-3 px-4 py-3.5" data-testid={`shared-account-${account.id}`}>
                {/* #212 r2: no type at the global level — plain bank tile */}
                <Icon name="bank-outline" size={22} color="var(--m-ink-3)" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-ink">{account.name}</span>
                  {subtitle && <span className="block truncate text-[11px] text-ink-4">{subtitle}</span>}
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

/** #227: an inert mirror of a bank-fed account inside the space that
 *  sees it — tapping jumps up to the REAL row, which lives in the top
 *  section (the screen's scroller owns the smooth scroll) */
function EchoRow({
  spaceId,
  entry,
  lang,
}: {
  spaceId: string;
  entry: GlobalAccount;
  lang: ReturnType<typeof useLang>['lang'];
}) {
  const { t } = useLang();
  const { account } = entry;
  return (
    <button
      data-testid={`account-echo-${spaceId}-${account.id}`}
      onClick={() => flashJumpTarget(account.id)}
      className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left opacity-60"
    >
      <Icon name="bank-outline" size={22} color="var(--m-ink-3)" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] text-ink">{account.name}</span>
        <span className="block truncate text-[11px] text-ink-4">{t('acct.echoHint')}</span>
      </span>
      <span className="m-num text-[15px] font-semibold text-ink">
        {fmtCents(account.balanceCents, account.currency, lang)}
      </span>
    </button>
  );
}

/** #227: one space's section — real rows first, bank-fed echoes next,
 *  and the default pots folded behind a quiet toggle (closed by default:
 *  six system rows per space drowned the accounts people actually made) */
function SpaceSection({
  segment,
  echoes,
  lang,
  onOpen,
}: {
  segment: SpaceScopedAccounts;
  echoes: GlobalAccount[];
  lang: ReturnType<typeof useLang>['lang'];
  onOpen: (entry: GlobalAccount) => void;
}) {
  const { t } = useLang();
  const [showDefaults, setShowDefaults] = useState(false);
  const visible = segment.accounts.filter((e) => !e.account.archived);
  const regular = visible.filter((e) => !e.account.defaultFor);
  const defaults = visible.filter((e) => !!e.account.defaultFor);
  if (visible.length === 0 && echoes.length === 0) return null;
  const aboveEchoes = regular.length > 0;
  const aboveToggle = aboveEchoes || echoes.length > 0;
  return (
    <div data-testid={`accounts-space-${segment.spaceId}`}>
      <div className="m-cap mt-5 mb-1 px-1">{`${segment.spaceName} · ${t('acct.spaceScopedCap')}`}</div>
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {regular.map((entry, i) => (
          <div key={entry.account.id} id={`acct-row-${entry.account.id}`}>
            {i > 0 && <div className="mx-4 h-px bg-line-2" />}
            <AccountRowButton entry={entry} lang={lang} showType onOpen={onOpen} />
          </div>
        ))}
        {echoes.map((entry, i) => (
          <div key={entry.account.id}>
            {(aboveEchoes || i > 0) && <div className="mx-4 h-px bg-line-2" />}
            <EchoRow spaceId={segment.spaceId} entry={entry} lang={lang} />
          </div>
        ))}
        {defaults.length > 0 && (
          <>
            {aboveToggle && <div className="mx-4 h-px bg-line-2" />}
            <button
              data-testid={`accounts-defaults-toggle-${segment.spaceId}`}
              onClick={() => setShowDefaults((v) => !v)}
              className="m-tap flex w-full items-center gap-2 border-none bg-transparent px-4 py-3 text-left text-[12px] font-medium text-ink-4"
            >
              <Icon name={showDefaults ? 'chevron-up' : 'chevron-down'} size={14} />
              {showDefaults ? t('acct.hideDefaults') : t('acct.showDefaults', { n: defaults.length })}
            </button>
            {showDefaults &&
              defaults.map((entry) => (
                <div key={entry.account.id} id={`acct-row-${entry.account.id}`}>
                  <div className="mx-4 h-px bg-line-2" />
                  <AccountRowButton entry={entry} lang={lang} showType onOpen={onOpen} />
                </div>
              ))}
          </>
        )}
      </div>
    </div>
  );
}

export function AccountsScreen() {
  const { t, lang } = useLang();
  const { store, repo, spaceId } = useData();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<AccountRow | null>(null);
  // the whole import journey lives in StatementImportFlow (extracted
  // 2026-08-01); this screen only opens its format-pick sheet
  const [importOpen, setImportOpen] = useState(false);
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

  // GLOBAL overview (user decision): every account I own across all my
  // spaces and feeds, plus what others share with me via shared spaces
  const global = useGlobalAccounts(myFeedIds);
  const mine = useMemo(() => (global?.mine ?? []).filter((e) => !e.account.archived), [global]);
  // #227: bank-fed accounts echo (inert) inside each space they feed
  const echoPool = useMemo(() => [...mine, ...(global?.sharedWithMe ?? [])], [mine, global]);
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

  const openEntry = (entry: GlobalAccount) => {
    if (entry.feedSpaceId) setAttaching(entry); // bank feed: manage attachments
    else setEditing(entry.account); // manual/legacy row: EditAccountSheet
  };

  // #239 r2 (user): arriving from a space's info sheet with a target —
  // open that account's sheet the moment the list knows it
  const [openTarget, setOpenTarget] = useState<string | null>(() => takeAccountOpenHandoff());
  useEffect(() => {
    if (!openTarget || !global) return;
    const entry = [...global.mine, ...global.sharedWithMe, ...global.spaceScoped.flatMap((s) => s.accounts)].find(
      (e) => e.account.id === openTarget,
    );
    if (!entry) return;
    setOpenTarget(null);
    openEntry(entry);
    // openEntry is stable in behavior; the effect keys on data arrival
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTarget, global]);

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
              onClick={() => setImportOpen(true)}
            >
              <Icon name="file-upload-outline" size={21} />
            </IconButton>
            <IconButton label={t('acct.addAccount')} testId="accounts-add" onClick={() => setAddOpen(true)}>
              <Icon name="plus" size={22} />
            </IconButton>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {/* #248 (user): the green auto-attach offer is gone — each
            unattached account wears its own quiet badge instead */}
        {global && mine.length === 0 && global.sharedWithMe.length === 0 && global.spaceScoped.length === 0 ? (
          <EmptyState
            testId="accounts-empty"
            icon="bank-outline"
            text={t('acct.emptyList')}
            action={
              // stacked (user ss 2026-08-01): side by side the two
              // wrapped into ragged two-line pills
              <div className="flex w-full max-w-[280px] flex-col gap-2">
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <Icon name="plus" size={16} />
                  {t('acct.addAccount')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
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
                live inside their space and list under it below.
                #212 r2: one plain section — a global account has no
                type of its own, so no assets/liabilities split here */}
            <AccountSection title={t('acct.globalCap')} list={mine} lang={lang} onOpen={openEntry} />
            <SharedWithMeSection list={global?.sharedWithMe ?? []} lang={lang} />
            {(global?.spaceScoped ?? []).map((segment) => (
              <SpaceSection
                key={segment.spaceId}
                segment={segment}
                echoes={echoPool.filter((e) => e.sharedVia.some((v) => v.spaceId === segment.spaceId && !v.archived))}
                lang={lang}
                onOpen={openEntry}
              />
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

      {/* the extracted import journey: format pick → preview → result */}
      <StatementImportFlow
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => void fetchMyFeedIds().then(setMyFeedIds).catch(() => undefined)}
      />

      {/* AE1: the ONE Add-account chooser (intent-routed). Manual is a
          DOOR here: this screen is the global overview, and manual
          accounts live inside a space (user ruling 2026-07-28) */}
      <AddAccountChooser
        open={addOpen}
        onOpenChange={setAddOpen}
        gcAvailable={gcAvailable}
        hideManual
        onConnect={() => setConnectOpen(true)}
        onImport={() => setImportOpen(true)}
      />

      <BankConnectSheet open={connectOpen} onOpenChange={setConnectOpen} />
      <ReconcileSheet open={reconcileIds !== null} onOpenChange={(next) => !next && setReconcileIds(null)} accountIds={reconcileIds ?? []} />

      <EditAccountSheet account={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
