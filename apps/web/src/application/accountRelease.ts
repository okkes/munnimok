import { writeTxTransform } from '@/db/joined';
import type { TxTransformFields } from '@/db/joined';
import { mirrorTxId, partMirrorSourceId } from '@/domain/feedIds';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { TransactionRow, TxMetaRow, TxSplit } from '@/db/types';

// #544: a leaving account (detached, deleted, retired default #546) takes every counterparty reference in the space:
// a row keeps its category, loses the link and returns to review; legs munni generated ON a leaving manual account
// retire via the write choke, a leg generated elsewhere becomes an ordinary row (that money moved)

interface StoredRow {
  raw: TransactionRow;
  meta?: TxMetaRow;
  spaceId: string;
}

const linkedOf = (row: StoredRow): string | undefined => (row.meta ? row.meta.linkedAccountId : row.raw.linkedAccountId);
const splitsOf = (row: StoredRow): TxSplit[] | undefined => (row.meta ? row.meta.splits : row.raw.splits);

function withoutLink(part: TxSplit): TxSplit {
  const { linkedAccountId: _linked, transferPeerId: _peer, txType: _type, ...rest } = part;
  return rest;
}

async function storedRows(store: StorageBackend, spaceId: string): Promise<StoredRow[]> {
  const rows: StoredRow[] = (await store.bySpace('transaction', spaceId))
    .filter((raw) => raw.deleted === 0)
    .map((raw) => ({ raw, spaceId }));
  for (const meta of await store.bySpace('txMeta', spaceId)) {
    if (meta.deleted !== 0) continue;
    const raw = await store.get('transaction', meta.txId);
    if (raw?.deleted === 0) rows.push({ raw, meta, spaceId });
  }
  return rows;
}

/** a deleted account's legs outlive the link: the write choke only retires legs on a live account */
async function dropLeftoverLeg(store: StorageBackend, repo: Repo, mintId: string, accountId: string): Promise<void> {
  const leg = await store.get('transaction', mintId);
  if (leg?.deleted === 0 && leg.accountId === accountId) await repo.remove('transaction', leg.spaceId, leg.id);
}

/** one row lets go of the account (row level and part level); false = it never named it */
async function releaseRow(store: StorageBackend, repo: Repo, row: StoredRow, accountId: string): Promise<boolean> {
  if (row.raw.accountId === accountId) return false;
  const splits = splitsOf(row) ?? [];
  const rowHit = linkedOf(row) === accountId;
  const hitParts = splits.filter((part) => part.linkedAccountId === accountId);
  if (!rowHit && hitParts.length === 0) return false;
  const fields: TxTransformFields = { needsReview: 1 };
  if (rowHit) Object.assign(fields, { linkedAccountId: null, transferPeerId: null });
  if (hitParts.length > 0) fields.splits = splits.map((part) => (part.linkedAccountId === accountId ? withoutLink(part) : part));
  await writeTxTransform(
    repo,
    {
      id: row.raw.id,
      spaceId: row.spaceId,
      feedSpaceId: row.meta ? row.raw.spaceId : undefined,
      needsReview: row.meta ? row.meta.needsReview : row.raw.needsReview,
    },
    fields,
  );
  if (rowHit) await dropLeftoverLeg(store, repo, mirrorTxId(row.raw.id), accountId);
  for (const part of hitParts) {
    if (part.id) await dropLeftoverLeg(store, repo, mirrorTxId(partMirrorSourceId(row.raw.id, part.id)), accountId);
  }
  return true;
}

// the leaving account's own rows forget the space's links too, written past the choke on purpose: legs those links
// generated stay where the money went, and a re-attach must not bring back half a pair
async function forgetOwnLinks(repo: Repo, row: StoredRow): Promise<boolean> {
  const splits = splitsOf(row) ?? [];
  const partLinked = splits.some((part) => !!part.linkedAccountId || !!part.transferPeerId);
  if (!row.meta || (!row.meta.linkedAccountId && !row.meta.transferPeerId && !partLinked)) return false;
  await repo.upsert('txMeta', row.spaceId, row.meta.id, {
    linkedAccountId: null as never,
    transferPeerId: null as never,
    ...(partLinked ? { splits: splits.map(withoutLink) } : {}),
  });
  return true;
}

async function releaseRecurrings(store: StorageBackend, repo: Repo, spaceId: string, accountIds: ReadonlySet<string>): Promise<void> {
  for (const rec of await store.bySpace('recurring', spaceId)) {
    if (rec.deleted === 0 && rec.linkedAccountId && accountIds.has(rec.linkedAccountId)) {
      await repo.upsert('recurring', spaceId, rec.id, { linkedAccountId: null as never });
    }
  }
}

/** run BEFORE a manual account's tombstone, so its generated legs retire with the links while it is still live */
export async function releaseAccountReferences(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  accountId: string,
): Promise<number> {
  let released = 0;
  for (const row of await storedRows(store, spaceId)) {
    if (row.raw.accountId === accountId) {
      await forgetOwnLinks(repo, row);
      continue;
    }
    if (await releaseRow(store, repo, row, accountId)) released++;
  }
  await releaseRecurrings(store, repo, spaceId, new Set([accountId]));
  return released;
}

// accounts positively lost: row deleted, or the space's attachment deleted with none live; an account this device
// does not know is left alone, its attachment may not have arrived
async function lostAccountIds(store: StorageBackend, spaceId: string, named: ReadonlySet<string>): Promise<Set<string>> {
  const links = await store.bySpace('accountLink', spaceId);
  const lost = new Set<string>();
  for (const accountId of named) {
    const account = await store.get('account', accountId);
    const live = links.some((l) => l.deleted === 0 && l.accountId === accountId);
    const detached = links.some((l) => l.deleted !== 0 && l.accountId === accountId);
    const deleted = account !== undefined && account.deleted !== 0;
    if (deleted || (detached && !live && account?.spaceId !== spaceId)) lost.add(accountId);
  }
  return lost;
}

function namedAccounts(rows: readonly StoredRow[]): Set<string> {
  const named = new Set<string>();
  for (const row of rows) {
    const linked = linkedOf(row);
    if (linked) named.add(linked);
    for (const part of splitsOf(row) ?? []) if (part.linkedAccountId) named.add(part.linkedAccountId);
  }
  return named;
}

/** #544: references to accounts that left before releases existed, or arriving from an older device, let go every boot */
export async function repairDanglingCounterparties(store: StorageBackend, repo: Repo): Promise<number> {
  const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0 && !!s.kind);
  let released = 0;
  for (const space of spaces) {
    const rows = await storedRows(store, space.id);
    const recurringNamed = (await store.bySpace('recurring', space.id))
      .filter((r) => r.deleted === 0 && !!r.linkedAccountId)
      .map((r) => r.linkedAccountId!);
    const lost = await lostAccountIds(store, space.id, new Set([...namedAccounts(rows), ...recurringNamed]));
    if (lost.size === 0) continue;
    for (const row of rows) released += await releaseLostAccounts(store, repo, row, lost);
    await releaseRecurrings(store, repo, space.id, lost);
  }
  return released;
}

async function releaseLostAccounts(store: StorageBackend, repo: Repo, row: StoredRow, lost: ReadonlySet<string>): Promise<number> {
  if (lost.has(row.raw.accountId)) {
    await forgetOwnLinks(repo, row);
    return 0;
  }
  const hits = new Set([linkedOf(row), ...(splitsOf(row) ?? []).map((p) => p.linkedAccountId)].filter((id): id is string => !!id && lost.has(id)));
  let released = 0;
  for (const accountId of hits) {
    // a row whose part and whole named two lost accounts lets go of each, reading itself fresh
    const fresh = hits.size > 1 ? await refreshed(store, row) : row;
    if (fresh && (await releaseRow(store, repo, fresh, accountId))) released++;
  }
  return released;
}

async function refreshed(store: StorageBackend, row: StoredRow): Promise<StoredRow | null> {
  const raw = await store.get('transaction', row.raw.id);
  if (raw?.deleted !== 0) return null;
  if (!row.meta) return { raw, spaceId: row.spaceId };
  const meta = await store.get('txMeta', row.meta.id);
  return meta?.deleted === 0 ? { raw, meta, spaceId: row.spaceId } : null;
}
