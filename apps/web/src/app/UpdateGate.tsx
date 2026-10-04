import { useEffect, useState } from 'react';
import { config } from '@/app/config';
import { useLang } from '@/i18n';
import { getProtocolIssue } from '@/lib/api';
import { nativePlatform } from '@/lib/platform';
import { nativeStoreUrl } from '@/domain/updateCheck';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';

const RECHECK_MS = 1_000;

/** the handshake's verdict, read on a beat — every sync cycle refreshes it (lib/protocol.ts) */
export function useClientOutdated(): boolean {
  const [outdated, setOutdated] = useState(() => getProtocolIssue() === 'client-outdated');
  useEffect(() => {
    const handle = setInterval(() => setOutdated(getProtocolIssue() === 'client-outdated'), RECHECK_MS);
    return () => clearInterval(handle);
  }, []);
  return outdated;
}

/**
 * The forced update (user ruling 2026-10-04: real users are on prod, no
 * backwards-compatible client code — a client the server no longer speaks
 * to is made to update, not kept running on stale rules). The handshake
 * (`lib/protocol.ts`) already made the engine refuse to sync; this takes
 * the screen as well, so nothing is edited on a build whose shapes the
 * server will reject. It sits on the router's root, above the data
 * provider: a fresh device stuck on its first sync is gated the same as a
 * device with data. A native shell gets its store; the web app reloads
 * into the build the server is serving, which is what the stale one is
 * not. The server being older than the app is the other way round and
 * stays a banner — nobody on the device can fix it.
 */
export function UpdateGate() {
  const { t } = useLang();
  const outdated = useClientOutdated();
  if (!outdated) return null;

  const store = nativeStoreUrl(nativePlatform(), config.channel);
  const update = () => {
    if (store) {
      window.open(store, '_blank');
      return;
    }
    // the web: the server already serves the new build — fetch it
    void navigator.serviceWorker?.getRegistration().then((registration) => registration?.update()).catch(() => undefined);
    globalThis.location.reload();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-bg px-6 text-center" data-testid="update-gate" role="alertdialog" aria-modal="true">
      <Icon name="cloud-alert-outline" size={44} color="var(--m-accent)" />
      <div className="m-h3 text-ink">{t('update.gateTitle')}</div>
      <p className="max-w-[320px] text-[13px] leading-relaxed text-ink-3" data-testid="update-gate-note">
        {t(store ? 'update.gateStore' : 'update.gateWeb')}
      </p>
      <Button data-testid="update-gate-go" onClick={update}>
        {t(store ? 'update.cta' : 'update.reload')}
      </Button>
    </div>
  );
}
