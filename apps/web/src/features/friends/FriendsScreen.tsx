import { useCallback, useEffect, useState } from 'react';
import { useSession } from '@/app/session';
import { useLang } from '@/i18n';
import { apiFetch } from '@/lib/api';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';

interface FriendDto {
  userId: string;
  displayName: string | null;
}
interface RequestDto {
  id: string;
  fromUserId: string;
  fromName: string | null;
  toUserId: string;
  toName: string | null;
}
interface FriendsResponse {
  friends: FriendDto[];
  sentPending: RequestDto[];
  receivedPending: RequestDto[];
}

const short = (id: string) => `${id.slice(0, 8)}…`;

/** Friends management (user identities only): the gateway to shared spaces. */
export function FriendsScreen() {
  const { t } = useLang();
  // friends are server-mediated: demo/offline identities must stay fully
  // local, so the screen shows a sign-in note and makes zero network calls
  const isUser = useSession((s) => s.identity?.kind === 'user');
  const [me, setMe] = useState<{ userId: string } | null>(null);
  const [data, setData] = useState<FriendsResponse | null>(null);
  const [addId, setAddId] = useState('');
  const [copied, setCopied] = useState(false);

  const reload = useCallback(async () => {
    const res = await apiFetch('/friends');
    if (res.ok) setData((await res.json()) as FriendsResponse);
  }, []);

  useEffect(() => {
    if (!isUser) return;
    void apiFetch('/me').then(async (res) => res.ok && setMe(await res.json()));
    void reload();
  }, [reload, isUser]);

  const sendRequest = async () => {
    const id = addId.trim();
    if (!id) return;
    await apiFetch('/friends/requests', { method: 'POST', body: JSON.stringify({ toUserId: id }) });
    setAddId('');
    await reload();
  };
  const accept = async (id: string) => {
    await apiFetch(`/friends/requests/${id}/accept`, { method: 'POST' });
    await reload();
  };
  const removeFriend = async (userId: string) => {
    await apiFetch(`/friends/${userId}`, { method: 'DELETE' });
    await reload();
  };

  const copyMyId = () => {
    if (!me) return;
    void navigator.clipboard?.writeText(me.userId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const Row = ({ name, sub, children }: { name: string; sub?: string; children?: React.ReactNode }) => (
    <div className="flex items-center gap-3 border-b border-line-2 px-4 py-3 last:border-0">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-deep">
        <Icon name="account-outline" size={19} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-ink">{name}</span>
        {sub && <span className="block truncate font-mono text-[11px] text-ink-4">{sub}</span>}
      </span>
      {children}
    </div>
  );

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-friends">
      <AppBar
        title={t('settings.friends')}
        leading={
          <IconButton label={t('action.back')} testId="friends-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
      />
      {!isUser && (
        <div className="flex flex-1 items-center justify-center px-8 text-center text-[14px] text-ink-3" data-testid="friends-requires-account">
          {t('friends.requiresAccount')}
        </div>
      )}
      {isUser && (
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {/* my id */}
        <div className="mt-2 rounded-card border border-line bg-surface px-4 py-3">
          <div className="m-cap">{t('friends.myId')}</div>
          <button data-testid="friends-copy-id" onClick={copyMyId} className="m-tap mt-1 flex w-full items-center gap-2 border-none bg-transparent p-0 text-left">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2">{me?.userId ?? '…'}</span>
            <Icon name={copied ? 'check' : 'content-copy'} size={16} color={copied ? 'var(--m-accent)' : 'var(--m-ink-4)'} />
          </button>
        </div>

        {/* add by id */}
        <div className="m-cap mt-5 mb-1 px-1">{t('friends.addById')}</div>
        <div className="flex gap-2">
          <input
            data-testid="friends-add-input"
            value={addId}
            onChange={(e) => setAddId(e.target.value)}
            placeholder={t('friends.idPlaceholder')}
            className="h-11 min-w-0 flex-1 rounded-input border border-line bg-surface px-4 font-mono text-[13px] text-ink outline-none placeholder:text-ink-4"
          />
          <Button size="sm" className="h-11" data-testid="friends-add-send" onClick={() => void sendRequest()} disabled={!addId.trim()}>
            {t('action.add')}
          </Button>
        </div>

        {/* received */}
        {(data?.receivedPending.length ?? 0) > 0 && (
          <>
            <div className="m-cap mt-5 mb-1 px-1">{t('friends.pendingReceived')}</div>
            <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="friends-received">
              {data!.receivedPending.map((r) => (
                <Row key={r.id} name={r.fromName ?? short(r.fromUserId)} sub={short(r.fromUserId)}>
                  <Button size="sm" data-testid={`friends-accept-${r.id}`} onClick={() => void accept(r.id)}>
                    {t('friends.accept')}
                  </Button>
                  <button aria-label={t('friends.decline')} onClick={() => void removeFriend(r.fromUserId)} className="m-tap border-none bg-transparent text-ink-4">
                    <Icon name="close" size={18} />
                  </button>
                </Row>
              ))}
            </div>
          </>
        )}

        {/* sent */}
        {(data?.sentPending.length ?? 0) > 0 && (
          <>
            <div className="m-cap mt-5 mb-1 px-1">{t('friends.pendingSent')}</div>
            <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="friends-sent">
              {data!.sentPending.map((r) => (
                <Row key={r.id} name={r.toName ?? short(r.toUserId)} sub={short(r.toUserId)}>
                  <Icon name="clock-outline" size={16} color="var(--m-ink-4)" />
                </Row>
              ))}
            </div>
          </>
        )}

        {/* friends */}
        <div className="m-cap mt-5 mb-1 px-1">{t('settings.friends')}</div>
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="friends-list">
          {(data?.friends ?? []).map((f) => (
            <Row key={f.userId} name={f.displayName ?? short(f.userId)} sub={short(f.userId)}>
              <button aria-label={t('action.delete')} data-testid={`friends-remove-${f.userId}`} onClick={() => void removeFriend(f.userId)} className="m-tap border-none bg-transparent text-ink-4">
                <Icon name="account-remove-outline" size={18} />
              </button>
            </Row>
          ))}
          {data && data.friends.length === 0 && (
            <div className="px-4 py-6 text-center text-[13px] text-ink-3">{t('friends.empty')}</div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
