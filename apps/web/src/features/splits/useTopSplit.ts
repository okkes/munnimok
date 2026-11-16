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
  net: number;
}

/** null: offline, signed out or no open split (the block shows its teaser); undefined: still loading */
/** #361: the last answer per identity — a tab return shows the block at once, the fetch refreshes it */
let lastTop: { key: string; value: TopSplit | null } | null = null;

const identityKeyOf = (identity: Identity | null): string => {
  if (!identity) return '';
  return `${identity.kind}:${'sub' in identity ? identity.sub : ''}`;
};

export function useTopSplit(): TopSplit | null | undefined {
  const { identity } = useSession();
  const api = useSplitsApi();
  const identityKey = identityKeyOf(identity);
  const [top, setTop] = useState<TopSplit | null | undefined>(() => (lastTop?.key === identityKey ? lastTop.value : undefined));
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
