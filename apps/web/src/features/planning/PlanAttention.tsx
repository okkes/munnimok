import { useEffect } from 'react';
import { create } from 'zustand';
import { useData } from '@/app/data';
import { usePlanningDot } from '@/application/planning';
import { useLang } from '@/i18n';
import { hapticNotify } from '@/lib/platform';
import { collectPlanAlerts } from '@/sync/swPlanning';

/**
 * The tab bar lives outside the data provider, so the planning tab's dot
 * travels through a module store: this headless component (inside the
 * provider) keeps it current and, once per day, records the "in the red"
 * notice — the in-app inbox row always, the OS notification when allowed.
 */
interface PlanDotState {
  dot: boolean;
  set: (dot: boolean) => void;
}

export const usePlanDot = create<PlanDotState>((set) => ({
  dot: false,
  set: (dot) => set({ dot }),
}));

export function PlanAttention() {
  const { store, spaceId } = useData();
  const { lang } = useLang();
  const dot = usePlanningDot();
  const publish = usePlanDot((s) => s.set);
  useEffect(() => {
    publish(dot);
  }, [dot, publish]);

  useEffect(() => {
    void (async () => {
      const alerts = await collectPlanAlerts(store, spaceId, lang);
      if (alerts.length === 0) return;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const registration = await navigator.serviceWorker?.ready.catch(() => undefined);
      if (!registration) return;
      for (const alert of alerts) {
        hapticNotify('WARNING');
        await registration.showNotification(alert.title, {
          body: alert.body,
          icon: 'icon-192.png',
          badge: 'icon-192.png',
          tag: alert.tag,
          data: { url: alert.url },
        });
      }
    })().catch(() => undefined); // best-effort; a closing db must not throw
  }, [store, spaceId, lang]);
  return null;
}
