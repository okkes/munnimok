import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useSession } from '@/app/session';
import { apiFetch } from '@/lib/api';
import { useServerRefresh } from '@/lib/serverEvents';
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

/**
 * Home inbox: everything waiting on the user (friend requests, space
 * invites) behind one bell with a count. Rows lead to the screen where
 * the decision is made. Signed-in identities only — the lists are
 * server-mediated.
 */
export function NotificationsBell() {
  const { t } = useLang();
  const isUser = useSession((s) => s.identity?.kind === 'user');
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
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

  if (!isUser) return null;
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

      <Sheet open={open} onOpenChange={setOpen} title={t('notif.title')} size="form">
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
      </Sheet>
    </>
  );
}
