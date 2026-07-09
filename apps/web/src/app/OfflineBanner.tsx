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

/** Slim strip above the tab bar: you are offline, and this is why. */
export function OfflineBanner() {
  const { t } = useLang();
  const reason = useOfflineReason();
  if (!reason) return null;
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
    </div>
  );
}
