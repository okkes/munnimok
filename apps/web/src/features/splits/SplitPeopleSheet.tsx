import { useCallback, useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { LOCALES, useLang } from '@/i18n';
import { publicOrigin } from '@/app/config';
import { useSession } from '@/app/session';
import type { SplitDetail, SplitFriendInvite, SplitLink, SplitMember, SplitsApi } from '@/application/splitsApi';
import { Avatar } from '@/features/profile/ProfileScreen';
import { apiFetch } from '@/lib/api';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import { memberName } from './splitsCore';

interface Friend {
  userId: string;
  displayName: string | null;
  picture?: string | null;
}

const ROW = 'flex items-center gap-3 py-2.5';
const QUIET = 'm-tap shrink-0 border-none bg-transparent p-0 text-[12px] font-medium';
const NUMBER = 'm-num h-10 w-20 rounded-input border border-line bg-surface px-2 text-right text-[14px] text-ink outline-none';

/** the link as a code a phone's camera reads; always dark on white — a dark theme must not invert it */
export function QrCode({ text, size = 176, label }: Readonly<{ text: string; size?: number; label: string }>) {
  const { count, path } = useMemo(() => {
    const code = qrcode(0, 'M');
    code.addData(text);
    code.make();
    const modules = code.getModuleCount();
    const dark: string[] = [];
    for (let row = 0; row < modules; row++) {
      for (let col = 0; col < modules; col++) {
        if (code.isDark(row, col)) dark.push(`M${col} ${row}h1v1h-1z`);
      }
    }
    return { count: modules, path: dark.join('') };
  }, [text]);
  return (
    <svg viewBox={`-2 -2 ${count + 4} ${count + 4}`} width={size} height={size} role="img" aria-label={label} data-testid="split-invite-qr" className="mx-auto rounded-lg">
      <rect x={-2} y={-2} width={count + 4} height={count + 4} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}

/** what a link allows, in a line: "3 of 6 used · an owner approves · until 20 November" */
function linkFacts(link: SplitLink, locale: string, t: ReturnType<typeof useLang>['t']): string {
  const parts = [
    link.maxUses > 0 ? t('splits.link.usesOf', { used: link.uses, max: link.maxUses }) : t('splits.link.uses', { used: link.uses }),
    link.needsApproval ? t('splits.link.approval') : '',
    link.expiresAt ? t('splits.link.until', { date: new Date(link.expiresAt).toLocaleDateString(locale, { day: 'numeric', month: 'long' }) }) : t('splits.link.noEnd'),
  ];
  return parts.filter(Boolean).join(' · ');
}

/** #538: a link's limits, set when it is made — how many people, whether they wait for an owner, for how long */
function LinkOptions({ busy, onCreate }: Readonly<{ busy: boolean; onCreate: (options: { maxUses: number; needsApproval: boolean; validDays: number }) => void }>) {
  const { t } = useLang();
  const [maxUses, setMaxUses] = useState('');
  const [days, setDays] = useState('');
  const [approval, setApproval] = useState(false);
  const whole = (text: string) => Math.max(0, Math.floor(Number(text) || 0));
  return (
    <div className="flex flex-col gap-2.5" data-testid="split-link-options">
      <label className="flex items-center gap-3 text-[13px] text-ink-2">
        <span className="min-w-0 flex-1">{t('splits.link.maxUses')}</span>
        <input data-testid="split-link-max" inputMode="numeric" placeholder="∞" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} className={NUMBER} />
      </label>
      <label className="flex items-center gap-3 text-[13px] text-ink-2">
        <span className="min-w-0 flex-1">{t('splits.link.validDays')}</span>
        <input data-testid="split-link-days" inputMode="numeric" placeholder="∞" value={days} onChange={(e) => setDays(e.target.value)} className={NUMBER} />
      </label>
      <label className="flex items-center gap-3 text-[13px] text-ink-2">
        <input type="checkbox" data-testid="split-link-approval" checked={approval} onChange={() => setApproval((on) => !on)} className="h-5 w-5 shrink-0 accent-[var(--m-accent-deep)]" />
        <span className="min-w-0 flex-1">{t('splits.link.needsApproval')}</span>
      </label>
      <Button data-testid="split-invite-create" disabled={busy} onClick={() => onCreate({ maxUses: Math.min(1000, whole(maxUses)), needsApproval: approval, validDays: Math.min(365, whole(days)) })}>
        {t('splits.inviteCreate')}
      </Button>
    </div>
  );
}

/** the link an owner hands out: read it, share it, replace it or stop it */
function LinkPanel({ api, splitId, splitName }: Readonly<{ api: SplitsApi; splitId: string; splitName: string }>) {
  const { t, lang } = useLang();
  const [link, setLink] = useState<SplitLink | null | 'failed'>(null);
  const [busy, setBusy] = useState(false);
  const [remaking, setRemaking] = useState(false);
  const [copied, setCopied] = useState(false);

  const read = useCallback(async () => setLink((await api.link(splitId)) ?? 'failed'), [api, splitId]);
  useEffect(() => {
    void read();
  }, [read]);

  if (link === null) return <p className="py-3 text-center text-[13px] text-ink-4">…</p>;
  if (link === 'failed') {
    return (
      <>
        <p className="text-[13px] text-warning" data-testid="split-invite-failed">
          {t('splits.inviteFailed')}
        </p>
        <Button variant="outline" data-testid="split-invite-retry" onClick={() => void read()}>
          {t('splits.joinRetry')}
        </Button>
      </>
    );
  }

  const create = async (options: { maxUses: number; needsApproval: boolean; validDays: number }) => {
    setBusy(true);
    const made = await api.newLink(splitId, options);
    setBusy(false);
    setRemaking(false);
    setCopied(false);
    setLink(made ?? 'failed');
  };
  const stop = async () => {
    setBusy(true);
    await api.endLink(splitId);
    setBusy(false);
    await read();
  };

  if (!link.token) {
    return (
      <>
        <p className="text-[12px] text-ink-4" data-testid="split-invite-none">
          {t('splits.inviteNone')}
        </p>
        <LinkOptions busy={busy} onCreate={(options) => void create(options)} />
      </>
    );
  }

  // the hosted https origin and a real path: the link must open for people on any platform, and in the app where it is installed
  const url = `${publicOrigin()}/splits/join/${link.token}`;
  const share = async () => {
    if (navigator.share) {
      await navigator.share({ title: splitName, url }).catch(() => undefined);
      return;
    }
    await navigator.clipboard?.writeText(url).catch(() => undefined);
    setCopied(true);
  };
  return (
    <>
      <QrCode text={url} label={t('splits.link.qr')} />
      <div data-testid="split-invite-link" className="w-full overflow-x-auto rounded-input border border-line bg-surface px-4 py-3 font-mono text-[12px] whitespace-nowrap text-ink-2">
        {url}
      </div>
      <p className="text-[12px] text-ink-4" data-testid="split-invite-facts">
        {linkFacts(link, LOCALES[lang], t)}
      </p>
      <Button data-testid="split-invite-share" onClick={() => void share()}>
        {copied ? t('splits.copied') : t('splits.copyLink')}
      </Button>
      {remaking ? (
        <>
          <p className="text-[12px] text-warning" data-testid="split-invite-new-note">
            {t('splits.inviteNewNote')}
          </p>
          <LinkOptions busy={busy} onCreate={(options) => void create(options)} />
        </>
      ) : (
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" data-testid="split-invite-new" onClick={() => setRemaking(true)}>
            {t('splits.inviteNew')}
          </Button>
          <Button variant="outline" className="flex-1" data-testid="split-invite-stop" disabled={busy} onClick={() => void stop()}>
            {t('splits.link.stop')}
          </Button>
        </div>
      )}
    </>
  );
}

/** the person's friends who are not in the split: ask them in, see who was asked, take an unanswered ask back */
function FriendsPanel({
  api,
  splitId,
  members,
  asked,
  onChanged,
}: Readonly<{ api: SplitsApi; splitId: string; members: readonly SplitMember[]; asked: readonly SplitFriendInvite[]; onChanged: () => Promise<void> }>) {
  const { t } = useLang();
  const { identity } = useSession();
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (identity?.kind !== 'user') {
      setFriends([]);
      return;
    }
    void (async () => {
      const res = await apiFetch('/friends').catch(() => null);
      setFriends(res?.ok ? ((await res.json()) as { friends: Friend[] }).friends : []);
    })();
  }, [identity]);

  const inSplit = new Set(members.filter((member) => member.state === 'active').map((member) => member.userId));
  const outside = (friends ?? []).filter((friend) => !inSplit.has(friend.userId));
  const act = async (key: string, run: () => Promise<boolean>) => {
    setBusy(key);
    await run();
    await onChanged();
    setBusy(null);
  };

  if (friends !== null && outside.length === 0) {
    return (
      <p className="text-[12px] text-ink-4" data-testid="split-friends-none">
        {t('splits.friends.none')}
      </p>
    );
  }
  return (
    <div className="divide-y divide-line-2" data-testid="split-friends">
      {outside.map((friend) => {
        const last = asked.find((invite) => invite.toUserId === friend.userId);
        const pending = last?.status === 'pending';
        return (
          <div key={friend.userId} className={ROW} data-testid={`split-friend-${friend.userId}`}>
            <Avatar picture={friend.picture} size={32} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] text-ink">{friend.displayName ?? t('splits.someone')}</span>
              {last && <span className="block text-[11px] text-ink-4">{t(`splits.friends.${last.status}`)}</span>}
            </span>
            {pending ? (
              <button className={`${QUIET} text-ink-3`} disabled={busy !== null} data-testid={`split-friend-cancel-${friend.userId}`} onClick={() => void act(friend.userId, () => api.cancelFriendInvite(splitId, last.id))}>
                {t('splits.friends.cancel')}
              </button>
            ) : (
              <button className={`${QUIET} text-accent-deep`} disabled={busy !== null} data-testid={`split-friend-invite-${friend.userId}`} onClick={() => void act(friend.userId, () => api.inviteFriend(splitId, friend.userId))}>
                {t(last ? 'splits.friends.again' : 'splits.friends.invite')}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * #538: the people of a split. Everybody sees who is in it and as what; an
 * owner makes others owners, takes people out (a contributor or another
 * owner), answers who waits behind an approval link, and opens the two
 * doors in — a link (with its code) and an invitation to a friend.
 */
export function SplitPeopleSheet({
  api,
  detail,
  open,
  onOpenChange,
  onChanged,
}: Readonly<{ api: SplitsApi; detail: SplitDetail; open: boolean; onOpenChange: (open: boolean) => void; onChanged: () => Promise<void> }>) {
  const { t } = useLang();
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const { split, members } = detail;
  const owner = split.role === 'owner' && split.state === 'active';
  const openSplit = split.status === 'open';

  const act = async (key: string, run: () => Promise<boolean>) => {
    setBusy(key);
    await run();
    await onChanged();
    setBusy(null);
    setRemoving(null);
  };
  const standing = (member: SplitMember): string => (member.state === 'active' ? t(`splits.role.${member.role}`) : t(`splits.state.${member.state}`));

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('splits.people.title')} size="full">
      <div className="flex flex-col gap-4 pt-1" data-testid="split-people">
        <div className="divide-y divide-line-2 rounded-card border border-line bg-surface px-3" data-testid="split-members">
          {members.map((member) => (
            <div key={member.userId} className={ROW} data-testid={`split-member-${member.userId}`} data-state={member.state}>
              <Avatar picture={member.picture} size={32} />
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-[14px] ${member.state === 'active' ? 'text-ink' : 'text-ink-4'}`}>{memberName(member, t)}</span>
                <span className="block text-[11px] text-ink-4">{standing(member)}</span>
              </span>
              {owner && !member.isMe && member.state === 'active' && (
                <>
                  {member.role === 'contributor' && (
                    <button className={`${QUIET} text-accent-deep`} disabled={busy !== null} data-testid={`split-promote-${member.userId}`} onClick={() => void act(member.userId, () => api.promote(split.id, member.userId))}>
                      {t('splits.people.promote')}
                    </button>
                  )}
                  <button
                    className={`${QUIET} text-negative`}
                    disabled={busy !== null}
                    data-testid={`split-remove-${member.userId}`}
                    onClick={() => (removing === member.userId ? void act(member.userId, () => api.removeMember(split.id, member.userId)) : setRemoving(member.userId))}
                  >
                    {t(removing === member.userId ? 'action.confirm' : 'splits.people.remove')}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>

        {owner && (detail.requests?.length ?? 0) > 0 && (
          <section data-testid="split-requests">
            <div className="m-cap mb-1 px-1">{t('splits.people.waiting')}</div>
            <div className="divide-y divide-line-2 rounded-card border border-line bg-surface px-3">
              {detail.requests?.map((request) => (
                <div key={request.id} className={ROW} data-testid={`split-request-${request.userId}`}>
                  <Avatar picture={request.picture} size={32} />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{request.displayName ?? t('splits.someone')}</span>
                  <button className={`${QUIET} text-accent-deep`} disabled={busy !== null} data-testid={`split-approve-${request.userId}`} onClick={() => void act(request.id, () => api.answerRequest(split.id, request.id, true))}>
                    {t('splits.people.approve')}
                  </button>
                  <button className={`${QUIET} text-ink-3`} disabled={busy !== null} data-testid={`split-refuse-${request.userId}`} onClick={() => void act(request.id, () => api.answerRequest(split.id, request.id, false))}>
                    {t('splits.people.refuse')}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {owner && openSplit && (
          <>
            <section className="flex flex-col gap-3" data-testid="split-invite-panel">
              <div className="m-cap px-1">{t('splits.people.link')}</div>
              <p className="px-1 text-[12px] leading-snug text-ink-4">{t('splits.inviteHint')}</p>
              <LinkPanel api={api} splitId={split.id} splitName={split.name} />
            </section>
            <section className="flex flex-col gap-2">
              <div className="m-cap px-1">{t('splits.people.friends')}</div>
              <FriendsPanel api={api} splitId={split.id} members={members} asked={detail.friendInvites ?? []} onChanged={onChanged} />
            </section>
          </>
        )}
        {!owner && openSplit && (
          <p className="px-1 text-[12px] text-ink-4" data-testid="split-people-owner-note">
            {t('splits.people.ownersInvite')}
          </p>
        )}
      </div>
    </Sheet>
  );
}
