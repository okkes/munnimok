import { useEffect, useState } from 'react';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { Avatar } from '@/features/profile/ProfileScreen';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { SearchField } from '@/ui/SearchField';
import { Sheet } from '@/ui/Sheet';
import type { SpaceRole } from './SpaceSharing';

export interface InvitableFriend {
  userId: string;
  displayName: string | null;
  picture?: string | null;
}

const short = (id: string) => `${id.slice(0, 8)}…`;
// picker order (#171): the default first, the powerful role last
const PICKER_ROLES: SpaceRole[] = ['contributor', 'reader', 'owner'];

/** #171: the shared three-role control (invite flow, member sheet, new-person block) */
export function RolePicker({
  value,
  onChange,
  testIdPrefix,
}: Readonly<{
  value: SpaceRole;
  onChange: (role: SpaceRole) => void;
  testIdPrefix: string;
}>) {
  const { t } = useLang();
  return (
    <div className="flex gap-1 rounded-input border border-line bg-surface p-1">
      {PICKER_ROLES.map((role) => (
        <button
          key={role}
          data-testid={`${testIdPrefix}-${role}`}
          aria-pressed={value === role}
          onClick={() => onChange(role)}
          className={`m-tap flex-1 rounded-lg border-none px-2 py-1.5 text-[12px] ${
            value === role ? 'bg-accent-soft font-medium text-accent-deep' : 'bg-transparent text-ink-3'
          }`}
        >
          {t(`space.role.${role}` as TranslationKey)}
        </button>
      ))}
    </div>
  );
}

/**
 * #170/#171: inviting an existing friend into a space — search the
 * invitable friends, expand one to see their FULL id, pick the role
 * UP FRONT (contributor preselected) and send.
 */
export function InviteFriendSheet({
  open,
  onOpenChange,
  friends,
  onInvite,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  friends: InvitableFriend[];
  onInvite: (friend: InvitableFriend, role: SpaceRole) => void | Promise<void>;
}>) {
  const { t } = useLang();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [role, setRole] = useState<SpaceRole>('contributor');
  // every open starts fresh: empty search, nothing expanded, default role
  useEffect(() => {
    if (open) {
      setSearch('');
      setSelectedId(null);
      setRole('contributor');
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

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('space.addMember')} size="tall">
      <div className="flex flex-col gap-3 pt-1">
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
      </div>
    </Sheet>
  );
}
