import { useEffect, useState } from 'react';
import { useLang } from '@/i18n';
import { publicOrigin } from '@/app/config';
import { shouldCheckForUpdate, storeUrlOf, updateAvailable } from '@/domain/updateCheck';
import type { UpdateCheckState } from '@/domain/updateCheck';
import { bundledWebBuild, getNativeAppId, isNativeApp, nativePlatform } from '@/lib/platform';
import { Icon } from '@/ui/Icon';

const LS_KEY = 'munni_update_check';

const readState = (): UpdateCheckState => {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as UpdateCheckState;
  } catch {
    return {};
  }
};
const writeState = (patch: Partial<UpdateCheckState>) =>
  localStorage.setItem(LS_KEY, JSON.stringify({ ...readState(), ...patch }));

// The shell's BUNDLED web build against the hosted version.json, roughly once a day: both carry the commit
// count, the store's build number does not. Dismissing silences that build; the next release nudges again.
export function UpdateCard() {
  const { t } = useLang();
  const [update, setUpdate] = useState<{ build: number; version: string; storeUrl: string | null } | null>(null);

  useEffect(() => {
    if (!isNativeApp()) return;
    void (async () => {
      const state = readState();
      if (!shouldCheckForUpdate(state, Date.now())) return;
      try {
        const res = await fetch(`${publicOrigin()}/version.json`, { cache: 'no-store' });
        if (!res.ok) return;
        const remote = (await res.json()) as { build: number; version: string };
        writeState({ lastCheckedAt: Date.now() });
        if (!updateAvailable(bundledWebBuild(), remote.build, state.dismissedBuild)) return;
        setUpdate({ build: remote.build, version: remote.version, storeUrl: storeUrlOf(nativePlatform(), await getNativeAppId()) });
      } catch {
        // offline or origin unreachable — try again another day
      }
    })();
  }, []);

  if (!update) return null;
  const { storeUrl } = update;

  return (
    <div
      className="mt-3 flex items-center gap-3 rounded-card border border-accent/40 bg-accent-soft/40 px-4 py-2.5"
      data-testid="update-card"
    >
      <Icon name="rocket-launch-outline" size={18} color="var(--m-accent-deep)" />
      <span className="min-w-0 flex-1 text-[13px] text-ink-2">{t('update.cardTitle', { version: update.version })}</span>
      {storeUrl && (
        <button
          data-testid="update-open-store"
          onClick={() => window.open(storeUrl, '_blank')}
          className="m-tap shrink-0 border-none bg-transparent text-[13px] font-semibold text-accent-deep"
        >
          {t('update.cta')}
        </button>
      )}
      <button
        data-testid="update-dismiss"
        aria-label={t('action.dismiss')}
        onClick={() => {
          writeState({ dismissedBuild: update.build });
          setUpdate(null);
        }}
        className="m-tap shrink-0 border-none bg-transparent text-ink-4"
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
