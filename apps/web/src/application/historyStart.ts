import { spaceAccountLinks } from '@/db/joined';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import { logActivity } from './activity';
import { settleSpaceReimbursements } from './catalogMaintenance';
import { requestReceiptMatching } from './receiptMatching';

// the numbers must be shown BEFORE the write: newer hides feed rows (stored in full) and tombstones the space's own
// manual rows before the date; older surfaces stored rows that may ask for review again
export interface HistoryMoveImpact {
  direction: 'newer' | 'older' | 'none';
  feedHiddenCount: number;
  manualDeleteCount: number;
  surfacedCount: number;
}

export async function historyMoveImpact(store: StorageBackend, spaceId: string, newDate: string): Promise<HistoryMoveImpact> {
  const [space, own, links] = await Promise.all([
    store.get('space', spaceId),
    store.bySpace('transaction', spaceId),
    spaceAccountLinks(store, spaceId),
  ]);
  const oldDate = space?.historyStartDate ?? '';
  if (newDate === oldDate) return { direction: 'none', feedHiddenCount: 0, manualDeleteCount: 0, surfacedCount: 0 };

  const ownLive = own.filter((t) => t.deleted === 0);
  if (newDate > oldDate) {
    let feedHidden = 0;
    for (const link of links) {
      const rows = await store.bySpace('transaction', link.feedSpaceId);
      feedHidden += rows.filter(
        (t) => t.deleted === 0 && t.accountId === link.accountId && (!link.historyFrom || t.date >= link.historyFrom) && t.date < newDate,
      ).length;
    }
    return {
      direction: 'newer',
      feedHiddenCount: feedHidden,
      // every own row before the new start goes, including ones an older start had already hidden
      manualDeleteCount: ownLive.filter((t) => t.date < newDate).length,
      surfacedCount: 0,
    };
  }

  let surfaced = ownLive.filter((t) => !!oldDate && t.date >= newDate && t.date < oldDate).length;
  for (const link of links) {
    if (!link.historyFrom || link.historyFrom <= newDate) continue;
    const rows = await store.bySpace('transaction', link.feedSpaceId);
    surfaced += rows.filter(
      (t) => t.deleted === 0 && t.accountId === link.accountId && t.date >= newDate && t.date < link.historyFrom!,
    ).length;
  }
  return { direction: 'older', feedHiddenCount: 0, manualDeleteCount: 0, surfacedCount: surfaced };
}

/** every attachment's gate moves with the space date (the settings sheet is the space-wide control) */
export async function applyHistoryMove(store: StorageBackend, repo: Repo, spaceId: string, newDate: string): Promise<void> {
  const [space, own, links] = await Promise.all([
    store.get('space', spaceId),
    store.bySpace('transaction', spaceId),
    spaceAccountLinks(store, spaceId),
  ]);
  const oldDate = space?.historyStartDate ?? '';
  await repo.upsert('space', spaceId, spaceId, { historyStartDate: newDate });
  for (const link of links) {
    if (link.historyFrom !== newDate) await repo.upsert('accountLink', spaceId, link.id, { historyFrom: newDate });
  }
  if (newDate > oldDate) {
    for (const tx of own.filter((t) => t.deleted === 0 && t.date < newDate)) {
      await repo.remove('transaction', spaceId, tx.id);
    }
    // #617: a reimbursement that named one of those rows is none any more
    await settleSpaceReimbursements(store, repo, spaceId);
  } else if (newDate < oldDate) {
    // older: stored rows surface; receipt matching runs now, not when the review opens
    requestReceiptMatching(spaceId);
  }
  void logActivity(store, repo, spaceId, 'spaceEdit', space?.name ?? '');
}
