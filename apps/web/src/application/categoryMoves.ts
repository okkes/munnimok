import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { CategoryRow } from '@/db/types';
import {
  GROCERY_MAIN_ID,
  GROCERY_MAIN_NAMES,
  GROCERY_OTHER_ID,
  GROCERY_SUB_BY_NAME,
  MERGED_BUILTINS,
  movedIds,
  movedItems,
  movedPicks,
  movedStory,
  normCatName,
} from '@/domain/categoryMoves';
import type { CatMoves } from '@/domain/categoryMoves';
import { myStoreFeedId } from './storeFeed';

/** the spaces this identity may write, and its own store feed (receipts live there; a feed has no space row) */
async function writableSpaceIds(store: StorageBackend, repo: Repo): Promise<string[]> {
  const ids = new Set((await store.allRows('space')).filter((s) => s.deleted === 0).map((s) => s.id));
  const feed = myStoreFeedId();
  if (feed) ids.add(feed);
  return [...ids].filter((id) => repo.canWrite(id));
}

async function moveTransactions(store: StorageBackend, repo: Repo, spaceId: string, moves: CatMoves): Promise<number> {
  let touched = 0;
  for (const tx of await store.bySpace('transaction', spaceId)) {
    const story = tx.deleted === 0 ? movedStory(tx, moves) : null;
    if (!story) continue;
    await repo.upsert('transaction', spaceId, tx.id, story);
    touched += 1;
  }
  for (const meta of await store.bySpace('txMeta', spaceId)) {
    const story = meta.deleted === 0 ? movedStory(meta, moves) : null;
    if (!story) continue;
    await repo.upsert('txMeta', spaceId, meta.id, story);
    touched += 1;
  }
  return touched;
}

async function moveRecurrings(store: StorageBackend, repo: Repo, spaceId: string, moves: CatMoves): Promise<number> {
  let touched = 0;
  for (const rec of await store.bySpace('recurring', spaceId)) {
    if (rec.deleted !== 0 || !rec.catId || !moves.has(rec.catId)) continue;
    await repo.upsert('recurring', spaceId, rec.id, { catId: moves.get(rec.catId) });
    touched += 1;
  }
  return touched;
}

async function moveBudgets(store: StorageBackend, repo: Repo, spaceId: string, moves: CatMoves): Promise<number> {
  let touched = 0;
  for (const budget of await store.bySpace('budget', spaceId)) {
    const catIds = budget.deleted === 0 ? movedIds(budget.catIds, moves) : null;
    if (!catIds) continue;
    await repo.upsert('budget', spaceId, budget.id, { catIds });
    touched += 1;
  }
  return touched;
}

async function moveSubjects(store: StorageBackend, repo: Repo, spaceId: string, moves: CatMoves): Promise<number> {
  let touched = 0;
  for (const subject of await store.bySpace('planSubject', spaceId)) {
    if (subject.deleted !== 0) continue;
    const catIds = movedIds(subject.catIds, moves);
    const excludeCatIds = movedIds(subject.excludeCatIds, moves);
    if (!catIds && !excludeCatIds) continue;
    await repo.upsert('planSubject', spaceId, subject.id, { ...(catIds ? { catIds } : {}), ...(excludeCatIds ? { excludeCatIds } : {}) });
    touched += 1;
  }
  return touched;
}

async function moveReceipts(store: StorageBackend, repo: Repo, spaceId: string, moves: CatMoves): Promise<number> {
  let touched = 0;
  for (const link of await store.bySpace('receiptLink', spaceId)) {
    if (link.deleted !== 0) continue;
    const items = movedItems(link.items, moves);
    const picks = movedPicks(link.picks, moves);
    if (!items && !picks) continue;
    await repo.upsert('receiptLink', spaceId, link.id, { ...(items ? { items } : {}), ...(picks ? { picks } : {}) });
    touched += 1;
  }
  for (const receipt of await store.bySpace('receipt', spaceId)) {
    const items = receipt.deleted === 0 ? movedItems(receipt.items, moves) : null;
    if (!items) continue;
    await repo.upsert('receipt', spaceId, receipt.id, { items });
    touched += 1;
  }
  return touched;
}

async function moveSpaceRow(store: StorageBackend, repo: Repo, spaceId: string, moves: CatMoves): Promise<number> {
  const space = await store.get('space', spaceId);
  if (space?.deleted !== 0) return 0;
  const hiddenMains = movedIds(space.hiddenMains, moves);
  const graphs = space.trendGraphs ?? [];
  const trendGraphs = graphs.some((graph) => movedIds(graph.catIds, moves))
    ? graphs.map((graph) => ({ ...graph, catIds: movedIds(graph.catIds, moves) ?? graph.catIds }))
    : null;
  if (!hiddenMains && !trendGraphs) return 0;
  await repo.upsert('space', spaceId, spaceId, { ...(hiddenMains ? { hiddenMains } : {}), ...(trendGraphs ? { trendGraphs } : {}) });
  return 1;
}

/** every stored mention of a moved category in one space follows it; amounts and everything else stay as they are */
export async function moveCategoriesInSpace(store: StorageBackend, repo: Repo, spaceId: string, moves: CatMoves): Promise<number> {
  if (moves.size === 0 || !repo.canWrite(spaceId)) return 0;
  return (
    (await moveTransactions(store, repo, spaceId, moves)) +
    (await moveRecurrings(store, repo, spaceId, moves)) +
    (await moveBudgets(store, repo, spaceId, moves)) +
    (await moveSubjects(store, repo, spaceId, moves)) +
    (await moveReceipts(store, repo, spaceId, moves)) +
    (await moveSpaceRow(store, repo, spaceId, moves))
  );
}

async function moveEverywhere(store: StorageBackend, repo: Repo, moves: CatMoves): Promise<number> {
  let touched = 0;
  for (const spaceId of await writableSpaceIds(store, repo)) touched += await moveCategoriesInSpace(store, repo, spaceId, moves);
  return touched;
}

/** where a person's own Groceries tree goes: the main and every sub the catalog names; the rest stays theirs */
export function groceryFold(main: CategoryRow, subs: readonly CategoryRow[]): { moves: Map<string, string>; kept: CategoryRow[] } {
  const moves = new Map<string, string>([[main.id, GROCERY_MAIN_ID]]);
  const kept: CategoryRow[] = [];
  for (const sub of subs) {
    const target = sub.isOther === 1 ? GROCERY_OTHER_ID : GROCERY_SUB_BY_NAME.get(normCatName(sub.name));
    if (target) moves.set(sub.id, target);
    else kept.push(sub);
  }
  return { moves, kept };
}

// #653: a main a person made for groceries before the catalog had one becomes the catalog's — told by its name; what was
// filed under it and under the subs the catalog names follows, a sub it has no name for stays the person's own under the
// catalog's main. The custom rows go last, so a pass cut short finds the main again and goes on
export async function foldOwnGroceries(store: StorageBackend, repo: Repo): Promise<number> {
  const rows = (await store.allRows('category')).filter((c) => c.deleted === 0);
  const mains = rows.filter(
    (c) => c.isParent === 1 && c.txType === 'expense' && GROCERY_MAIN_NAMES.has(normCatName(c.name)) && repo.canWrite(c.spaceId),
  );
  let touched = 0;
  for (const main of mains) {
    const subs = rows.filter((c) => c.parentId === main.id);
    const { moves, kept } = groceryFold(main, subs);
    for (const sub of kept) await repo.upsert('category', sub.spaceId, sub.id, { parentId: GROCERY_MAIN_ID });
    touched += await moveEverywhere(store, repo, moves);
    for (const sub of subs) if (moves.has(sub.id)) await repo.remove('category', sub.spaceId, sub.id);
    await repo.remove('category', main.spaceId, main.id);
    touched += 1;
  }
  return touched;
}

// every start, once the device holds what the server holds (a copy that is behind would move rows another device
// already moved or refiled): the merged built-ins a device still names, then the person's own Groceries tree.
// The server moves the merged built-ins once for everybody; this is for what a device wrote before it updated
export async function applyCategoryMoves(store: StorageBackend, repo: Repo): Promise<number> {
  return (await moveEverywhere(store, repo, MERGED_BUILTINS)) + (await foldOwnGroceries(store, repo));
}
