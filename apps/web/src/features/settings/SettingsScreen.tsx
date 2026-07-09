import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { apiFetch, getApiCapabilities } from '@/lib/api';
import { config } from '@/app/config';
import { LOCALES, useLang } from '@/i18n';
import type { Lang } from '@/i18n';
import { useTheme } from '@/app/theme';
import { destroyIdentityData, useData } from '@/app/data';
import { OFFLINE_REASON_KEYS, useOfflineReason } from '@/app/OfflineBanner';
import { oidcSignOut } from '@/app/authToken';
import { useSession } from '@/app/session';
import { AppBar } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { setVpdebug, vpdebugEnabled } from '@/ui/ViewportDebug';
import { useLiveQuery } from 'dexie-react-hooks';
import { Avatar } from '@/features/profile/ProfileScreen';
import { disablePush, enablePush, getPushSubscription, pushSupported } from '@/lib/push';
import { LAST_SYNC_KEY } from '@/sync/engine';
import type { SyncStatus } from '@/sync/engine';
import {
  biometricAvailable,
  hashPin,
  randomSalt,
  readLockConfig,
  registerBiometric,
  validPin,
  writeLockConfig,
} from '@/features/lock/lock';

const SYNC_STATUS_KEYS = {
  idle: 'sync.synced',
  syncing: 'sync.syncing',
  offline: 'sync.offline',
  error: 'sync.error',
} as const;

/** live sync state + last successful sync — silent failures can't hide */
function SyncStatusRow() {
  const { t, lang } = useLang();
  const { db, engine } = useData();
  const [status, setStatus] = useState<SyncStatus>(engine?.getStatus() ?? 'idle');
  useEffect(() => engine?.onStatus(setStatus), [engine]);
  const lastSync = useLiveQuery(async () => (await db.meta.get(LAST_SYNC_KEY))?.value as number | undefined, []);
  const offlineReason = useOfflineReason();

  if (!engine) return null;
  const healthy = status === 'idle' || status === 'syncing';
  // exactly two lines, always — the row used to grow/shrink as the status
  // flipped (idle → syncing → idle, reason appearing), which made the
  // whole settings list jump
  const lastSyncLabel = lastSync
    ? new Date(lastSync).toLocaleString(LOCALES[lang], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : t('sync.never');
  const subLine = offlineReason ? t(OFFLINE_REASON_KEYS[offlineReason]) : `${t('sync.lastSync')}: ${lastSyncLabel}`;
  return (
    <div className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-[15px] text-ink" data-testid="settings-sync-row">
      <Icon
        name={healthy ? 'cloud-check-outline' : 'cloud-alert-outline'}
        size={20}
        color={healthy ? 'var(--m-accent)' : 'var(--m-warning)'}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate" data-testid="settings-sync-status">
          {t(SYNC_STATUS_KEYS[status])}
        </span>
        <span
          className="block truncate text-[11px]"
          style={{ color: offlineReason ? 'var(--m-warning)' : 'var(--m-ink-4)' }}
          data-testid={offlineReason ? 'settings-sync-reason' : 'settings-sync-last'}
        >
          {subLine}
        </span>
      </span>
    </div>
  );
}

function ProfileHeaderRow({ onClick }: Readonly<{ onClick: () => void }>) {
  const { t } = useLang();
  const { db } = useData();
  const profile = useLiveQuery(
    async () => (await db.meta.get('profile'))?.value as { name?: string; picture?: string } | undefined,
    [],
  );
  return (
    <button
      data-testid="settings-profile-row"
      onClick={onClick}
      className="m-tap mb-4 flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3.5 text-left"
    >
      <Avatar picture={profile?.picture} size={44} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold text-ink">{profile?.name ?? t('profile.title')}</span>
        <span className="block text-[12px] text-ink-3">{t('profile.title')}</span>
      </span>
      <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
    </button>
  );
}

const LANGS: { code: Lang; labelKey: 'lang.en' | 'lang.nl' | 'lang.tr'; badge: string }[] = [
  { code: 'en', labelKey: 'lang.en', badge: 'EN' },
  { code: 'nl', labelKey: 'lang.nl', badge: 'NL' },
  { code: 'tr', labelKey: 'lang.tr', badge: 'TR' },
];

export function SettingsScreen() {
  const { t, lang, setLang } = useLang();
  const { theme, toggle } = useTheme();
  const [langSheetOpen, setLangSheetOpen] = useState(false);
  const { identity, logout } = useSession();
  const navigate = useNavigate();
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
  const [vpdebugOn, setVpdebugOn] = useState(vpdebugEnabled);

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

  const signOut = async () => {
    const current = identity;
    logout();
    // user identities keep local data (sync is the source of truth);
    // offline profiles keep their data too (this device IS the truth) —
    // only the demo resets to its pristine dataset on sign-out
    if (current?.kind === 'user') {
      if (!current.testAuth && (await oidcSignOut(window.location.origin))) return; // full OIDC logout redirects
      await navigate({ to: '/login' });
      return;
    }
    await navigate({ to: '/login' });
    if (current?.kind === 'demo') await destroyIdentityData(current);
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-settings">
      <AppBar large title={t('screen.settings')} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <ProfileHeaderRow onClick={() => void navigate({ to: '/profile' })} />
        {identity?.kind === 'user' && (
          <div className="mb-4 overflow-hidden rounded-card border border-line bg-surface">
            <SyncStatusRow />
          </div>
        )}
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {/* spaces moved here from the tab bar — day-to-day switching
              happens via the Home avatar, management is a settings task */}
          <button
            data-testid="settings-spaces-row"
            onClick={() => void navigate({ to: '/spaces' })}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
          >
            <Icon name="account-group-outline" size={20} />
            <span className="flex-1">{t('screen.spaces')}</span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
          <div className="mx-4 h-px bg-line-2" />
          <button
            data-testid="settings-budgets-row"
            onClick={() => void navigate({ to: '/budgets' })}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
          >
            <Icon name="wallet-outline" size={20} />
            <span className="flex-1">{t('budgets.title')}</span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
          <div className="mx-4 h-px bg-line-2" />
          <button
            data-testid="settings-accounts-row"
            onClick={() => void navigate({ to: '/accounts' })}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
          >
            <Icon name="bank-outline" size={20} />
            <span className="flex-1">{t('acct.financialAccounts')}</span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
          <div className="mx-4 h-px bg-line-2" />
          <button
            data-testid="settings-categories-row"
            onClick={() => void navigate({ to: '/categories' })}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
          >
            <Icon name="shape-outline" size={20} />
            <span className="flex-1">{t('screen.categories')}</span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
          {identity?.kind === 'user' && (
            <>
              <div className="mx-4 h-px bg-line-2" />
              <button
                data-testid="settings-friends-row"
                onClick={() => void navigate({ to: '/friends' })}
                className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
              >
                <Icon name="account-multiple-outline" size={20} />
                <span className="flex-1">{t('settings.friends')}</span>
                <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
              </button>
            </>
          )}
          {gcAvailable && (
            <>
              <div className="mx-4 h-px bg-line-2" />
              <button
                data-testid="settings-connections-row"
                onClick={openConnections}
                className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
              >
                <Icon name="bank-transfer" size={20} />
                <span className="flex-1">{t('gc.connections')}</span>
                <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
              </button>
            </>
          )}
          <div className="mx-4 h-px bg-line-2" />
          <button
            data-testid="settings-language-row"
            onClick={() => setLangSheetOpen(true)}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
          >
            <Icon name="translate" size={20} />
            <span className="flex-1">{t('settings.language')}</span>
            <span className="rounded-md bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-3">
              {lang.toUpperCase()}
            </span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
          {vapidKey && (
            <>
              <div className="mx-4 h-px bg-line-2" />
              <button
                data-testid="settings-push-toggle"
                onClick={() => void togglePush()}
                disabled={pushBusy}
                className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
              >
                <Icon name={pushOn ? 'bell-ring-outline' : 'bell-outline'} size={20} />
                <span className="min-w-0 flex-1">
                  <span className="block">{t('settings.notifications')}</span>
                  <span className="block text-[11px] text-ink-4">
                    {typeof Notification !== 'undefined' && Notification.permission === 'denied'
                      ? t('push.denied')
                      : t('push.sub')}
                  </span>
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    pushOn ? 'bg-accent-soft text-accent-deep' : 'bg-bg-2 text-ink-4'
                  }`}
                  data-testid="settings-push-state"
                >
                  {pushOn ? 'ON' : 'OFF'}
                </span>
              </button>
            </>
          )}
          <div className="mx-4 h-px bg-line-2" />
          <button
            data-testid="settings-lock-toggle"
            onClick={() => void toggleLock()}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
          >
            <Icon name={lockOn ? 'lock' : 'lock-open-variant-outline'} size={20} />
            <span className="min-w-0 flex-1">
              <span className="block">{t('lock.title')}</span>
              <span className="block text-[11px] text-ink-4">{t('lock.sub')}</span>
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                lockOn ? 'bg-accent-soft text-accent-deep' : 'bg-bg-2 text-ink-4'
              }`}
              data-testid="settings-lock-state"
            >
              {lockOn ? 'ON' : 'OFF'}
            </span>
          </button>
          <div className="mx-4 h-px bg-line-2" />
          <button
            data-testid="settings-theme-toggle"
            onClick={toggle}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
          >
            <Icon name={theme === 'dark' ? 'weather-night' : 'weather-sunny'} size={20} />
            <span className="flex-1">{t('settings.appearance')}</span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
          <div className="mx-4 h-px bg-line-2" />
          {/* installed PWAs have no URL bar to pass ?vpdebug=1 — this is the
              only way to arm the overlay for a mobile layout bug report */}
          <button
            data-testid="settings-vpdebug-toggle"
            onClick={() => {
              setVpdebug(!vpdebugOn);
              setVpdebugOn(!vpdebugOn);
            }}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
          >
            <Icon name="cellphone-information" size={20} />
            <span className="min-w-0 flex-1">
              <span className="block">{t('settings.vpdebug')}</span>
              <span className="block text-[11px] text-ink-4">{t('settings.vpdebugSub')}</span>
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                vpdebugOn ? 'bg-accent-soft text-accent-deep' : 'bg-bg-2 text-ink-4'
              }`}
              data-testid="settings-vpdebug-state"
            >
              {vpdebugOn ? 'ON' : 'OFF'}
            </span>
          </button>
        </div>

        <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface">
          <button
            data-testid="settings-signout"
            onClick={() => void signOut()}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-negative"
          >
            <Icon name="logout" size={20} />
            <span className="flex-1">{t('settings.signOut')}</span>
          </button>
        </div>

        <div className="pt-6 pb-6 text-center text-[11px] text-ink-4">
          munni · v{__APP_VERSION__} · build {String(__BUILD_NUMBER__)}
          {config.channel !== 'production' && ` · ${config.channel || 'local'}`}
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
