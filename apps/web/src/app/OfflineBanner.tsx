import { useEffect, useState, useSyncExternalStore } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from './data';
import { usePendingSync } from './pendingSync';
import { Icon } from '@/ui/Icon';
import type { SyncStatus } from '@/sync/engine';
import { getProtocolIssue } from '@/lib/api';
import type { ProtocolIssue } from '@/lib/protocol';
import { isSessionExpired, subscribeSessionExpiry } from './sessionExpiry';
import { oidcSignIn } from './authToken';
import { callbackUri } from '@/features/auth/logto';

// why sync fails for a signed-in user (session-expired = grant spent #222, server fine); null when fine and for
// demo/offline identities, whose local-only mode is a choice
export type OfflineReason = 'session-expired' | 'no-network' | 'unreachable' | ProtocolIssue;

export function resolveOfflineReason(
  hasEngine: boolean,
  onLine: boolean,
  status: SyncStatus,
  compat: ProtocolIssue | null = null,
  sessionExpired = false,
): OfflineReason | null {
  if (!hasEngine) return null;
  // an expired session outranks everything: "unreachable" sent the user chasing the wrong problem
  if (sessionExpired) return 'session-expired';
  // a version mismatch outranks the network states: the server is reachable, syncing is deliberately refused
  if (compat) return compat;
  if (!onLine) return 'no-network'; // definitive — show before any sync attempt fails
  if (status === 'offline' || status === 'error') return 'unreachable';
  return null;
}

export function useOfflineReason(): OfflineReason | null {
  const { engine } = useData();
  const [status, setStatus] = useState<SyncStatus>(engine?.getStatus() ?? 'idle');
  const [onLine, setOnLine] = useState(navigator.onLine);
  const [compat, setCompat] = useState<ProtocolIssue | null>(getProtocolIssue());
  const sessionExpired = useSyncExternalStore(subscribeSessionExpiry, isSessionExpired);
  useEffect(
    () =>
      engine?.onStatus((next) => {
        setStatus(next);
        // every sync attempt refreshes /health — re-read its verdict
        setCompat(getProtocolIssue());
      }),
    [engine],
  );
  useEffect(() => {
    const update = () => setOnLine(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return resolveOfflineReason(!!engine, onLine, status, compat, sessionExpired);
}

export const OFFLINE_REASON_KEYS = {
  'session-expired': 'sync.reasonSessionExpired',
  'no-network': 'sync.reasonNoNetwork',
  unreachable: 'sync.reasonUnreachable',
  'client-outdated': 'sync.reasonClientOutdated',
  'server-outdated': 'sync.reasonServerOutdated',
} as const;

const REASON_ICON: Record<OfflineReason, string> = {
  'session-expired': 'account-lock-outline',
  'no-network': 'wifi-off',
  unreachable: 'cloud-alert-outline',
  'client-outdated': 'cloud-alert-outline',
  'server-outdated': 'cloud-alert-outline',
};

// sessionStorage: a dismissal lasts this visit only, a reopened app shows the banner again
const DISMISS_KEY = 'munni_offline_banner_dismissed';

export function OfflineBanner() {
  const { t } = useLang();
  const reason = useOfflineReason();
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISS_KEY) === '1');
  if (!reason || dismissed) return null;
  const expired = reason === 'session-expired';
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-t border-line bg-warning-soft px-4 py-2"
      data-testid="offline-banner"
      data-reason={reason}
    >
      <Icon name={REASON_ICON[reason]} size={15} color="var(--m-warning)" />
      <span className="min-w-0 flex-1 text-[12px] leading-snug text-ink-2">
        {/* "Offline — saved on this device" would be a lie: the network is fine, the SESSION is spent (#222) */}
        {!expired && <span className="font-medium">{t('sync.offlineBanner')} </span>}
        {t(OFFLINE_REASON_KEYS[reason])}
      </span>
      {expired && (
        <span className="flex shrink-0 flex-col items-end gap-1">
          <button
            data-testid="offline-banner-signin"
            onClick={() => void oidcSignIn(callbackUri())}
            className="m-tap shrink-0 rounded-full bg-brand px-3 py-1.5 text-[12px] font-semibold text-on-brand"
          >
            {t('sync.signInAgain')}
          </button>
          <button
            data-testid="offline-banner-another"
            onClick={() => void oidcSignIn(callbackUri(), true)}
            className="m-tap border-none bg-transparent p-0 text-[11px] font-medium text-accent-deep underline"
          >
            {t('sync.anotherAccount')}
          </button>
        </span>
      )}
      <button
        aria-label={t('action.dismiss')}
        data-testid="offline-banner-dismiss"
        onClick={() => {
          sessionStorage.setItem(DISMISS_KEY, '1');
          setDismissed(true);
        }}
        className="m-tap -my-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-none bg-transparent"
      >
        <Icon name="close" size={15} color="var(--m-ink-3)" />
      </button>
    </div>
  );
}

export function syncPillFace(
  reason: OfflineReason | null,
  pending: number,
  status: SyncStatus,
  t: (key: 'sync.signInAgain' | 'sync.offlineShort' | 'sync.syncing' | 'sync.pendingShort', vars?: Record<string, string | number>) => string,
): { icon: string; text: string } | null {
  if (!reason && pending === 0) return null;
  const count = pending > 0 ? t('sync.pendingShort', { n: pending }) : null;
  if (reason === 'session-expired') return { icon: 'account-lock-outline', text: t('sync.signInAgain') };
  if (reason) return { icon: 'wifi-off', text: count ? `${t('sync.offlineShort')} · ${count}` : t('sync.offlineShort') };
  if (status === 'syncing') return { icon: 'cloud-sync-outline', text: t('sync.syncing') };
  return { icon: 'cloud-upload-outline', text: count ?? '' };
}

/** quiet pill for Home: keeps signalling offline after the banner was dismissed, counts changes waiting on this device */
export function SyncIndicator() {
  const { t } = useLang();
  const navigate = useNavigate();
  const { engine } = useData();
  const reason = useOfflineReason();
  const pending = usePendingSync();
  const [status, setStatus] = useState<SyncStatus>(engine?.getStatus() ?? 'idle');
  useEffect(() => engine?.onStatus(setStatus), [engine]);
  const face = syncPillFace(reason, pending, status, t);
  if (!face) return null;
  return (
    <button
      type="button"
      data-testid={reason ? 'home-offline-indicator' : 'home-sync-indicator'}
      data-pending={pending}
      title={reason ? t(OFFLINE_REASON_KEYS[reason]) : t('sync.pendingOnline', { n: pending })}
      onClick={() => void navigate({ to: '/settings' })}
      className="m-tap flex items-center gap-1.5 rounded-full border-none bg-warning-soft px-2.5 py-1 text-[11px] font-medium text-ink-2"
    >
      <Icon name={face.icon} size={12} color="var(--m-warning)" />
      {face.text}
    </button>
  );
}
