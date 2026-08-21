import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { useData } from '@/app/data';
import { logActivity } from '@/application/activity';
import { ensureSpaceShared, healSharedKind, stampJoinedSharedSpace } from '@/application/spaces';
import { apiFetch } from '@/lib/api';
import { useServerRefresh } from '@/lib/serverEvents';
import { Avatar } from '@/features/profile/ProfileScreen';
import { postFriendRequest } from '@/features/friends/sendFriendRequest';
import { Button } from '@/ui/Button';
import { FormBlockerNote, blockerRing } from '@/ui/FormBlockerNote';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { InviteFriendSheet, RolePicker } from './InviteFriendSheet';
import { MemberSheet } from './MemberSheet';

export type SpaceRole = 'owner' | 'contributor' | 'reader';

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
/** #291: a sent friend request as GET /friends reports it */
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

/**
 * The signed-in user's role in a space. Non-synced identities (demo,
 * offline) own everything they see; while the members call is in
 * flight — or offline — we optimistically assume owner, matching the
 * server's enforcement as the real gate.
 */
export function useMyRole(spaceId: string | undefined, syncing: boolean): SpaceRole {
  const { store, repo } = useData();
  const [role, setRole] = useState<SpaceRole>('owner');
  useEffect(() => {
    setRole('owner');
    if (!syncing || !spaceId) return;
    void (async () => {
      const [membersRes, meRes] = await Promise.all([
        apiFetch(`/spaces/${spaceId}/members`).catch(() => null),
        apiFetch('/me').catch(() => null),
      ]);
      if (!membersRes?.ok || !meRes?.ok) return;
      const members = (await membersRes.json()) as MemberDto[];
      // #277 r2: every members fetch is a chance to heal a joiner's (or
      // pre-flip owner's) row that never learned it is shared
      void healSharedKind(store, repo, spaceId, members);
      const me = ((await meRes.json()) as { userId: string }).userId;
      const mine = members.find((m) => m.userId === me)?.role;
      if (mine) setRole(mine);
    })();
  }, [spaceId, syncing, store, repo]);
  return role;
}

/**
 * Self-removal from a shared space: the server drops the membership
 * FIRST (that instantly revokes read access to every financial account
 * attached through the space — feed access derives from membership),
 * then the local copy is purged and the active space moves on.
 */
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

/** Pending space invites, shown at the top of the Spaces tab. */
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
      // pull the new space now; #277 r2 (user): the JOINER's copy must
      // carry the shared fact too (the inviter is an owner — good enough
      // for a missing creator line)
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

/**
 * #292: the signed-in user's row reads "Me" (with their real name kept
 * quietly beside it) and wears a check mark that ONLY the authenticated
 * self row gets — a member merely NAMED "Me" shows neither mark nor
 * suffix, so nobody can pose as you.
 */
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
        {isSelf && (
          <span data-testid="member-me-icon" className="inline-flex shrink-0 text-accent-deep">
            <Icon name="account-check" size={15} />
          </span>
        )}
        <span className="min-w-0 truncate text-[14px] text-ink">
          {isSelf ? t('space.me') : (member.displayName ?? short(member.userId))}
        </span>
        {isSelf && member.displayName && (
          <span className="min-w-0 truncate text-[12px] text-ink-4">· {member.displayName}</span>
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
  /** reports the current user's role once members are loaded */
  onMyRole?: (role: SpaceRole) => void;
  /** called after this user left the space (sheet should close) */
  onLeft?: () => void;
}

/** Members, roles + invite-a-friend for the space settings sheet (user identities). */
export function SpaceMembersSection({ spaceId, spaceName, onMyRole, onLeft }: SpaceMembersSectionProps) {
  const { t } = useLang();
  const { store, repo, engine, setActiveSpace, spaceId: activeSpaceId } = useData();
  // the private lock (arc 4): a locked space renders the invite tools as
  // an explainer — unlocking is an explicit owner act in space settings
  const spaceRow = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const locked = spaceRow?.inviteLock === 1;
  const [members, setMembers] = useState<MemberDto[] | null>(null);
  const [friends, setFriends] = useState<FriendDto[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingInviteDto[]>([]);
  // #291: friend requests sent from HERE, still waiting for their yes
  const [pendingFriends, setPendingFriends] = useState<SentFriendRequestDto[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [friendId, setFriendId] = useState('');
  // #169: the new person's role in THIS space, picked up front
  const [newFriendRole, setNewFriendRole] = useState<SpaceRole>('contributor');
  // #195: Send stays enabled — an empty click says why instead
  const [addAttempted, setAddAttempted] = useState(false);
  // #291: the id pointed at nobody — a field-level error, not a log line
  const [friendNotFound, setFriendNotFound] = useState(false);
  const [friendRequestSent, setFriendRequestSent] = useState(false);
  const [inviteSentTo, setInviteSentTo] = useState<string | null>(null);
  // #170/#171: the invite-a-friend sheet (search + role, replaces the badges)
  const [inviteOpen, setInviteOpen] = useState(false);
  // #172: the tapped member's sheet — held by ID so reloads keep it fresh
  // and a kicked member's sheet closes on its own
  const [memberSheetId, setMemberSheetId] = useState<string | null>(null);
  // removing someone is disruptive (they lose the shared accounts too) —
  // the door only opens a confirm sheet, the sheet does the removal
  const [kickTarget, setKickTarget] = useState<MemberDto | null>(null);

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
      // #291: requests sent from this surface pend HERE too — the carried
      // space name is the only key the payload offers
      setPendingFriends((payload.sentPending ?? []).filter((r) => r.spaceName === spaceName));
    }
    if (meRes?.ok) setMe(((await meRes.json()) as { userId: string }).userId);
    if (outgoingRes?.ok) setOutgoing((await outgoingRes.json()) as OutgoingInviteDto[]);
    // #277 r2 (after the state lands): 2+ members = shared, whatever the
    // local row still says — both sides may run this heal (idempotent LWW)
    if (list) await healSharedKind(store, repo, spaceId, list);
  }, [spaceId, spaceName, store, repo]);
  useEffect(() => void reload(), [reload]);
  // an accepted invite shows up while you're looking at the member list
  useServerRefresh(reload);

  const myRole = members?.find((m) => m.userId === me)?.role;
  useEffect(() => {
    if (myRole) onMyRole?.(myRole);
  }, [myRole, onMyRole]);

  if (members === null) return null; // not a member / offline — hide section
  const isOwner = myRole === 'owner';
  const memberIds = new Set(members.map((m) => m.userId));
  const pendingIds = new Set(outgoing.map((i) => i.toUserId));
  const invitable = friends.filter((f) => !memberIds.has(f.userId) && !pendingIds.has(f.userId));

  // inviting someone makes this a shared space: category adoption + the
  // kind flip live in ensureSpaceShared now (#277 r2 — the joiner-side
  // stamp and the members-fetch heal share the same machinery)
  const ensureShared = async () => {
    if (await ensureSpaceShared(store, repo, spaceId)) {
      void logActivity(store, repo, spaceId, 'spaceShare', spaceName);
    }
  };
  // #171: the role travels with the invite — picked in the sheet up front
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
    await reload();
  };
  // #169: one shot — the friend request carries this space and the
  // picked role, so accepting it also joins them here
  const addFriend = async () => {
    const toUserId = friendId.trim();
    if (!toUserId) {
      setAddAttempted(true);
      return;
    }
    setAddAttempted(false);
    const outcome = await postFriendRequest({ toUserId, spaceId, role: newFriendRole, spaceName });
    // #291: 404 = nobody owns that id — the field says so and keeps the
    // typed id for fixing; "sent" is only claimed when it really was
    setFriendNotFound(outcome === 'notFound');
    setFriendRequestSent(outcome === 'sent');
    if (outcome === 'sent') {
      void logActivity(store, repo, spaceId, 'memberInvite', short(toUserId));
      await ensureShared();
      setFriendId('');
      setNewFriendRole('contributor');
    }
    // if they had already requested me, the server auto-accepts (the
    // space intent becomes a regular invite) and the reload shows it
    await reload();
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
        {/* #172: the row opens the member's sheet — role control and
            removal live there now (read-only info for non-owners).
            #292: self is matched on the authenticated id, never the name */}
        {members.map((m) => (
          <MemberRow key={m.userId} member={m} isSelf={m.userId === me} onOpen={setMemberSheetId} />
        ))}
      </div>
      {isOwner && (outgoing.length > 0 || pendingFriends.length > 0) && (
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
                  <span className="block truncate text-[12px] text-ink-4">{t('space.invitePending')}</span>
                </span>
                <button
                  aria-label={t('action.delete')}
                  data-testid={`space-invite-revoke-${invitation.id}`}
                  onClick={() => void revokeInvite(invitation.id)}
                  className="m-tap border-none bg-transparent text-ink-4"
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            ))}
            {/* #291: friend requests sent from here wait HERE too — the
                person becomes a member the moment they accept */}
            {pendingFriends.map((request) => (
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
      {isOwner && locked && (
        <div className="mt-3 flex items-start gap-3 rounded-card border border-line bg-bg-2 px-4 py-3" data-testid="space-invite-locked">
          <Icon name="lock-outline" size={18} color="var(--m-ink-3)" />
          <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink-3">
            {t('space.inviteLockedBody')}
          </span>
        </div>
      )}
      {isOwner && !locked && (
        <>
          <div className="m-cap mt-3 mb-1 px-1">{t('space.addMember')}</div>
          {inviteSentTo && (
            <p className="mb-2 flex items-center gap-1.5 px-1 text-[12px] text-accent-deep" data-testid="space-invite-sent">
              <Icon name="check-circle-outline" size={14} />
              {t('space.spaceInviteSent', { name: inviteSentTo })}
            </p>
          )}
          {/* #170: one door — the sheet searches friends and asks the
              role up front (the instant-invite badges died with it) */}
          <Button variant="outline" className="w-full" data-testid="space-invite-open" onClick={() => setInviteOpen(true)}>
            {t('space.addMember')}
          </Button>
          {/* global friends stay the invite guard — but adding a new friend
              must not require leaving the invite flow (user decision) */}
          <div className="m-cap mt-3 mb-1 px-1">{t('friends.addById')}</div>
          <FormBlockerNote show={addAttempted && !friendId.trim()} text={t('form.needId')} testId="space-addfriend-blocker" className="mb-1 px-1" />
          {/* #291: the 404 answer lands AT the field, #195 style */}
          <FormBlockerNote show={friendNotFound} text={t('friends.userNotFound')} testId="space-addfriend-notfound" className="mb-1 px-1" />
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
              onClick={() => void addFriend()}
            >
              {t('friends.sendRequest')}
            </Button>
          </div>
          {/* #169: their role here, decided before they even accept */}
          <div className="mt-2">
            <RolePicker value={newFriendRole} onChange={setNewFriendRole} testIdPrefix="space-addfriend-role" />
          </div>
          <p className="mt-1.5 px-1 text-[12px] text-ink-3" data-testid="space-addfriend-autonote">
            {t('invite.autoAddNote', { space: spaceName })}
          </p>
          {friendRequestSent && (
            <p className="mt-1.5 px-1 text-[12px] text-accent-deep" data-testid="space-addfriend-sent">
              {t('invite.requestSent')}
            </p>
          )}
        </>
      )}
      {members.length > 1 && (
        <div className="mt-4">
          {confirmLeave && <p className="mb-2 text-[13px] text-ink-3">{t('space.leaveConfirm')}</p>}
          <Button
            variant="outline"
            className="w-full"
            data-testid="space-leave"
            onClick={() => (confirmLeave ? void leave() : setConfirmLeave(true))}
          >
            {confirmLeave ? t('action.confirm') : t('space.leave')}
          </Button>
        </div>
      )}
      {/* #170/#171: search + role, then send */}
      <InviteFriendSheet
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        friends={invitable}
        onInvite={async (friend, role) => {
          await invite(friend, role);
          setInviteOpen(false);
        }}
      />
      {/* #172: the tapped member — resolved live so a kick closes it */}
      <MemberSheet
        member={members.find((m) => m.userId === memberSheetId) ?? null}
        meIsOwner={isOwner}
        isSelf={memberSheetId === me}
        onOpenChange={(next) => !next && setMemberSheetId(null)}
        onChangeRole={(userId, role) => void changeRole(userId, role)}
        onKick={(m) => setKickTarget(m)}
      />
      {/* removal double-check (user request): the door never removes directly */}
      <Sheet open={kickTarget !== null} onOpenChange={(next) => !next && setKickTarget(null)} title={t('space.kickTitle')} size="compact">
        <div className="flex flex-col gap-4 pt-1">
          <p className="text-[14px] text-ink-2" data-testid="space-kick-body">
            {t('space.kickBody', { name: kickTarget?.displayName ?? short(kickTarget?.userId ?? '') })}
          </p>
          <Button
            variant="danger"
            data-testid="space-kick-confirm"
            onClick={() => kickTarget && void kick(kickTarget.userId)}
          >
            {t('action.confirm')}
          </Button>
          <Button variant="outline" data-testid="space-kick-cancel" onClick={() => setKickTarget(null)}>
            {t('action.cancel')}
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
