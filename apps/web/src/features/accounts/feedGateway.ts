import { personalFeedSpaceId } from '@/domain/feedIds';
import { apiFetch } from '@/lib/api';
import type { AccountType } from '@/db/types';
import type { FeedGateway } from './importCamt';

/**
 * API-backed feed gateway for syncing identities. Registration falls
 * back to the caller's personal (sub-salted) feed id when the
 * deterministic one is owned by another user — the import always
 * proceeds, only cross-user dedupe is lost (security S1).
 */
export function apiFeedGateway(sub: string): FeedGateway {
  return {
    async register(preferredFeedId, accountRef) {
      // #281: a 409 here is the designed fork (the shared feed id is
      // taken) — the personal-feed retry below handles it, no report
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

/** feeds the signed-in user registered (ownership source of truth) */
export async function fetchMyFeedIds(): Promise<ReadonlySet<string>> {
  const res = await apiFetch('/me/feeds');
  if (!res.ok) return new Set();
  const feeds = (await res.json()) as { feedSpaceId: string }[];
  return new Set(feeds.map((f) => f.feedSpaceId));
}

/** attach (server first — the synced mirror is the caller's job): the
 *  gate the link starts at and the SPACE's type for the account; the
 *  server keeps both on the link and answers them on every later read */
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

/** delete one financial account: my bank consent always goes; the feed
 *  itself is erased only when nobody else still covers it (server ruling) */
export async function deleteFeedAccount(feedSpaceId: string): Promise<{ erased: boolean }> {
  const res = await apiFetch(`/me/feeds/${feedSpaceId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete failed (${res.status})`);
  return (await res.json()) as { erased: boolean };
}

/** server links of a space (authoritative ids needed for detach) */
export interface ServerSpaceLink {
  id: string;
  feedSpaceId: string;
  accountId: string;
  /** the link's OWN facts — the server settles the gate and the space's
   *  account type on every link it writes; the reconcile mirror copies
   *  them, never re-guesses them (#305: a boot-minted fresh historyFrom
   *  out-HLC'd the real attach and ratcheted the gate forward) */
  historyFrom: string;
  type: AccountType;
  attachedByName?: string | null;
  archived?: boolean;
}

export async function fetchSpaceLinks(spaceId: string): Promise<ServerSpaceLink[]> {
  const res = await apiFetch(`/spaces/${spaceId}/accounts`);
  return res.ok ? ((await res.json()) as ServerSpaceLink[]) : [];
}
