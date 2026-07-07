import { useNavigate } from '@tanstack/react-router';
import { useLogto } from '@logto/react';
import { useLang } from '@/i18n';
import { logtoConfigured } from '@/app/config';
import { useSession } from '@/app/session';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Logo } from '@/ui/Logo';
import { callbackUri } from './logto';

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

  const enterDemo = () => {
    login({ kind: 'demo' });
    void navigate({ to: '/home' });
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
      </div>

      <p className="pb-[max(24px,env(safe-area-inset-bottom))] text-center text-[11px] text-ink-4">
        {t('login.terms')}
      </p>
      </div>
    </div>
  );
}
