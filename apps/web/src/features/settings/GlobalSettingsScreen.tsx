import { useEffect, useState } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { apiFetch, getApiCapabilities } from '@/lib/api';
import { LOCALES, useLang } from '@/i18n';
import type { Lang } from '@/i18n';
import { useTheme } from '@/app/theme';
import { useSession } from '@/app/session';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Pill, Row } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { disablePush, enablePush, getPushSubscription, pushSupported } from '@/lib/push';
import {
  biometricAvailable,
  hashPin,
  randomSalt,
  readLockConfig,
  registerBiometric,
  validPin,
  writeLockConfig,
} from '@/features/lock/lock';

const LANGS: { code: Lang; labelKey: 'lang.en' | 'lang.nl' | 'lang.tr'; badge: string }[] = [
  { code: 'en', labelKey: 'lang.en', badge: 'EN' },
  { code: 'nl', labelKey: 'lang.nl', badge: 'NL' },
  { code: 'tr', labelKey: 'lang.tr', badge: 'TR' },
];

/**
 * Everything that is NOT scoped to a space lives here, behind a single
 * "Global settings" door on the Settings tab (user feedback: mixing
 * space-scoped and app-wide rows in one list was confusing).
 */
export function GlobalSettingsScreen() {
  const { t, lang, setLang } = useLang();
  const { theme, toggle } = useTheme();
  const [langSheetOpen, setLangSheetOpen] = useState(false);
  const identity = useSession((s) => s.identity);
  const navigate = useNavigate();
  const router = useRouter();
  const [gcAvailable, setGcAvailable] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [connections, setConnections] = useState<
    { gcAccountId: string; iban: string; lastFetchAt: string | null }[] | null
  >(null);
  const [vapidKey, setVapidKey] = useState('');
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [lockOn, setLockOn] = useState(() => readLockConfig() !== null);
  const [lockSheetOpen, setLockSheetOpen] = useState(false);
  const [lockPin, setLockPin] = useState('');
  const [lockPin2, setLockPin2] = useState('');
  const [lockTimeout, setLockTimeout] = useState(60);
  const [lockBioAvailable, setLockBioAvailable] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);

  useEffect(() => {
    if (identity?.kind !== 'user') return;
    void getApiCapabilities().then((caps) => {
      setGcAvailable(caps.gocardless);
      if (caps.push && caps.vapidPublicKey && pushSupported()) setVapidKey(caps.vapidPublicKey);
    });
    void getPushSubscription().then((sub) => setPushOn(!!sub));
  }, [identity?.kind]);

  const toggleLock = async () => {
    if (lockOn) {
      // the user already proved themself at unlock time — direct disable
      writeLockConfig(null);
      setLockOn(false);
      return;
    }
    setLockPin('');
    setLockPin2('');
    setLockTimeout(60);
    setLockError(null);
    setLockBioAvailable(await biometricAvailable());
    setLockSheetOpen(true);
  };

  const saveLock = async () => {
    if (!validPin(lockPin)) return;
    if (lockPin !== lockPin2) {
      setLockError(t('lock.pinMismatch'));
      return;
    }
    // biometrics are best-effort: cancelled/unsupported leaves PIN-only
    const credentialId = lockBioAvailable ? await registerBiometric() : null;
    const pinSalt = randomSalt();
    writeLockConfig({
      enabled: true,
      credentialId: credentialId ?? undefined,
      pinSalt,
      pinHash: await hashPin(lockPin, pinSalt),
      timeoutSec: lockTimeout,
    });
    setLockOn(true);
    setLockSheetOpen(false);
  };

  const togglePush = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      if (pushOn) {
        await disablePush();
        setPushOn(false);
      } else {
        setPushOn(await enablePush(vapidKey));
      }
    } finally {
      setPushBusy(false);
    }
  };

  const openConnections = () => {
    setConnectionsOpen(true);
    void apiFetch('/gocardless/connections')
      .then(async (res) => (res.ok ? setConnections(await res.json()) : setConnections([])))
      .catch(() => setConnections([]));
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-settings-global">
      <AppBar
        title={t('settings.global')}
        leading={
          <IconButton label={t('action.back')} testId="settingsglobal-back" onClick={() => router.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {/* spaces moved here from the tab bar — day-to-day switching
              happens via the Home avatar, management is a settings task */}
          <Row testId="settings-spaces-row" icon="account-group-outline" title={t('screen.spaces')} onClick={() => void navigate({ to: '/spaces' })} />
          <Row testId="settings-accounts-row" icon="bank-outline" title={t('acct.financialAccounts')} onClick={() => void navigate({ to: '/accounts' })} />
          {identity?.kind === 'user' && (
            <Row testId="settings-friends-row" icon="account-multiple-outline" title={t('settings.friends')} onClick={() => void navigate({ to: '/friends' })} />
          )}
          {gcAvailable && (
            <Row testId="settings-connections-row" icon="bank-transfer" title={t('gc.connections')} onClick={openConnections} />
          )}
          <Row
            testId="settings-language-row"
            icon="translate"
            title={t('settings.language')}
            trailing={
              <span className="rounded-md bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-3">
                {lang.toUpperCase()}
              </span>
            }
            onClick={() => setLangSheetOpen(true)}
          />
          <Row testId="settings-shopping-row" icon="storefront-outline" title={t('shop.title')} onClick={() => void navigate({ to: '/shopping' })} />
          <Row testId="settings-help-row" icon="school-outline" title={t('help.title')} onClick={() => void navigate({ to: '/help' })} />
          {vapidKey && (
            <Row
              testId="settings-push-toggle"
              icon={pushOn ? 'bell-ring-outline' : 'bell-outline'}
              title={t('settings.notifications')}
              sub={
                typeof Notification !== 'undefined' && Notification.permission === 'denied'
                  ? t('push.denied')
                  : t('push.sub')
              }
              chevron={false}
              disabled={pushBusy}
              trailing={
                <Pill tone={pushOn ? 'accent' : 'neutral'} testId="settings-push-state">
                  {pushOn ? 'ON' : 'OFF'}
                </Pill>
              }
              onClick={() => void togglePush()}
            />
          )}
          <Row
            testId="settings-lock-toggle"
            icon={lockOn ? 'lock' : 'lock-open-variant-outline'}
            title={t('lock.title')}
            sub={t('lock.sub')}
            chevron={false}
            trailing={
              <Pill tone={lockOn ? 'accent' : 'neutral'} testId="settings-lock-state">
                {lockOn ? 'ON' : 'OFF'}
              </Pill>
            }
            onClick={() => void toggleLock()}
          />
          <Row
            testId="settings-theme-toggle"
            icon={theme === 'dark' ? 'weather-night' : 'weather-sunny'}
            title={t('settings.appearance')}
            onClick={toggle}
          />
        </div>
      </div>

      {/* Bank connections status */}
      <Sheet open={connectionsOpen} onOpenChange={setConnectionsOpen} title={t('gc.connections')} size="form">
        <p className="pb-2 text-[12px] text-ink-3">{t('gc.connectSub')}</p>
        {connections === null && <div className="py-6 text-center text-sm text-ink-3">…</div>}
        {connections?.map((c) => (
          <div key={c.gcAccountId} className="flex items-center gap-3 border-b border-line-2 px-1 py-3 last:border-0">
            <Icon name="bank-check" size={22} color="var(--m-accent)" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[13px] text-ink">{c.iban}</span>
              <span className="block text-[12px] text-ink-3">
                {t('gc.lastSync')}:{' '}
                {c.lastFetchAt
                  ? new Date(c.lastFetchAt).toLocaleString(LOCALES[lang], {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : t('gc.never')}
              </span>
            </span>
          </div>
        ))}
      </Sheet>

      {/* App lock setup: backup PIN + re-lock timeout (+ biometrics when available) */}
      <Sheet open={lockSheetOpen} onOpenChange={setLockSheetOpen} title={t('lock.setup')} size="form">
        <div className="flex flex-col gap-3 pt-1">
          {!lockBioAvailable && <p className="text-[12px] text-ink-3">{t('lock.notSupported')}</p>}
          <input
            data-testid="lock-setup-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={lockPin}
            onChange={(e) => setLockPin(e.target.value.replaceAll(/\D/g, ''))}
            placeholder={t('lock.pinLabel')}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
          />
          <input
            data-testid="lock-setup-pin2"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={lockPin2}
            onChange={(e) => setLockPin2(e.target.value.replaceAll(/\D/g, ''))}
            placeholder={t('lock.pinConfirm')}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
          />
          <div className="m-cap px-1">{t('lock.timeout')}</div>
          <div className="flex gap-2">
            {[0, 60, 300, 900].map((seconds) => (
              <button
                key={seconds}
                data-testid={`lock-timeout-${seconds}`}
                onClick={() => setLockTimeout(seconds)}
                className={`m-tap flex-1 rounded-full border px-2 py-1.5 text-[11px] ${
                  lockTimeout === seconds
                    ? 'border-accent bg-accent-soft font-medium text-accent-deep'
                    : 'border-line bg-surface text-ink-2'
                }`}
              >
                {t(`lock.timeout.${seconds}` as Parameters<typeof t>[0])}
              </button>
            ))}
          </div>
          {lockError && (
            <p className="text-center text-[13px] text-negative" data-testid="lock-setup-error">
              {lockError}
            </p>
          )}
          <Button data-testid="lock-setup-save" onClick={() => void saveLock()} disabled={!validPin(lockPin)}>
            {t('action.save')}
          </Button>
        </div>
      </Sheet>

      <Sheet open={langSheetOpen} onOpenChange={setLangSheetOpen} title={t('lang.title')}>
        <div className="flex flex-col pt-1">
          {LANGS.map((entry) => (
            <button
              key={entry.code}
              data-testid={`lang-option-${entry.code}`}
              onClick={() => {
                setLang(entry.code);
                setLangSheetOpen(false);
              }}
              className="m-tap flex items-center gap-3 border-none bg-transparent px-1 py-3.5 text-left text-[15px] text-ink"
            >
              <span className="rounded-md bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-3">
                {entry.badge}
              </span>
              <span className="flex-1">{t(entry.labelKey)}</span>
              {lang === entry.code && <Icon name="check" size={18} color="var(--m-accent)" />}
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}
