import { useEffect, useState } from 'react';
import { config } from '@/app/config';
import { useLang } from '@/i18n';
import { getProtocolIssue } from '@/lib/api';
import { nativePlatform } from '@/lib/platform';
import { nativeStoreUrl } from '@/domain/updateCheck';
import { reloadIntoNewBuild } from './newBuild';
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

// forced update (real users on prod, no backwards-compatible client code): the handshake stops sync, this takes the
// screen too. Above the data provider, so a device stuck on its first sync is gated. A server older than the app
// stays a banner: nobody on the device can fix it
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
    void reloadIntoNewBuild();
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
