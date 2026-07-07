import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLogto } from '@logto/react';
import { useLang } from '@/i18n';
import { logtoConfigured } from '@/app/config';
import { useSession } from '@/app/session';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Logo } from '@/ui/Logo';
import { Sheet } from '@/ui/Sheet';
import { callbackUri } from './logto';
import { addOfflineProfile, listOfflineProfiles } from './offlineProfiles';

/** real OIDC sign-in — only rendered when Logto is configured */
function LogtoSignInButton() {
  const { t } = useLang();
  const { signIn } = useLogto();
  return (
    <Button variant="primary" data-testid="login-signin-btn" onClick={() => void signIn(callbackUri())}>
      {t('login.signIn')}
    </Button>
  );
}

/**
 * v1 login gate. Real sign-in (Logto) arrives in Phase 2 — until then the
 * demo user is the way in, exactly like the legacy prototype's demo flow.
 */
export function LoginScreen() {
  const { t } = useLang();
  const { login } = useSession();
  const navigate = useNavigate();
  const [offlineOpen, setOfflineOpen] = useState(false);
  const [profileName, setProfileName] = useState('');
  const profiles = listOfflineProfiles();

  const enterDemo = () => {
    login({ kind: 'demo' });
    void navigate({ to: '/home' });
  };

  const enterOffline = (profileId: string) => {
    login({ kind: 'offline', profileId });
    void navigate({ to: '/home' });
  };

  const createOffline = () => {
    if (!profileName.trim()) return;
    enterOffline(addOfflineProfile(profileName).id);
  };

  return (
    <div className="m-fade flex h-full flex-col items-center bg-bg px-6" data-testid="screen-login">
      {/* constrain to a phone-ish column on desktop */}
      <div className="flex h-full w-full max-w-[420px] flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <Logo size={44} />
        <h1 className="m-h2 mt-4 text-ink">{t('login.welcomeFirst')}</h1>
        <p className="max-w-[280px] text-sm text-ink-3">{t('login.subtitle')}</p>
      </div>

      <div className="flex flex-col gap-3 pb-4">
        {logtoConfigured ? (
          <LogtoSignInButton />
        ) : (
          <>
            <Button variant="primary" disabled data-testid="login-google-btn">
              {t('login.google')}
            </Button>
            <Button variant="primary" disabled data-testid="login-apple-btn">
              {t('login.apple')}
            </Button>
          </>
        )}
        <div className="flex items-center gap-3 py-1">
          <div className="h-px flex-1 bg-line" />
          <span className="text-xs text-ink-4">{t('login.or')}</span>
          <div className="h-px flex-1 bg-line" />
        </div>
        <Button variant="outline" onClick={enterDemo} data-testid="login-demo-btn">
          <Icon name="account-eye-outline" size={18} />
          {t('login.demoUser')}
        </Button>
        <Button variant="ghost" onClick={() => setOfflineOpen(true)} data-testid="login-offline-btn">
          <Icon name="lock-outline" size={16} />
          {t('offline.loginBtn')}
        </Button>
      </div>

      {/* offline mode: fully local profiles, zero network */}
      <Sheet open={offlineOpen} onOpenChange={setOfflineOpen} title={t('offline.infoTitle')} height={460}>
        <p className="pb-3 text-[13px] text-ink-3">{t('offline.infoSubtitle')}</p>
        {profiles.length > 0 && (
          <div className="mb-3 overflow-hidden rounded-card border border-line bg-surface" data-testid="offline-profiles">
            {profiles.map((p) => (
              <button
                key={p.id}
                data-testid={`offline-profile-${p.id}`}
                onClick={() => enterOffline(p.id)}
                className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3 text-left text-[14px] text-ink"
              >
                <Icon name="account-lock-outline" size={19} color="var(--m-ink-3)" />
                <span className="flex-1 truncate">{p.name}</span>
                <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            data-testid="offline-name"
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
            placeholder={t('login.namePlaceholder')}
            className="h-11 min-w-0 flex-1 rounded-input border border-line bg-surface px-4 text-[14px] text-ink outline-none placeholder:text-ink-4"
          />
          <Button size="sm" className="h-11" data-testid="offline-create" onClick={createOffline} disabled={!profileName.trim()}>
            {t('offline.addProfile')}
          </Button>
        </div>
      </Sheet>

      <p className="pb-[max(24px,env(safe-area-inset-bottom))] text-center text-[11px] text-ink-4">
        {t('login.terms')}
      </p>
      </div>
    </div>
  );
}
