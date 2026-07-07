import { useEffect, useState } from 'react';
import { useLogto } from '@logto/react';
import { logtoConfigured } from '@/app/config';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { getOfflineProfile, updateOfflineProfile } from '@/features/auth/offlineProfiles';
import { useLang } from '@/i18n';
import { apiFetch } from '@/lib/api';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';

/** avatar presets: "icon|color" */
export const AVATARS = [
  'account-outline|#08372B', 'emoticon-happy-outline|#3498DB', 'cat|#E67E22', 'dog|#795548',
  'rocket-launch-outline|#9B59B6', 'flower-outline|#E91E63', 'coffee-outline|#A8782B', 'bike|#27AE60',
  'gamepad-variant-outline|#E74C3C', 'music|#1ABC9C', 'book-open-outline|#2980B9', 'leaf|#16A085',
];

export function Avatar({ picture, size = 40 }: { picture?: string | null; size?: number }) {
  const [icon, color] = (picture ?? AVATARS[0]).split('|');
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full"
      style={{ width: size, height: size, background: `${color}22`, color }}
      data-testid="profile-avatar"
    >
      <Icon name={icon} size={size * 0.55} />
    </span>
  );
}

const PROFILE_META_KEY = 'profile';

interface LocalProfile {
  name?: string;
  picture?: string;
}

/**
 * Who you are: display name + avatar (shared with friends/space members
 * for signed-in users), your user id and login email. Demo and offline
 * identities keep everything on the device.
 */
export function ProfileScreen() {
  const { t } = useLang();
  const { db } = useData();
  const identity = useSession((s) => s.identity);
  const [name, setName] = useState('');
  const [picture, setPicture] = useState(AVATARS[0]);
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  // load current values per identity kind
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (identity?.kind === 'user') {
        const res = await apiFetch('/me').catch(() => null);
        if (res?.ok && !cancelled) {
          const me = (await res.json()) as { userId: string; displayName: string | null; picture: string | null };
          setName(me.displayName ?? '');
          if (me.picture) setPicture(me.picture);
          setUserId(me.userId);
        }
      } else if (identity?.kind === 'offline') {
        const profile = getOfflineProfile(identity.profileId);
        setName(profile?.name ?? '');
        if (profile?.picture) setPicture(profile.picture);
      } else {
        const stored = (await db.meta.get(PROFILE_META_KEY))?.value as LocalProfile | undefined;
        setName(stored?.name ?? 'Demo');
        if (stored?.picture) setPicture(stored.picture);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identity, db]);

  const save = async () => {
    if (!name.trim()) return;
    if (identity?.kind === 'user') {
      await apiFetch('/me', { method: 'PUT', body: JSON.stringify({ displayName: name.trim(), picture }) }).catch(
        () => undefined, // offline is fine — retried on next profile save
      );
    } else if (identity?.kind === 'offline') {
      updateOfflineProfile(identity.profileId, { name: name.trim(), picture });
    }
    // local copy for instant display everywhere (all identity kinds)
    await db.meta.put({ key: PROFILE_META_KEY, value: { name: name.trim(), picture } satisfies LocalProfile });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const copyId = () => {
    if (!userId) return;
    void navigator.clipboard?.writeText(userId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-profile">
      <AppBar
        title={t('profile.title')}
        leading={
          <IconButton label={t('action.back')} testId="profile-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="flex flex-col items-center py-5">
          <Avatar picture={picture} size={72} />
        </div>

        <div className="m-cap mb-1 px-1">{t('profile.avatar')}</div>
        <div className="grid grid-cols-6 gap-2">
          {AVATARS.map((preset) => (
            <button
              key={preset}
              data-testid={`profile-avatar-${preset.split('|')[0]}`}
              onClick={() => setPicture(preset)}
              className={`m-tap flex h-11 items-center justify-center rounded-xl border ${
                picture === preset ? 'border-accent bg-accent-soft' : 'border-line bg-surface'
              }`}
            >
              <Avatar picture={preset} size={28} />
            </button>
          ))}
        </div>

        <div className="m-cap mt-5 mb-1 px-1">{t('profile.displayName')}</div>
        <input
          data-testid="profile-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('login.fullName')}
          className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
        />

        <Button className="mt-4 w-full" data-testid="profile-save" onClick={() => void save()} disabled={!name.trim()}>
          {saved ? t('profile.saved') : t('action.save')}
        </Button>

        {identity?.kind === 'user' && (
          <div className="mt-6 overflow-hidden rounded-card border border-line bg-surface">
            <button
              data-testid="profile-copy-id"
              onClick={copyId}
              className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="m-cap block">{t('profile.userId')}</span>
                <span className="block truncate font-mono text-[12px] text-ink-2">{userId ?? '…'}</span>
              </span>
              <Icon name={copied ? 'check' : 'content-copy'} size={16} color={copied ? 'var(--m-accent)' : 'var(--m-ink-4)'} />
            </button>
            <div className="mx-4 h-px bg-line-2" />
            <div className="px-4 py-3">
              <span className="m-cap block">{t('profile.email')}</span>
              <span className="block truncate text-[13px] text-ink-2" data-testid="profile-email">
                {email ?? '—'}
              </span>
            </div>
          </div>
        )}
        {identity?.kind === 'user' && <EmailLoader onEmail={setEmail} sub={identity.sub} />}
      </div>
    </div>
  );
}

/** resolves the login email from the OIDC id token (or the test subject) */
function EmailLoader({ onEmail, sub }: { onEmail: (email: string) => void; sub: string }) {
  useEffect(() => {
    if (!logtoConfigured) onEmail(sub);
  }, [onEmail, sub]);
  if (!logtoConfigured) return null;
  return <LogtoEmailLoader onEmail={onEmail} />;
}

function LogtoEmailLoader({ onEmail }: { onEmail: (email: string) => void }) {
  const { getIdTokenClaims } = useLogto();
  useEffect(() => {
    void getIdTokenClaims().then((claims) => {
      const value = claims?.email ?? claims?.username ?? claims?.sub;
      if (value) onEmail(value);
    });
  }, [getIdTokenClaims, onEmail]);
  return null;
}
