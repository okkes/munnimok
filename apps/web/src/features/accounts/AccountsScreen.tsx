import { useEffect, useMemo, useState } from 'react';
import { useGlobalAccounts } from '@/application/accounts';
import type { GlobalAccount, SharedVia, SpaceScopedAccounts } from '@/application/accounts';
import { SharedSpaceBadge } from '@/features/spaces/SpaceSwitcher';
import { useSession } from '@/app/session';
import { linkAllCounterparties } from '@/application/counterLink';
import { applyTitleMemory } from '@/application/titleMemory';
import { linkPaypalFunding } from '@/application/paypalLink';
import { fetchMyFeedIds } from './feedGateway';
import { AttachSheet, fetchesItself } from './AttachSheet';
import { EditAccountSheet } from './EditAccountSheet';
import { ReconcileSheet } from './ReconcileSheet';
import { StatementImportFlow } from './StatementImportFlow';
import { normalizeIban } from '@/domain/feedIds';
import { takeAccountOpenHandoff } from './openHandoff';
import { BANK_KINDS, ConnectionHub } from '@/features/connectors/ConnectionsScreen';
import { takeCatalogueIntent } from '@/features/connectors/catalogueIntent';
import { useQuery } from '@/db/useQuery';
import { AddAccountChooser } from './AddAccountChooser';
import { institutionLogoUrl } from './useInstitutionLogos';
import { useLang } from '@/i18n';
import { SpacePicture } from '@/features/spaces/SpacePicture';
import { useData } from '@/app/data';
import { useCanEdit } from '@/app/useCanEdit';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { fmtTimeAgo } from '@/lib/text';
import type { AccountRow, SpaceRow } from '@/db/types';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
import { Icon } from '@/ui/Icon';
import { Picture } from '@/ui/Picture';
import { Sheet } from '@/ui/Sheet';

import { typeDef } from './accountTypes';

/** whole days between a yyyy-mm-dd date and now; 0 when absent */
const daysSince = (date?: string | null): number =>
  date ? Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000) : 0;

/** #227 r2: matches the m-row-flash animation in styles.css */
const FLASH_MS = 1600;
const SETTLE_POLL_MS = 100;
const SETTLE_QUIET_CHECKS = 2;
const SETTLE_MAX_MS = 1500;
const flashCleanups = new WeakMap<HTMLElement, () => void>();

function scrollAncestorOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** reflow first, so a re-tap after settle restarts the CSS animation */
function startFlashPulse(target: HTMLElement): void {
  delete target.dataset.flash;
  void target.offsetWidth;
  target.dataset.flash = '1';
  const timer = window.setTimeout(() => {
    delete target.dataset.flash;
    flashCleanups.delete(target);
  }, FLASH_MS);
  flashCleanups.set(target, () => window.clearTimeout(timer));
}

// #227: the pulse waits for the smooth scroll to settle, else it is nearly gone on arrival; a tap needing no scroll
// never fires 'scrollend', so a rect-stability poll covers it
function watchScrollSettle(target: HTMLElement, onSettled: () => void): void {
  const scroller = scrollAncestorOf(target);
  let lastTop = target.getBoundingClientRect().top;
  let quiet = 0;
  let poll = 0;
  let cap = 0;
  function teardown(): void {
    window.clearInterval(poll);
    window.clearTimeout(cap);
    window.removeEventListener('scrollend', settle);
    scroller?.removeEventListener('scrollend', settle);
  }
  function settle(): void {
    teardown();
    onSettled();
  }
  poll = window.setInterval(() => {
    const { top } = target.getBoundingClientRect();
    quiet = top === lastTop ? quiet + 1 : 0;
    lastTop = top;
    if (quiet >= SETTLE_QUIET_CHECKS) settle();
  }, SETTLE_POLL_MS);
  cap = window.setTimeout(settle, SETTLE_MAX_MS);
  window.addEventListener('scrollend', settle);
  scroller?.addEventListener('scrollend', settle);
  flashCleanups.set(target, teardown);
}

function flashJumpTarget(accountId: string): void {
  const target = document.getElementById(`acct-row-${accountId}`);
  if (!target) return;
  flashCleanups.get(target)?.();
  flashCleanups.delete(target);
  delete target.dataset.flash;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  watchScrollSettle(target, () => startFlashPulse(target));
}

function AccountRowButton({
  entry,
  lang,
  showType,
  onOpen,
}: {
  entry: GlobalAccount;
  lang: ReturnType<typeof useLang>['lang'];
  /** #212: only space-owned rows name a type; a global account gets its reading per space at attach */
  showType?: boolean;
  onOpen: (entry: GlobalAccount) => void;
}) {
  const { t } = useLang();
  const { fmtSensitive } = useDisplayMoney();
  const { account, feedSpaceId, sharedVia } = entry;
  const bankLogo = account.logo ?? institutionLogoUrl(account);
  const active = sharedVia.filter((v) => !v.archived);
  const archivedOnly = sharedVia.length > 0 && active.length === 0;
  // #248: no auto-attach nag: the unattached state is a quiet per-row badge
  const unattached = sharedVia.length === 0;
  return (
    <button
      data-testid={`account-row-${account.id}`}
      onClick={() => onOpen(entry)}
      className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left"
    >
      <span className="relative shrink-0">
        {bankLogo ? (
          <Picture
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
        {account.lastSyncedAt && (
          <span className="block truncate text-[11px] text-ink-4" data-testid={`account-synced-${account.id}`}>
            {t('acct.lastSynced', { when: fmtTimeAgo(account.lastSyncedAt, lang) })}
          </span>
        )}
        {/* a recent import of an OLD export leaves a silent hole: say where the data ends */}
        {!fetchesItself(account) && daysSince(account.dataThroughDate) > 14 && (
          <span className="block truncate text-[11px] text-warning" data-testid={`account-datathrough-${account.id}`}>
            {t('acct.dataThrough', { when: fmtTimeAgo(account.dataThroughDate!, lang) })}
          </span>
        )}
        {/* #240: an empty answer from the bank is a fact: "synced, zero rows" must say so */}
        {fetchesItself(account) && account.lastFetchReceived === 0 && (
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
        {fmtSensitive(account.balanceCents, account.currency, { asRecorded: true })}
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

interface EchoEntry {
  entry: GlobalAccount;
  via: SharedVia;
}

function SpaceAvatar({ space }: Readonly<{ space?: SpaceRow }>) {
  if (space?.picture) {
    return <SpacePicture space={space} className="h-6 w-6" />;
  }
  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
      style={{
        background: `color-mix(in srgb, ${space?.color ?? 'var(--m-ink-4)'} 14%, transparent)`,
        color: space?.color ?? 'var(--m-ink-3)',
      }}
    >
      <Icon name={space?.icon ?? (space?.kind === 'shared' ? 'account-group-outline' : 'leaf')} size={14} />
    </span>
  );
}

/** #305: read-only story of an account shared into a space: no rename, detach or delete (not the consumer's to manage) */
function SharedAccountSheet({
  info,
  onClose,
  lang,
}: {
  info: EchoEntry | null;
  onClose: () => void;
  lang: ReturnType<typeof useLang>['lang'];
}) {
  const { t } = useLang();
  const { fmtSensitive } = useDisplayMoney();
  const account = info?.entry.account;
  const bankLogo = account ? (account.logo ?? institutionLogoUrl(account)) : undefined;
  return (
    <Sheet open={info !== null} onOpenChange={(next) => !next && onClose()} title={account?.name} size="form">
      {info && account && (
        <div className="flex flex-col gap-3 pt-1" data-testid="shared-account-info">
          <div className="flex items-center gap-2.5">
            {bankLogo ? (
              <Picture src={bankLogo} className="h-7 w-7 rounded-lg object-contain" data-testid="shared-info-logo" />
            ) : (
              <Icon name="bank-outline" size={22} color="var(--m-ink-3)" />
            )}
            <SharedSpaceBadge testId="shared-info-badge" />
          </div>
          <p className="px-1 text-[13px] leading-snug text-ink-3" data-testid="shared-info-readonly">
            {t('acct.sharedReadOnly')}
          </p>
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            {[
              account.iban ? ([t('accounts.ibanLabel'), account.iban] as const) : null,
              // #152: the type is the SPACE's reading of the attachment
              [t('acct.typeRow'), t(typeDef(info.via.type ?? account.type).labelKey)] as const,
              [t('acct.balanceNow'), fmtSensitive(account.balanceCents, account.currency, { asRecorded: true })] as const,
              account.dataThroughDate ? ([t('acct.dataThroughLabel'), account.dataThroughDate] as const) : null,
              account.lastSyncedAt ? ([t('acct.lastSyncedLabel'), fmtTimeAgo(account.lastSyncedAt, lang)] as const) : null,
              info.via.attachedByName ? ([t('acct.attachedBy'), info.via.attachedByName] as const) : null,
            ]
              .filter((row): row is readonly [string, string] => row !== null)
              .map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-3 border-b border-line-2 px-4 py-3 text-[13px] last:border-0">
                  <span className="text-ink-3">{label}</span>
                  <span className="min-w-0 truncate text-right font-mono text-[12px] text-ink">{value}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </Sheet>
  );
}

// #227: inert mirror of a bank-fed account, tap jumps to the real row.
// #305: for a shared account the echo is its only face
function EchoRow({
  spaceId,
  echo,
  shared,
  onOpenShared,
}: {
  spaceId: string;
  echo: EchoEntry;
  /** #305: reachable only through someone else's attachment */
  shared: boolean;
  onOpenShared: (echo: EchoEntry) => void;
}) {
  const { t } = useLang();
  const { fmtSensitive } = useDisplayMoney();
  const { account } = echo.entry;
  // #305: the owner's icon pick lives on the synced account row
  const bankLogo = account.logo ?? institutionLogoUrl(account);
  // #314: an archived share says why: its sharer stopped sharing; the link's frozen attachedByName is the only name known
  let archivedReason: string | null = null;
  if (shared && echo.via.archived) {
    archivedReason = echo.via.attachedByName
      ? t('acct.noLongerSharedBy', { name: echo.via.attachedByName })
      : t('acct.noLongerShared');
  }
  return (
    <button
      data-testid={`account-echo-${spaceId}-${account.id}`}
      onClick={() => (shared ? onOpenShared(echo) : flashJumpTarget(account.id))}
      className={`m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left${shared ? '' : ' opacity-60'}`}
    >
      <span className="shrink-0">
        {bankLogo ? (
          <Picture
            src={bankLogo}
            alt=""
            className="h-7 w-7 rounded-lg object-contain"
            loading="lazy"
            data-testid={`account-echo-logo-${account.id}`}
            onError={(e) => {
              e.currentTarget.style.display = 'none';
              e.currentTarget.nextElementSibling?.classList.remove('hidden');
            }}
          />
        ) : null}
        <span className={bankLogo ? 'hidden' : ''}>
          <Icon name="bank-outline" size={22} color="var(--m-ink-3)" />
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-[15px] text-ink">{account.name}</span>
          {shared && <SharedSpaceBadge testId={`echo-shared-${spaceId}-${account.id}`} />}
        </span>
        {archivedReason ? (
          <span
            className="block truncate text-[11px] text-warning"
            data-testid={`echo-archived-hint-${spaceId}-${account.id}`}
          >
            {archivedReason}
          </span>
        ) : (
          <span className="block truncate text-[11px] text-ink-4">{t(shared ? 'acct.sharedEchoHint' : 'acct.echoHint')}</span>
        )}
      </span>
      {echo.via.archived && (
        <span
          className="rounded bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold text-ink-2"
          data-testid={`echo-archived-${spaceId}-${account.id}`}
        >
          {t('acct.archived')}
        </span>
      )}
      <span className="m-num text-[15px] font-semibold text-ink">
        {fmtSensitive(account.balanceCents, account.currency, { asRecorded: true })}
      </span>
    </button>
  );
}

/** #314: each space is its own card, collapsed on every mount (not persisted); real rows first, bank-fed echoes next */
function SpaceSection({
  segment,
  space,
  ownName,
  echoes,
  sharedIds,
  lang,
  onOpen,
  onOpenShared,
}: {
  segment: SpaceScopedAccounts;
  space?: SpaceRow;
  /** the user's own profile name — "created by" only names OTHERS */
  ownName?: string;
  echoes: EchoEntry[];
  /** #305: accounts reaching me only through someone else's attachment */
  sharedIds: ReadonlySet<string>;
  lang: ReturnType<typeof useLang>['lang'];
  onOpen: (entry: GlobalAccount) => void;
  onOpenShared: (echo: EchoEntry) => void;
}) {
  const { t } = useLang();
  // #314 r2: closed on every mount — deliberately not persisted
  const [expanded, setExpanded] = useState(false);
  // #546: the default pots retired — the cash wallet is one of the space's accounts
  const regular = segment.accounts.filter((e) => !e.account.archived);
  const aboveEchoes = regular.length > 0;
  // #314: name the creator only when the space is someone else's work
  const creator = space?.kind === 'shared' && space.createdByName && space.createdByName !== ownName
    ? space.createdByName
    : undefined;
  return (
    <div data-testid={`accounts-space-${segment.spaceId}`} className="overflow-hidden rounded-card border border-line bg-surface">
      <button
        data-testid={`accounts-space-head-${segment.spaceId}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="m-tap flex w-full items-center gap-2.5 border-none bg-transparent px-4 py-3.5 text-left"
      >
        <SpaceAvatar space={space} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-ink">{segment.spaceName}</span>
          {creator && (
            <span className="block truncate text-[11px] text-ink-4" data-testid={`accounts-space-creator-${segment.spaceId}`}>
              {t('space.createdBy', { name: creator })}
            </span>
          )}
        </span>
        <span className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>
          <Icon name="chevron-down" size={16} color="var(--m-ink-4)" />
        </span>
      </button>
      {expanded && (
        <>
          <div className="mx-4 h-px bg-line-2" />
          {regular.map((entry, i) => (
            <div key={entry.account.id} id={`acct-row-${entry.account.id}`}>
              {i > 0 && <div className="mx-4 h-px bg-line-2" />}
              <AccountRowButton entry={entry} lang={lang} showType onOpen={onOpen} />
            </div>
          ))}
          {echoes.map((echo, i) => (
            <div key={echo.entry.account.id}>
              {(aboveEchoes || i > 0) && <div className="mx-4 h-px bg-line-2" />}
              <EchoRow
                spaceId={segment.spaceId}
                echo={echo}
                shared={sharedIds.has(echo.entry.account.id)}
                onOpenShared={onOpenShared}
              />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

interface ReconcileOffer {
  name: string;
  imported: number;
  accountIds: string[];
  merge?: { importedAccountId: string; bankAccountId: string };
}
type ReconcileOfferState = Pick<ReconcileOffer, 'accountIds' | 'merge'>;

const sectionHasContent = (
  segment: { spaceId: string; accounts: { account: { archived?: unknown } }[] },
  echoPool: { sharedVia: { spaceId: string }[] }[],
): boolean =>
  segment.accounts.some((e) => !e.account.archived) ||
  echoPool.some((entry) => entry.sharedVia.some((v) => v.spaceId === segment.spaceId));

export function AccountsScreen() {
  const { t, lang } = useLang();
  const { store, repo, spaceId } = useData();
  const [addOpen, setAddOpen] = useState(false);
  // #527: the bank picker of the bank connections below — a Connect door elsewhere arrives with it open
  const [bankPick, setBankPick] = useState(() => takeCatalogueIntent());
  const [editing, setEditing] = useState<AccountRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const identity = useSession((s) => s.identity);

  // party-fed accounts arrive via sync (no local "created" moment): reconcile whenever this screen opens (idempotent)
  const canEditActive = useCanEdit();
  useEffect(() => {
    // #505: upkeep — a space this identity only reads is reconciled by its writers
    const upkeep = repo.upkeep();
    void linkAllCounterparties(store, upkeep, spaceId).catch(() => undefined);
    void linkPaypalFunding(store, upkeep, spaceId).catch(() => undefined);
    void applyTitleMemory(store, upkeep, spaceId).catch(() => undefined);
  }, [store, repo, spaceId]);
  const [myFeedIds, setMyFeedIds] = useState<ReadonlySet<string> | undefined>(undefined);
  const [attaching, setAttaching] = useState<GlobalAccount | null>(null);

  useEffect(() => {
    if (identity?.kind !== 'user') return;
    // ownership source of truth; offline, the undefined set counts every local feed as mine, right for a single-user device
    void fetchMyFeedIds().then(setMyFeedIds).catch(() => undefined);
  }, [identity?.kind]);

  const global = useGlobalAccounts(myFeedIds);
  const mine = useMemo(() => (global?.mine ?? []).filter((e) => !e.account.archived), [global]);
  // #288: a deleted feed can leave a ghost echo from a member space; only a LIVE account row counts
  // (archived-only stays: the sharer left)
  const sharedWithMe = useMemo(
    () => (global?.sharedWithMe ?? []).filter((e) => e.account.deleted === 0),
    [global],
  );
  // #305: shared-with-me accounts live only as echoes, so the pool carries them
  const echoPool = useMemo(() => [...mine, ...sharedWithMe], [mine, sharedWithMe]);
  const sharedIds = useMemo(() => new Set(sharedWithMe.map((e) => e.account.id)), [sharedWithMe]);
  const [sharedInfo, setSharedInfo] = useState<{ entry: GlobalAccount; via: SharedVia } | null>(null);
  // #305: a space holding only others' attachments still owns a section: the shared echo needs a home
  const sections = useMemo(() => {
    const out = [...(global?.spaceScoped ?? [])];
    const known = new Set(out.map((s) => s.spaceId));
    for (const entry of echoPool) {
      for (const via of entry.sharedVia) {
        if (known.has(via.spaceId)) continue;
        known.add(via.spaceId);
        out.push({ spaceId: via.spaceId, spaceName: via.spaceName, accounts: [] });
      }
    }
    return out.sort((a, b) => a.spaceName.localeCompare(b.spaceName));
  }, [global, echoPool]);
  const echoesFor = (spaceId: string): { entry: GlobalAccount; via: SharedVia }[] =>
    echoPool.flatMap((entry) => {
      const via = entry.sharedVia.find((v) => v.spaceId === spaceId);
      return via ? [{ entry, via }] : [];
    });
  const renderableSections = useMemo(
    () => sections.filter((segment) => sectionHasContent(segment, echoPool)),
    [sections, echoPool],
  );
  const spaceRows = useQuery(store, async () => (await store.allRows('space')).filter((s) => s.deleted === 0), []);
  const spacesById = useMemo(() => new Map((spaceRows ?? []).map((s) => [s.id, s])), [spaceRows]);
  // "created by {name}" must stay quiet for the user's own spaces
  const ownName = useQuery(store, async () => ((await store.metaGet('profile'))?.value as { name?: string } | undefined)?.name, []);
  // reconcile pairing spans BOTH pools: a manual/imported row inside a
  // space can be the twin of a global bank connection
  const suggestionPool = useMemo(
    () => [...mine, ...(global?.spaceScoped ?? []).flatMap((s) => s.accounts).filter((e) => !e.account.archived)],
    [mine, global],
  );

  // an account fed by both a bank connection and statement uploads, or a same-IBAN linked+imported pair,
  // offers reconcile (linked = truth)
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
  const [reconcileOffer, setReconcileOffer] = useState<ReconcileOfferState | null>(null);
  const reconcileSuggestions = useMemo(() => {
    if (!sourcesByAccount) return [];
    const out: ReconcileOffer[] = [];
    const claimed = new Set<string>();
    for (const entry of suggestionPool) {
      const own = sourcesByAccount.get(entry.account.id);
      if (own?.linked && own.imported > 0) {
        out.push({ name: entry.account.name, imported: own.imported, accountIds: [entry.account.id] });
        claimed.add(entry.account.id);
        continue;
      }
      // #311: a same-IBAN pair stays TWO accounts: the offer is an explicit merge, never a silent adoption
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
        out.push({
          name: twin.account.name,
          imported: own.imported,
          accountIds: [twin.account.id, entry.account.id],
          merge: { importedAccountId: entry.account.id, bankAccountId: twin.account.id },
        });
        claimed.add(entry.account.id);
        claimed.add(twin.account.id);
      }
    }
    return out;
  }, [suggestionPool, sourcesByAccount]);

  const openEntry = (entry: GlobalAccount) => {
    // #305: not mine to manage: the read-only sheet opens (shared rows have no top row)
    if (sharedIds.has(entry.account.id)) {
      const via = entry.sharedVia.find((v) => !v.archived) ?? entry.sharedVia[0];
      if (via) setSharedInfo({ entry, via });
      return;
    }
    if (entry.feedSpaceId) setAttaching(entry);
    else setEditing(entry.account);
  };

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
            <IconButton label={t('acct.addAccount')} testId="accounts-add" onClick={() => setAddOpen(true)}>
              <Icon name="plus" size={22} />
            </IconButton>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {global && mine.length === 0 && sharedWithMe.length === 0 && global.spaceScoped.length === 0 ? (
          <EmptyState
            testId="accounts-empty"
            icon="bank-outline"
            text={t('acct.emptyList')}
            action={
              // stacked: side by side they wrapped into ragged two-line pills
              <div className="flex w-full max-w-[280px] flex-col gap-2">
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <Icon name="plus" size={16} />
                  {t('acct.addAccount')}
                </Button>
                {/* #505: an import lands in the active space — never one this identity only reads */}
                {canEditActive && (
                  <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                    <Icon name="file-upload-outline" size={16} />
                    {t('import.statement')}
                  </Button>
                )}
              </div>
            }
          />
        ) : (
          <>
            {reconcileSuggestions.map((suggestion) => (
              <button
                key={suggestion.accountIds.join('+')}
                data-testid={`account-reconcile-${suggestion.accountIds[suggestion.accountIds.length - 1]}`}
                onClick={() => setReconcileOffer({ accountIds: suggestion.accountIds, merge: suggestion.merge })}
                className="m-tap mb-2 flex w-full items-center gap-2.5 rounded-card border border-accent bg-accent-soft px-4 py-3 text-left text-[13px] font-medium text-accent-deep"
              >
                <Icon name={suggestion.merge ? 'source-merge' : 'bank-check'} size={18} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{suggestion.name}</span>
                  <span className="block text-[11px] font-normal">
                    {t(suggestion.merge ? 'reconcile.suggestMerge' : 'reconcile.suggest', { n: suggestion.imported })}
                  </span>
                </span>
                <Icon name="chevron-right" size={16} />
              </button>
            ))}
            {/* global first: bank connections and statement imports are user-level, manual accounts live in their space (#212) */}
            <AccountSection title={t('acct.globalCap')} list={mine} lang={lang} onOpen={openEntry} />
            {renderableSections.length > 0 && (
              <>
                <div className="m-cap mt-5 mb-1 px-1">{t('acct.inSpacesCap')}</div>
                <div className="flex flex-col gap-2" data-testid="accounts-spaces-segment">
                  {renderableSections.map((segment) => (
                    <SpaceSection
                      key={segment.spaceId}
                      segment={segment}
                      space={spacesById.get(segment.spaceId)}
                      ownName={ownName}
                      echoes={echoesFor(segment.spaceId)}
                      sharedIds={sharedIds}
                      lang={lang}
                      onOpen={openEntry}
                      onOpenShared={setSharedInfo}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
        {/* #527: the banks are connected and managed here, not under Connected services */}
        <div className="mt-2">
          <ConnectionHub kinds={BANK_KINDS} route="/accounts" picker={{ open: bankPick, onOpenChange: setBankPick }} />
        </div>
      </div>

      <AttachSheet
        open={!!attaching}
        onOpenChange={(open) => !open && setAttaching(null)}
        entry={attaching}
        canEdit={!!attaching && !global?.sharedWithMe.includes(attaching)}
      />

      <StatementImportFlow
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => void fetchMyFeedIds().then(setMyFeedIds).catch(() => undefined)}
      />

      {/* manual is a door here: manual accounts live inside a space; Connect opens this screen's bank picker (#527) */}
      <AddAccountChooser open={addOpen} onOpenChange={setAddOpen} hideManual onImport={() => setImportOpen(true)} onConnect={() => setBankPick(true)} />

      <ReconcileSheet
        open={reconcileOffer !== null}
        onOpenChange={(next) => !next && setReconcileOffer(null)}
        accountIds={reconcileOffer?.accountIds ?? []}
        merge={reconcileOffer?.merge}
      />

      <EditAccountSheet account={editing} onClose={() => setEditing(null)} />

      <SharedAccountSheet info={sharedInfo} onClose={() => setSharedInfo(null)} lang={lang} />
    </div>
  );
}
