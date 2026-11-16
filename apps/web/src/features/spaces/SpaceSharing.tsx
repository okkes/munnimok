import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { useData } from '@/app/data';
import { logActivity } from '@/application/activity';
import { ensureSpaceShared, healSharedKind, stampJoinedSharedSpace } from '@/application/spaces';
import { useSpaceRole } from '@/app/useCanEdit';
import type { SpaceRole } from '@/sync/spaceAccess';
import { apiFetch } from '@/lib/api';
import { useServerRefresh } from '@/lib/serverEvents';
import { Avatar } from '@/features/profile/ProfileScreen';
import { postFriendRequest } from '@/features/friends/sendFriendRequest';
import type { FriendRequestOutcome } from '@/features/friends/sendFriendRequest';
import { PinChallengeSheet } from '@/features/lock/PinChallengeSheet';
import { readLockConfig } from '@/features/lock/lock';
import { Button } from '@/ui/Button';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { FormBlockerNote, blockerRing } from '@/ui/FormBlockerNote';
import { Icon } from '@/ui/Icon';
import { SearchField } from '@/ui/SearchField';
import { Sheet } from '@/ui/Sheet';
import { RolePicker } from './InviteFriendSheet';
import { MemberSheet } from './MemberSheet';

export type { SpaceRole } from '@/sync/spaceAccess';

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
  role: SpaceRole;
  picture?: string | null;
  /** #172: membership creation time; null on pre-column rows */
  joinedAt?: string | null;
}
interface FriendDto {
  userId: string;
  displayName: string | null;
  picture?: string | null;
}
interface OutgoingInviteDto {
  id: string;
  toUserId: string;
  toName: string | null;
  role: string;
}
interface SentFriendRequestDto {
  id: string;
  toUserId: string;
  toName: string | null;
  /** set when the request carries a space along (#169) */
  spaceName?: string | null;
}
interface FriendsPayload {
  friends: FriendDto[];
  sentPending?: SentFriendRequestDto[];
}

const short = (id: string) => `${id.slice(0, 8)}…`;
const roleKey = (role: string): TranslationKey => `space.role.${role}` as TranslationKey;

// #505: the role the server last named (sync/spaceAccess, known offline too); non-synced identities and
// spaces the server never named read as owner: the server's enforcement stays the real gate
export function useMyRole(spaceId: string | undefined, syncing: boolean): SpaceRole {
  const { store, repo, access } = useData();
  const known = useSpaceRole(spaceId);
  useEffect(() => {
    if (!syncing || !spaceId) return;
    void (async () => {
      const [membersRes, meRes] = await Promise.all([
        apiFetch(`/spaces/${spaceId}/members`).catch(() => null),
        apiFetch('/me').catch(() => null),
      ]);
      if (!membersRes?.ok || !meRes?.ok) return;
      const members = (await membersRes.json()) as MemberDto[];
      // every members fetch heals a joiner's (or pre-flip owner's) row that never learned it is shared (#277)
      void healSharedKind(store, repo, spaceId, members);
      const me = ((await meRes.json()) as { userId: string }).userId;
      const mine = members.find((m) => m.userId === me)?.role;
      if (mine) await access.note(spaceId, mine);
    })();
  }, [spaceId, syncing, store, repo, access]);
  return known ?? 'owner';
}

// the server drops the membership FIRST: that instantly revokes read access to the space's financial accounts
export async function leaveSpace(
  ctx: {
    store: { allRows: (entity: 'space') => Promise<{ deleted: number; id: string }[]> };
    engine: { purgeSpace: (spaceId: string) => Promise<void> } | null;
    setActiveSpace: (spaceId: string) => Promise<void> | void;
    activeSpaceId: string;
  },
  spaceId: string,
): Promise<boolean> {
  const meRes = await apiFetch('/me').catch(() => null);
  if (!meRes?.ok) return false;
  const me = ((await meRes.json()) as { userId: string }).userId;
  const res = await apiFetch(`/spaces/${spaceId}/members/${me}`, { method: 'DELETE' }).catch(() => null);
  if (!res?.ok) return false;
  await ctx.engine?.purgeSpace(spaceId);
  if (ctx.activeSpaceId === spaceId) {
    const remaining = (await ctx.store.allRows('space')).find((s) => s.deleted === 0 && s.id !== spaceId);
    if (remaining) await ctx.setActiveSpace(remaining.id);
  }
  return true;
}

export function SpaceInvitesBanner() {
  const { t } = useLang();
  const { store, repo, engine } = useData();
  const [invites, setInvites] = useState<InviteDto[]>([]);

  const reload = useCallback(async () => {
    const res = await apiFetch('/me/invites').catch(() => null);
    if (res?.ok) setInvites((await res.json()) as InviteDto[]);
  }, []);
  useEffect(() => void reload(), [reload]);
  useServerRefresh(reload);

  const respond = async (invite: InviteDto, action: 'accept' | 'decline') => {
    await apiFetch(`/spaces/invites/${invite.id}/${action}`, { method: 'POST' });
    await reload();
    if (action === 'accept') {
      // the joiner's copy must carry the shared fact too; the inviter counts as owner for a missing creator line (#277)
      await stampJoinedSharedSpace(
        store,
        repo,
        async () => {
          await engine?.syncAll().catch(() => undefined);
        },
        { spaceId: invite.spaceId },
        invite.fromName,
      );
    }
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
              {t('space.invitedYou', { name: invite.fromName ?? short(invite.fromUserId) })} · {t(roleKey(invite.role))}
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

// #292: the check mark ONLY the authenticated self row gets: a member merely NAMED "Me" shows none,
// so nobody can pose as you
function MemberRow({ member, isSelf, onOpen }: Readonly<{ member: MemberDto; isSelf: boolean; onOpen: (userId: string) => void }>) {
  const { t } = useLang();
  return (
    <button
      data-testid={`member-row-${member.userId}`}
      onClick={() => onOpen(member.userId)}
      className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-2.5 text-left last:border-0"
    >
      <Avatar picture={member.picture} size={24} />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 truncate text-[14px] text-ink">
          {isSelf ? t('space.me') : (member.displayName ?? short(member.userId))}
        </span>
        {isSelf && (
          <span data-testid="member-me-icon" className="inline-flex shrink-0 text-accent-deep">
            <Icon name="account-check" size={15} />
          </span>
        )}
      </span>
      <span className="text-[11px] text-ink-4" data-testid={`space-rolelabel-${member.userId}`}>
        {t(roleKey(member.role))}
      </span>
      <Icon name="chevron-right" size={15} color="var(--m-ink-4)" />
    </button>
  );
}

interface SpaceMembersSectionProps {
  spaceId: string;
  spaceName: string;
  onMyRole?: (role: SpaceRole) => void;
  onLeft?: () => void;
}

// #391: the invitation switch lives with the members; closed = nobody can be invited.
// Opening it on a device with an app lock asks the PIN first (#302)
function InviteLockRow({ locked, onWrite }: Readonly<{ locked: boolean; onWrite: (next: 0 | 1) => void }>) {
  const { t } = useLang();
  const [challengeOpen, setChallengeOpen] = useState(false);
  const toggle = () => {
    if (locked && readLockConfig()) {
      setChallengeOpen(true);
      return;
    }
    onWrite(locked ? 0 : 1);
  };
  return (
    <>
      <div className="mt-3 flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3" data-testid="space-invite-lock-row">
        <Icon name={locked ? 'lock-outline' : 'lock-open-variant-outline'} size={18} color="var(--m-ink-3)" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-ink">{t('space.invitesTitle')}</div>
          <div className="text-[12px] leading-snug text-ink-3">{t(locked ? 'space.invitesClosed' : 'space.invitesOpen')}</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={!locked}
          aria-label={t('space.invitesTitle')}
          data-testid="space-invite-toggle"
          onClick={toggle}
          className={`flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-none p-0.5 transition-colors ${
            locked ? 'justify-start bg-bg-2' : 'justify-end bg-accent'
          }`}
        >
          <span className="h-4 w-4 rounded-full bg-surface shadow" />
        </button>
      </div>
      <PinChallengeSheet
        open={challengeOpen}
        onOpenChange={setChallengeOpen}
        title={t('space.inviteUnlockTitle')}
        body={t('space.inviteUnlockBody')}
        onPass={() => onWrite(0)}
      />
    </>
  );
}

export function SpaceMembersSection({ spaceId, spaceName, onMyRole, onLeft }: SpaceMembersSectionProps) {
  const { t } = useLang();
  const { store, repo, engine, setActiveSpace, spaceId: activeSpaceId, access } = useData();
  const spaceRow = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const locked = spaceRow?.inviteLock === 1;
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [friends, setFriends] = useState<FriendDto[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingInviteDto[]>([]);
  const [pendingFriends, setPendingFriends] = useState<SentFriendRequestDto[]>([]);
  const [me, setMe] = useState<string | null>(null);
  // #304: leaving is as destructive as being removed: the same danger sheet with cooldown
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [inviteSentTo, setInviteSentTo] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  // held by ID so reloads keep it fresh and a kicked member's sheet closes on its own (#172)
  const [memberSheetId, setMemberSheetId] = useState<string | null>(null);
  // removing is disruptive (they lose the shared accounts too): the door only opens a confirm sheet
  const [kickTarget, setKickTarget] = useState<MemberDto | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<OutgoingInviteDto | null>(null);

  const reload = useCallback(async () => {
    const [membersRes, friendsRes, meRes, outgoingRes] = await Promise.all([
      apiFetch(`/spaces/${spaceId}/members`).catch(() => null),
      apiFetch('/friends').catch(() => null),
      apiFetch('/me').catch(() => null),
      apiFetch(`/spaces/${spaceId}/invites`).catch(() => null), // owner-only: 403 for others
    ]);
    let list: MemberDto[] | null = null;
    if (membersRes?.ok) {
      list = (await membersRes.json()) as MemberDto[];
      setMembers(list);
    }
    if (friendsRes?.ok) {
      const payload = (await friendsRes.json()) as FriendsPayload;
      setFriends(payload.friends);
      // the carried space name is the only key the payload offers (#291)
      setPendingFriends((payload.sentPending ?? []).filter((r) => r.spaceName === spaceName));
    }
    if (meRes?.ok) setMe(((await meRes.json()) as { userId: string }).userId);
    if (outgoingRes?.ok) setOutgoing((await outgoingRes.json()) as OutgoingInviteDto[]);
    // 2+ members = shared, whatever the local row says; both sides may run this heal (idempotent LWW) (#277)
    if (list) await healSharedKind(store, repo, spaceId, list);
  }, [spaceId, spaceName, store, repo]);
  useEffect(() => void reload(), [reload]);
  useServerRefresh(reload);

  const myRole = members?.find((m) => m.userId === me)?.role;
  useEffect(() => {
    if (!myRole) return;
    onMyRole?.(myRole);
    void access.note(spaceId, myRole); // #505: the screen's fresh answer is the guard's too
  }, [myRole, onMyRole, access, spaceId]);

  if (members === null) return null; // not a member / offline — hide section
  const isOwner = myRole === 'owner';
  const memberIds = new Set(members.map((m) => m.userId));
  const pendingIds = new Set(outgoing.map((i) => i.toUserId));
  const invitable = friends.filter((f) => !memberIds.has(f.userId) && !pendingIds.has(f.userId));
  // someone with a pending SPACE invite or already a member must not also show as a friend-request row (#291)
  const friendPendingRows = pendingFriends.filter((r) => !pendingIds.has(r.toUserId) && !memberIds.has(r.toUserId));

  const ensureShared = async () => {
    if (await ensureSpaceShared(store, repo, spaceId)) {
      void logActivity(store, repo, spaceId, 'spaceShare', spaceName);
    }
  };
  const invite = async (friend: FriendDto, role: SpaceRole) => {
    const res = await apiFetch(`/spaces/${spaceId}/invites`, {
      method: 'POST',
      body: JSON.stringify({ toUserId: friend.userId, role, spaceName }),
    }).catch(() => null);
    if (res?.ok) {
      setInviteSentTo(friend.displayName ?? short(friend.userId));
      void logActivity(store, repo, spaceId, 'memberInvite', friend.displayName ?? short(friend.userId));
    }
    await ensureShared();
    await reload();
  };
  const revokeInvite = async (inviteId: string) => {
    await apiFetch(`/spaces/invites/${inviteId}`, { method: 'DELETE' }).catch(() => null);
    setInviteSentTo(null);
    setRevokeTarget(null);
    await reload();
  };
  // #169: the friend request carries this space and the role, so accepting it also joins them here
  const sendFriendRequestHere = async (toUserId: string, role: SpaceRole): Promise<FriendRequestOutcome> => {
    const outcome = await postFriendRequest({ toUserId, spaceId, role, spaceName });
    if (outcome === 'sent') {
      void logActivity(store, repo, spaceId, 'memberInvite', short(toUserId));
      await ensureShared();
    }
    // if they had already requested me, the server auto-accepts (the space intent becomes a regular invite)
    await reload();
    return outcome;
  };
  const kick = async (userId: string) => {
    const name = members.find((m) => m.userId === userId)?.displayName ?? short(userId);
    // the space's name rides along for the victim's push text (#172)
    await apiFetch(`/spaces/${spaceId}/members/${userId}?spaceName=${encodeURIComponent(spaceName)}`, { method: 'DELETE' });
    void logActivity(store, repo, spaceId, 'memberRemove', name);
    setKickTarget(null);
    await reload();
  };
  const changeRole = async (userId: string, role: SpaceRole) => {
    await apiFetch(`/spaces/${spaceId}/members/${userId}/role`, { method: 'PUT', body: JSON.stringify({ role, spaceName }) });
    void logActivity(store, repo, spaceId, 'memberRole', members.find((m) => m.userId === userId)?.displayName ?? short(userId));
    await reload();
  };
  const leave = async () => {
    if (await leaveSpace({ store, engine, setActiveSpace, activeSpaceId }, spaceId)) onLeft?.();
  };

  return (
    <div className="mt-2" data-testid="space-members">
      <div className="m-cap mb-1 px-1">{t('space.members')}</div>
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {/* #292: self is matched on the authenticated id, never the name */}
        {members.map((m) => (
          <MemberRow key={m.userId} member={m} isSelf={m.userId === me} onOpen={setMemberSheetId} />
        ))}
      </div>
      {isOwner && (outgoing.length > 0 || friendPendingRows.length > 0) && (
        <>
          <div className="m-cap mt-3 mb-1 px-1">{t('space.invitePendingTitle')}</div>
          <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="space-outgoing-invites">
            {outgoing.map((invitation) => (
              <div key={invitation.id} className="flex items-center gap-3 border-b border-line-2 px-4 py-2.5 last:border-0">
                <Icon name="clock-outline" size={18} color="var(--m-ink-4)" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">
                    {invitation.toName ?? short(invitation.toUserId)}
                  </span>
                  <span className="block truncate text-[12px] text-ink-4">
                    {t('space.invitePending')} · {t(roleKey(invitation.role))}
                  </span>
                </span>
                <button
                  aria-label={t('friends.cancelInvite')}
                  data-testid={`space-invite-revoke-${invitation.id}`}
                  onClick={() => setRevokeTarget(invitation)}
                  className="m-tap border-none bg-transparent text-ink-4"
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            ))}
            {friendPendingRows.map((request) => (
              <div
                key={request.id}
                className="flex items-center gap-3 border-b border-line-2 px-4 py-2.5 last:border-0"
                data-testid={`space-friendpending-${request.toUserId}`}
              >
                <Icon name="clock-outline" size={18} color="var(--m-ink-4)" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">
                    {request.toName ?? short(request.toUserId)}
                  </span>
                  <span className="block truncate text-[12px] text-ink-4">{t('space.friendPending')}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {/* #391: owner only; applies immediately (LWW) */}
      {isOwner && (
        <InviteLockRow
          locked={locked}
          onWrite={(next) => {
            void repo.upsert('space', spaceId, spaceId, { inviteLock: next });
            void logActivity(store, repo, spaceId, 'spaceEdit', spaceName);
          }}
        />
      )}
      {isOwner && !locked && (
        <>
          {inviteSentTo && (
            <p className="mt-3 mb-2 flex items-center gap-1.5 px-1 text-[12px] text-accent-deep" data-testid="space-invite-sent">
              <Icon name="check-circle-outline" size={14} />
              {t('space.spaceInviteSent', { name: inviteSentTo })}
            </p>
          )}
          <Button variant="outline" className="mt-3 w-full" data-testid="space-members-add" onClick={() => setInviteOpen(true)}>
            {t('space.inviteSomeone')}
          </Button>
        </>
      )}
      {members.length > 1 && (
        <div className="mt-4">
          <Button variant="outline" className="w-full" data-testid="space-leave" onClick={() => setLeaveOpen(true)}>
            {t('space.leave')}
          </Button>
        </div>
      )}
      <SpaceInviteSheet
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        friends={invitable}
        spaceName={spaceName}
        onInvite={async (friend, role) => {
          await invite(friend, role);
          setInviteOpen(false);
        }}
        onSendRequest={sendFriendRequestHere}
      />
      {/* resolved live so a kick closes it (#172) */}
      <MemberSheet
        member={members.find((m) => m.userId === memberSheetId) ?? null}
        meIsOwner={isOwner}
        isSelf={memberSheetId === me}
        onOpenChange={(next) => !next && setMemberSheetId(null)}
        onChangeRole={(userId, role) => void changeRole(userId, role)}
        onKick={(m) => setKickTarget(m)}
      />
      <DangerConfirmSheet
        open={kickTarget !== null}
        onOpenChange={(next) => {
          if (!next) setKickTarget(null);
        }}
        title={t('space.kickTitle')}
        body={t('space.kickBody', { name: kickTarget?.displayName ?? short(kickTarget?.userId ?? '') })}
        onConfirm={() => {
          if (kickTarget) void kick(kickTarget.userId);
        }}
        testId="space-kick"
      />
      <DangerConfirmSheet
        open={leaveOpen}
        onOpenChange={setLeaveOpen}
        title={t('space.leaveConfirmTitle')}
        body={t('space.leaveConfirm')}
        confirmLabel={t('space.leave')}
        onConfirm={() => void leave()}
        testId="space-leave"
      />
      {/* no cooldown: a withdrawn invite is re-sendable in two taps (#303) */}
      <DangerConfirmSheet
        open={revokeTarget !== null}
        onOpenChange={(next) => {
          if (!next) setRevokeTarget(null);
        }}
        title={t('space.cancelInviteTitle')}
        body={t('space.cancelInviteBody', { name: revokeTarget?.toName ?? short(revokeTarget?.toUserId ?? '') })}
        onConfirm={() => {
          if (revokeTarget) void revokeInvite(revokeTarget.id);
        }}
        testId="space-revoke"
        cooldown={0}
      />
    </div>
  );
}

function SpaceInviteSheet({
  open,
  onOpenChange,
  friends,
  spaceName,
  onInvite,
  onSendRequest,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  friends: FriendDto[];
  spaceName: string;
  onInvite: (friend: FriendDto, role: SpaceRole) => void | Promise<void>;
  onSendRequest: (toUserId: string, role: SpaceRole) => Promise<FriendRequestOutcome>;
}>) {
  const { t } = useLang();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [role, setRole] = useState<SpaceRole>('contributor');
  const [friendId, setFriendId] = useState('');
  const [requestRole, setRequestRole] = useState<SpaceRole>('contributor');
  const [addAttempted, setAddAttempted] = useState(false);
  const [friendNotFound, setFriendNotFound] = useState(false);
  const [requestSent, setRequestSent] = useState(false);
  useEffect(() => {
    if (open) {
      setSearch('');
      setSelectedId(null);
      setRole('contributor');
      setFriendId('');
      setRequestRole('contributor');
      setAddAttempted(false);
      setFriendNotFound(false);
      setRequestSent(false);
    }
  }, [open]);

  const needle = search.trim().toLowerCase();
  const matches = friends.filter(
    (f) => !needle || (f.displayName ?? '').toLowerCase().includes(needle) || f.userId.toLowerCase().includes(needle),
  );

  const pick = (userId: string) => {
    setSelectedId((prev) => (prev === userId ? null : userId));
    setRole('contributor');
  };

  const sendRequest = async () => {
    const toUserId = friendId.trim();
    if (!toUserId) {
      setAddAttempted(true);
      return;
    }
    setAddAttempted(false);
    const outcome = await onSendRequest(toUserId, requestRole);
    // "not found" says so AT the field and keeps the typed id; "sent" is claimed only when true (#291)
    setFriendNotFound(outcome === 'notFound');
    setRequestSent(outcome === 'sent');
    if (outcome === 'sent') {
      setFriendId('');
      setRequestRole('contributor');
    }
  };

  return (
    // dirty: a typed-but-unsent id survives an accidental swipe-down
    <Sheet open={open} onOpenChange={onOpenChange} title={t('space.inviteSomeone')} size="tall" dirty={friendId.trim() !== ''}>
      <div className="flex flex-col gap-3 pt-1" data-testid="space-invite-sheet">
        <div className="m-cap px-1">{t('space.inviteFromFriends')}</div>
        <SearchField testId="space-invite-search" value={search} onChange={setSearch} placeholder={t('invite.searchPlaceholder')} height="h-11" textSize="text-[14px]" />
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {matches.map((f) => (
            <div key={f.userId} className="border-b border-line-2 last:border-0">
              <button
                data-testid={`space-invite-row-${f.userId}`}
                onClick={() => pick(f.userId)}
                className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3 text-left"
              >
                <Avatar picture={f.picture} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-ink">{f.displayName ?? short(f.userId)}</span>
                  <span className="block truncate font-mono text-[11px] text-ink-4">{short(f.userId)}</span>
                </span>
                <Icon name={selectedId === f.userId ? 'chevron-up' : 'chevron-down'} size={17} color="var(--m-ink-4)" />
              </button>
              {selectedId === f.userId && (
                <div className="flex flex-col gap-2 px-4 pb-3">
                  <p className="font-mono text-[11px] break-all text-ink-3" data-testid="space-invite-full-id">
                    {f.userId}
                  </p>
                  <div className="m-cap">{t('invite.roleTitle')}</div>
                  <RolePicker value={role} onChange={setRole} testIdPrefix="space-invite-role" />
                  <Button size="sm" data-testid="space-invite-send" onClick={() => void onInvite(f, role)}>
                    {t('friends.send')}
                  </Button>
                </div>
              )}
            </div>
          ))}
          {matches.length === 0 && (
            <p className="px-4 py-6 text-center text-[13px] text-ink-3" data-testid="space-invite-empty">
              {t('friends.noFriendsToInvite')}
            </p>
          )}
        </div>
        {/* the friend-request door lives in the SAME sheet; global friends stay the invite guard */}
        <div className="m-cap mt-2 px-1">{t('friends.addById')}</div>
        <p className="px-1 text-[12px] text-ink-3">{t('space.inviteRequestLead')}</p>
        <FormBlockerNote show={addAttempted && !friendId.trim()} text={t('form.needId')} testId="space-addfriend-blocker" className="px-1" />
        <FormBlockerNote show={friendNotFound} text={t('friends.userNotFound')} testId="space-addfriend-notfound" className="px-1" />
        <div className="flex gap-2">
          <input
            data-testid="space-addfriend-input"
            value={friendId}
            onChange={(e) => {
              setFriendId(e.target.value);
              setFriendNotFound(false);
            }}
            placeholder={t('friends.idPlaceholder')}
            aria-invalid={(addAttempted && !friendId.trim()) || friendNotFound}
            className={`h-10 min-w-0 flex-1 rounded-input border border-line bg-surface px-3 font-mono text-[12px] text-ink outline-none placeholder:text-ink-4${blockerRing((addAttempted && !friendId.trim()) || friendNotFound)}`}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-10"
            data-testid="space-addfriend-send"
            onClick={() => void sendRequest()}
          >
            {t('friends.sendRequest')}
          </Button>
        </div>
        <RolePicker value={requestRole} onChange={setRequestRole} testIdPrefix="space-addfriend-role" />
        <p className="px-1 text-[12px] text-ink-3" data-testid="space-addfriend-autonote">
          {t('invite.autoAddNote', { space: spaceName })}
        </p>
        {requestSent && (
          <p className="px-1 text-[12px] text-accent-deep" data-testid="space-addfriend-sent">
            {t('invite.requestSent')}
          </p>
        )}
      </div>
    </Sheet>
  );
}
