import { useCallback, useEffect, useState } from 'react';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { apiFetch } from '@/lib/api';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';

interface InviteDto {
  id: string;
  spaceId: string;
  spaceName: string | null;
  fromUserId: string;
  fromName: string | null;
  role: string;
}
interface MemberDto {
  userId: string;
  displayName: string | null;
  role: string;
}
interface FriendDto {
  userId: string;
  displayName: string | null;
}

const short = (id: string) => `${id.slice(0, 8)}…`;

/** Pending space invites, shown at the top of the Spaces tab. */
export function SpaceInvitesBanner() {
  const { t } = useLang();
  const { engine } = useData();
  const [invites, setInvites] = useState<InviteDto[]>([]);

  const reload = useCallback(async () => {
    const res = await apiFetch('/me/invites').catch(() => null);
    if (res?.ok) setInvites((await res.json()) as InviteDto[]);
  }, []);
  useEffect(() => void reload(), [reload]);

  const respond = async (invite: InviteDto, action: 'accept' | 'decline') => {
    await apiFetch(`/spaces/invites/${invite.id}/${action}`, { method: 'POST' });
    await reload();
    if (action === 'accept') await engine?.syncAll(); // pull the new space now
  };

  if (invites.length === 0) return null;
  return (
    <div className="mb-4 flex flex-col gap-2" data-testid="space-invites">
      {invites.map((invite) => (
        <div key={invite.id} className="flex items-center gap-3 rounded-card border border-accent bg-accent-soft px-4 py-3">
          <Icon name="email-outline" size={20} color="var(--m-accent-deep)" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium text-accent-deep">
              {invite.spaceName ?? invite.spaceId.slice(0, 12)}
            </span>
            <span className="block truncate text-[12px] text-ink-3">
              {t('space.invitedYou', { name: invite.fromName ?? short(invite.fromUserId) })}
            </span>
          </span>
          <Button size="sm" data-testid={`space-invite-accept-${invite.id}`} onClick={() => void respond(invite, 'accept')}>
            {t('friends.accept')}
          </Button>
          <button
            aria-label={t('friends.decline')}
            onClick={() => void respond(invite, 'decline')}
            className="m-tap border-none bg-transparent text-ink-4"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Members + invite-a-friend for the space edit sheet (user identities). */
export function SpaceMembersSection({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const { t } = useLang();
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [friends, setFriends] = useState<FriendDto[]>([]);
  const [me, setMe] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [membersRes, friendsRes, meRes] = await Promise.all([
      apiFetch(`/spaces/${spaceId}/members`).catch(() => null),
      apiFetch('/friends').catch(() => null),
      apiFetch('/me').catch(() => null),
    ]);
    if (membersRes?.ok) setMembers((await membersRes.json()) as MemberDto[]);
    if (friendsRes?.ok) setFriends(((await friendsRes.json()) as { friends: FriendDto[] }).friends);
    if (meRes?.ok) setMe(((await meRes.json()) as { userId: string }).userId);
  }, [spaceId]);
  useEffect(() => void reload(), [reload]);

  if (members === null) return null; // not a member / offline — hide section
  const myRole = members.find((m) => m.userId === me)?.role;
  const memberIds = new Set(members.map((m) => m.userId));
  const invitable = friends.filter((f) => !memberIds.has(f.userId));

  const invite = async (toUserId: string) => {
    await apiFetch(`/spaces/${spaceId}/invites`, {
      method: 'POST',
      body: JSON.stringify({ toUserId, role: 'member', spaceName }),
    });
    await reload();
  };
  const kick = async (userId: string) => {
    await apiFetch(`/spaces/${spaceId}/members/${userId}`, { method: 'DELETE' });
    await reload();
  };

  return (
    <div className="mt-2" data-testid="space-members">
      <div className="m-cap mb-1 px-1">{t('space.members')}</div>
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {members.map((m) => (
          <div key={m.userId} className="flex items-center gap-3 border-b border-line-2 px-4 py-2.5 last:border-0">
            <Icon name="account-outline" size={18} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
              {m.displayName ?? short(m.userId)}
            </span>
            <span className="text-[11px] text-ink-4">{m.role}</span>
            {myRole === 'owner' && m.userId !== me && (
              <button
                aria-label={t('action.delete')}
                data-testid={`space-kick-${m.userId}`}
                onClick={() => void kick(m.userId)}
                className="m-tap border-none bg-transparent text-ink-4"
              >
                <Icon name="close" size={16} />
              </button>
            )}
          </div>
        ))}
      </div>
      {myRole === 'owner' && invitable.length > 0 && (
        <>
          <div className="m-cap mt-3 mb-1 px-1">{t('space.addMember')}</div>
          <div className="flex flex-wrap gap-2">
            {invitable.map((f) => (
              <button
                key={f.userId}
                data-testid={`space-invite-${f.userId}`}
                onClick={() => void invite(f.userId)}
                className="m-tap rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] text-ink-2"
              >
                + {f.displayName ?? short(f.userId)}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
