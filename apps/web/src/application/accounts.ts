import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { visibleTransactions, writeTxTransform } from '@/db/joined';
import { UNCATEGORIZED_ID } from '@/domain/categories';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { AccountLinkRow, AccountRow, AccountType } from '@/db/types';

// accounts are not space-scoped: a FEED account lives in a feed space (feeds carry no space row), `sharedVia` collects
// the attached local spaces, and accounts on feeds the user does not own (/me/feeds) are "shared with me"

export interface SharedVia {
  spaceId: string;
  spaceName: string;
  archived: boolean;
  attachedByName?: string;
  historyFrom?: string;
  /** #305: the SPACE's type opinion for the attachment (#152) */
  type?: AccountType;
  linkRowId: string;
}

export interface GlobalAccount {
  account: AccountRow;
  /** set for feed accounts (undefined = the space's own manual row) */
  feedSpaceId?: string;
  sharedVia: SharedVia[];
}

export interface SpaceScopedAccounts {
  spaceId: string;
  spaceName: string;
  accounts: GlobalAccount[];
}

export interface GlobalAccounts {
  /** feed accounts (bank connections + statement imports): the only truly user-level rows */
  mine: GlobalAccount[];
  /** manual accounts live inside a space, grouped per space */
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
    // #295: a deleted space's account rows stay live and, with no live space row, read as FEED accounts with a false
    // "not attached" badge; real feeds never have a local space row
    const tombstonedSpaceIds = new Set(allSpaces.filter((s) => s.deleted !== 0).map((s) => s.id));

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
        type: link.type,
        linkRowId: link.id,
      });
      viaByAccount.set(link.accountId, list);
    }

    const mine: GlobalAccount[] = [];
    const scopedBySpace = new Map<string, GlobalAccount[]>();
    const sharedWithMe: GlobalAccount[] = [];
    for (const account of accounts) {
      if (tombstonedSpaceIds.has(account.spaceId)) continue;
      const isFeedAccount = !memberSpaceIds.has(account.spaceId);
      const entry: GlobalAccount = {
        account,
        feedSpaceId: isFeedAccount ? account.spaceId : undefined,
        sharedVia: viaByAccount.get(account.id) ?? [],
      };
      if (!isFeedAccount) {
        const list = scopedBySpace.get(account.spaceId) ?? [];
        list.push(entry);
        scopedBySpace.set(account.spaceId, list);
      } else if (!myFeedIds || myFeedIds.has(account.spaceId) || entry.sharedVia.length === 0) {
        // #182: a feed with ZERO links can only be mine; mid-import the ownership fetch is stale and it landed under
        // "shared with me" with a false Archived pill
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

// #205: read from RAW rows across all local spaces: visibleTransactions (member spaces, gated) under-reports the fact
export async function newestTxDate(store: StorageBackend, accountId: string): Promise<string | undefined> {
  let newest: string | undefined;
  for (const tx of await store.allRows('transaction')) {
    if (tx.deleted !== 0 || tx.accountId !== accountId) continue;
    if (!newest || tx.date > newest) newest = tx.date;
  }
  return newest;
}

// #212: a type change is destructive by design: the type drives stamping, so every transaction on the account goes
// back to review with the category cleared; balances, links and pairs are physical facts and survive
export async function changeAccountType(
  store: StorageBackend,
  repo: Repo,
  account: AccountRow,
  nextType: AccountType,
): Promise<number> {
  await repo.upsert('account', account.spaceId, account.id, { type: nextType });
  const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0);
  let touched = 0;
  for (const space of spaces) {
    const rows = (await visibleTransactions(store, space.id)).filter((r) => r.accountId === account.id && r.deleted === 0);
    for (const row of rows) {
      await writeTxTransform(repo, row, {
        catId: UNCATEGORIZED_ID,
        needsReview: 1,
      });
      touched++;
    }
  }
  return touched;
}

// #212: an attached account's type is the SPACE's fact on the accountLink: only this space's rows return to review,
// other spaces' readings stand
export async function changeLinkedAccountType(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  link: AccountLinkRow,
  nextType: AccountType,
): Promise<number> {
  await repo.upsert('accountLink', spaceId, link.id, { type: nextType });
  const rows = (await visibleTransactions(store, spaceId)).filter(
    (r) => r.accountId === link.accountId && r.deleted === 0,
  );
  let touched = 0;
  for (const row of rows) {
    await writeTxTransform(repo, row, {
      catId: UNCATEGORIZED_ID,
      needsReview: 1,
    });
    touched++;
  }
  return touched;
}
