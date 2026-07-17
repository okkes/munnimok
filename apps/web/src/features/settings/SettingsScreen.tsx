import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { config } from '@/app/config';
import { LOCALES, useLang } from '@/i18n';
import { destroyIdentityData, useData } from '@/app/data';
import { OFFLINE_REASON_KEYS, useOfflineReason } from '@/app/OfflineBanner';
import { oidcSignOut } from '@/app/authToken';
import { isNativeApp } from '@/lib/platform';
import { useSession } from '@/app/session';
import { AppBar } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { Row } from '@/ui/primitives';
import { useQuery } from '@/db/useQuery';
import { Avatar } from '@/features/profile/ProfileScreen';
import { LAST_SYNC_KEY } from '@/sync/engine';
import type { SyncStatus } from '@/sync/engine';

const SYNC_STATUS_KEYS = {
  idle: 'sync.synced',
  syncing: 'sync.syncing',
  offline: 'sync.offline',
  error: 'sync.error',
} as const;

/** live sync state + last successful sync — silent failures can't hide */
function SyncStatusRow() {
  const { t, lang } = useLang();
  const { store, engine } = useData();
  const [status, setStatus] = useState<SyncStatus>(engine?.getStatus() ?? 'idle');
  useEffect(() => engine?.onStatus(setStatus), [engine]);
  const lastSync = useQuery(store, async () => (await store.metaGet(LAST_SYNC_KEY))?.value as number | undefined, []);
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
  const { store } = useData();
  const profile = useQuery(store, 
    async () => (await store.metaGet('profile'))?.value as { name?: string; picture?: string } | undefined,
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
        {/* no name yet → the title already says "Profile"; repeating it read
            as a bug ("Profiel / Profiel") — invite instead (§2L) */}
        <span className="block text-[12px] text-ink-3">{profile?.name ? t('profile.title') : t('profile.setupHint')}</span>
      </span>
      <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
    </button>
  );
}

export function SettingsScreen() {
  const { t } = useLang();
  const { store, spaceId } = useData();
  const activeSpace = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const { identity, logout } = useSession();
  const navigate = useNavigate();
  const signOut = async () => {
    const current = identity;
    logout();
    // user identities keep local data (sync is the source of truth);
    // offline profiles keep their data too (this device IS the truth) —
    // only the demo resets to its pristine dataset on sign-out
    if (current?.kind === 'user') {
      // native: the end-session round-trip happens in the system browser,
      // so the post-logout landing must be the app's own deep-link scheme
      // (register munni://signed-out + munni-dev://signed-out as post
      // sign-out redirect URIs in the Logto native apps); the webview
      // origin would dead-end in Safari/Chrome
      const postLogout = isNativeApp() ? `${config.nativeScheme}://signed-out` : window.location.origin;
      if (!current.testAuth && (await oidcSignOut(postLogout))) return; // full OIDC logout redirects
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
        {/* scope split (user feedback): what belongs to THIS space vs the
            whole app was invisible — space-scoped rows get captions, and
            everything app-wide lives behind ONE door so the two scopes
            can't blur together. The feature doors group by intent
            (redesign ruling): Plan / Track / Learn / Setup. */}
        <p className="m-cap mb-1 px-1" data-testid="settings-scope-space">
          {t('settings.scopeSpace', { name: activeSpace?.name ?? '' })}
        </p>
        {(
          [
            {
              capKey: 'settings.groupPlan',
              rows: [
                { testId: 'settings-budgets-row', icon: 'wallet-outline', labelKey: 'budgets.title', to: '/budgets' },
                { testId: 'settings-allocation-row', icon: 'cash-multiple', labelKey: 'alloc.title', to: '/allocate' },
              ],
            },
            {
              capKey: 'settings.groupTrack',
              rows: [
                { testId: 'settings-events-row', icon: 'party-popper', labelKey: 'events.title', to: '/events' },
                // splits live here, not in Global (user remark): the group
                // itself is space-independent, but its attachment and the
                // transactions you pick from belong to the current space
                { testId: 'settings-splits-row', icon: 'account-cash-outline', labelKey: 'splits.title', to: '/splits', userOnly: true },
                { testId: 'settings-goals-row', icon: 'flag-outline', labelKey: 'goals.title', to: '/goals' },
                { testId: 'settings-debts-row', icon: 'hand-coin-outline', labelKey: 'debts.title', to: '/debts' },
              ],
            },
            {
              capKey: 'settings.groupLearn',
              rows: [
                { testId: 'settings-insights-row', icon: 'lightbulb-outline', labelKey: 'ins.title', to: '/insights' },
                { testId: 'settings-trends-row', icon: 'chart-bar', labelKey: 'trends.title', to: '/trends' },
              ],
            },
            {
              capKey: 'settings.groupSetup',
              rows: [
                { testId: 'settings-space-settings-row', icon: 'cog-outline', labelKey: 'space.settings', to: '/spaces/$spaceId' },
                // the space's accounts/members moved out of the (already
                // big) space-settings screen — user remark
                { testId: 'settings-space-accounts-row', icon: 'bank-outline', labelKey: 'space.financialAccounts', to: '/spaces/$spaceId/accounts' },
                { testId: 'settings-space-members-row', icon: 'account-multiple-outline', labelKey: 'space.members', to: '/spaces/$spaceId/members', userOnly: true },
                { testId: 'settings-categories-row', icon: 'shape-outline', labelKey: 'screen.categories', to: '/categories' },
              ],
            },
          ] as const
        ).map((group, groupIndex) => (
          <div key={group.capKey}>
            <p className={`px-1 pb-1 text-[10px] font-semibold tracking-wide text-ink-4 uppercase ${groupIndex === 0 ? '' : 'pt-3'}`}>
              {t(group.capKey)}
            </p>
            <div className="overflow-hidden rounded-card border border-line bg-surface">
              {group.rows
                .filter((row) => !('userOnly' in row) || identity?.kind === 'user')
                .map((row) => (
                  <Row
                    key={row.testId}
                    testId={row.testId}
                    icon={row.icon}
                    title={t(row.labelKey)}
                    onClick={() => void navigate({ to: row.to, params: { spaceId } })}
                  />
                ))}
            </div>
          </div>
        ))}

        <p className="m-cap mt-4 mb-1 px-1" data-testid="settings-scope-global">
          {t('settings.scopeGlobal')}
        </p>
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <Row
            testId="settings-global-row"
            icon="earth"
            title={t('settings.global')}
            sub={t('settings.globalSub')}
            onClick={() => void navigate({ to: '/settings/global' })}
          />
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
          {/* account deletion moved to Global settings (user remark: too
              close to sign-out for comfort) */}
        </div>

        <div className="pt-6 pb-6 text-center text-[11px] text-ink-4">
          munni · v{__APP_VERSION__} · build {String(__BUILD_NUMBER__)}
          {config.channel !== 'production' && ` · ${config.channel || 'local'}`}
        </div>
      </div>
    </div>
  );
}
