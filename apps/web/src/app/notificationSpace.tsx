import { useEffect } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useData } from './data';

const ID_SHAPE = /^[A-Za-z0-9_-]+$/;

/**
 * #551: a notification opens its screen IN its space. The space rides the
 * url as `?space=` (a cold start from the notification carries it too);
 * this switches there when the person is a member of it, then drops the
 * param so a reload or a step back does not switch again. A space the
 * person left stays where they are. Headless, inside the data provider.
 */
export function NotificationSpaceSwitch() {
  const { store, spaceId, setActiveSpace } = useData();
  const navigate = useNavigate();
  const target = useRouterState({
    select: (s) => (s.location.search as { space?: unknown }).space,
  });

  useEffect(() => {
    if (typeof target !== 'string' || !ID_SHAPE.test(target)) return;
    let live = true;
    void (async () => {
      if (target !== spaceId) {
        const row = await store.get('space', target);
        if (live && row?.deleted === 0) await setActiveSpace(target);
      }
      if (!live) return;
      await navigate({
        to: '.',
        search: ((prev: Record<string, unknown>) => {
          const { space: _space, ...rest } = prev;
          return rest;
        }) as never,
        replace: true,
      });
    })().catch(() => undefined); // a closing store mid-switch: the next open starts clean
    return () => {
      live = false;
    };
    // one switch per arriving param — the strip itself clears it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return null;
}
