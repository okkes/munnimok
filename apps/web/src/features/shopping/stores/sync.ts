import type { MunniDB } from '@/db/schema';
import type { Repo } from '@/db/repo';
import { bestMatch, mapAhItems, mapAhSummary } from '@/domain/storeReceipts';
import { ahFetchReceiptItems, ahFetchReceipts, ahRefresh } from './ah';
import type { ProxyCall, StoreTokens } from './ah';

/**
 * One store sync pass (receipts design S2): refresh-on-401 once, pull
 * the receipt list, ingest what's new with deterministic ids (two
 * devices fetching the same receipt converge to one row), and attach
 * each to its transaction when the match is unambiguous.
 */

export const storeReceiptId = (store: string, storeReceiptId: string): string => `rcpt:${store}:${storeReceiptId}`;

export interface StoreSyncResult {
  status: 'ok' | 'expired' | 'error';
  added: number;
}

export async function syncAhReceipts(call: ProxyCall, db: MunniDB, repo: Repo, spaceId: string): Promise<StoreSyncResult> {
  const connection = await db.storeConnections.get('ah');
  if (!connection || connection.status !== 'ok') return { status: 'error', added: 0 };

  let tokens: StoreTokens = { access: connection.tokens.access, refresh: connection.tokens.refresh };
  let list = await ahFetchReceipts(call, tokens.access);
  if (list.status === 401) {
    const refreshed = await ahRefresh(call, tokens.refresh);
    if (!refreshed) {
      await db.storeConnections.put({ ...connection, status: 'expired' });
      await repo.upsert('storeMarker', spaceId, `store:${spaceId}:ah`, { store: 'ah', status: 'expired' });
      return { status: 'expired', added: 0 };
    }
    tokens = refreshed;
    list = await ahFetchReceipts(call, tokens.access);
  }
  if (list.status !== 200) return { status: 'error', added: 0 };

  const [txs, existing] = await Promise.all([
    db.transactions.where('spaceId').equals(spaceId).filter((t) => t.deleted === 0).toArray(),
    db.receipts.filter((r) => r.spaceId === spaceId).toArray(),
  ]);
  const known = new Set(existing.map((r) => r.id));
  const taken = new Set(existing.filter((r) => r.deleted === 0 && r.txId).map((r) => r.txId!));

  let added = 0;
  for (const row of list.receipts) {
    const summary = mapAhSummary(row);
    const id = storeReceiptId('ah', summary.storeId);
    if (known.has(id)) continue;
    const items = mapAhItems(await ahFetchReceiptItems(call, tokens.access, summary.storeId));
    const txId = bestMatch(summary, txs, taken);
    if (txId) taken.add(txId);
    await repo.upsert('receipt', spaceId, id, {
      txId: txId ?? undefined,
      source: 'ah',
      date: summary.date,
      totalCents: summary.totalCents,
      merchant: 'Albert Heijn',
      items: items.length > 0 ? items : undefined,
    });
    added += 1;
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
