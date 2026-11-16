import type { StorageBackend } from '@/db/backend';
import { visibleTransactions } from '@/db/joined';
import { closeShownWhere, shownNotifications } from './deliveredNotifications';

// #614: what the phone (or the browser) itself shows leaves once it was handled, here or on another device

const NEW_TX = 'new-tx-';

const waitsForReview = async (store: StorageBackend, spaceId: string): Promise<boolean> =>
  (await visibleTransactions(store, spaceId)).some((tx) => tx.needsReview === 1);

/** "3 new transactions arrived" goes once nothing in that space waits for review */
export async function settleReviewed(store: StorageBackend): Promise<void> {
  const announced = (await shownNotifications()).filter((shown) => shown.tag.startsWith(NEW_TX));
  if (announced.length === 0) return;
  const spaces = (await store.allRows('space')).filter((space) => space.deleted === 0).map((space) => space.id);
  const waiting = new Map<string, boolean>();
  const waits = async (spaceId: string): Promise<boolean> => {
    if (!waiting.has(spaceId)) waiting.set(spaceId, await waitsForReview(store, spaceId));
    return waiting.get(spaceId) === true;
  };
  for (const shown of announced) {
    const spaceId = shown.tag.slice(NEW_TX.length);
    // a push that named no space speaks for all of them
    const about = spaceId === 'all' ? spaces : [spaceId];
    let open = false;
    for (const id of about) open ||= await waits(id);
    if (!open) await shown.close();
  }
}

/** what the server says still waits for the person's answer; a part left out is not judged */
export interface StillPending {
  friendRequests?: number;
  spaceInvites?: number;
  /** the splits the person is invited to */
  splitInvites?: readonly string[];
  /** one split, and how many people ask to join it */
  splitRequests?: { splitId: string; waiting: number };
}

/** a request or an invitation goes once it was answered */
export async function settleAnswered(pending: StillPending): Promise<void> {
  const invited = pending.splitInvites ? new Set(pending.splitInvites) : undefined;
  await closeShownWhere((tag) => {
    if (tag === 'friend-request') return pending.friendRequests === 0;
    if (tag === 'space-invite') return pending.spaceInvites === 0;
    if (invited && tag.startsWith('split-invited-')) return !invited.has(tag.slice('split-invited-'.length));
    const asked = pending.splitRequests;
    return !!asked && asked.waiting === 0 && tag === `split-join-request-${asked.splitId}`;
  });
}
