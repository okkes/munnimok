import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import { visibleTransactions, writeTxTransform } from '@/db/joined';
import { tombstonedIds } from '@/domain/catalogDoc';
import { REIMBURSED_ID, UNCATEGORIZED_ID } from '@/domain/categories';
import type { TxReimbursement, TxSplit, TxSplitCat } from '@/db/types';
import { isReimbContainer, largestOpenPartId, reimbCentsByPart, reimbSettleFields } from '@/domain/reimbursement';
import { cachedCatalog } from '@/sync/catalogSync';

// AC3: once per catalog version, retired builtins detach their transactions and overlays to Uncategorized and back to
// review; custom subs under a retired premade parent cascade away; other custom categories are never touched
export async function applyCatalogTombstones(store: StorageBackend, repo: Repo): Promise<number> {
  const doc = await cachedCatalog(store);
  if (!doc) return 0;
  const dead = new Set(tombstonedIds(doc));
  if (dead.size === 0) return 0;
  const markerKey = `catalogDetach_v${doc.version}`;
  if (await store.metaGet(markerKey)) return 0;

  let touched = 0;
  const orphans = (await store.allRows('category')).filter(
    (c) => c.deleted === 0 && !!c.parentId && dead.has(c.parentId),
  );
  for (const orphan of orphans) {
    await repo.remove('category', orphan.spaceId, orphan.id);
    dead.add(orphan.id);
    touched++;
  }
  for (const tx of await store.allRows('transaction')) {
    if (tx.deleted === 0 && tx.catId && dead.has(tx.catId)) {
      await repo.upsert('transaction', tx.spaceId, tx.id, { catId: UNCATEGORIZED_ID, needsReview: 1 });
      touched++;
    }
  }
  for (const meta of await store.allRows('txMeta')) {
    if (meta.deleted === 0 && meta.catId && dead.has(meta.catId)) {
      await repo.upsert('txMeta', meta.spaceId, meta.id, { catId: UNCATEGORIZED_ID, needsReview: 1 });
      touched++;
    }
  }
  await store.metaPut(markerKey, Date.now());
  return touched;
}

// #228: reimbursement on a SPLIT stays on the split. EVERY boot: a link made before its row was split gets a part name
// and each side is recomputed; ID-based tie-breaks make concurrent heals on two devices write identical rows (LWW)
export async function normalizeReimbursements(store: StorageBackend, repo: Repo): Promise<number> {
  let touched = 0;
  const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0);
  for (const space of spaces) touched += await settleSpaceReimbursements(store, repo, space.id);
  return touched;
}

/** #617: one space settled now, right after its transactions were deleted, so neither side waits for the next start */
export async function settleSpaceReimbursements(store: StorageBackend, repo: Repo, spaceId: string): Promise<number> {
  return normalizeSpaceReimbursements(store, repo, await visibleTransactions(store, spaceId));
}

/** settle bookkeeping still on a side whose links may all be gone */
const hasReimbRemnant = (tx: { cats?: TxSplitCat[]; splits?: TxSplit[] }): boolean =>
  (tx.cats ?? []).some((c) => c.catId === REIMBURSED_ID) ||
  (tx.splits ?? []).some((s) => s.cats?.some((c) => c.catId === REIMBURSED_ID));

type SpaceRows = Awaited<ReturnType<typeof visibleTransactions>>;

const bump = (map: Map<string, number>, key: string, cents: number): void => {
  map.set(key, (map.get(key) ?? 0) + cents);
};

function nameLooseLink(
  tx: SpaceRows[number],
  link: TxReimbursement,
  ownNamed: Map<string, number>,
  byId: Map<string, SpaceRows[number]>,
  givenOf: (creditId: string) => Map<string, number>,
): TxReimbursement {
  let next = link;
  if (!next.partId && isReimbContainer(tx)) {
    const partId = largestOpenPartId(tx.splits, ownNamed);
    if (partId) {
      next = { ...next, partId };
      bump(ownNamed, partId, next.amountCents);
    }
  }
  const credit = byId.get(next.txId);
  if (!next.creditPartId && credit && isReimbContainer(credit)) {
    const creditPartId = largestOpenPartId(credit.splits, givenOf(credit.id));
    if (creditPartId) {
      next = { ...next, creditPartId };
      bump(givenOf(credit.id), creditPartId, next.amountCents);
    }
  }
  return next;
}

function seedNamedGiven(txs: SpaceRows): Map<string, Map<string, number>> {
  const namedGiven = new Map<string, Map<string, number>>();
  for (const tx of txs) {
    for (const link of tx.reimbursements ?? []) {
      if (!link.creditPartId) continue;
      const map = namedGiven.get(link.txId) ?? new Map<string, number>();
      namedGiven.set(link.txId, map);
      bump(map, link.creditPartId, link.amountCents);
    }
  }
  return namedGiven;
}

// pass A: a link made before the row was split lands on the largest open part, in stable row order so devices converge
async function nameReimbursementParts(repo: Repo, txs: SpaceRows): Promise<Map<string, TxReimbursement[]>> {
  const byId = new Map(txs.map((tx) => [tx.id, tx]));
  const namedGiven = seedNamedGiven(txs);
  const givenOf = (creditId: string) => {
    const map = namedGiven.get(creditId) ?? new Map<string, number>();
    namedGiven.set(creditId, map);
    return map;
  };

  const nextLinks = new Map<string, TxReimbursement[]>();
  for (const tx of [...txs].sort((a, b) => a.id.localeCompare(b.id))) {
    const links = tx.reimbursements ?? [];
    if (!links.length) continue;
    const ownNamed = new Map<string, number>();
    for (const link of links) {
      if (link.partId) bump(ownNamed, link.partId, link.amountCents);
    }
    const renamed = links.map((link) => nameLooseLink(tx, link, ownNamed, byId, givenOf));
    if (renamed.some((link, i) => link !== links[i])) {
      await writeTxTransform(repo, tx, { reimbursements: renamed });
      nextLinks.set(tx.id, renamed);
    }
  }
  return nextLinks;
}

// compare the stored essence: the join adds derived view fields, and comparing those to rebuilt entries rewrites every boot
const plainCats = (cats: TxSplitCat[] | null | undefined): { catId: string; amountCents: number; pct?: number }[] | null =>
  cats?.length
    ? cats.map((c) => ({ catId: c.catId, amountCents: c.amountCents, ...(c.pct !== undefined ? { pct: c.pct } : {}) }))
    : null;
const comparableSplits = (splits: TxSplit[] | null | undefined) =>
  splits?.length ? splits.map((p) => ({ ...p, txType: undefined, cats: plainCats(p.cats) ?? undefined })) : null;

// #617: a link to a deleted transaction is no link; only a row this device holds as deleted counts, one it lacks may not
// have arrived
async function dropLinksToDeleted(store: StorageBackend, repo: Repo, txs: SpaceRows): Promise<{ rows: SpaceRows; dropped: number }> {
  const live = new Set(txs.map((tx) => tx.id));
  const gone = new Map<string, boolean>();
  const isGone = async (id: string): Promise<boolean> => {
    if (live.has(id)) return false;
    if (!gone.has(id)) gone.set(id, (await store.get('transaction', id))?.deleted === 1);
    return gone.get(id) ?? false;
  };
  const rows: SpaceRows = [];
  let dropped = 0;
  for (const tx of txs) {
    const links = tx.reimbursements ?? [];
    const kept: TxReimbursement[] = [];
    for (const link of links) {
      if (!(await isGone(link.txId))) kept.push(link);
    }
    if (kept.length === links.length) {
      rows.push(tx);
      continue;
    }
    await writeTxTransform(repo, tx, { reimbursements: kept });
    rows.push({ ...tx, reimbursements: kept });
    dropped++;
  }
  return { rows, dropped };
}

async function normalizeSpaceReimbursements(store: StorageBackend, repo: Repo, allRows: SpaceRows): Promise<number> {
  const nameOf = (id: string) => id;
  const { rows: txs, dropped } = await dropLinksToDeleted(
    store,
    repo,
    allRows.filter((tx) => tx.deleted === 0),
  );
  const renamed = await nameReimbursementParts(repo, txs);
  const linksOf = (tx: SpaceRows[number]) => renamed.get(tx.id) ?? tx.reimbursements ?? [];

  const namedBy = new Map<string, TxReimbursement[]>();
  for (const tx of txs) {
    for (const link of linksOf(tx)) {
      namedBy.set(link.txId, [...(namedBy.get(link.txId) ?? []), link]);
    }
  }
  let touched = dropped;
  for (const tx of txs) {
    const own = linksOf(tx);
    const named = namedBy.get(tx.id) ?? [];
    if (!own.length && !named.length && !hasReimbRemnant(tx)) continue;
    const side = tx.amountCents > 0 ? named : own;
    const total = side.reduce((sum, link) => sum + link.amountCents, 0);
    const byPart = reimbCentsByPart(side, tx.amountCents > 0 ? 'creditPartId' : 'partId', tx.splits);
    const fields = settleDiffFields(tx, reimbSettleFields(tx, total, byPart, nameOf));
    if (!Object.keys(fields).length) continue;
    await writeTxTransform(repo, tx, fields);
    touched++;
  }
  return touched;
}

function settleDiffFields(
  tx: SpaceRows[number],
  patch: ReturnType<typeof reimbSettleFields>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (patch.catId !== undefined && patch.catId !== tx.catId) fields.catId = patch.catId;
  if ('cats' in patch && JSON.stringify(plainCats(patch.cats)) !== JSON.stringify(plainCats(tx.cats))) {
    fields.cats = patch.cats;
  }
  if ('splits' in patch && JSON.stringify(comparableSplits(patch.splits)) !== JSON.stringify(comparableSplits(tx.splits))) {
    fields.splits = patch.splits;
  }
  return fields;
}
