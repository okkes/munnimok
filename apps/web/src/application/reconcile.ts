import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { ReceiptLinkRow, TransactionRow, TxMetaRow } from '@/db/types';
import { txMetaId } from '@/domain/feedIds';
import { reconcilePlan } from '@/domain/reconcile';
import type { ReconcileMatch, ReconcilePlan } from '@/domain/reconcile';
import { logActivity } from './activity';
import { isLinkedTo, linkedTxIds } from './receiptLinks';

// the connection is the truth: matched imports hand their edits to the truth row (unless opted out),
// then every judged import inside the coverage is deleted; pre-coverage history survives

export async function buildReconcilePlan(
  store: StorageBackend,
  accountId: string,
): Promise<ReconcilePlan | null> {
  const rows = (await store.allRows('transaction')).filter((t) => t.deleted === 0 && t.accountId === accountId);
  if (rows.length === 0) return null;
  return reconcilePlan(rows);
}

/** spans both accounts of the pair; the classifier splits the union by row provenance */
export async function buildMergePlan(
  store: StorageBackend,
  importedAccountId: string,
  bankAccountId: string,
): Promise<ReconcilePlan | null> {
  const rows = (await store.allRows('transaction')).filter(
    (t) => t.deleted === 0 && (t.accountId === importedAccountId || t.accountId === bankAccountId),
  );
  if (rows.length === 0) return null;
  return reconcilePlan(rows);
}

const OPINION_FIELDS = [
  'catId',
  'needsReview',
  'notes',
  'titleOverride',
  'cats',
  'splits',
  'reimbursements',
  'linkedAccountId',
  'recurringId',
  'eventId',
] as const;

const pickOpinions = (source: Partial<TxMetaRow> & Partial<TransactionRow>) => {
  const out: Record<string, unknown> = {};
  for (const field of OPINION_FIELDS) {
    const value = (source as Record<string, unknown>)[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
};

async function migrateMatch(store: StorageBackend, repo: Repo, match: ReconcileMatch, spaceIds: string[]): Promise<void> {
  const direct = pickOpinions(match.imported);
  if (Object.keys(direct).length > 0) {
    await repo.upsert('transaction', match.linked.spaceId, match.linked.id, direct);
  }
  for (const spaceId of spaceIds) {
    const metas = (await store.bySpace('txMeta', spaceId)).filter((m) => m.deleted === 0 && m.txId === match.imported.id);
    for (const meta of metas) {
      await repo.upsert('txMeta', spaceId, txMetaId(spaceId, match.linked.id), {
        txId: match.linked.id,
        ...pickOpinions(meta),
      });
    }
    // the import's review verdict travels: an import never reviewed (no overlay, an explicit 1, or one silent about review)
    // must not come out reviewed because the bank row wore a prediction overlay claiming 0; the category may stay (#311)
    const importedUnreviewed = !metas.some((m) => m.needsReview === 0);
    if (importedUnreviewed) {
      const linkedMeta = await store.get('txMeta', txMetaId(spaceId, match.linked.id));
      if (linkedMeta?.deleted === 0 && linkedMeta?.needsReview === 0) {
        await repo.upsert('txMeta', spaceId, txMetaId(spaceId, match.linked.id), { txId: match.linked.id, needsReview: 1 });
      }
    }
    for (const link of (await store.bySpace('receiptLink', spaceId)).filter((l) => l.deleted === 0 && isLinkedTo(l, match.imported.id))) {
      await repo.upsert('receiptLink', spaceId, link.id, repointedLink(link, match.imported.id, match.linked.id));
    }
  }
}

function repointedLink(link: ReceiptLinkRow, from: string, to: string): Pick<ReceiptLinkRow, 'txId' | 'alsoTxIds'> {
  const [txId, ...alsoTxIds] = [...new Set(linkedTxIds(link).map((id) => (id === from ? to : id)))];
  return { txId, alsoTxIds: alsoTxIds.length > 0 ? alsoTxIds : (null as never) };
}

type ReimbLink = { txId: string; amountCents: number };

function rewriteLinks(
  links: ReimbLink[] | undefined,
  replacements: ReadonlyMap<string, string | null>,
): ReimbLink[] | undefined {
  if (!links?.some((l) => replacements.has(l.txId))) return undefined;
  const next: ReimbLink[] = [];
  for (const link of links) {
    if (!replacements.has(link.txId)) {
      next.push(link);
      continue;
    }
    const target = replacements.get(link.txId);
    if (target) next.push({ ...link, txId: target });
  }
  return next;
}

async function repointIn(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  entity: 'txMeta' | 'transaction',
  replacements: ReadonlyMap<string, string | null>,
): Promise<void> {
  for (const row of await store.bySpace(entity, spaceId)) {
    if (row.deleted !== 0) continue;
    const next = rewriteLinks(row.reimbursements, replacements);
    if (next) await repo.upsert(entity, spaceId, row.id, { reimbursements: next });
  }
}

async function repointReimbursements(
  store: StorageBackend,
  repo: Repo,
  spaceIds: string[],
  replacements: ReadonlyMap<string, string | null>,
): Promise<void> {
  for (const spaceId of spaceIds) {
    await repointIn(store, repo, spaceId, 'txMeta', replacements);
    await repointIn(store, repo, spaceId, 'transaction', replacements);
  }
}

export interface ReconcileResult {
  migrated: number;
  removed: number;
}

/** the live spaces whose rows this identity may move — one it only reads keeps its own, for its writers to settle */
const writableSpaceIds = async (store: StorageBackend, repo: Repo): Promise<string[]> =>
  (await store.allRows('space')).filter((s) => s.deleted === 0 && repo.canWrite(s.id)).map((s) => s.id);

export async function applyReconcile(
  store: StorageBackend,
  repo: Repo,
  activeSpaceId: string,
  plan: ReconcilePlan,
  ignoredImportedIds: ReadonlySet<string>,
  onProgress?: (done: number, total: number) => void,
): Promise<ReconcileResult> {
  const spaceIds = await writableSpaceIds(store, repo);
  const toDelete = [...plan.matches.map((m) => m.imported), ...plan.mismatched];
  const total = plan.matches.length + 1 + toDelete.length;
  let done = 0;
  const step = () => onProgress?.(++done, total);

  const replacements = new Map<string, string | null>();
  let migrated = 0;
  for (const match of plan.matches) {
    if (!ignoredImportedIds.has(match.imported.id)) {
      await migrateMatch(store, repo, match, spaceIds);
      migrated++;
    }
    replacements.set(match.imported.id, match.linked.id);
    step();
  }
  for (const row of plan.mismatched) replacements.set(row.id, null);
  await repointReimbursements(store, repo, spaceIds, replacements);
  step();

  // ignoring a match only skips the edit migration; the duplicate still falls
  for (const row of toDelete) {
    await repo.remove('transaction', row.spaceId, row.id);
    step();
  }

  void logActivity(store, repo, activeSpaceId, 'reconcile', `${migrated}/${toDelete.length}`);
  return { migrated, removed: toDelete.length };
}

export interface MergeResult extends ReconcileResult {
  moved: number;
}

/** explicit MERGE of a statement-imported account into its bank twin (#311): surviving pre-coverage history MOVES,
 *  space links repoint, the imported account retires */
export async function applyMerge(
  store: StorageBackend,
  repo: Repo,
  activeSpaceId: string,
  pair: { importedAccountId: string; bankAccountId: string },
  plan: ReconcilePlan,
  ignoredImportedIds: ReadonlySet<string>,
  onProgress?: (done: number, total: number) => void,
): Promise<MergeResult> {
  const result = await applyReconcile(store, repo, activeSpaceId, plan, ignoredImportedIds, onProgress);
  let moved = 0;
  for (const row of plan.kept) {
    await repo.upsert('transaction', row.spaceId, row.id, { accountId: pair.bankAccountId });
    moved++;
  }
  // links share their id across the pair; only the accountId fact changes hands
  for (const spaceId of await writableSpaceIds(store, repo)) {
    const links = (await store.bySpace('accountLink', spaceId)).filter(
      (l) => l.deleted === 0 && l.accountId === pair.importedAccountId,
    );
    for (const link of links) {
      await repo.upsert('accountLink', spaceId, link.id, { accountId: pair.bankAccountId });
    }
  }
  const imported = await store.get('account', pair.importedAccountId);
  if (imported?.deleted === 0) await repo.remove('account', imported.spaceId, imported.id);
  return { ...result, moved };
}
