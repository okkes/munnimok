import { personalFeedSpaceId } from '@/domain/feedIds';
import { apiFetch } from '@/lib/api';
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
      const res = await apiFetch('/feeds', {
        method: 'POST',
        body: JSON.stringify({ feedSpaceId: preferredFeedId, accountRef }),
      });
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
    async attach(spaceId, feedSpaceId, accountId) {
      const res = await apiFetch(`/spaces/${spaceId}/accounts`, {
        method: 'POST',
        body: JSON.stringify({ feedSpaceId, accountId }),
      });
      if (!res.ok) throw new Error(`attach failed (${res.status})`);
    },
  };
}
