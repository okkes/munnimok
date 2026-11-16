import { useEffect, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useNavigate, useParams, useRouter } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { attachFeedToSpace, detachFeedFromSpace } from '@/application/accountAttach';
import { newestTxDate } from '@/application/accounts';
import { logActivity } from '@/application/activity';
import { fetchMyFeedIds } from '@/features/accounts/feedGateway';
import { sourceKeyFor, sourceParamsFor } from '@/features/accounts/AttachSheet';
import { useMyFeedIds } from '@/application/connections';
import { ownsFeed } from '@/domain/accountCoverage';
import type { ReconnectNeed } from '@/domain/accountCoverage';
import { BankConnect } from '@/features/connectors/BankConnect';
import { useReconnectReader } from '@/features/connectors/useReconnect';
import { ReconnectNote } from '@/features/accounts/ReconnectNote';
import { AddAccountChooser } from '@/features/accounts/AddAccountChooser';
import { institutionLogoUrl } from '@/features/accounts/useInstitutionLogos';
import { EditAccountSheet } from '@/features/accounts/EditAccountSheet';
import { AccountTypeRow } from '@/features/accounts/AccountTypeRow';
import { ACCOUNT_TYPES, groupByAccountType, typeDef } from '@/features/accounts/accountTypes';
import { setAccountOpenHandoff, takeSpaceAttachIntent } from '@/features/accounts/openHandoff';
import { useMyRole } from './SpaceSharing';
import { ReadOnlyNote } from './ReadOnlyNote';
import { SharedSpaceBadge } from './SpaceSwitcher';
import { takeSpaceAddAccountIntent } from './spaceAccountsHandoff';
import { linkEffectiveType } from '@/db/joined';
import type { AccountLinkRow, AccountRow, AccountType } from '@/db/types';
import { fmtTimeAgo } from '@/lib/text';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { Icon } from '@/ui/Icon';
import { Picture } from '@/ui/Picture';
import { Pill } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';

interface AttachedAccountEntry {
  key: string;
  name: string;
  /** what the account is to THIS space (an attachment's type) — its segment (#550) */
  type: AccountType;
  subtitle: string;
  archived: boolean;
  /** present = a detachable feed attachment */
  detach?: { feedSpaceId: string; accountId: string };
  /** present = a space-owned manual account, editable in place */
  manual?: AccountRow;
  /** the backing account row (own or feed) — icon, IBAN, sync details */
  account?: AccountRow;
  /** the attachment row (feed entries) — provenance + history gate */
  link?: AccountLinkRow;
}

const SOURCE_ICONS: Record<AccountRow['source'], string> = {
  manual: 'pencil-outline',
  camt053: 'file-document-outline',
  connector: 'link-variant',
};

interface AttachCandidate {
  accountId: string;
  feedSpaceId: string;
  name: string;
  ibanTail?: string;
  /** #536: the bank's reported type: only the attach step's first suggestion, the space's pick decides */
  reportedType: AccountType;
}

type T = ReturnType<typeof useLang>['t'];
type Lang = ReturnType<typeof useLang>['lang'];

const ibanTail = (iban?: string) => (iban ? `…${iban.slice(-4)}` : undefined);

const syncLine = (t: T, lang: Lang, account?: AccountRow) =>
  account?.lastSyncedAt ? t('acct.lastSynced', { when: fmtTimeAgo(account.lastSyncedAt, lang) }) : undefined;

function linkProvenance(t: T, link: AccountLinkRow, mySub?: string): string | undefined {
  if (link.attachedBy && mySub === link.attachedBy) return t('acct.provMine');
  if (link.attachedByName) return t('acct.provShared', { name: link.attachedByName });
  return undefined;
}

function linkEntry(t: T, link: AccountLinkRow, account: AccountRow | undefined): AttachedAccountEntry {
  return {
    key: link.id,
    // #239: the space's own name wins here — the global one stays global
    name: link.displayName || (account?.name ?? t('acct.bank')),
    // the SPACE's type decides, and names the row's segment (#212, #550)
    type: account ? linkEffectiveType(link, account) : (link.type ?? 'checking'),
    subtitle: [
      ibanTail(account?.iban),
      account ? t(sourceKeyFor(account), sourceParamsFor(account)) : undefined,
    ]
      .filter(Boolean)
      .join(' · '),
    archived: !!link.archived,
    detach: { feedSpaceId: link.feedSpaceId, accountId: link.accountId },
    account,
    link,
  };
}

function infoFacts(t: T, lang: Lang, info: AttachedAccountEntry, mySub: string | undefined, newestTx: string | undefined): (readonly [string, string])[] {
  return [
    info.link && info.account ? ([t('acct.globalName'), info.account.name] as const) : null,
    info.account?.iban ? ([t('accounts.ibanLabel'), info.account.iban] as const) : null,
    // an absent gate says it shows the full history, not a bare dash (#177)
    info.link ? ([t('acct.historyFrom'), info.link.historyFrom ?? t('acct.historyFromAll')] as const) : null,
    info.link && linkProvenance(t, info.link, mySub) ? ([t('acct.attachedBy'), linkProvenance(t, info.link, mySub)!] as const) : null,
    syncLine(t, lang, info.account) ? ([t('acct.lastSyncedLabel'), syncLine(t, lang, info.account)!] as const) : null,
    // #205: where the data ends (imports stamp it) and the newest actual transaction are not "last synced"
    info.account?.dataThroughDate ? ([t('acct.dataThroughLabel'), info.account.dataThroughDate] as const) : null,
    [t('acct.newestTx'), newestTx ?? '—'] as const,
  ].filter((row): row is readonly [string, string] => row !== null);
}

export function SpaceAccountsScreen() {
  const { t, lang } = useLang();
  const { store, repo } = useData();
  const identity = useSession((s) => s.identity);
  const navigate = useNavigate();
  const router = useRouter();
  const { spaceId } = useParams({ strict: false }) as { spaceId: string };
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const syncing = identity?.kind === 'user';
  // #284: readers look but don't touch; the server enforces, the UI stops promising
  const myRole = useMyRole(spaceId, syncing);
  const readOnly = myRole === 'reader';

  const [attachOpen, setAttachOpen] = useState(false);
  const [picked, setPicked] = useState<AttachCandidate | null>(null);
  // #310: an attach door elsewhere forwarded here; read once at mount, resolved when the candidates load
  const [pendingAttach, setPendingAttach] = useState(() => takeSpaceAttachIntent());
  // #310: the intent named THIS account: the sheet skips the pick list and opens on the final step
  const [attachFocus, setAttachFocus] = useState(false);
  // #152: the account's type is a SPACE-level decision, made here
  const [attachType, setAttachType] = useState<AccountType>('checking');
  const [busy, setBusy] = useState(false);
  const [detachTarget, setDetachTarget] = useState<AttachedAccountEntry | null>(null);
  const [editing, setEditing] = useState<AccountRow | null>(null);
  // #179: a pending add intent opens the chooser on arrival (read once at mount)
  const [addOpen, setAddOpen] = useState(() => takeSpaceAddAccountIntent());
  const [info, setInfo] = useState<AttachedAccountEntry | null>(null);
  const infoAccountId = info?.account?.id;
  const infoNewestTx = useQuery(
    store,
    async () => (infoAccountId ? newestTxDate(store, infoAccountId) : undefined),
    [infoAccountId],
  );

  const mySub = identity?.kind === 'user' ? identity.sub : undefined;
  // #305: my own feeds come from /me/feeds; anything else was shared INTO the space and wears the shared badge
  // (offline the set is unknown: no badge beats a wrong one)
  const myFeeds = useMyFeedIds();
  // #445/#528: only the owner of the feeding connection can tell if it still feeds; the feed set decides, not the link
  const reconnect = useReconnectReader();
  const reconnectOf = (entry: AttachedAccountEntry): ReconnectNeed | null => {
    if (!entry.account || !reconnect) return null;
    const owned = ownsFeed(entry.link?.feedSpaceId ?? entry.account.spaceId, myFeeds, entry.link ? [entry.link] : [], mySub);
    return reconnect.needOf(entry.account, owned);
  };
  const infoNeed = info ? reconnectOf(info) : null;
  const [showArchived, setShowArchived] = useState(false);
  const [bankConnectOpen, setBankConnectOpen] = useState(false);

  const entries = useQuery(store, async () => {
    // reads only — a teardown/closed-db rejection must never escape
    const [allAccounts, allLinks] = await Promise.all([
      store.bySpace('account', spaceId),
      store.bySpace('accountLink', spaceId),
    ]).catch(() => [[], []] as const);
    const ownAccounts = allAccounts.filter((a) => a.deleted === 0);
    const links = allLinks.filter((l) => l.deleted === 0);
    const feedAccounts = new Map<string, AccountRow>();
    const linkedIds = new Set(links.map((l) => l.accountId));
    const linked = await Promise.all([...linkedIds].map((id) => store.get('account', id))).catch(() => []);
    for (const account of linked) {
      if (account) feedAccounts.set(account.id, account);
    }
    const list: AttachedAccountEntry[] = ownAccounts.map((account) => ({
      key: account.id,
      name: account.name,
      type: account.type,
      subtitle: [ibanTail(account.iban), t(sourceKeyFor(account), sourceParamsFor(account))].filter(Boolean).join(' · '),
      archived: !!account.archived,
      manual: account,
      account,
    }));
    for (const link of links) {
      list.push(linkEntry(t, link, feedAccounts.get(link.accountId)));
    }
    list.sort((x, y) => x.name.localeCompare(y.name));
    return list;
  }, [spaceId, mySub]);

  const candidates = useQuery(
    store,
    async () => {
      if (!syncing) return [];
      const [myFeeds, links, allAccounts] = await Promise.all([
        fetchMyFeedIds().catch(() => new Set<string>()),
        store.bySpace('accountLink', spaceId),
        store.allRows('account'),
      ]);
      // archived links (I left the space once) don't count as attached —
      // re-attaching here is the revive path
      const attached = new Set(links.filter((l) => l.deleted === 0 && !l.archived).map((l) => l.accountId));
      return allAccounts
        .filter((a) => a.deleted === 0 && myFeeds.has(a.spaceId) && !attached.has(a.id))
        .map((a) => ({ accountId: a.id, feedSpaceId: a.spaceId, name: a.name, ibanTail: ibanTail(a.iban), reportedType: typeDef(a.type).type }));
    },
    [spaceId, syncing, attachOpen],
  );

  // #310: a named account that is a candidate lands pre-picked on the final step;
  // an unknown or already-attached one falls back to the pick list; waits for the candidates query
  useEffect(() => {
    if (!pendingAttach || candidates === undefined) return;
    const target = pendingAttach.accountId
      ? candidates.find((c) => c.accountId === pendingAttach.accountId)
      : undefined;
    setPicked(target ?? null);
    if (target) setAttachType(target.reportedType);
    setAttachFocus(!!target);
    setAttachOpen(true);
    setPendingAttach(null);
  }, [pendingAttach, candidates]);

  const attach = async () => {
    if (!picked || busy) return;
    setBusy(true);
    try {
      // #207: no per-attach history date; the space's own history start decides inside attachFeedToSpace
      await attachFeedToSpace(store, repo, spaceId, picked.feedSpaceId, picked.accountId, undefined, attachType);
      setPicked(null);
      setAttachType('checking');
      setAttachFocus(false);
      setAttachOpen(false);
    } catch {
      // offline or forbidden — the sheet simply stays open
    } finally {
      setBusy(false);
    }
  };

  const detach = async () => {
    const target = detachTarget?.detach;
    if (!target) return;
    setBusy(true);
    try {
      await detachFeedFromSpace(store, repo, spaceId, target.feedSpaceId, target.accountId);
      setDetachTarget(null);
    } catch {
      // offline or forbidden — nothing changed, the sheet stays
    } finally {
      setBusy(false);
    }
  };

  const archived = (entries ?? []).filter((entry) => entry.archived);

  const renderRow = (entry: AttachedAccountEntry) => {
    const logo = entry.account?.logo ?? institutionLogoUrl(entry.account);
    return (
      <button
        key={entry.key}
        data-testid={`space-account-${entry.key}`}
        // #206: a manual row edits directly; readers get the read-only info sheet instead (#284)
        onClick={() => (entry.manual && !readOnly ? setEditing(entry.manual) : setInfo(entry))}
        className="m-tap flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3.5 text-left"
      >
        {/* a 404 on the bank mark must not leave a broken square (#176) */}
        {logo && (
          <Picture
            src={logo}
            className="h-9 w-9 shrink-0 rounded-full object-contain"
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
              e.currentTarget.nextElementSibling?.classList.remove('hidden');
            }}
          />
        )}
        <span className={`${logo ? 'hidden ' : ''}flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-2`}>
          <Icon name={typeDef(entry.type).icon} size={18} color="var(--m-ink-3)" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium text-ink">{entry.name}</span>
          <span className="block truncate text-[12px] text-ink-4">{entry.subtitle}</span>
        </span>
        {entry.link && myFeeds && !myFeeds.has(entry.link.feedSpaceId) && (
          <SharedSpaceBadge testId={`space-account-shared-${entry.key}`} />
        )}
        {reconnectOf(entry) && (
          <Pill tone="warning" testId={`space-account-stale-${entry.key}`}>
            {t('acct.reconnectHint')}
          </Pill>
        )}
        {entry.archived && <Pill>{t('acct.archived')}</Pill>}
        {entry.account && (
          <Icon name={SOURCE_ICONS[entry.account.source]} size={16} color="var(--m-ink-4)" />
        )}
        <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
      </button>
    );
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-space-accounts">
      <AppBar
        title={t('space.financialAccounts')}
        sub={space?.name}
        leading={
          <IconButton label={t('action.back')} testId="spaceaccounts-back" onClick={() => router.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
        trailing={<HelpButton tourId="spaceAccounts" />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        <div className="pt-1" data-testid="space-accounts">
          <ReadOnlyNote spaceId={spaceId} className="mb-2" testId="space-accounts-reader-note" />
          {entries?.length === 0 && (
            <p className="px-1 text-[13px] text-ink-4" data-testid="space-accounts-empty">
              {t('space.noAccounts')}
            </p>
          )}
          {!!entries?.length && (
            <div className="flex flex-col gap-2.5" data-testid="space-accounts-list">
              {groupByAccountType(entries.filter((entry) => !entry.archived)).map((group) => (
                <section key={group.type} className="flex flex-col gap-2.5" data-testid={`space-accounts-group-${group.type}`}>
                  <div className="m-cap px-1 pt-2">{t(typeDef(group.type).groupKey)}</div>
                  {group.items.map(renderRow)}
                </section>
              ))}
            </div>
          )}
          {archived.length > 0 && (
            <div className="mt-3" data-testid="space-accounts-archived">
              <button
                data-testid="space-accounts-archived-toggle"
                aria-expanded={showArchived}
                onClick={() => setShowArchived((v) => !v)}
                className="m-tap flex w-full items-center gap-2 border-none bg-transparent px-1 py-1.5 text-left text-[12px] font-medium text-ink-4"
              >
                <Icon name={showArchived ? 'chevron-up' : 'chevron-down'} size={14} />
                {showArchived ? t('acct.hideArchived') : t('acct.showArchived', { n: archived.length })}
              </button>
              {showArchived && <div className="mt-1.5 flex flex-col gap-2.5">{archived.map(renderRow)}</div>}
            </div>
          )}
          {!readOnly &&
            (syncing ? (
              <Button
                variant="outline"
                className="mt-3 w-full"
                data-testid="space-accounts-attach"
                onClick={() => {
                  setPicked(null);
                  setAttachOpen(true);
                }}
              >
                <Icon name="link-plus" size={17} />
                {t('acct.attachToSpace')}
              </Button>
            ) : (
              <button
                data-testid="space-accounts-manage"
                onClick={() => void navigate({ to: '/accounts' })}
                className="m-tap mt-1.5 flex items-center gap-1 border-none bg-transparent px-1 text-[13px] text-accent-deep"
              >
                {t('space.manageAccounts')}
                <Icon name="chevron-right" size={15} />
              </button>
            ))}
          {!readOnly && (
            <Button
              variant="outline"
              className="mt-2 w-full"
              data-testid="space-accounts-add"
              onClick={() => setAddOpen(true)}
            >
              <Icon name="plus" size={17} />
              {t('acct.addAccount')}
            </Button>
          )}
        </div>
      </div>

      <AddAccountChooser open={addOpen} onOpenChange={setAddOpen} onConnect={() => setBankConnectOpen(true)} />
      {syncing && <BankConnect open={bankConnectOpen} onOpenChange={setBankConnectOpen} />}

      <Sheet open={info !== null} onOpenChange={(next) => !next && setInfo(null)} title={info?.name} size="form">
        {info && (
          <div className="flex flex-col gap-3 pt-1" data-testid="space-account-info">
            <div className="flex items-center gap-2 text-[13px] text-ink-2">
              {info.account && <Icon name={SOURCE_ICONS[info.account.source]} size={16} color="var(--m-ink-3)" />}
              {info.account ? t(sourceKeyFor(info.account), sourceParamsFor(info.account)) : t('acct.bank')}
            </div>
            {/* #528: why it needs its connection again; its card is brought into view, where signing in again reuses it */}
            {info.account && infoNeed && reconnect && (
              <ReconnectNote
                account={info.account}
                need={infoNeed}
                door={reconnect.doorOf(info.account, infoNeed)}
                onLeave={() => setInfo(null)}
                testId="space-account-uncovered"
                actionTestId="space-account-reconnect"
              />
            )}
            {/* #239: this SPACE's own name for the account; the global name stays untouched, clearing falls back to it */}
            {info.link && (
              <label className="flex items-center gap-3 text-[13px] text-ink-2">
                {t('acct.spaceName')}
                <input
                  data-testid="space-account-rename"
                  defaultValue={info.link.displayName ?? ''}
                  placeholder={info.account?.name ?? ''}
                  readOnly={readOnly}
                  onBlur={(e) => {
                    if (readOnly) return;
                    const trimmed = e.target.value.trim();
                    if (trimmed === (info.link!.displayName ?? '')) return;
                    void repo.upsert('accountLink', spaceId, info.link!.id, {
                      displayName: (trimmed || null) as never,
                    });
                    void logActivity(store, repo, spaceId, 'accountEdit', trimmed || (info.account?.name ?? ''));
                  }}
                  className="h-10 min-w-0 flex-1 rounded-input border border-line bg-surface px-3 text-[13px] text-ink outline-none placeholder:text-ink-4"
                />
              </label>
            )}
            {/* #212: the type is this space's own fact; changing re-reviews THIS space only (#284: readers don't) */}
            {info.link && info.account && !readOnly && <AccountTypeRow account={info.account} link={info.link} />}
            <div className="overflow-hidden rounded-card border border-line bg-surface">
              {infoFacts(t, lang, info, mySub, infoNewestTx).map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-3 border-b border-line-2 px-4 py-3 text-[13px] last:border-0">
                  <span className="text-ink-3">{label}</span>
                  <span className="min-w-0 truncate text-right font-mono text-[12px] text-ink">{value}</span>
                </div>
              ))}
            </div>
            {info.link && info.account && (
              <Button
                variant="outline"
                data-testid="space-account-goto-global"
                onClick={() => {
                  setAccountOpenHandoff(info.account!.id);
                  setInfo(null);
                  void navigate({ to: '/accounts' });
                }}
              >
                <Icon name="bank-outline" size={16} /> {t('acct.openGlobal')}
              </Button>
            )}
            {info.detach && !readOnly && (
              <Button
                variant="danger"
                data-testid="space-account-sheet-detach"
                onClick={() => {
                  setDetachTarget(info);
                  setInfo(null);
                }}
              >
                <Icon name="link-off" size={16} /> {t('acct.detach')}
              </Button>
            )}
          </div>
        )}
      </Sheet>

      <EditAccountSheet account={editing} onClose={() => setEditing(null)} />

      <Sheet
        open={attachOpen}
        onOpenChange={(next) => {
          setAttachOpen(next);
          if (!next) setAttachFocus(false);
        }}
        title={t('acct.attachToSpace')}
        size="tall"
      >
        <div className="flex flex-col gap-3 pt-1">
          {attachFocus && picked && (
            <div
              className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3"
              data-testid="space-attach-focus"
            >
              <Icon name="link-plus" size={18} color="var(--m-accent)" />
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{picked.name}</span>
              {picked.ibanTail && <span className="font-mono text-[11px] text-ink-4">{picked.ibanTail}</span>}
            </div>
          )}
          {!(attachFocus && picked) && ((candidates ?? []).length > 0 ? (
            <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="space-attach-candidates">
              {(candidates ?? []).map((candidate) => (
                <button
                  key={candidate.accountId}
                  data-testid={`space-attach-pick-${candidate.accountId}`}
                  onClick={() => {
                    setPicked(candidate);
                    setAttachType(candidate.reportedType);
                  }}
                  className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-4 py-3 text-left last:border-0"
                >
                  <Icon
                    name={picked?.accountId === candidate.accountId ? 'radiobox-marked' : 'radiobox-blank'}
                    size={18}
                    color={picked?.accountId === candidate.accountId ? 'var(--m-accent)' : 'var(--m-ink-4)'}
                  />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{candidate.name}</span>
                  {candidate.ibanTail && <span className="font-mono text-[11px] text-ink-4">{candidate.ibanTail}</span>}
                </button>
              ))}
            </div>
          ) : (
            <p className="px-1 text-[13px] text-ink-4" data-testid="space-attach-none">
              {t('acct.noAttachable')}
            </p>
          ))}

          {picked && (
            <>
              <p className="px-1 text-[13px] text-ink-2">{t('acct.attachTypeLabel')}</p>
              <div className="grid grid-cols-2 gap-2" data-testid="space-attach-types">
                {ACCOUNT_TYPES.map((def) => (
                  <button
                    key={def.type}
                    data-testid={`space-attach-type-${def.type}`}
                    onClick={() => setAttachType(def.type)}
                    className={`m-tap flex items-center gap-2 rounded-card border px-3 py-2.5 text-left text-[13px] ${
                      attachType === def.type ? 'border-accent bg-accent-soft/30 text-ink' : 'border-line bg-surface text-ink-2'
                    }`}
                  >
                    <Icon name={def.icon} size={16} color={attachType === def.type ? 'var(--m-accent-deep)' : 'var(--m-ink-3)'} />
                    <span className="min-w-0 truncate">{t(def.labelKey)}</span>
                  </button>
                ))}
              </div>
              {attachType === 'funding' && (
                <p
                  className="rounded-card bg-accent-soft/30 px-3 py-2 text-[12px] leading-snug text-ink-2"
                  data-testid="space-attach-funding-note"
                >
                  {t('acct.fundingAttachNote')}
                </p>
              )}
              {/* #308: connect/import never auto-attach: this attach is when data reaches others; kind='shared' needs a joined member */}
              {space?.kind === 'shared' && (
                <div
                  className="flex items-start gap-2.5 rounded-card bg-warning-soft px-3 py-2.5"
                  data-testid="space-attach-share-warn"
                >
                  <Icon name="account-group-outline" size={18} color="var(--m-warning)" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-ink">{t('acct.attachShareWarnTitle')}</p>
                    <p className="mt-0.5 text-[12px] leading-snug text-ink-2">
                      {t('acct.attachShareWarnBody', { space: space.name })}
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
          <Button data-testid="space-attach-save" disabled={!picked || busy} onClick={() => void attach()}>
            {t('acct.attach')}
          </Button>
          <button
            data-testid="space-attach-manage"
            onClick={() => {
              setAttachOpen(false);
              void navigate({ to: '/accounts' });
            }}
            className="m-tap border-none bg-transparent py-1 text-center text-[12px] font-medium text-accent-deep"
          >
            {t('space.manageAccounts')}
          </button>
        </div>
      </Sheet>

      <DangerConfirmSheet
        open={detachTarget !== null}
        onOpenChange={(open) => !open && setDetachTarget(null)}
        title={t('acct.detachConfirmTitle')}
        body={t('acct.detachConfirmBody', { name: detachTarget?.name ?? '' })}
        busy={busy}
        onConfirm={() => void detach()}
        testId="space-account-detach"
      />
    </div>
  );
}
