import { useEffect, useState } from 'react';
import { useSession } from '@/app/session';
import type { Identity } from '@/app/session';
import { useSplitsApi } from './splitsCore';

export interface TopSplit {
  id: string;
  name: string;
  memberCount: number;
  entryCount: number;
  currency: string;
  /** my net position (settlement plan sign: + = owed to me) */
  net: number;
}

/**
 * The Home block's data: my most recently created OPEN split with my
 * net position. Splits are online-only — offline, signed-out and
 * "no open splits" all resolve to null and the block falls back to
 * its teaser. undefined = still loading (render nothing yet).
 */
/** #361: the last answer per identity — a tab return shows the block at once, the fetch refreshes it */
let lastTop: { key: string; value: TopSplit | null } | null = null;

/** the identity's cache key — the sub for a user, the kind alone otherwise */
const identityKeyOf = (identity: Identity | null): string => {
  if (!identity) return '';
  return `${identity.kind}:${'sub' in identity ? identity.sub : ''}`;
};

export function useTopSplit(): TopSplit | null | undefined {
  const { identity } = useSession();
  const api = useSplitsApi();
  const identityKey = identityKeyOf(identity);
  const [top, setTop] = useState<TopSplit | null | undefined>(() => (lastTop?.key === identityKey ? lastTop.value : undefined));
  // the settled answer is remembered for the next mount under this identity
  useEffect(() => {
    if (top !== undefined) lastTop = { key: identityKey, value: top };
  }, [top, identityKey]);

  useEffect(() => {
    if (!api) {
      setTop(null);
      return;
    }
    let stale = false;
    void api.list().then((splits) => {
      if (stale) return;
      // the server orders newest first; the list already says where I stand
      const open = splits?.find((split) => split.status === 'open' && split.state === 'active');
      setTop(open ? { id: open.id, name: open.name, memberCount: open.memberCount, entryCount: open.entryCount, currency: open.currency, net: open.myBalanceCents } : null);
    });
    return () => {
      stale = true;
    };
  }, [api]);

  return top;
}
