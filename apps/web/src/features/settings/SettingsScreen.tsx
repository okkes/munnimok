import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { apiFetch, getApiCapabilities } from '@/lib/api';
import { useLang } from '@/i18n';
import type { Lang } from '@/i18n';
import { useTheme } from '@/app/theme';
import { destroyIdentityData } from '@/app/data';
import { oidcSignOut } from '@/app/authToken';
import { useSession } from '@/app/session';
import { AppBar } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

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

  useEffect(() => {
    if (identity?.kind !== 'user') return;
    void getApiCapabilities().then((caps) => setGcAvailable(caps.gocardless));
  }, [identity?.kind]);

  const openConnections = () => {
    setConnectionsOpen(true);
    void apiFetch('/gocardless/connections')
      .then(async (res) => (res.ok ? setConnections(await res.json()) : setConnections([])))
      .catch(() => setConnections([]));
  };

  const signOut = async () => {
    const current = identity;
    logout();
    // user identities keep their local data (fast re-login; sync is the
    // source of truth); demo/offline are device-only and reset on logout
    if (current?.kind === 'user') {
      if (!current.testAuth && (await oidcSignOut(window.location.origin))) return; // full OIDC logout redirects
      await navigate({ to: '/login' });
      return;
    }
    await navigate({ to: '/login' });
    if (current) await destroyIdentityData(current);
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-settings">
      <AppBar large title={t('screen.settings')} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="overflow-hidden rounded-card border border-line bg-surface">
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
          munni · v1.0.0 · build {String(__BUILD_NUMBER__)}
        </div>
      </div>

      {/* Bank connections status */}
      <Sheet open={connectionsOpen} onOpenChange={setConnectionsOpen} title={t('gc.connections')} height={380}>
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
                  ? new Date(c.lastFetchAt).toLocaleString(lang === 'en' ? 'en-GB' : lang === 'nl' ? 'nl-NL' : 'tr-TR', {
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
