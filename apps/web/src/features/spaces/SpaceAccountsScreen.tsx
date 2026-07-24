import { useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useNavigate, useParams, useRouter } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { attachFeedToSpace, detachFeedFromSpace } from '@/application/accountAttach';
import { fetchMyFeedIds } from '@/features/accounts/feedGateway';
import { SOURCE_KEYS } from '@/features/accounts/AttachSheet';
import { AddAccountChooser } from '@/features/accounts/AddAccountChooser';
import type { AccountLinkRow, AccountRow } from '@/db/types';
import { fmtTimeAgo } from '@/lib/text';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { Icon } from '@/ui/Icon';
import { Pill, Row } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';

/** bank-linked data older than this smells like a dead consent (90/180d
 *  windows) — the row asks for a reconnect instead of silently aging */
const STALE_SYNC_MS = 48 * 60 * 60 * 1000;

interface AttachedAccountEntry {
  key: string;
  name: string;
  subtitle: string;
  archived: boolean;
  stale: boolean;
  /** present = a detachable feed attachment */
  detach?: { feedSpaceId: string; accountId: string };
}

interface AttachCandidate {
  accountId: string;
  feedSpaceId: string;
  name: string;
  ibanTail?: string;
}

type T = ReturnType<typeof useLang>['t'];
type Lang = ReturnType<typeof useLang>['lang'];

const ibanTail = (iban?: string) => (iban ? `…${iban.slice(-4)}` : undefined);

const syncLine = (t: T, lang: Lang, account?: AccountRow) =>
  account?.lastSyncedAt ? t('acct.lastSynced', { when: fmtTimeAgo(account.lastSyncedAt, lang) }) : undefined;

const isStale = (account?: AccountRow) =>
  account?.source === 'gocardless' &&
  !!account.lastSyncedAt &&
  Date.now() - Date.parse(account.lastSyncedAt) > STALE_SYNC_MS;

function linkProvenance(t: T, link: AccountLinkRow, mySub?: string): string | undefined {
  if (link.attachedBy && mySub === link.attachedBy) return t('acct.provMine');
  if (link.attachedByName) return t('acct.provShared', { name: link.attachedByName });
  return undefined;
}

/** one feed attachment as a display row (S3776: out of the query fn) */
function linkEntry(t: T, lang: Lang, link: AccountLinkRow, account: AccountRow | undefined, mySub?: string): AttachedAccountEntry {
  return {
    key: link.id,
    name: account?.name ?? t('acct.bank'),
    subtitle: [
      ibanTail(account?.iban),
      account ? t(SOURCE_KEYS[account.source]) : undefined,
      linkProvenance(t, link, mySub),
      link.historyFrom ? `${t('acct.historyFrom')} ${link.historyFrom}` : undefined,
      // last-sync on the space overview too (user request)
      syncLine(t, lang, account),
    ]
      .filter(Boolean)
      .join(' · '),
    archived: !!link.archived,
    stale: isStale(account),
    detach: { feedSpaceId: link.feedSpaceId, accountId: link.accountId },
  };
}

/**
 * The financial accounts this space sees (redesign 2026-07-22): the
 * list shows last-sync freshness, every feed attachment detaches HERE
 * (danger sheet + cooldown), and "+ attach" offers the user's not-yet-
 * attached accounts with a history start date — account CREATION stays
 * behind the manage door inside that sheet.
 */
export function SpaceAccountsScreen() {
  const { t, lang } = useLang();
  const { store, repo } = useData();
  const identity = useSession((s) => s.identity);
  const navigate = useNavigate();
  const router = useRouter();
  const { spaceId } = useParams({ strict: false }) as { spaceId: string };
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const syncing = identity?.kind === 'user';

  const [attachOpen, setAttachOpen] = useState(false);
  const [picked, setPicked] = useState<AttachCandidate | null>(null);
  const [historyFrom, setHistoryFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [detachTarget, setDetachTarget] = useState<AttachedAccountEntry | null>(null);
  // AE1: creation goes through the shared chooser now
  const [addOpen, setAddOpen] = useState(false);

  const mySub = identity?.kind === 'user' ? identity.sub : undefined;

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
    // provenance is spelled out per row (user request): space-scoped
    // manual, your global account, or shared into this space by someone
    const list: AttachedAccountEntry[] = ownAccounts.map((account) => ({
      key: account.id,
      name: account.name,
      subtitle: [ibanTail(account.iban), t(SOURCE_KEYS[account.source]), t('acct.provSpace'), syncLine(t, lang, account)]
        .filter(Boolean)
        .join(' · '),
      archived: !!account.archived,
      stale: isStale(account),
    }));
    for (const link of links) {
      list.push(linkEntry(t, lang, link, feedAccounts.get(link.accountId), mySub));
    }
    list.sort((x, y) => x.name.localeCompare(y.name));
    return list;
  }, [spaceId, mySub]);

  // "+ attach": my feeds' accounts that this space does NOT have yet
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
        .map((a) => ({ accountId: a.id, feedSpaceId: a.spaceId, name: a.name, ibanTail: ibanTail(a.iban) }));
    },
    [spaceId, syncing, attachOpen],
  );

  const attach = async () => {
    if (!picked || busy) return;
    setBusy(true);
    try {
      await attachFeedToSpace(store, repo, spaceId, picked.feedSpaceId, picked.accountId, historyFrom || undefined);
      setPicked(null);
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
          {entries?.length === 0 && (
            <p className="px-1 text-[13px] text-ink-4" data-testid="space-accounts-empty">
              {t('space.noAccounts')}
            </p>
          )}
          {!!entries?.length && (
            <div className="overflow-hidden rounded-card border border-line bg-surface">
              {entries.map((entry) => (
                <Row
                  key={entry.key}
                  kind="data"
                  icon="bank-outline"
                  title={entry.name}
                  sub={entry.subtitle || undefined}
                  trailing={
                    <span className="flex items-center gap-1.5">
                      {entry.stale && (
                        <Pill tone="warning" testId={`space-account-stale-${entry.key}`}>
                          {t('acct.reconnectHint')}
                        </Pill>
                      )}
                      {entry.archived && <Pill>{t('acct.archived')}</Pill>}
                      {entry.detach && (
                        <button
                          aria-label={t('acct.detach')}
                          data-testid={`space-account-detach-${entry.key}`}
                          onClick={() => setDetachTarget(entry)}
                          className="m-tap flex h-8 w-8 items-center justify-center border-none bg-transparent text-ink-4"
                        >
                          <Icon name="link-off" size={16} />
                        </button>
                      )}
                    </span>
                  }
                />
              ))}
            </div>
          )}
          {syncing ? (
            <Button
              variant="outline"
              className="mt-3 w-full"
              data-testid="space-accounts-attach"
              onClick={() => {
                setPicked(null);
                setHistoryFrom('');
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
          )}
          <Button
            variant="outline"
            className="mt-2 w-full"
            data-testid="space-accounts-add"
            onClick={() => setAddOpen(true)}
          >
            <Icon name="plus" size={17} />
            {t('acct.addAccount')}
          </Button>
        </div>
      </div>

      {/* AE1: the shared intent chooser — manual creates in place */}
      <AddAccountChooser open={addOpen} onOpenChange={setAddOpen} gcAvailable={syncing} />

      {/* pick an existing account, choose the history start, attach */}
      <Sheet open={attachOpen} onOpenChange={setAttachOpen} title={t('acct.attachToSpace')} size="tall">
        <div className="flex flex-col gap-3 pt-1">
          {(candidates ?? []).length > 0 ? (
            <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="space-attach-candidates">
              {(candidates ?? []).map((candidate) => (
                <button
                  key={candidate.accountId}
                  data-testid={`space-attach-pick-${candidate.accountId}`}
                  onClick={() => setPicked(candidate)}
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
          )}

          {picked && (
            <>
              <label className="flex items-center gap-3 text-[13px] text-ink-2">
                {t('acct.historyFrom')}
                <input
                  data-testid="space-attach-history"
                  type="date"
                  value={historyFrom}
                  onChange={(e) => setHistoryFrom(e.target.value)}
                  className="h-10 flex-1 rounded-input border border-line bg-surface px-3 text-[13px] text-ink outline-none"
                />
              </label>
              <p className="px-1 text-[11px] leading-snug text-ink-4">{t('acct.historyFromHint')}</p>
            </>
          )}
          <Button data-testid="space-attach-save" disabled={!picked || busy} onClick={() => void attach()}>
            {t('acct.attach')}
          </Button>
          {/* need a NEW account? creation lives on the manage screen */}
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

      {/* aligned destructive confirm: sheet + cooldown (user request) */}
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
