import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import type { TFunc, TranslationKey } from '@/i18n';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { useSession } from '@/app/session';
import { appendNotification, readInbox, stampNotifSeen, unreadNotifCount, type InboxEntry, type InboxKind } from '@/application/notifications';
import { clearNotifications, syncNotificationsCleared } from '@/application/inboxClear';
import { refreshSpacesNotifyOff } from '@/application/spaceNotifications';
import { WhatsNewSheet } from '@/features/help/WhatsNew';
import { latestWhatsNewVersion, useMarkWhatsNewSeen, useWhatsNewUnseen } from '@/features/help/releaseNotes';
import { apiFetch } from '@/lib/api';
import { refreshPushRegistrationOnce } from '@/lib/push';
import { useServerRefresh } from '@/lib/serverEvents';
import { fmtTimeAgo } from '@/lib/text';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

interface PendingRequest {
  id: string;
  fromUserId: string;
  fromName: string | null;
}
interface PendingInvite {
  id: string;
  spaceId: string;
  spaceName: string | null;
  fromName: string | null;
}

const short = (id: string) => `${id.slice(0, 8)}…`;

/** per-kind history line + icon (unknown kinds render the generic line) */
const ACT_VISUAL: Record<string, { key: TranslationKey; icon: string }> = {
  review: { key: 'act.review', icon: 'check-decagram-outline' },
  note: { key: 'act.note', icon: 'note-edit-outline' },
  txAdd: { key: 'act.txAdd', icon: 'plus-circle-outline' },
  txEdit: { key: 'act.txEdit', icon: 'pencil-outline' },
  txDelete: { key: 'act.txDelete', icon: 'delete-outline' },
  txCategory: { key: 'act.txCategory', icon: 'shape-outline' },
  txLink: { key: 'act.txLink', icon: 'link-variant' },
  reimburse: { key: 'act.reimburse', icon: 'cash-refund' },
  importRun: { key: 'act.importRun', icon: 'file-upload-outline' },
  attach: { key: 'act.attach', icon: 'link-plus' },
  detach: { key: 'act.detach', icon: 'link-off' },
  accountAdd: { key: 'act.accountAdd', icon: 'bank-outline' },
  accountEdit: { key: 'act.accountEdit', icon: 'bank-outline' },
  accountRemove: { key: 'act.accountRemove', icon: 'bank-remove' },
  budgetAdd: { key: 'act.budgetAdd', icon: 'chart-donut' },
  budgetEdit: { key: 'act.budgetEdit', icon: 'chart-donut' },
  budgetRemove: { key: 'act.budgetRemove', icon: 'chart-donut' },
  catAdd: { key: 'act.catAdd', icon: 'shape-plus' },
  catEdit: { key: 'act.catEdit', icon: 'shape-outline' },
  catRemove: { key: 'act.catRemove', icon: 'shape-outline' },
  recAdd: { key: 'act.recAdd', icon: 'autorenew' },
  recEdit: { key: 'act.recEdit', icon: 'autorenew' },
  recRemove: { key: 'act.recRemove', icon: 'autorenew' },
  eventAdd: { key: 'act.eventAdd', icon: 'calendar-star' },
  eventEdit: { key: 'act.eventEdit', icon: 'calendar-star' },
  eventRemove: { key: 'act.eventRemove', icon: 'calendar-remove' },
  goalAdd: { key: 'act.goalAdd', icon: 'flag-outline' },
  goalEdit: { key: 'act.goalEdit', icon: 'flag-outline' },
  goalRemove: { key: 'act.goalRemove', icon: 'flag-outline' },
  goalCashOut: { key: 'act.goalCashOut', icon: 'flag-checkered' },
  goalCashOutUndo: { key: 'act.goalCashOutUndo', icon: 'flag-outline' },
  goalPurchase: { key: 'act.goalPurchase', icon: 'flag-checkered' },
  entryLink: { key: 'act.entryLink', icon: 'link-variant' },
  entryUnlink: { key: 'act.entryUnlink', icon: 'link-variant-off' },
  debtAdd: { key: 'act.debtAdd', icon: 'scale-balance' },
  debtEdit: { key: 'act.debtEdit', icon: 'scale-balance' },
  debtRemove: { key: 'act.debtRemove', icon: 'scale-balance' },
  planStart: { key: 'act.planStart', icon: 'clipboard-text-outline' },
  planFund: { key: 'act.planFund', icon: 'clipboard-text-outline' },
  planEdit: { key: 'act.planEdit', icon: 'clipboard-text-outline' },
  planAhead: { key: 'act.planAhead', icon: 'calendar-sync-outline' },
  planBlueprint: { key: 'act.planBlueprint', icon: 'content-copy' },
  planSandbox: { key: 'act.planSandbox', icon: 'flask-outline' },
  // #541: which accounts and set-asides safe to spend counts
  spendEdit: { key: 'act.spendEdit', icon: 'calendar-arrow-right' },
  holdingAdd: { key: 'act.holdingAdd', icon: 'chart-line' },
  holdingEdit: { key: 'act.holdingEdit', icon: 'chart-line' },
  holdingRemove: { key: 'act.holdingRemove', icon: 'chart-line' },
  receiptAdd: { key: 'act.receiptAdd', icon: 'receipt-text-outline' },
  receiptRemove: { key: 'act.receiptRemove', icon: 'receipt-text-outline' },
  spaceEdit: { key: 'act.spaceEdit', icon: 'cog-outline' },
  spaceShare: { key: 'act.spaceShare', icon: 'share-variant-outline' },
  memberInvite: { key: 'act.memberInvite', icon: 'account-plus-outline' },
  memberRemove: { key: 'act.memberRemove', icon: 'account-remove-outline' },
  memberRole: { key: 'act.memberRole', icon: 'account-cog-outline' },
  storeConnect: { key: 'act.storeConnect', icon: 'storefront-outline' },
  storeEdit: { key: 'act.storeEdit', icon: 'storefront-outline' },
  storeRemove: { key: 'act.storeRemove', icon: 'storefront-outline' },
  storeAttach: { key: 'act.storeAttach', icon: 'storefront-outline' },
  storeDetach: { key: 'act.storeDetach', icon: 'storefront-outline' },
  deviceRevoke: { key: 'act.deviceRevoke', icon: 'cellphone-remove' },
  reconcile: { key: 'act.reconcile', icon: 'bank-check' },
  importRollback: { key: 'act.importRollback', icon: 'file-undo' },
  // user 2026-10-08: the custom trend graphs on the space row
  trendGraphAdd: { key: 'act.trendGraphAdd', icon: 'chart-bar' },
  trendGraphEdit: { key: 'act.trendGraphEdit', icon: 'chart-bar' },
  trendGraphRemove: { key: 'act.trendGraphRemove', icon: 'chart-bar' },
  // #577: the space's phone bar
  navEdit: { key: 'act.navEdit', icon: 'dock-bottom' },
};
const GENERIC_VISUAL: { key: TranslationKey; icon: string } = { key: 'act.generic', icon: 'history' };

/** the in-app inbox rows (arc 6): icon + destination per kind */
const INBOX_VISUAL: Record<InboxKind, { icon: string; to?: '/recurring' | '/debts' | '/insights' | '/planning' }> = {
  whatsnew: { icon: 'bullhorn-variant-outline' },
  recurringDue: { icon: 'autorenew', to: '/recurring' },
  debtRate: { icon: 'scale-balance', to: '/debts' },
  digest: { icon: 'lightbulb-on-outline', to: '/insights' },
  planOverspent: { icon: 'clipboard-alert-outline', to: '/planning' },
};

/** #551: "Household · " before the row's age — the space the row is about, while the person is in it */
function spaceLabel(names: Map<string, string> | undefined, entry: InboxEntry): string {
  const name = entry.payload?.spaceId ? names?.get(entry.payload.spaceId) : undefined;
  return name ? `${name} · ` : '';
}

/** one localized line per inbox kind — reusing the OS-notification copy */
function inboxLine(t: TFunc, entry: InboxEntry): string {
  const p = entry.payload ?? {};
  if (entry.kind === 'whatsnew') return t('notif.whatsnewRow', { version: p.version ?? '' });
  if (entry.kind === 'recurringDue') return t('notif.recurringDueRow', { name: p.name ?? '', date: p.date ?? '' });
  if (entry.kind === 'debtRate') return t('debts.rateReminderBody', { name: p.name ?? '' });
  if (entry.kind === 'planOverspent') return t('notif.planOverspentRow', { names: p.names ?? '' });
  return t('ins.digestBody', { n: p.n ?? '' });
}

/** the space's newest-first action history (YNAB-style, user request) */
function HistoryList({ onNavigate }: Readonly<{ onNavigate: (to: '/profile' | 'members') => void }>) {
  const { t, lang } = useLang();
  const { store, spaceId } = useData();
  const identity = useSession((s) => s.identity);
  const mySub = identity?.kind === 'user' ? identity.sub : undefined;
  const rows = useQuery(
    store,
    async () =>
      (await store.bySpace('activity', spaceId))
        .filter((r) => r.deleted === 0)
        .sort((a, b) => b.at.localeCompare(a.at)),
    [spaceId],
  );
  if (!rows?.length) {
    return (
      <div className="flex flex-col items-center gap-2 pt-10 text-center" data-testid="history-empty">
        <Icon name="history" size={30} color="var(--m-ink-4)" />
        <p className="text-[13px] text-ink-3">{t('act.empty')}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col" data-testid="history-list">
      {rows.map((row) => {
        const visual = ACT_VISUAL[row.kind] ?? GENERIC_VISUAL;
        // "You" whenever the row is provably mine — or on single-user
        // identities (offline/demo), where every action IS yours; other
        // members show their frozen display name
        const mine = row.actorSub ? row.actorSub === mySub : !mySub;
        const actor = mine ? t('act.you') : (row.actorName ?? t('act.someone'));
        // the actor sits mid-sentence in some languages (TR) — split on a
        // marker so the highlighted name lands wherever {actor} does
        const [before, after] = t(visual.key, { actor: '\u0000', detail: row.detail ?? '' }).split('\u0000');
        return (
          <div
            key={row.id}
            data-testid={`history-row-${row.id}`}
            className="flex w-full items-start gap-3 border-b border-line-2 px-1 py-3 text-left last:border-0"
          >
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-2">
              <Icon name={visual.icon} size={16} color="var(--m-ink-3)" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] leading-snug text-ink">
                {before}
                {/* only the person is tappable (user rule): it opens their
                    profile — the rest of the line is plain text */}
                <button
                  data-testid={`history-actor-${row.id}`}
                  onClick={() => onNavigate(mine ? '/profile' : 'members')}
                  className="m-tap inline border-none bg-transparent p-0 text-[13px] font-medium text-accent-deep"
                >
                  {actor}
                </button>
                {after}
              </span>
              <span className="block pt-0.5 text-[11px] text-ink-4">{fmtTimeAgo(row.at, lang)}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Home inbox: everything waiting on the user (friend requests, space
 * invites) plus the space's action history behind one bell. Alerts are
 * server-mediated (signed-in only); history is local-first and shows
 * for every identity.
 */
export function NotificationsBell() {
  const { t, lang } = useLang();
  const isUser = useSession((s) => s.identity?.kind === 'user');
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // Notifications | Activity for EVERY identity (arc 6) — the inbox is
  // local and works offline; activity stays the audit trail it was
  const [tab, setTab] = useState<'notifications' | 'activity'>('notifications');
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [whatsnewOpen, setWhatsnewOpen] = useState(false);
  const { store, spaceId } = useData();
  const markWhatsNewSeen = useMarkWhatsNewSeen();

  // a fresh release drops a What's-new row into the inbox (once per
  // version — dedupe key) and the Home banner is retired
  const whatsnewUnseen = useWhatsNewUnseen();
  useEffect(() => {
    const version = latestWhatsNewVersion();
    if (whatsnewUnseen && version) void appendNotification(store, 'whatsnew', { version }, `v${version}`);
  }, [whatsnewUnseen, store]);

  const inbox = useQuery(store, async () => readInbox(store), []);
  const unread = useQuery(store, async () => unreadNotifCount(store), []);
  // #551: each row says which space it is about (a space since left says nothing)
  const spaceNames = useQuery(
    store,
    async () => new Map((await store.allRows('space')).filter((s) => s.deleted === 0).map((s) => [s.id, s.name])),
    [],
  );

  // opening the Notifications tab stamps everything seen — the badge's
  // inbox share clears; actionable server items keep their own count
  useEffect(() => {
    if (open && tab === 'notifications') void stampNotifSeen(store);
  }, [open, tab, store]);

  const openActor = (to: '/profile' | 'members') => {
    setOpen(false);
    if (to === '/profile') void navigate({ to: '/profile' });
    else void navigate({ to: '/spaces/$spaceId/members', params: { spaceId } });
  };

  const reload = useCallback(async () => {
    if (!isUser) return;
    // what the person chose on their other devices comes in with the list:
    // the spaces switched off (#549) and a clear made elsewhere (#580)
    void refreshSpacesNotifyOff(store);
    void syncNotificationsCleared(store);
    // a device another account used, or one the server lost, is filed under this account again
    void refreshPushRegistrationOnce(store);
    const [friendsRes, invitesRes] = await Promise.all([
      apiFetch('/friends').catch(() => null),
      apiFetch('/me/invites').catch(() => null),
    ]);
    if (friendsRes?.ok) {
      const body = (await friendsRes.json()) as { receivedPending: PendingRequest[] };
      setRequests(body.receivedPending);
    }
    if (invitesRes?.ok) setInvites((await invitesRes.json()) as PendingInvite[]);
  }, [isUser, store]);

  useEffect(() => void reload(), [reload]);
  useServerRefresh(reload);

  const count = requests.length + invites.length + (unread ?? 0);

  const go = (to: '/friends' | '/spaces') => {
    setOpen(false);
    void navigate({ to });
  };

  const openInboxRow = (entry: InboxEntry) => {
    if (entry.kind === 'whatsnew') {
      markWhatsNewSeen();
      setWhatsnewOpen(true);
      return;
    }
    const to = INBOX_VISUAL[entry.kind].to;
    if (to) {
      setOpen(false);
      // #551: the screen opens in the space the row is about
      const about = entry.payload?.spaceId;
      void navigate({ href: about ? `${to}?space=${encodeURIComponent(about)}` : to });
    }
  };

  return (
    <>
      <button
        aria-label={t('notif.title')}
        data-testid="home-notifications"
        onClick={() => setOpen(true)}
        className="m-tap relative flex h-9 w-9 items-center justify-center rounded-full border-none bg-transparent"
      >
        <Icon name="bell-outline" size={21} color="var(--m-ink-2)" />
        {count > 0 && (
          <span
            data-testid="home-notifications-badge"
            className="absolute top-0 right-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-negative px-1 text-[9px] font-bold text-white"
          >
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      <Sheet open={open} onOpenChange={setOpen} title={t('notif.title')} size="tall">
        {/* Notifications | Activity for every identity (arc 6): the
            inbox is device-local, activity stays the audit trail */}
        <div className="mb-2 flex gap-1 rounded-input border border-line bg-surface p-1" role="tablist">
          {(
            [
              ['notifications', 'notif.tabNotifications'],
              ['activity', 'notif.tabActivity'],
            ] as const
          ).map(([id, key]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              data-testid={`notif-tab-${id}`}
              onClick={() => setTab(id)}
              className={`m-tap flex-1 rounded-[7px] border-none py-1.5 text-[12px] font-medium ${tab === id ? 'bg-accent-soft text-accent-deep' : 'bg-transparent text-ink-3'}`}
            >
              {t(key)}
            </button>
          ))}
        </div>
        {tab === 'activity' ? (
          <HistoryList onNavigate={openActor} />
        ) : (
          <>
            {count === 0 && (inbox?.length ?? 0) === 0 && (
              <div className="flex flex-col items-center gap-2 pt-10 text-center" data-testid="notif-empty">
                <Icon name="bell-check-outline" size={30} color="var(--m-ink-4)" />
                <p className="text-[13px] text-ink-3">{t('notif.empty')}</p>
              </div>
            )}
            {/* #580: the list empties here and on the person's other devices, and the phone's
                own notification centre lets go of them; requests and invites wait for an answer */}
            {(inbox?.length ?? 0) > 0 && (
              <div className="flex justify-end">
                <button
                  data-testid="notif-clear"
                  onClick={() => void clearNotifications(store, isUser)}
                  className="m-tap flex items-center gap-1 border-none bg-transparent px-1 py-1 text-[12px] font-medium text-accent-deep"
                >
                  <Icon name="notification-clear-all" size={15} />
                  {t('notif.clear')}
                </button>
              </div>
            )}
            <div className="flex flex-col">
              {requests.map((r) => (
                <button
                  key={r.id}
                  data-testid={`notif-request-${r.id}`}
                  onClick={() => go('/friends')}
                  className="m-tap flex items-center gap-3 border-b border-line-2 bg-transparent px-1 py-3 text-left last:border-0"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft">
                    <Icon name="account-plus-outline" size={18} color="var(--m-accent-deep)" />
                  </span>
                  <span className="min-w-0 flex-1 text-[13px] leading-snug text-ink">
                    {t('notif.friendRequest', { name: r.fromName ?? short(r.fromUserId) })}
                  </span>
                  <Icon name="chevron-right" size={15} color="var(--m-ink-4)" />
                </button>
              ))}
              {invites.map((invite) => (
                <button
                  key={invite.id}
                  data-testid={`notif-invite-${invite.id}`}
                  onClick={() => go('/spaces')}
                  className="m-tap flex items-center gap-3 border-b border-line-2 bg-transparent px-1 py-3 text-left last:border-0"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft">
                    <Icon name="email-outline" size={18} color="var(--m-accent-deep)" />
                  </span>
                  <span className="min-w-0 flex-1 text-[13px] leading-snug text-ink">
                    {t('notif.spaceInvite', {
                      name: invite.fromName ?? t('notif.someone'),
                      space: invite.spaceName ?? short(invite.spaceId),
                    })}
                  </span>
                  <Icon name="chevron-right" size={15} color="var(--m-ink-4)" />
                </button>
              ))}
              {/* the local inbox (arc 6): what's-new, due reminders, the
                  rate nudge, the weekly digest — identical offline */}
              {(inbox ?? []).map((entry) => (
                <button
                  key={entry.id}
                  data-testid={`notif-inbox-${entry.id}`}
                  onClick={() => openInboxRow(entry)}
                  className="m-tap flex items-start gap-3 border-b border-line-2 bg-transparent px-1 py-3 text-left last:border-0"
                >
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-2">
                    <Icon name={INBOX_VISUAL[entry.kind].icon} size={17} color="var(--m-ink-2)" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] leading-snug text-ink">{inboxLine(t, entry)}</span>
                    <span className="block truncate pt-0.5 text-[11px] text-ink-4" data-testid={`notif-inbox-meta-${entry.id}`}>
                      {spaceLabel(spaceNames, entry)}
                      {fmtTimeAgo(entry.ts, lang)}
                    </span>
                  </span>
                  <Icon name="chevron-right" size={15} color="var(--m-ink-4)" />
                </button>
              ))}
            </div>
          </>
        )}
      </Sheet>
      <WhatsNewSheet open={whatsnewOpen} onOpenChange={setWhatsnewOpen} />
    </>
  );
}
