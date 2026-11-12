import { useEffect, useState } from 'react';
import { useSession } from '@/app/session';
import type { StorageBackend } from '@/db/backend';
import { apiCapabilitiesKnown, getApiCapabilities } from '@/lib/api';
import { pushEnabled, pushSupported } from '@/lib/push';
import { spaceNotifyOn } from './spaceNotifications';

/**
 * Whether this device can be warned about a space (#534): `on` — the device
 * receives notifications and the space's own switch (#549) is on; `off` — it
 * could be, but one of the two is off; `no-account` — the demo and offline
 * profiles have no server to push from; `unsupported` — the server or this
 * browser offers no push (the same test the Settings row uses to show itself).
 */
export type PushState = 'on' | 'off' | 'no-account' | 'unsupported';

/** the push state for one space on this device; null while it is being asked */
export function usePushState(store: Pick<StorageBackend, 'metaGet' | 'metaPut'>, spaceId: string): PushState | null {
  const kind = useSession((s) => s.identity?.kind);
  const [state, setState] = useState<PushState | null>(null);
  useEffect(() => {
    if (kind !== 'user') {
      setState('no-account');
      return;
    }
    let live = true;
    const settle = (next: PushState) => {
      if (live) setState(next);
    };
    void (async () => {
      if (!pushSupported()) {
        settle('unsupported');
        return;
      }
      // a registered device answers from its own facts — the server need not be reachable for that
      if (await pushEnabled()) {
        settle((await spaceNotifyOn(store, spaceId)) ? 'on' : 'off');
        return;
      }
      const caps = await getApiCapabilities();
      // a server that could not be asked says nothing about what it offers: the device is not registered, no more
      settle(apiCapabilitiesKnown() && (!caps.push || !caps.vapidPublicKey) ? 'unsupported' : 'off');
    })().catch(() => settle('unsupported'));
    return () => {
      live = false;
    };
  }, [kind, store, spaceId]);
  return state;
}
