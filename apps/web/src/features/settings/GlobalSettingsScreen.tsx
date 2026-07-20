import { useEffect, useState } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { apiFetch, getApiCapabilities } from '@/lib/api';
import { LOCALES, useLang } from '@/i18n';
import type { Lang } from '@/i18n';
import { useTheme } from '@/app/theme';
import { destroyIdentityData, useData } from '@/app/data';
import { useSession } from '@/app/session';
import { TIPS_DISABLED_KEY, useTipsDisabled } from '@/features/help/tipsPref';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Pill, Row } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { disablePush, enablePush, pushEnabled, pushSupported } from '@/lib/push';
import { isNativeApp } from '@/lib/platform';
import { config } from '@/app/config';
import { FLAG_KEY } from '@/db/openStore';
import { ExportSheet } from './ExportSheet';
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

/** three-state appearance control: light / dark / follow device */
function ThemeModeSwitch() {
  const { t } = useLang();
  const { mode, setMode } = useTheme();
  const segCls = (active: boolean) =>
    `m-tap flex items-center justify-center px-2.5 py-1 ${
      active ? 'bg-accent-soft text-accent-deep' : 'text-ink-3'
    }`;
  return (
    // no group role (S6819): each segment is a labelled aria-pressed
    // button — the span is purely a visual frame
    <span className="flex shrink-0 overflow-hidden rounded-lg border border-line-2">
      <button
        type="button"
        data-testid="settings-theme-light"
        aria-label={t('settings.themeLight')}
        aria-pressed={mode === 'light'}
        onClick={() => setMode('light')}
        className={segCls(mode === 'light')}
      >
        <Icon name="weather-sunny" size={15} />
      </button>
      <button
        type="button"
        data-testid="settings-theme-dark"
        aria-label={t('settings.themeDark')}
        aria-pressed={mode === 'dark'}
        onClick={() => setMode('dark')}
        className={`${segCls(mode === 'dark')} border-x border-line-2`}
      >
        <Icon name="weather-night" size={15} />
      </button>
      <button
        type="button"
        data-testid="settings-theme-auto"
        aria-label={t('settings.followDevice')}
        aria-pressed={mode === 'system'}
        onClick={() => setMode('system')}
        className={`${segCls(mode === 'system')} font-mono text-[11px] font-semibold`}
      >
        AUTO
      </button>
    </span>
  );
}

/**
 * Everything that is NOT scoped to a space lives here, behind a single
 * "Global settings" door on the Settings tab (user feedback: mixing
 * space-scoped and app-wide rows in one list was confusing).
 */
/** E2 dev switch state: the flag is read at db open, so a clean reload applies it */
function useEncryptedStoreToggle() {
  const [encryptedOn, setEncryptedOn] = useState(() => localStorage.getItem(FLAG_KEY) === '1');
  const toggleEncrypted = () => {
    const next = !encryptedOn;
    if (next) localStorage.setItem(FLAG_KEY, '1');
    else localStorage.removeItem(FLAG_KEY);
    setEncryptedOn(next);
    window.location.reload();
  };
  return { encryptedOn, toggleEncrypted };
}

/** E2 dev switch: run the native shell on the encrypted SQLCipher store —
 *  visible only in non-production native builds until E3/E4 make it the
 *  default. Flipping it relaunches onto an empty store; a signed-in
 *  identity simply re-syncs. */
function EncryptedStoreRow() {
  const { t } = useLang();
  const { encryptedOn, toggleEncrypted } = useEncryptedStoreToggle();
  if (!isNativeApp() || config.channel === 'production') return null;
  return (
    <Row
      testId="settings-encrypted-toggle"
      icon={encryptedOn ? 'shield-lock' : 'shield-lock-open-outline'}
      title={t('settings.encryptedStore')}
      sub={t('settings.encryptedStoreSub')}
      chevron={false}
      trailing={
        <Pill tone={encryptedOn ? 'accent' : 'neutral'} testId="settings-encrypted-state">
          {encryptedOn ? 'ON' : 'OFF'}
        </Pill>
      }
      onClick={toggleEncrypted}
    />
  );
}

export function GlobalSettingsScreen() {
  const { t, lang, setLang, langOverridden, followDeviceLang } = useLang();
  const { theme, mode: themeMode } = useTheme();
  const { store } = useData();
  const tipsOff = useTipsDisabled();
  const [langSheetOpen, setLangSheetOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const identity = useSession((s) => s.identity);
  const logout = useSession((s) => s.logout);
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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTyped, setDeleteTyped] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState(false);

  // full account deletion (account-deletion design; Apple 5.1.1(v)):
  // the server erases everything, then the device forgets the identity
  const deleteAccount = async () => {
    const current = identity;
    if (current?.kind !== 'user') return;
    setDeleteBusy(true);
    setDeleteError(false);
    const res = await apiFetch('/me', { method: 'DELETE' }).catch(() => null);
    if (!res?.ok) {
      setDeleteBusy(false);
      setDeleteError(true);
      return;
    }
    logout();
    await destroyIdentityData(current);
    await navigate({ to: '/login' });
  };

  useEffect(() => {
    if (identity?.kind !== 'user') return;
    void getApiCapabilities().then((caps) => {
      setGcAvailable(caps.gocardless);
      if (caps.push && caps.vapidPublicKey && pushSupported()) setVapidKey(caps.vapidPublicKey);
    });
    void pushEnabled().then(setPushOn);
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
    const biometric = lockBioAvailable ? await registerBiometric() : null;
    const pinSalt = randomSalt();
    writeLockConfig({
      enabled: true,
      credentialId: biometric?.credentialId,
      biometricKind: biometric?.kind,
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
          <Row testId="settings-receipts-row" icon="receipt-text-outline" title={t('receipts.title')} onClick={() => void navigate({ to: '/receipts' })} />
          {/* store logins were hidden behind receipts (user report) */}
          <Row testId="settings-shopping-row" icon="storefront-outline" title={t('shop.title')} onClick={() => void navigate({ to: '/shopping' })} />
          {/* trust feature: munni reads your banks, so it also lets you leave */}
          <Row testId="settings-export-row" icon="download-outline" title={t('settings.exportData')} onClick={() => setExportOpen(true)} />
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
          <EncryptedStoreRow />
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
            sub={themeMode === 'system' ? t('settings.followDevice') : undefined}
            chevron={false}
            trailing={<ThemeModeSwitch />}
          />
          <Row
            testId="settings-tips-toggle"
            icon={tipsOff ? 'help-circle' : 'help-circle-outline'}
            title={t('settings.hideTips')}
            sub={t('settings.hideTipsSub')}
            chevron={false}
            trailing={
              <Pill tone={tipsOff ? 'accent' : 'neutral'} testId="settings-tips-state">
                {tipsOff ? 'ON' : 'OFF'}
              </Pill>
            }
            onClick={() => void store.metaPut(TIPS_DISABLED_KEY, !tipsOff)}
          />
        </div>

        {/* account deletion lives here, deliberately far from sign-out
            (user remark: the two were one accidental tap apart) */}
        {identity?.kind === 'user' && (
          <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface">
            <button
              data-testid="settings-delete-account"
              onClick={() => {
                setDeleteTyped('');
                setDeleteError(false);
                setDeleteOpen(true);
              }}
              className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-negative"
            >
              <Icon name="account-remove-outline" size={20} />
              <span className="min-w-0 flex-1">
                <span className="block">{t('settings.deleteAccount')}</span>
                <span className="block text-[11px] text-ink-4">{t('settings.deleteAccountSub')}</span>
              </span>
            </button>
          </div>
        )}
      </div>

      {/* the point of no return: everything the design promises, spelled
          out, then a typed confirmation — no accidental taps */}
      <Sheet open={deleteOpen} onOpenChange={setDeleteOpen} title={t('settings.deleteAccountTitle')} size="form">
        <div className="flex flex-col gap-3 pt-1">
          <p className="text-[13px] text-ink-2">{t('settings.deleteAccountBody')}</p>
          <p className="text-[12px] text-ink-3">{t('settings.deleteTypePrompt', { word: t('settings.deleteTypeWord') })}</p>
          <input
            data-testid="delete-account-input"
            value={deleteTyped}
            onChange={(e) => setDeleteTyped(e.target.value)}
            placeholder={t('settings.deleteTypeWord')}
            autoCapitalize="characters"
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none"
          />
          {deleteError && (
            <p className="text-[12px] text-negative" data-testid="delete-account-error">
              {t('settings.deleteFailed')}
            </p>
          )}
          <button
            data-testid="delete-account-confirm"
            disabled={deleteBusy || deleteTyped.trim().toUpperCase() !== t('settings.deleteTypeWord')}
            onClick={() => void deleteAccount()}
            className="m-tap h-12 rounded-input border-none bg-negative font-semibold text-white disabled:opacity-40"
          >
            {deleteBusy ? '…' : t('settings.deleteAccountConfirm')}
          </button>
        </div>
      </Sheet>

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
          {/* native-benefits §3: no pinned language = track the device */}
          <button
            data-testid="lang-option-device"
            onClick={() => {
              followDeviceLang();
              setLangSheetOpen(false);
            }}
            className="m-tap flex items-center gap-3 border-b border-line-2 border-none bg-transparent px-1 py-3.5 text-left text-[15px] text-ink"
          >
            <Icon name="cellphone-cog" size={18} color="var(--m-ink-3)" />
            <span className="flex-1">{t('settings.followDevice')}</span>
            {!langOverridden && <Icon name="check" size={18} color="var(--m-accent)" />}
          </button>
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
              {langOverridden && lang === entry.code && <Icon name="check" size={18} color="var(--m-accent)" />}
            </button>
          ))}
        </div>
      </Sheet>

      <ExportSheet open={exportOpen} onOpenChange={setExportOpen} />
    </div>
  );
}
