import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { visibleTransactions, writeTxTransform } from '@/db/joined';
import { UNCATEGORIZED_ID } from '@/domain/categories';
import { accountStamp } from '@/domain/txType';
import { standardTypeFor } from '@/domain/txKind';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { AccountRow, AccountType } from '@/db/types';

/**
 * Global financial accounts (user decision: accounts are NOT
 * space-scoped). Everything is computed from local synced data, so the
 * overview works offline:
 *
 * - a FEED account lives in a feed space — recognizable locally because
 *   feeds carry no space row (only spaces the user is a member of do);
 * - `sharedVia` collects every local space attached to the account;
 * - ownership comes from /me/feeds (fetched by the screen when online)
 *   — accounts on feeds the user does not own are "shared with me".
 */

export interface SharedVia {
  spaceId: string;
  spaceName: string;
  archived: boolean;
  attachedByName?: string;
  historyFrom?: string;
  /** synced link row id (client mirror) */
  linkRowId: string;
}

export interface GlobalAccount {
  account: AccountRow;
  /** set for feed accounts (undefined = legacy/manual row in a member space) */
  feedSpaceId?: string;
  sharedVia: SharedVia[];
}

export interface SpaceScopedAccounts {
  spaceId: string;
  spaceName: string;
  accounts: GlobalAccount[];
}

export interface GlobalAccounts {
  /** feed accounts (bank connections + statement imports) — truly
   *  user-level; the only rows that are "global" (user ruling 2026-07-28) */
  mine: GlobalAccount[];
  /** manual accounts, which live INSIDE a space — grouped per space so
   *  the overview says clearly where each one belongs */
  spaceScoped: SpaceScopedAccounts[];
  /** accounts reaching the user only through someone else's attachment */
  sharedWithMe: GlobalAccount[];
}

export function useGlobalAccounts(myFeedIds: ReadonlySet<string> | undefined): GlobalAccounts | undefined {
  const { store } = useData();
  return useQuery(store, async () => {
    const [allSpaces, allAccounts, allLinks] = await Promise.all([
      store.allRows('space'),
      store.allRows('account'),
      store.allRows('accountLink'),
    ]);
    const spaces = allSpaces.filter((s) => s.deleted === 0);
    const accounts = allAccounts.filter((a) => a.deleted === 0);
    const links = allLinks.filter((l) => l.deleted === 0);
    const spaceNames = new Map(spaces.map((s) => [s.id, s.name]));
    const memberSpaceIds = new Set(spaces.map((s) => s.id));

    const viaByAccount = new Map<string, SharedVia[]>();
    for (const link of links) {
      if (!memberSpaceIds.has(link.spaceId)) continue;
      const list = viaByAccount.get(link.accountId) ?? [];
      list.push({
        spaceId: link.spaceId,
        spaceName: spaceNames.get(link.spaceId) ?? link.spaceId.slice(0, 8),
        archived: !!link.archived,
        attachedByName: link.attachedByName,
        historyFrom: link.historyFrom,
        linkRowId: link.id,
      });
      viaByAccount.set(link.accountId, list);
    }

    const mine: GlobalAccount[] = [];
    const scopedBySpace = new Map<string, GlobalAccount[]>();
    const sharedWithMe: GlobalAccount[] = [];
    for (const account of accounts) {
      const isFeedAccount = !memberSpaceIds.has(account.spaceId);
      const entry: GlobalAccount = {
        account,
        feedSpaceId: isFeedAccount ? account.spaceId : undefined,
        sharedVia: viaByAccount.get(account.id) ?? [],
      };
      if (!isFeedAccount) {
        // manual rows live inside their space — never in the global list
        const list = scopedBySpace.get(account.spaceId) ?? [];
        list.push(entry);
        scopedBySpace.set(account.spaceId, list);
      } else if (!myFeedIds || myFeedIds.has(account.spaceId)) {
        mine.push(entry);
      } else {
        sharedWithMe.push(entry);
      }
    }
    const spaceScoped: SpaceScopedAccounts[] = [...scopedBySpace.entries()]
      .map(([spaceId, list]) => ({ spaceId, spaceName: spaceNames.get(spaceId) ?? spaceId.slice(0, 8), accounts: list }))
      .sort((a, b) => a.spaceName.localeCompare(b.spaceName));
    return { mine, spaceScoped, sharedWithMe };
  }, [myFeedIds]);
}

/**
 * #212 (user): changing an account's TYPE is destructive by design —
 * the type drives the stamping rules, so every transaction on the
 * account goes back to review with a fresh interpretation (category
 * cleared, type re-derived from the new stamp), "as if the account is
 * added for the first time". Physical facts survive: balances, links
 * and pairs describe money that actually moved and are not the type's
 * business. Writes go through the transform choke per space, so
 * per-space overlays (feed rows) and plain rows both land correctly.
 */
export async function changeAccountType(
  store: StorageBackend,
  repo: Repo,
  account: AccountRow,
  nextType: AccountType,
): Promise<number> {
  await repo.upsert('account', account.spaceId, account.id, { type: nextType });
  const stamp = accountStamp(nextType);
  const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0);
  let touched = 0;
  for (const space of spaces) {
    const rows = (await visibleTransactions(store, space.id)).filter((r) => r.accountId === account.id && r.deleted === 0);
    for (const row of rows) {
      await writeTxTransform(repo, row, {
        catId: UNCATEGORIZED_ID,
        txType: stamp ?? standardTypeFor(row.amountCents),
        needsReview: 1,
      });
      touched++;
    }
  }
  return touched;
}
