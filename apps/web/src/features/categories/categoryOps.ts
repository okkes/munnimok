import { CATEGORY_BY_ID, LOCKED_MAIN_IDS } from '@/domain/categories';
import {
  affectedByDelete,
  affectedByDirectionChange,
  affectedByTypeChange,
  detachCategoryPatch,
} from '@/domain/categoryRules';
import { historyTransactions, writeTxTransform } from '@/db/joined';
import type { SpaceTx } from '@/db/joined';
import type { CategoryRow, CatDirection, SpaceRow, TxType } from '@/db/types';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import { firstFreeIcon } from './categoryIcons';

// edits that break assignments report the affected transactions first; commit detaches them to Uncategorized + review

export interface CategoryChanges {
  name?: string;
  icon?: string;
  color?: string;
  txType?: TxType;
  direction?: CatDirection;
  parentId?: string;
}

export interface PendingCommit {
  affected: SpaceTx[];
  commit: () => Promise<void>;
}

/** a custom category belongs to the space it was created in (#387): only that space's transactions can reference it */
async function visibleSpaceIds(_store: StorageBackend, row: CategoryRow): Promise<string[]> {
  return [row.spaceId];
}

/** #389: sub-categories under one main must not share an icon — the icon is the row's face in every list */
export const iconConflict = (
  candidate: { icon: string; parentId?: string; selfId?: string },
  rows: readonly { id: string; icon: string; parentId?: string }[],
): boolean =>
  !!candidate.parentId && rows.some((r) => r.parentId === candidate.parentId && r.id !== candidate.selfId && r.icon === candidate.icon);

export interface CopyGroup {
  space: SpaceRow;
  /** the other space's custom main this space lacks — it comes along (with its Other) when ticked */
  main?: CategoryRow;
  /** that main's locked Other: copied with it, and a sibling whose icon the subs may not share */
  other?: CategoryRow;
  /** or: the main the subs join here — a catalog main, or this space's own main of the same name */
  intoId?: string;
  /** the custom subs this space lacks under that main — each one a pick of its own (#390 r2) */
  subs: CategoryRow[];
}

const normName = (name?: string) => (name ?? '').trim().toLowerCase();
const isCatalogMain = (id: string) => !!CATEGORY_BY_ID.get(id)?.isParent;

interface CopyScan {
  /** the active space's mains: name → id */
  hereMains: ReadonlyMap<string, string>;
  /** the active space's subs, as `parentId|name` */
  hereSubs: ReadonlySet<string>;
  mains: ReadonlyMap<string, CategoryRow>;
  groups: Map<string, CopyGroup>;
}

function groupOf(scan: CopyScan, space: SpaceRow, sourceMainId: string): CopyGroup {
  const key = `${space.id}|${sourceMainId}`;
  let group = scan.groups.get(key);
  if (!group) {
    group = { space, subs: [] };
    scan.groups.set(key, group);
  }
  return group;
}

/** a custom main heads its own group — unless a main of the same name is here: that one takes its subs instead (addSub) */
function addMain(scan: CopyScan, space: SpaceRow, row: CategoryRow): void {
  if (!scan.hereMains.has(normName(row.name))) groupOf(scan, space, row.id).main = row;
}

function addOther(scan: CopyScan, space: SpaceRow, row: CategoryRow): void {
  if (row.parentId && scan.mains.has(row.parentId)) groupOf(scan, space, row.parentId).other = row;
}

/** spaces often hold the same category (it was copied between them): only the first space's offer stands, or ticking both would write it twice */
function offeredOnce(groups: readonly CopyGroup[]): CopyGroup[] {
  const mains = new Set<string>();
  const subs = new Set<string>();
  const offered: CopyGroup[] = [];
  for (const group of groups) {
    if (group.main) {
      const name = normName(group.main.name);
      if (!mains.has(name)) offered.push(group);
      mains.add(name);
      continue;
    }
    const fresh = group.subs.filter((sub) => !subs.has(`${group.intoId}|${normName(sub.name)}`));
    for (const sub of fresh) subs.add(`${group.intoId}|${normName(sub.name)}`);
    if (fresh.length > 0) offered.push({ ...group, subs: fresh });
  }
  return offered;
}

function addSub(scan: CopyScan, space: SpaceRow, row: CategoryRow): void {
  if (!row.parentId) return;
  const sourceMain = scan.mains.get(row.parentId);
  const joins = sourceMain ? scan.hereMains.get(normName(sourceMain.name)) : row.parentId;
  if (!sourceMain && !isCatalogMain(row.parentId)) return;
  if (joins && (LOCKED_MAIN_IDS.has(joins) || scan.hereSubs.has(`${joins}|${normName(row.name)}`))) return;
  const group = groupOf(scan, space, row.parentId);
  if (joins) group.intoId = joins;
  group.subs.push(row);
}

// #390: "has already" is decided by name; locked specials take no subs (#385); rows of the active space never appear
export function copyGroups(spaceId: string, spaces: readonly SpaceRow[], rows: readonly CategoryRow[]): CopyGroup[] {
  const live = rows.filter((r) => r.deleted === 0);
  const here = live.filter((r) => r.spaceId === spaceId);
  const hereMains = new Map(here.filter((r) => r.isParent === 1).map((r) => [normName(r.name), r.id]));
  const hereSubs = new Set(here.filter((r) => r.isParent !== 1).map((r) => `${r.parentId}|${normName(r.name)}`));
  const spaceById = new Map(spaces.filter((sp) => sp.deleted === 0).map((sp) => [sp.id, sp]));
  const mains = new Map(live.filter((r) => r.isParent === 1).map((r) => [r.id, r]));
  const scan: CopyScan = { hereMains, hereSubs, mains, groups: new Map() };
  for (const row of live) {
    if (row.spaceId === spaceId) continue;
    const space = spaceById.get(row.spaceId);
    if (!space) continue;
    if (row.isParent === 1) addMain(scan, space, row);
    else if (row.isOther === 1) addOther(scan, space, row);
    else addSub(scan, space, row);
  }
  const byName = (a: CategoryRow, b: CategoryRow) => (a.name ?? '').localeCompare(b.name ?? '');
  const ordered = [...scan.groups.values()]
    .filter((g) => g.main || (g.intoId && g.subs.length > 0))
    .map((g) => ({ ...g, subs: [...g.subs].sort(byName) }))
    .sort(
      (a, b) =>
        a.space.name.localeCompare(b.space.name) ||
        // two spaces may share a name: the id keeps one space's groups together and the first offer the same on every render
        a.space.id.localeCompare(b.space.id) ||
        Number(!a.main) - Number(!b.main) ||
        (a.main?.name ?? a.intoId ?? '').localeCompare(b.main?.name ?? b.intoId ?? ''),
    );
  return offeredOnce(ordered);
}

// a declined offer's key: the main's name for a main this space lacks (any space), else the main here the subs join
export const copyDeclineKey = (group: CopyGroup): string => (group.main ? `main:${normName(group.main.name)}` : `into:${group.intoId ?? ''}`);

export const copyDeclineNames = (group: CopyGroup): string[] => group.subs.map((sub) => normName(sub.name)).sort((a, b) => a.localeCompare(b));

// #390 r4: a declined offer returns only when its main gains a sub that was not on offer; a removed sub changes nothing
export function withoutDeclined(groups: readonly CopyGroup[], declined: Readonly<Record<string, string[]>> | null | undefined): CopyGroup[] {
  return groups.filter((group) => {
    const seen = declined?.[copyDeclineKey(group)];
    return !seen || group.subs.some((sub) => !seen.includes(normName(sub.name)));
  });
}

export async function declineCopyGroup(store: StorageBackend, repo: Repo, spaceId: string, group: CopyGroup): Promise<void> {
  const declined = (await store.get('space', spaceId))?.copyDeclined ?? {};
  await repo.upsert('space', spaceId, spaceId, { copyDeclined: { ...declined, [copyDeclineKey(group)]: copyDeclineNames(group) } });
}

export async function restoreCopyOffers(repo: Repo, spaceId: string): Promise<void> {
  await repo.upsert('space', spaceId, spaceId, { copyDeclined: {} });
}

/** how much the banner announces: a main counts once with its subs, a sub joining a main here counts on its own */
export const copyCount = (groups: readonly CopyGroup[]): number => groups.reduce((n, g) => n + (g.main ? 1 : g.subs.length), 0);

/** a new main has one sibling already: the Other that is copied with it */
function wornWhere(group: CopyGroup, wornUnder: (mainId: string) => Iterable<string>): Iterable<string> {
  if (group.intoId) return wornUnder(group.intoId);
  return group.other ? [group.other.icon] : [];
}

// #389: decided over ALL groups in order, one worn set per target main: two groups into one main never share an icon,
// and the sheet previews exactly what a copy writes
export function copyFaces(groups: readonly CopyGroup[], wornUnder: (mainId: string) => Iterable<string>): Map<string, string> {
  const wornByTarget = new Map<string, Set<string>>();
  const faces = new Map<string, string>();
  for (const group of groups) {
    const target = group.intoId ? `into:${group.intoId}` : `new:${group.main?.id ?? ''}`;
    const worn = wornByTarget.get(target) ?? new Set(wornWhere(group, wornUnder));
    wornByTarget.set(target, worn);
    for (const sub of group.subs) {
      const face = worn.has(sub.icon) ? firstFreeIcon(worn) : sub.icon;
      worn.add(face);
      faces.set(sub.id, face);
    }
  }
  return faces;
}

// own rows and attached feeds, with the view's DERIVED types (a category conflict is view-level; nothing stores a type)
async function txsInSpaces(store: StorageBackend, spaceIds: string[]): Promise<SpaceTx[]> {
  const out: SpaceTx[] = [];
  for (const spaceId of spaceIds) out.push(...(await historyTransactions(store, spaceId)));
  return out;
}

const parentTypeOf = async (store: StorageBackend, parentId: string): Promise<TxType> => {
  const builtin = CATEGORY_BY_ID.get(parentId);
  if (builtin) return builtin.txTypes[0];
  const custom = await store.get('category', parentId);
  return custom?.txType ?? 'expense';
};

// #244: a sub follows its parent's nature: income is credit, expense debit; legacy custom mains of other types stay open
export const directionForType = (txType: TxType): CatDirection => {
  if (txType === 'income') return 'credit';
  return txType === 'expense' ? 'debit' : 'both';
};

/** the space's opinion is what detaches: in place on own rows, on the
 *  overlay for feed rows (the ONE write path) */
async function detachAll(repo: Repo, affected: SpaceTx[], catIds: Set<string>): Promise<void> {
  for (const tx of affected) {
    await writeTxTransform(repo, tx, detachCategoryPatch(tx, catIds));
  }
}

export async function subsOf(store: StorageBackend, parent: CategoryRow): Promise<CategoryRow[]> {
  return (await store.allRows('category')).filter((c) => c.deleted === 0 && c.parentId === parent.id);
}

interface EditImpact {
  affected: SpaceTx[];
  detachIds: Set<string>;
  /** the sub's new inherited type when it moves under another parent */
  movedType?: TxType;
}

const addBroken = (impact: EditImpact, broken: SpaceTx[], catIds: Iterable<string>) => {
  if (broken.length === 0) return;
  for (const tx of broken) {
    if (!impact.affected.some((a) => a.id === tx.id)) impact.affected.push(tx);
  }
  for (const id of catIds) impact.detachIds.add(id);
};

const typeChangeImpact = (impact: EditImpact, txs: SpaceTx[], row: CategoryRow, changes: CategoryChanges, subtree: Set<string>) => {
  if (row.isParent !== 1 || !changes.txType || changes.txType === row.txType) return;
  addBroken(impact, affectedByTypeChange(txs, subtree, changes.txType), subtree);
};

const directionChangeImpact = (impact: EditImpact, txs: SpaceTx[], row: CategoryRow, changes: CategoryChanges) => {
  if (row.isParent === 1 || !changes.direction || changes.direction === (row.direction ?? 'both')) return;
  addBroken(impact, affectedByDirectionChange(txs, row.id, changes.direction), [row.id]);
};

const moveImpact = async (impact: EditImpact, store: StorageBackend, txs: SpaceTx[], row: CategoryRow, changes: CategoryChanges) => {
  if (row.isParent === 1 || !changes.parentId || changes.parentId === row.parentId) return;
  impact.movedType = await parentTypeOf(store, changes.parentId);
  if (impact.movedType === row.txType) return;
  addBroken(impact, affectedByTypeChange(txs, new Set([row.id]), impact.movedType), [row.id]);
};

export async function prepareCategoryEdit(
  store: StorageBackend,
  repo: Repo,
  row: CategoryRow,
  changes: CategoryChanges,
): Promise<PendingCommit> {
  const txs = await txsInSpaces(store, await visibleSpaceIds(store, row));
  const subs = row.isParent === 1 ? await subsOf(store, row) : [];
  const subtree = new Set([row.id, ...subs.map((s) => s.id)]);

  const impact: EditImpact = { affected: [], detachIds: new Set() };
  typeChangeImpact(impact, txs, row, changes, subtree);
  directionChangeImpact(impact, txs, row, changes);
  await moveImpact(impact, store, txs, row, changes);

  return {
    affected: impact.affected,
    commit: async () => {
      if (impact.detachIds.size > 0) await detachAll(repo, impact.affected, impact.detachIds);
      const patch: Partial<CategoryRow> = { ...changes };
      // #244: a moved sub follows its NEW parent's nature: type and direction both re-derive
      if (impact.movedType) {
        patch.txType = impact.movedType;
        patch.direction = directionForType(impact.movedType);
      }
      await repo.upsert('category', row.spaceId, row.id, patch);
      // keep stored txType on subs consistent with the parent
      if (row.isParent === 1 && changes.txType && changes.txType !== row.txType) {
        for (const sub of subs) {
          await repo.upsert('category', sub.spaceId, sub.id, { txType: changes.txType });
        }
      }
    },
  };
}

export async function prepareCategoryDelete(store: StorageBackend, repo: Repo, row: CategoryRow): Promise<PendingCommit> {
  const subs = row.isParent === 1 ? await subsOf(store, row) : [];
  const subtree = new Set([row.id, ...subs.map((s) => s.id)]);
  const txs = await txsInSpaces(store, await visibleSpaceIds(store, row));
  const affected = affectedByDelete(txs, subtree);
  return {
    affected,
    commit: async () => {
      await detachAll(repo, affected, subtree);
      for (const sub of subs) await repo.remove('category', sub.spaceId, sub.id);
      await repo.remove('category', row.spaceId, row.id);
    },
  };
}

export async function createMainCategory(
  repo: Repo,
  spaceId: string,
  input: { name: string; icon: string; color: string; txType: TxType; otherName: string },
): Promise<string> {
  const id = repo.newId();
  await repo.upsert('category', spaceId, id, {
    name: input.name,
    icon: input.icon,
    color: input.color,
    txType: input.txType,
    isParent: 1,
    sortOrder: 999,
    builtin: 0,
  });
  await repo.upsert('category', spaceId, repo.newId(), {
    parentId: id,
    name: input.otherName,
    icon: input.icon,
    color: '',
    txType: input.txType,
    direction: 'both',
    isOther: 1,
    sortOrder: 9999,
    builtin: 0,
  });
  return id;
}

/** type and direction are inherited from the parent (#244: the user never states a direction) */
export async function createSubCategory(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  input: { parentId: string; name: string; icon: string },
): Promise<string> {
  const id = repo.newId();
  const txType = await parentTypeOf(store, input.parentId);
  await repo.upsert('category', spaceId, id, {
    parentId: input.parentId,
    name: input.name,
    icon: input.icon,
    color: '',
    txType,
    direction: directionForType(txType),
    sortOrder: 999,
    builtin: 0,
  });
  return id;
}

/** the copyable payload of a category row (fresh envelope on the target) */
const categoryCopyFields = (r: CategoryRow, overrides: Partial<CategoryRow>): Record<string, unknown> => ({
  parentId: r.parentId,
  name: r.name,
  icon: r.icon,
  color: r.color,
  txType: r.txType,
  direction: r.direction,
  isParent: r.isParent,
  isOther: r.isOther,
  sortOrder: r.sortOrder,
  builtin: 0,
  ...overrides,
});

// #390: copies categories only; transactions are not touched
export async function copyGroupToSpace(
  repo: Repo,
  targetSpaceId: string,
  group: CopyGroup,
  picked: ReadonlySet<string>,
  faces: ReadonlyMap<string, string>,
): Promise<void> {
  let parentId = group.intoId;
  if (group.main) {
    if (!picked.has(group.main.id)) return;
    parentId = repo.newId();
    await repo.upsert('category', targetSpaceId, parentId, categoryCopyFields(group.main, { parentId: undefined }));
    if (group.other) await repo.upsert('category', targetSpaceId, repo.newId(), categoryCopyFields(group.other, { parentId }));
  }
  if (!parentId) return;
  for (const sub of group.subs) {
    if (!picked.has(sub.id)) continue;
    await repo.upsert('category', targetSpaceId, repo.newId(), categoryCopyFields(sub, { parentId, icon: faces.get(sub.id) ?? sub.icon }));
  }
}
