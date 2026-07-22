import { accountLinkId } from '@/domain/feedIds';
import { DEFAULT_HISTORY_MONTHS, isoMonthsAgo } from '@/features/spaces/spaceDefaults';
import { attachAccount, detachAccount, fetchSpaceLinks } from '@/features/accounts/feedGateway';
import type { Repo } from '@/db/repo';
import type { StorageBackend } from '@/db/backend';

/**
 * Attach/detach of feed accounts to spaces (redesign 2026-07-22): the
 * space's own accounts screen drives both now — server first (access
 * control lives there), then the synced accountLink mirror so offline
 * devices render the change.
 */

export async function attachFeedToSpace(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  feedSpaceId: string,
  accountId: string,
  historyFrom?: string,
): Promise<void> {
  // the override wins, then the space's history start, then the app
  // default — never silently unlimited (user bug report)
  const from =
    historyFrom || (await store.get('space', spaceId))?.historyStartDate || isoMonthsAgo(DEFAULT_HISTORY_MONTHS);
  await attachAccount(spaceId, feedSpaceId, accountId, from);
  await repo.upsert('accountLink', spaceId, accountLinkId(spaceId, feedSpaceId), {
    feedSpaceId,
    accountId,
    historyFrom: from,
    archived: 0,
  });
}

export async function detachFeedFromSpace(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  feedSpaceId: string,
  accountId: string,
): Promise<void> {
  const serverLinks = await fetchSpaceLinks(spaceId);
  const serverLink = serverLinks.find((l) => l.feedSpaceId === feedSpaceId && l.accountId === accountId);
  if (serverLink) await detachAccount(spaceId, serverLink.id);
  const local = (await store.bySpace('accountLink', spaceId)).find(
    (l) => l.deleted === 0 && l.accountId === accountId && l.feedSpaceId === feedSpaceId,
  );
  if (local) await repo.remove('accountLink', spaceId, local.id);
}
