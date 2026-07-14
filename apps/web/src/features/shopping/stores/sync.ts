import type { MunniDB } from '@/db/schema';
import type { Repo } from '@/db/repo';
import type { ReceiptItem } from '@/db/types';
import { bestMatch, mapAhItems, mapAhSummary } from '@/domain/storeReceipts';
import { ahFetchReceiptItems, ahFetchReceipts, ahRefresh } from './ah';
import type { ProxyCall, StoreTokens } from './ah';

/**
 * One store sync pass (receipts design S2 + v2 sharing): refresh-on-401
 * once, pull the receipt list, then ingest what's new into EVERY space
 * the connection is shared with (user ruling) — deterministic per-space
 * ids so devices converge, one items fetch per receipt however many
 * spaces receive it. Matching runs per space against that space's
 * transactions; only a rung-1 single attaches automatically.
 */

/** per-space receipt row id; the storeRef field carries the cross-space dedupe key */
export const storeReceiptId = (store: string, externalId: string, spaceId: string): string =>
  `rcpt:${store}:${externalId}@${spaceId}`;

export const storeRefOf = (store: string, externalId: string): string => `${store}:${externalId}`;

/** pre-sharing rows were `rcpt:{store}:{externalId}` — derive their ref */
const legacyRef = (id: string): string => {
  const base = id.startsWith('rcpt:') ? id.slice('rcpt:'.length) : id;
  const at = base.indexOf('@');
  return at === -1 ? base : base.slice(0, at);
};

export interface StoreSyncResult {
  status: 'ok' | 'expired' | 'error';
  added: number;
  /** upstream HTTP status when the read failed — the live-debug signal */
  httpStatus?: number;
}

/** one space's ingest pass: dedupe by storeRef, rung-1 auto-attach per space */
async function ingestSpace(
  db: MunniDB,
  repo: Repo,
  spaceId: string,
  receipts: readonly Parameters<typeof mapAhSummary>[0][],
  fetchItems: (externalId: string) => Promise<ReceiptItem[]>,
): Promise<number> {
  const [txs, existing] = await Promise.all([
    db.transactions.where('spaceId').equals(spaceId).filter((t) => t.deleted === 0).toArray(),
    db.receipts.filter((r) => r.spaceId === spaceId).toArray(),
  ]);
  const seen = new Set(existing.map((r) => r.storeRef ?? legacyRef(r.id)));
  const taken = new Set(existing.filter((r) => r.deleted === 0 && r.txId).map((r) => r.txId!));

  let added = 0;
  for (const row of receipts) {
    const summary = mapAhSummary(row);
    const ref = storeRefOf('ah', summary.storeId);
    if (seen.has(ref)) continue;
    const items = await fetchItems(summary.storeId);
    const txId = bestMatch(summary, txs, taken);
    if (txId) taken.add(txId);
    await repo.upsert('receipt', spaceId, storeReceiptId('ah', summary.storeId, spaceId), {
      txId: txId ?? undefined,
      source: 'ah',
      date: summary.date,
      totalCents: summary.totalCents,
      merchant: 'Albert Heijn',
      items: items.length > 0 ? items : undefined,
      storeRef: ref,
    });
    added += 1;
  }
  return added;
}

export async function syncAhReceipts(call: ProxyCall, db: MunniDB, repo: Repo, activeSpaceId: string): Promise<StoreSyncResult> {
  const connection = await db.storeConnections.get('ah');
  if (connection?.status !== 'ok') return { status: 'error', added: 0 };

  let tokens: StoreTokens = { access: connection.tokens.access, refresh: connection.tokens.refresh };
  let list = await ahFetchReceipts(call, tokens.access);
  if (list.status === 401) {
    const refreshed = await ahRefresh(call, tokens.refresh);
    if (!refreshed) {
      await db.storeConnections.put({ ...connection, status: 'expired' });
      for (const spaceId of connection.sharedSpaceIds ?? [activeSpaceId]) {
        await repo.upsert('storeMarker', spaceId, `store:${spaceId}:ah`, { store: 'ah', status: 'expired' });
      }
      return { status: 'expired', added: 0 };
    }
    tokens = refreshed;
    list = await ahFetchReceipts(call, tokens.access);
  }
  if (list.status !== 200) return { status: 'error', added: 0, httpStatus: list.status };

  // spaces the connection feeds — deleted spaces silently drop out; an
  // empty result (mid-bootstrap) falls back to the active space
  const localSpaceIds = new Set((await db.spaces.filter((s) => s.deleted === 0).toArray()).map((s) => s.id));
  const known = (connection.sharedSpaceIds ?? [activeSpaceId]).filter((id) => localSpaceIds.has(id));
  const targets = known.length > 0 ? known : [activeSpaceId];

  // one items fetch per receipt, however many spaces receive it
  const itemsCache = new Map<string, ReceiptItem[]>();
  const fetchItems = async (externalId: string): Promise<ReceiptItem[]> => {
    const cached = itemsCache.get(externalId);
    if (cached) return cached;
    const items = mapAhItems(await ahFetchReceiptItems(call, tokens.access, externalId));
    itemsCache.set(externalId, items);
    return items;
  };

  let added = 0;
  for (const spaceId of targets) {
    added += await ingestSpace(db, repo, spaceId, list.receipts, fetchItems);
  }

  await db.storeConnections.put({
    ...connection,
    tokens: { access: tokens.access, refresh: tokens.refresh },
    refreshedAt: new Date().toISOString(),
    status: 'ok',
    lastReceiptId: list.receipts[0]?.transactionId ?? connection.lastReceiptId,
  });
  return { status: 'ok', added };
}
