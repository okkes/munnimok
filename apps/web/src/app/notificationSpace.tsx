import { useEffect } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useData } from './data';

const ID_SHAPE = /^[A-Za-z0-9_-]+$/;

/** #551: the space rides the url as `?space=` (cold starts too); switch there if a member,
 * then drop the param so reload/back does not switch again */
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
