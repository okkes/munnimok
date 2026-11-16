import { personalFeedSpaceId } from '@/domain/feedIds';
import { apiFetch } from '@/lib/api';
import type { AccountType } from '@/db/types';
import type { FeedGateway } from './importCamt';

// a feed id owned by another user falls back to the caller's personal (sub-salted) one: the import proceeds,
// only cross-user dedupe is lost (security S1)
export function apiFeedGateway(sub: string): FeedGateway {
  return {
    async register(preferredFeedId, accountRef) {
      // #281: a 409 is the designed fork (the shared feed id is taken): the personal retry handles it, no report
      const res = await apiFetch(
        '/feeds',
        { method: 'POST', body: JSON.stringify({ feedSpaceId: preferredFeedId, accountRef }) },
        { expectStatuses: [409] },
      );
      if (res.ok) return preferredFeedId;
      if (res.status === 409) {
        const personal = personalFeedSpaceId(accountRef, sub);
        const retry = await apiFetch('/feeds', {
          method: 'POST',
          body: JSON.stringify({ feedSpaceId: personal, accountRef }),
        });
        if (retry.ok) return personal;
      }
      throw new Error(`feed registration failed (${res.status})`);
    },
    async attach(spaceId, feedSpaceId, accountId, historyFrom, type) {
      await attachAccount(spaceId, feedSpaceId, accountId, historyFrom, type);
    },
  };
}

/** ownership source of truth */
export async function fetchMyFeedIds(): Promise<ReadonlySet<string>> {
  const res = await apiFetch('/me/feeds');
  if (!res.ok) return new Set();
  const feeds = (await res.json()) as { feedSpaceId: string }[];
  return new Set(feeds.map((f) => f.feedSpaceId));
}

/** server first; the link keeps the gate and the space's account type and answers them on every later read */
export async function attachAccount(
  spaceId: string,
  feedSpaceId: string,
  accountId: string,
  historyFrom?: string,
  type?: AccountType,
): Promise<void> {
  const res = await apiFetch(`/spaces/${spaceId}/accounts`, {
    method: 'POST',
    body: JSON.stringify({ feedSpaceId, accountId, historyFrom: historyFrom || undefined, type }),
  });
  if (!res.ok) throw new Error(`attach failed (${res.status})`);
}

export async function detachAccount(spaceId: string, serverLinkId: string): Promise<void> {
  await apiFetch(`/spaces/${spaceId}/accounts/${serverLinkId}`, { method: 'DELETE' });
}

/** my bank consent always goes; the feed itself is erased only when nobody else still covers it */
export async function deleteFeedAccount(feedSpaceId: string): Promise<{ erased: boolean }> {
  const res = await apiFetch(`/me/feeds/${feedSpaceId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete failed (${res.status})`);
  return (await res.json()) as { erased: boolean };
}

export interface ServerSpaceLink {
  id: string;
  feedSpaceId: string;
  accountId: string;
  /** the server settles gate and type on every link; the reconcile mirror copies them, never re-guesses
   *  (#305: a boot-minted historyFrom out-HLC'd the real attach and ratcheted the gate forward) */
  historyFrom: string;
  type: AccountType;
  attachedByName?: string | null;
  archived?: boolean;
}

export async function fetchSpaceLinks(spaceId: string): Promise<ServerSpaceLink[]> {
  const res = await apiFetch(`/spaces/${spaceId}/accounts`);
  return res.ok ? ((await res.json()) as ServerSpaceLink[]) : [];
}
