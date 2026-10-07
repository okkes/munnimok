import { useEffect, useState } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { useLogto } from '@logto/react';
import { useLang } from '@/i18n';
import { localCaUrl, logtoConfigured } from '@/app/config';
import { reportError } from '@/lib/report';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Logo } from '@/ui/Logo';
import { callbackUri } from './logto';
import leafUrl from '@/assets/leaf.png';

/** live navigator.onLine — the login screen's hook, kept local on purpose
 *  (that file changes by one line for the invitation feature) */
function useOnLine(): boolean {
  const [onLine, setOnLine] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnLine(navigator.onLine);
    for (const event of ['online', 'offline']) window.addEventListener(event, update);
    return () => {
      for (const event of ['online', 'offline']) window.removeEventListener(event, update);
    };
  }, []);
  return onLine;
}

/**
 * The accept button in its own component: useLogto throws outside the
 * provider, and the provider exists only with Logto configured.
 */
function InviteAccept({ token, email, onLine }: Readonly<{ token: string; email: string; onLine: boolean }>) {
  const { t } = useLang();
  const { signIn } = useLogto();
  const [failed, setFailed] = useState<string | null>(null);
  const caUrl = localCaUrl();
  const accept = () => {
    setFailed(null);
    // Logto verifies the one-time token, registers the invitee by e-mail
    // (even with sign-up closed) or signs the existing account in, and
    // returns through the normal callback. The SDK's default clearTokens
    // makes it a fresh sign-in even with someone signed in on this device
    // — another person's invitation or the same one, either way. A
    // rejected signIn is named on screen AND reported (the login screen's
    // rule: a native user has no devtools).
    signIn({ redirectUri: callbackUri(), extraParams: { one_time_token: token, login_hint: email } }).catch((err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError('auth', e);
      setFailed(e.message || e.name);
    });
  };
  return (
    <>
      <Button variant="primary" data-testid="invite-accept" disabled={!onLine} onClick={accept}>
        {t('invite.accept')}
      </Button>
      {!onLine && (
        <p className="flex items-center justify-center gap-1.5 text-center text-[12px] text-ink-3" data-testid="invite-offline-note">
          <Icon name="wifi-off" size={13} color="var(--m-warning)" />
          {t('login.offlineNote')}
        </p>
      )}
      {failed !== null && (
        <p className="text-center text-[12px] leading-relaxed text-ink-3" data-testid="invite-accept-error">
          <Icon name="alert-circle-outline" size={13} color="var(--m-warning)" /> {t('login.signInFailed')} {failed}
          {caUrl ? ` — ${t('login.signInFailedCaHint')}` : ''}
        </p>
      )}
    </>
  );
}

/**
 * The landing of an invitation mail (Logto's magic link): /invite?token=…&email=…,
 * bounced into the hash router by main.tsx. The single-use token is spent on
 * the person's TAP alone — a mail gateway that follows links with JavaScript
 * would burn it on landing — and the normal sign-in callback finishes the
 * account. Public: the invitee has no account yet. A plain route, so the
 * browser's back button works by itself.
 */
export function InviteScreen() {
  const { t } = useLang();
  const { token, email } = useSearch({ strict: false }) as { token?: string; email?: string };
  const onLine = useOnLine();
  // without Logto there is no sign-in to accept into (local builds) — the
  // link is as unusable as an incomplete one
  const invite = token && email && logtoConfigured ? { token, email } : null;

  return (
    <div className="m-fade flex h-full flex-col overflow-y-auto bg-bg" data-testid="screen-invite">
      <div className="mx-auto flex w-full max-w-[480px] flex-1 flex-col px-6 pb-[max(24px,env(safe-area-inset-bottom))]">
        {/* the login screen's wordmark */}
        <div className="flex items-center gap-2.5 pt-[max(12px,env(safe-area-inset-top))]">
          <img src={leafUrl} alt="" className="h-9 w-9 object-contain" />
          <Logo size={24} />
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft">
            <Icon name={invite ? 'email-check-outline' : 'email-alert-outline'} size={26} color="var(--m-accent-deep)" />
          </span>
          <h1 className="m-h2 text-ink">{t('invite.title')}</h1>
          {invite ? (
            <p className="max-w-[320px] text-sm text-ink-3" data-testid="invite-body">
              {t('invite.body', { email: invite.email })}
            </p>
          ) : (
            <p className="max-w-[320px] text-sm text-ink-3" data-testid="invite-invalid">
              {t('invite.invalid')}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3 pb-4">
          {invite && <InviteAccept token={invite.token} email={invite.email} onLine={onLine} />}
          <Link
            to="/login"
            data-testid="invite-not-now"
            className="m-tap inline-flex h-12 items-center justify-center text-[14px] font-medium text-ink-3 underline"
          >
            {t('invite.notNow')}
          </Link>
        </div>
      </div>
    </div>
  );
}
