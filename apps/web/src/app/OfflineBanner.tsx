import { useEffect, useState } from 'react';
import { useLang } from '@/i18n';
import { useData } from './data';
import { Icon } from '@/ui/Icon';
import type { SyncStatus } from '@/sync/engine';

/**
 * Why sync is failing for a signed-in user right now:
 * - 'no-network'  — the device has no connectivity at all
 * - 'unreachable' — the network is up but the munni server can't be
 *   reached (server down, DNS, or a firewall/filter blocking it)
 * null when everything is fine — and always null for demo/offline
 * identities, whose local-only mode is a choice, not an error.
 */
export type OfflineReason = 'no-network' | 'unreachable';

export function resolveOfflineReason(hasEngine: boolean, onLine: boolean, status: SyncStatus): OfflineReason | null {
  if (!hasEngine) return null;
  if (!onLine) return 'no-network'; // definitive — show before any sync attempt fails
  if (status === 'offline' || status === 'error') return 'unreachable';
  return null;
}

export function useOfflineReason(): OfflineReason | null {
  const { engine } = useData();
  const [status, setStatus] = useState<SyncStatus>(engine?.getStatus() ?? 'idle');
  const [onLine, setOnLine] = useState(navigator.onLine);
  useEffect(() => engine?.onStatus(setStatus), [engine]);
  useEffect(() => {
    const update = () => setOnLine(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return resolveOfflineReason(!!engine, onLine, status);
}

export const OFFLINE_REASON_KEYS = {
  'no-network': 'sync.reasonNoNetwork',
  unreachable: 'sync.reasonUnreachable',
} as const;

// sessionStorage so a dismissal lasts for this visit only — closing and
// reopening the app brings the banner back (the user's requested behavior)
const DISMISS_KEY = 'munni_offline_banner_dismissed';

/** Slim strip above the tab bar: you are offline, and this is why. */
export function OfflineBanner() {
  const { t } = useLang();
  const reason = useOfflineReason();
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISS_KEY) === '1');
  if (!reason || dismissed) return null;
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-t border-line bg-warning-soft px-4 py-2"
      data-testid="offline-banner"
      data-reason={reason}
    >
      <Icon name={reason === 'no-network' ? 'wifi-off' : 'cloud-alert-outline'} size={15} color="var(--m-warning)" />
      <span className="min-w-0 flex-1 text-[12px] leading-snug text-ink-2">
        <span className="font-medium">{t('sync.offlineBanner')}</span> {t(OFFLINE_REASON_KEYS[reason])}
      </span>
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

/** Quiet pill for the Home app bar: keeps signalling offline after the
 *  banner was dismissed, without shouting. */
export function OfflineIndicator() {
  const { t } = useLang();
  const reason = useOfflineReason();
  if (!reason) return null;
  return (
    <span
      data-testid="home-offline-indicator"
      title={t(OFFLINE_REASON_KEYS[reason])}
      className="flex items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1 text-[11px] font-medium text-ink-2"
    >
      <Icon name="wifi-off" size={12} color="var(--m-warning)" />
      {t('sync.offlineShort')}
    </span>
  );
}
