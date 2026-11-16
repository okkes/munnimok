import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLang } from '@/i18n';
import { Avatar } from '@/features/profile/ProfileScreen';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

export interface FriendProfile {
  userId: string;
  displayName: string | null;
  picture?: string | null;
}

/** #165: the remove CONFIRM stays with the caller */
export function FriendProfileSheet({
  friend,
  onOpenChange,
  onRemove,
}: Readonly<{
  friend: FriendProfile | null;
  onOpenChange: (open: boolean) => void;
  onRemove: (friend: FriendProfile) => void;
}>) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  useEffect(() => {
    setCopied(false);
    setViewerOpen(false);
  }, [friend]);

  // presets ("icon|#color") have nothing to zoom — only real pictures do
  const hasPicture = friend?.picture?.startsWith('data:') === true;
  const copyId = () => {
    if (!friend) return;
    void navigator.clipboard?.writeText(friend.userId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <Sheet open={friend !== null} onOpenChange={onOpenChange} size="form">
        <div className="flex flex-col items-center gap-3 pt-2" data-testid="friend-profile-sheet">
          {hasPicture ? (
            <button
              aria-label={t('friends.viewPicture')}
              data-testid="friend-profile-avatar"
              onClick={() => setViewerOpen(true)}
              className="m-tap border-none bg-transparent p-0"
            >
              <Avatar picture={friend?.picture} size={96} />
            </button>
          ) : (
            <Avatar picture={friend?.picture} size={96} />
          )}
          <div className="max-w-full truncate text-[17px] font-semibold text-ink">
            {friend?.displayName ?? `${friend?.userId.slice(0, 8) ?? ''}…`}
          </div>
          <div className="w-full rounded-card border border-line bg-surface px-4 py-3">
            <div className="m-cap">{t('friends.friendId')}</div>
            <button data-testid="friend-profile-copy" onClick={copyId} className="m-tap mt-1 flex w-full items-center gap-2 border-none bg-transparent p-0 text-left">
              <span className="min-w-0 flex-1 font-mono text-[12px] break-all text-ink-2 select-text" data-testid="friend-profile-id">
                {friend?.userId ?? ''}
              </span>
              <Icon name={copied ? 'check' : 'content-copy'} size={16} color={copied ? 'var(--m-accent)' : 'var(--m-ink-4)'} />
            </button>
          </div>
          <Button
            variant="danger"
            className="w-full"
            data-testid="friend-profile-remove"
            onClick={() => {
              if (friend) onRemove(friend);
            }}
          >
            {t('friends.removeFriend')}
          </Button>
        </div>
      </Sheet>
      {/* fullscreen viewer, portaled to body so sheet transforms cannot re-anchor the fixed overlay */}
      {viewerOpen &&
        hasPicture &&
        createPortal(
          <button
            aria-label={t('action.close')}
            data-testid="friend-picture-viewer"
            onClick={() => setViewerOpen(false)}
            className="fixed inset-0 z-[70] flex items-center justify-center border-none bg-black/90 p-0"
          >
            <img src={friend!.picture!} alt="" className="max-h-full max-w-full object-contain" />
          </button>,
          document.body,
        )}
    </>
  );
}
