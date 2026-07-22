import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { useSession } from '@/app/session';
import { apiFetch } from '@/lib/api';
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
  attach: { key: 'act.attach', icon: 'link-plus' },
  detach: { key: 'act.detach', icon: 'link-off' },
  budgetAdd: { key: 'act.budgetAdd', icon: 'chart-donut' },
  accountAdd: { key: 'act.accountAdd', icon: 'bank-outline' },
};

/** the space's newest-first action history (YNAB-style, user request) */
function HistoryList() {
  const { t, lang } = useLang();
  const { store, spaceId } = useData();
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
        const visual = ACT_VISUAL[row.kind] ?? { key: 'act.generic' as TranslationKey, icon: 'history' };
        return (
          <div key={row.id} data-testid={`history-row-${row.id}`} className="flex items-start gap-3 border-b border-line-2 px-1 py-3 last:border-0">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-2">
              <Icon name={visual.icon} size={16} color="var(--m-ink-3)" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] leading-snug text-ink">
                {t(visual.key, { actor: row.actorName ?? t('act.someone'), detail: row.detail ?? '' })}
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
  const { t } = useLang();
  const isUser = useSession((s) => s.identity?.kind === 'user');
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'alerts' | 'history'>(isUser ? 'alerts' : 'history');
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [invites, setInvites] = useState<PendingInvite[]>([]);

  const reload = useCallback(async () => {
    if (!isUser) return;
    const [friendsRes, invitesRes] = await Promise.all([
      apiFetch('/friends').catch(() => null),
      apiFetch('/me/invites').catch(() => null),
    ]);
    if (friendsRes?.ok) {
      const body = (await friendsRes.json()) as { receivedPending: PendingRequest[] };
      setRequests(body.receivedPending);
    }
    if (invitesRes?.ok) setInvites((await invitesRes.json()) as PendingInvite[]);
  }, [isUser]);

  useEffect(() => void reload(), [reload]);
  useServerRefresh(reload);

  const count = requests.length + invites.length;

  const go = (to: '/friends' | '/spaces') => {
    setOpen(false);
    void navigate({ to });
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
            {count}
          </span>
        )}
      </button>

      <Sheet open={open} onOpenChange={setOpen} title={t('notif.title')} size="tall">
        {/* history rides the same bell (user request: a history tab) */}
        {isUser && (
          <div className="mb-2 flex gap-1 rounded-input border border-line bg-surface p-1" role="tablist">
            {(
              [
                ['alerts', 'notif.tabAlerts'],
                ['history', 'notif.tabHistory'],
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
        )}
        {tab === 'history' || !isUser ? (
          <HistoryList />
        ) : (
          <>
            {count === 0 && (
              <div className="flex flex-col items-center gap-2 pt-10 text-center" data-testid="notif-empty">
                <Icon name="bell-check-outline" size={30} color="var(--m-ink-4)" />
                <p className="text-[13px] text-ink-3">{t('notif.empty')}</p>
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
            </div>
          </>
        )}
      </Sheet>
    </>
  );
}
