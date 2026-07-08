import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLogto } from '@logto/react';
import { LANG_NAMES, LANGS, useLang } from '@/i18n';
import { logtoConfigured } from '@/app/config';
import { useSession } from '@/app/session';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Logo } from '@/ui/Logo';
import { Sheet } from '@/ui/Sheet';
import { callbackUri } from './logto';
import { addOfflineProfile, listOfflineProfiles } from './offlineProfiles';
import leafUrl from '@/assets/leaf.png';
import loginBgUrl from '@/assets/login-bg.png';

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

/** compact top-right language pill (legacy parity); code badges, no flag emoji */
function LangPill() {
  const { lang, setLang } = useLang();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        data-testid="login-lang-trigger"
        onClick={() => setOpen((v) => !v)}
        className="m-tap flex items-center gap-1.5 rounded-full border border-line bg-surface py-1.5 pr-2.5 pl-3 text-[12px] font-semibold text-ink-2 shadow-[0_2px_12px_rgba(0,0,0,0.10)]"
      >
        <span className="rounded-[4px] bg-bg-2 px-1 text-[10px] font-bold text-ink-3">{lang.toUpperCase()}</span>
        {LANG_NAMES[lang]}
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} color="var(--m-ink-3)" />
      </button>
      {open && (
        <div className="absolute top-[calc(100%+8px)] right-0 z-50 min-w-[180px] overflow-hidden rounded-card border border-line bg-surface shadow-[0_8px_32px_rgba(0,0,0,0.16)]">
          {LANGS.map((code) => (
            <button
              key={code}
              data-testid={`login-lang-${code}`}
              onClick={() => {
                setLang(code);
                setOpen(false);
              }}
              className="m-tap flex w-full items-center gap-2.5 border-b border-line-2 bg-transparent px-4 py-3 text-left text-[14px] text-ink last:border-0"
            >
              <span className="rounded-[4px] bg-bg-2 px-1 text-[10px] font-bold text-ink-3">{code.toUpperCase()}</span>
              <span className="flex-1">{LANG_NAMES[code]}</span>
              {lang === code && <Icon name="check" size={15} color="var(--m-accent)" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Login gate. With Logto configured there is exactly one real sign-in
 * button; without it, unavailable providers are hidden entirely (a grey
 * disabled wall reads as broken) and demo/offline lead.
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
    <div className="m-fade relative flex h-full flex-col overflow-y-auto bg-bg md:flex-row md:overflow-hidden" data-testid="screen-login">
      {/* logo + language: overlays the hero on mobile, spans both panes on desktop */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-5 pt-[max(12px,env(safe-area-inset-top))] md:px-8 md:pt-6">
        <div className="flex items-center gap-2.5">
          <img src={leafUrl} alt="" className="h-9 w-9 object-contain" />
          <Logo size={24} />
        </div>
        <LangPill />
      </div>

      {/* hero art: top band on mobile, full-height left pane on desktop */}
      <div className="relative flex max-h-[min(400px,44vh)] shrink-0 items-end overflow-hidden md:h-full md:max-h-none md:w-1/2 md:items-stretch lg:w-3/5">
        <img src={loginBgUrl} alt="" aria-hidden="true" className="block h-auto w-full md:h-full md:object-cover md:object-left-bottom" />
        {/* blend the art's edge into the paper background */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-b from-transparent to-bg md:inset-y-0 md:right-0 md:left-auto md:h-auto md:w-24 md:bg-gradient-to-r" />
      </div>

      {/* form pane */}
      <div className="flex flex-1 flex-col md:h-full md:items-center md:justify-center">
        <div className="flex flex-1 flex-col md:max-w-[400px] md:flex-none md:gap-2">
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center md:flex-none md:pb-6">
            <h1 className="m-h2 text-ink md:text-[32px]">{t('login.welcomeFirst')}</h1>
            <p className="max-w-[280px] text-sm text-ink-3">{t('login.subtitle')}</p>
          </div>

          <div className="flex flex-col gap-3 px-6 pb-4 md:w-[360px] md:px-0">
            {logtoConfigured && <LogtoSignInButton />}
            {logtoConfigured && (
              <div className="flex items-center gap-3 py-1">
                <div className="h-px flex-1 bg-line" />
                <span className="text-xs text-ink-4">{t('login.or')}</span>
                <div className="h-px flex-1 bg-line" />
              </div>
            )}
            <Button variant={logtoConfigured ? 'outline' : 'primary'} onClick={enterDemo} data-testid="login-demo-btn">
              <Icon name="account-eye-outline" size={18} />
              {t('login.demoUser')}
            </Button>
            <Button variant="ghost" onClick={() => setOfflineOpen(true)} data-testid="login-offline-btn">
              <Icon name="lock-outline" size={16} />
              {t('offline.loginBtn')}
            </Button>
          </div>
        </div>

        {/* offline mode: fully local profiles, zero network */}
        <Sheet open={offlineOpen} onOpenChange={setOfflineOpen} title={t('offline.infoTitle')} size="form">
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

        <p className="px-6 pb-[max(24px,env(safe-area-inset-bottom))] text-center text-[11px] text-ink-4 md:pb-8">
          {t('login.terms')}
        </p>
      </div>
    </div>
  );
}
