import { useEffect, useState } from 'react';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useSession } from '@/app/session';
import { useQuery } from '@/db/useQuery';
import { readSpacesNotifyOff, refreshSpacesNotifyOff, setSpaceNotify } from '@/application/spaceNotifications';
import { getApiCapabilities } from '@/lib/api';
import { enablePush, pushEnabled, pushSupported, sendTestPush } from '@/lib/push';
import { Pill, Row } from '@/ui/primitives';

/**
 * #549: the space's notifications, on the space's own settings (they were one
 * switch in Global settings). ON means this device gets them: the space is
 * not switched off AND the device is registered — the first switch-on here
 * asks the browser (or the phone) for permission. The choice itself belongs
 * to the person and reaches their other devices; signed-in identities only,
 * like before — the demo and offline profiles have no server to push from.
 */
export function SpaceNotificationsCard() {
  const { t } = useLang();
  const { store, spaceId } = useData();
  const isUser = useSession((s) => s.identity?.kind === 'user');
  const [vapidKey, setVapidKey] = useState('');
  const [deviceOn, setDeviceOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // the test row: what the last attempt said (sent to n devices / no device / failed)
  const [testNote, setTestNote] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const off = useQuery(store, async () => readSpacesNotifyOff(store), []);

  useEffect(() => {
    if (!isUser) return;
    void getApiCapabilities().then((caps) => {
      if (caps.push && caps.vapidPublicKey && pushSupported()) setVapidKey(caps.vapidPublicKey);
    });
    void pushEnabled().then(setDeviceOn);
    void refreshSpacesNotifyOff(store);
  }, [isUser, store]);

  if (!isUser || !vapidKey) return null;
  const spaceOn = !(off ?? []).includes(spaceId);
  const on = deviceOn && spaceOn;
  const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied';

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      if (on) {
        if (!(await setSpaceNotify(store, spaceId, false))) setFailed(true);
        return;
      }
      if (!deviceOn) {
        const registered = await enablePush(vapidKey);
        setDeviceOn(registered);
        if (!registered) {
          // a refusal says so through the permission line; anything else failed to save
          if (typeof Notification === 'undefined' || Notification.permission !== 'denied') setFailed(true);
          return;
        }
      }
      if (!spaceOn && !(await setSpaceNotify(store, spaceId, true))) setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    if (testBusy) return;
    setTestBusy(true);
    try {
      const sent = await sendTestPush(spaceId);
      let note: string;
      if (sent === null) note = t('push.testFailed');
      else if (sent === 0) note = t('push.testNone');
      else note = t('push.testSent', { n: sent });
      setTestNote(note);
    } finally {
      setTestBusy(false);
    }
  };

  let sub = t('push.sub');
  if (denied) sub = t('push.denied');
  else if (failed) sub = t('push.saveFailed');

  return (
    <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface" data-testid="settings-notify-card">
      <Row
        testId="settings-push-toggle"
        icon={on ? 'bell-ring-outline' : 'bell-outline'}
        title={t('settings.notifications')}
        sub={sub}
        chevron={false}
        disabled={busy}
        trailing={
          <Pill tone={on ? 'accent' : 'neutral'} testId="settings-push-state">
            {on ? 'ON' : 'OFF'}
          </Pill>
        }
        onClick={() => void toggle()}
      />
      {on && (
        <Row
          testId="settings-push-test"
          icon="bell-ring-outline"
          title={t('push.testTitle')}
          sub={testNote ?? t('push.testSub')}
          chevron={false}
          disabled={testBusy}
          onClick={() => void sendTest()}
        />
      )}
    </div>
  );
}
