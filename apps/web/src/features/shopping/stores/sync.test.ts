// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { storeReceiptId, syncAhReceipts } from './sync';
import type { ProxyCall } from './ah';

const SPACE = 's1';
let counter = 0;
let db: MunniDB;
let repo: Repo;

/** scripts the AH endpoints (GraphQL primary); a token refresh can be demanded */
function fakeAh({ expireFirst = false, refreshWorks = true, graphqlDown = false } = {}) {
  let refreshed = false;
  const calls: string[] = [];
  const call: ProxyCall = async (_store, path, init) => {
    calls.push(path);
    if (path === '/mobile-auth/v1/auth/token/refresh') {
      refreshed = true;
      return refreshWorks
        ? { status: 200, json: { access_token: 'fresh-access', refresh_token: 'fresh-refresh' } }
        : { status: 400, json: null };
    }
    if (path === '/graphql') {
      if (graphqlDown) return { status: 404, json: null };
      if (expireFirst && !refreshed) return { status: 401, json: null };
      expect(init?.authorization).toBe(`Bearer ${expireFirst ? 'fresh-access' : 'old-access'}`);
      const body = init?.body as { query: string; variables: Record<string, unknown> };
      if (body.query.includes('posReceiptsPage')) {
        return {
          status: 200,
          json: {
            data: {
              posReceiptsPage: {
                posReceipts: [
                  { id: 't-100', dateTime: '2026-07-05T17:31:00Z', totalAmount: { amount: 23.5 } },
                  { id: 't-200', dateTime: '2026-07-03T09:00:00Z', totalAmount: { amount: 9.99 } },
                ],
              },
            },
          },
        };
      }
      return { status: 200, json: { data: { posReceiptDetails: { products: [{ name: 'MELK', amount: { amount: 2.58 } }] } } } };
    }
    if (path === '/mobile-services/v2/receipts') {
      // legacy REST — only reachable when GraphQL is down
      expect(graphqlDown).toBe(true);
      return {
        status: 200,
        json: [{ transactionId: 't-100', transactionMoment: '2026-07-05T17:31:00Z', total: { amount: { amount: 23.5 } } }],
      };
    }
    if (path.startsWith('/mobile-services/v2/receipts/')) {
      return { status: 200, json: { receiptUiItems: [{ type: 'product', description: 'MELK', amount: '2,58' }] } };
    }
    throw new Error(`unexpected path ${path}`);
  };
  return { call, calls };
}

beforeEach(async () => {
  db = new MunniDB(`store_sync_test_${++counter}`);
  repo = new Repo(db, new HlcClock('dev'), { trackOutbox: false });
  await db.storeConnections.put({
    store: 'ah',
    tokens: { access: 'old-access', refresh: 'old-refresh' },
    refreshedAt: '2026-07-01T00:00:00Z',
    status: 'ok',
  });
});

describe('syncAhReceipts', () => {
  it('ingests new receipts with deterministic ids and matches the clear one', async () => {
    await repo.upsert('transaction', SPACE, 'tx-ah', {
      accountId: 'a1',
      date: '2026-07-05',
      amountCents: -2350,
      currency: 'EUR',
      merchant: 'Albert Heijn',
      txType: 'expense',
      needsReview: 0,
    });

    const { call } = fakeAh();
    const result = await syncAhReceipts(call, db, repo, SPACE);
    expect(result).toEqual({ status: 'ok', added: 2 });

    const matched = await db.receipts.get(storeReceiptId('ah', 't-100'));
    expect(matched?.txId).toBe('tx-ah');
    expect(matched?.items).toEqual([{ name: 'MELK', qty: undefined, totalCents: 258 }]);
    // no €9.99 transaction exists → stays unmatched for the manual pick
    const unmatched = await db.receipts.get(storeReceiptId('ah', 't-200'));
    expect(unmatched?.txId).toBeUndefined();

    // second pass: nothing new, nothing duplicated
    const again = await syncAhReceipts(call, db, repo, SPACE);
    expect(again).toEqual({ status: 'ok', added: 0 });
  });

  it('refreshes an expired token once and stores the fresh pair', async () => {
    const { call } = fakeAh({ expireFirst: true });
    const result = await syncAhReceipts(call, db, repo, SPACE);
    expect(result.status).toBe('ok');
    const connection = await db.storeConnections.get('ah');
    expect(connection?.tokens.access).toBe('fresh-access');
    expect(connection?.status).toBe('ok');
  });

  it('falls back to the legacy REST receipts when GraphQL is gone', async () => {
    const { call, calls } = fakeAh({ graphqlDown: true });
    const result = await syncAhReceipts(call, db, repo, SPACE);
    expect(result.status).toBe('ok');
    expect(result.added).toBe(1);
    expect(calls).toContain('/graphql');
    expect(calls).toContain('/mobile-services/v2/receipts');
  });

  it('a dead refresh token expires the connection and flags the synced marker', async () => {
    const { call } = fakeAh({ expireFirst: true, refreshWorks: false });
    const result = await syncAhReceipts(call, db, repo, SPACE);
    expect(result.status).toBe('expired');
    expect((await db.storeConnections.get('ah'))?.status).toBe('expired');
    expect((await db.storeMarkers.get(`store:${SPACE}:ah`))?.status).toBe('expired');
  });
});
