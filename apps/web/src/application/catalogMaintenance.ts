import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import { visibleTransactions, writeTxTransform } from '@/db/joined';
import { tombstonedIds } from '@/domain/catalogDoc';
import { REIMBURSED_ID, UNCATEGORIZED_ID, autoSubFor } from '@/domain/categories';
import type { TxSplit, TxSplitCat } from '@/db/types';
import { givenCents, settledSplits, totalReimbursedCents } from '@/domain/reimbursement';
import { standardTypeFor } from '@/domain/txKind';
import { cachedCatalog } from '@/sync/catalogSync';

/**
 * AC3: apply the catalog document's tombstones locally, once per
 * published version. Retired builtins detach their transactions (raw
 * rows and per-space overlays) to Uncategorized and put them back into
 * review — the same story as deleting a user category. Custom subs the
 * user created under a retired premade parent cascade away with it
 * (user ruling: "in that case we can't do much about it"); custom
 * categories are otherwise never touched by catalog updates.
 */
export async function applyCatalogTombstones(store: StorageBackend, repo: Repo): Promise<number> {
  const doc = await cachedCatalog(store);
  if (!doc) return 0;
  const dead = new Set(tombstonedIds(doc));
  if (dead.size === 0) return 0;
  const markerKey = `catalogDetach_v${doc.version}`;
  if (await store.metaGet(markerKey)) return 0;

  let touched = 0;
  // cascade: custom subs under a retired premade parent
  const orphans = (await store.allRows('category')).filter(
    (c) => c.deleted === 0 && !!c.parentId && dead.has(c.parentId),
  );
  for (const orphan of orphans) {
    await repo.remove('category', orphan.spaceId, orphan.id);
    dead.add(orphan.id); // their transactions detach in the same pass
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

/**
 * Reimbursement redesign migration (answer d, docs/
 * reimbursement-redesign.md): legacy rows carried NET slices — the
 * settled value had silently shrunk away. One pass per identity rewrites
 * every linked transaction (both sides, per space overlay) to gross
 * slices + an explicit `reimbursed` slice. Tie-breaks use category IDS,
 * not localized names, so concurrent migrations on two devices write
 * byte-identical splits and LWW converges cleanly.
 */
export async function migrateReimbursementSlices(store: StorageBackend, repo: Repo): Promise<number> {
  const markerKey = 'reimbSettledSlices_v1';
  if (await store.metaGet(markerKey)) return 0;
  const nameOf = (id: string) => id;

  let touched = 0;
  const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0);
  for (const space of spaces) {
    touched += await migrateSpaceReimbursements(repo, await visibleTransactions(store, space.id), nameOf);
  }
  await store.metaPut(markerKey, Date.now());
  return touched;
}

/**
 * 2026-08-01 (user, ss review): the debt family shrank to exactly the
 * arc-2 pair — Repaid / Borrowed. Rows on the retired lendMoney /
 * creditCardPayment subs refile under the sign-picked family sub, raw
 * rows and per-space overlays alike; review status stays untouched.
 */
const RETIRED_DEBT_SUBS = new Set(['lendMoney', 'creditCardPayment']);

export async function migrateRetiredDebtSubs(store: StorageBackend, repo: Repo): Promise<number> {
  const markerKey = 'debtSubsRetired_v1';
  if (await store.metaGet(markerKey)) return 0;

  let touched = 0;
  for (const tx of await store.allRows('transaction')) {
    if (tx.deleted === 0 && tx.catId && RETIRED_DEBT_SUBS.has(tx.catId)) {
      await repo.upsert('transaction', tx.spaceId, tx.id, { catId: autoSubFor('debtPayment', tx.amountCents) });
      touched++;
    }
  }
  for (const meta of await store.allRows('txMeta')) {
    if (meta.deleted === 0 && meta.catId && RETIRED_DEBT_SUBS.has(meta.catId)) {
      const raw = await store.get('transaction', meta.txId);
      await repo.upsert('txMeta', meta.spaceId, meta.id, { catId: autoSubFor('debtPayment', raw?.amountCents ?? -1) });
      touched++;
    }
  }
  await store.metaPut(markerKey, Date.now());
  return touched;
}

/**
 * Typed-splits v2, Q3 (user 2026-08-05): the funding TYPE retires —
 * funding is a marked special CATEGORY on standard rows now. Every
 * funding-typed row (raw and overlay alike) re-derives its type by
 * sign and keeps — or gains — its funding category so no meaning is
 * lost. The stored TxType union keeps 'funding' for old devices.
 */
export async function migrateFundingRows(store: StorageBackend, repo: Repo): Promise<number> {
  const markerKey = 'txFundingCat_v1';
  if (await store.metaGet(markerKey)) return 0;

  let touched = 0;
  for (const tx of await store.allRows('transaction')) {
    if (tx.deleted !== 0 || tx.txType !== 'funding') continue;
    await repo.upsert('transaction', tx.spaceId, tx.id, {
      txType: standardTypeFor(tx.amountCents),
      catId: tx.catId && tx.catId !== UNCATEGORIZED_ID ? tx.catId : autoSubFor('funding', tx.amountCents),
    });
    touched++;
  }
  for (const meta of await store.allRows('txMeta')) {
    if (meta.deleted !== 0 || meta.txType !== 'funding') continue;
    const raw = await store.get('transaction', meta.txId);
    const amount = raw?.amountCents ?? -1;
    await repo.upsert('txMeta', meta.spaceId, meta.id, {
      txType: standardTypeFor(amount),
      catId: meta.catId && meta.catId !== UNCATEGORIZED_ID ? meta.catId : autoSubFor('funding', amount),
    });
    touched++;
  }
  await store.metaPut(markerKey, Date.now());
  return touched;
}

/**
 * #211 split categories: `splits` means PARTS from here on — a plain
 * multi-category assignment lives in the row's own `cats` partition.
 * One pass folds every legacy bare-slice split (no part story on any
 * entry) into `cats`, raw rows and per-space overlays alike. Real
 * splits — any entry with a label, type, link, event, recurring,
 * note or spread — stay containers untouched. A partition that no
 * longer sums to the gross amount (pre-redesign drift) also stays: the
 * readers keep their legacy `splits` fallback for exactly that shape.
 */
const isBareSlice = (s: TxSplit): boolean =>
  s.label === undefined && s.txType === undefined && s.linkedAccountId === undefined
    && s.transferPeerId === undefined && s.eventId === undefined && s.recurringId === undefined
    && s.notes === undefined && !s.cats?.length;

/** the fold's write fields — null when the split must stay a container.
 *  A single plain slice is "no split" (the shadow catId already says
 *  it), so only a real spread or settled bookkeeping materializes cats.
 *  A row that EVER saw a #211-aware write carries a `cats` field
 *  version (split writers stamp an explicit null) — its splits are
 *  REAL parts by definition and never fold, so a fresh device syncing
 *  modern data can run this one-shot safely. */
function catSpreadFold(
  row: { cats?: TxSplitCat[]; splits?: TxSplit[]; deleted: number; fieldVersions?: Record<string, string> },
  grossAbs: number,
): { cats?: TxSplitCat[] } | null {
  if (row.deleted !== 0 || row.cats?.length) return null;
  if (row.fieldVersions && 'cats' in row.fieldVersions) return null;
  const splits = row.splits;
  if (!splits?.length || !splits.every(isBareSlice)) return null;
  if (splits.reduce((total, s) => total + s.amountCents, 0) !== grossAbs) return null;
  const entries = splits.map((s) => ({ catId: s.catId, amountCents: s.amountCents, ...(s.pct !== undefined ? { pct: s.pct } : {}) }));
  const spread = entries.length > 1 || entries.some((e) => e.catId === REIMBURSED_ID);
  return spread ? { cats: entries } : {};
}

export async function migrateCatSpreads(store: StorageBackend, repo: Repo): Promise<number> {
  const markerKey = 'txCatSpreads_v1';
  if (await store.metaGet(markerKey)) return 0;

  let touched = 0;
  for (const tx of await store.allRows('transaction')) {
    const fold = catSpreadFold(tx, Math.abs(tx.amountCents));
    if (!fold) continue;
    await repo.upsert('transaction', tx.spaceId, tx.id, { ...fold, splits: null as never });
    touched++;
  }
  for (const meta of await store.allRows('txMeta')) {
    const raw = await store.get('transaction', meta.txId);
    const fold = raw ? catSpreadFold(meta, Math.abs(raw.amountCents)) : null;
    if (!fold) continue;
    await repo.upsert('txMeta', meta.spaceId, meta.id, { ...fold, splits: null as never });
    touched++;
  }
  await store.metaPut(markerKey, Date.now());
  return touched;
}

async function migrateSpaceReimbursements(
  repo: Repo,
  txs: Awaited<ReturnType<typeof visibleTransactions>>,
  nameOf: (id: string) => string,
): Promise<number> {
  let touched = 0;
  for (const tx of txs) {
    if (tx.deleted !== 0) continue;
    const settled = tx.amountCents < 0 ? totalReimbursedCents(tx) : givenCents(txs, tx.id);
    if (settled <= 0) continue;
    const next = settledSplits(tx, settled, nameOf);
    if (JSON.stringify(next) === JSON.stringify(tx.splits ?? [])) continue;
    await writeTxTransform(repo, tx, { splits: next });
    touched++;
  }
  return touched;
}
