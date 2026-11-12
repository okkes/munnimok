// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { MunniDB } from '@/db/schema';
import { feedSpaceId } from '@/domain/feedIds';
import { CLIENT_PROTOCOL } from '@/lib/protocol';
import { HlcClock } from '@/sync/hlc';
import { CAMT_FIXTURE } from '@/test/camt-fixture';
import { USER_TEST_DB, renderAppAsUser } from '@/test/harness';

const FEED = feedSpaceId('NL69INGB0123456789');
/** `a-shared` sorts before `s-user`: the pass over every space meets the read-only one first */
const ROLES = { 'a-shared': 'reader', 's-user': 'owner', [FEED]: 'owner' } as const;
const SPACE = { currency: 'EUR', periodType: 'month' as const, periodDay: 1 };
const ACCOUNT = { source: 'manual' as const, currency: 'EUR', balanceCents: 0 };

const plainRepo = (db: MunniDB) => new Repo(new DexieBackend(db), new HlcClock('seed'), { trackOutbox: false });

/** a transfer's two legs nobody paired yet: checking → pot */
async function openPair(repo: Repo, spaceId: string, prefix: string) {
  const leg = { date: '2026-07-25', currency: 'EUR', needsReview: 0 as const };
  await repo.upsert('transaction', spaceId, `${prefix}-out`, { ...leg, accountId: `${prefix}-chk`, amountCents: -50_000, merchant: 'To the pot', linkedAccountId: `${prefix}-pot` });
  await repo.upsert('transaction', spaceId, `${prefix}-in`, { ...leg, accountId: `${prefix}-pot`, amountCents: 50_000, merchant: 'From checking' });
}

describe('after a statement import', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('the pairing pass leaves a space the person only reads alone and still pairs their own', async () => {
    const seed = new MunniDB(USER_TEST_DB);
    await seed.meta.put({ key: 'activeSpaceId', value: 's-user' });
    await seed.meta.put({ key: 'spaceRoles', value: ROLES });
    const seeded = plainRepo(seed);
    await seeded.upsert('space', 'a-shared', 'a-shared', { ...SPACE, name: 'Theirs', kind: 'shared' });
    await seeded.upsert('space', 's-user', 's-user', { ...SPACE, name: 'Personal', kind: 'personal' });
    for (const [spaceId, prefix] of [['a-shared', 'their'], ['s-user', 'mine']] as const) {
      await seeded.upsert('account', spaceId, `${prefix}-chk`, { ...ACCOUNT, name: 'Checking', type: 'checking' });
      await seeded.upsert('account', spaceId, `${prefix}-pot`, { ...ACCOUNT, name: 'Pot', type: 'savings' });
    }
    seed.close();

    renderAppAsUser('/accounts', {
      spaces: [{ id: 's-user', name: 'Personal' }],
      roles: ROLES,
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: {}, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }),
        'GET /me/spaces': () => Object.keys(ROLES),
        'GET /me/feeds': () => [],
        'POST /feeds': () => ({}),
      },
    });
    await screen.findByTestId('screen-accounts');
    // the legs land after the start's own pairing ran: only the import's pass can pair them
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const db = new MunniDB(USER_TEST_DB);
    await openPair(plainRepo(db), 'a-shared', 'their');
    await openPair(plainRepo(db), 's-user', 'mine');

    const input = screen.getByTestId('accounts-import-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File([CAMT_FIXTURE], 'statement.xml', { type: 'text/xml' })] });
    fireEvent.change(input);
    fireEvent.click(await screen.findByTestId('import-run'));
    await screen.findByTestId('import-result', {}, { timeout: 10_000 });

    await waitFor(async () => expect((await db.transactions.get('mine-in'))?.transferPeerId).toBe('mine-out'), { timeout: 8000 });
    expect((await db.transactions.get('mine-out'))?.transferPeerId).toBe('mine-in');
    expect((await db.transactions.get('their-out'))?.transferPeerId).toBeUndefined();
    expect((await db.outbox.toArray()).filter((op) => op.spaceId === 'a-shared')).toEqual([]);
    db.close();
  }, 30_000);
});
