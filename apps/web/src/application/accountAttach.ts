import { accountLinkId } from '@/domain/feedIds';
import { releaseAccountReferences } from './accountRelease';
import { logActivity } from './activity';
import { DEFAULT_HISTORY_MONTHS, isoMonthsAgo } from '@/features/spaces/spaceDefaults';
import { attachAccount, detachAccount, fetchSpaceLinks } from '@/features/accounts/feedGateway';
import type { Repo } from '@/db/repo';
import type { StorageBackend } from '@/db/backend';
import type { AccountType } from '@/db/types';

// server first (access control lives there), then the synced accountLink mirror so offline devices render the change

export async function attachFeedToSpace(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  feedSpaceId: string,
  accountId: string,
  historyFrom?: string,
  /** #152: the SPACE-level type; absent keeps the account row's value */
  type?: AccountType,
): Promise<void> {
  // the override, then the space's history start, then the app default: never silently unlimited
  const from =
    historyFrom || (await store.get('space', spaceId))?.historyStartDate || isoMonthsAgo(DEFAULT_HISTORY_MONTHS);
  await attachAccount(spaceId, feedSpaceId, accountId, from, type);
  await repo.upsert('accountLink', spaceId, accountLinkId(spaceId, feedSpaceId), {
    feedSpaceId,
    accountId,
    historyFrom: from,
    archived: 0,
    ...(type ? { type } : {}),
  });
  void logActivity(store, repo, spaceId, 'attach', (await store.get('account', accountId))?.name);
}

// server links → local mirrors for attachments this client never saw: the bank-connect completion runs anonymously on
// the hosted page, so the server attaches but no device wrote the mirror and the account showed nowhere
export async function reconcileSpaceLinks(store: StorageBackend, repo: Repo, spaceId: string): Promise<number> {
  const server = await fetchSpaceLinks(spaceId);
  if (server.length === 0) return 0;
  const local = (await store.bySpace('accountLink', spaceId)).filter((l) => l.deleted === 0);
  let mirrored = 0;
  for (const link of server) {
    if (local.some((l) => l.feedSpaceId === link.feedSpaceId && l.accountId === link.accountId)) continue;
    // #305: copy the SERVER link's gate and type; minting a fresh historyFrom out-HLC'd the real attach op and ratcheted
    // the gate forward, hiding older shared transactions
    await repo.upsert('accountLink', spaceId, accountLinkId(spaceId, link.feedSpaceId), {
      feedSpaceId: link.feedSpaceId,
      accountId: link.accountId,
      historyFrom: link.historyFrom,
      type: link.type,
      ...(link.attachedByName ? { attachedByName: link.attachedByName } : {}),
      archived: link.archived ? (1 as const) : (0 as const),
    });
    mirrored++;
  }
  return mirrored;
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
  // #547: detaching takes the manual entries typed on the account: they were this space's alone
  for (const row of await store.bySpace('transaction', spaceId)) {
    if (row.deleted === 0 && row.accountId === accountId && !!row.enteredAt) await repo.remove('transaction', spaceId, row.id);
  }
  await releaseAccountReferences(store, repo, spaceId, accountId);
  void logActivity(store, repo, spaceId, 'detach', (await store.get('account', accountId))?.name);
}
