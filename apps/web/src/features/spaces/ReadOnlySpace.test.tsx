// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { MunniDB } from '@/db/schema';
import { HlcClock } from '@/sync/hlc';
import { USER_TEST_DB, renderAppAsUser } from '@/test/harness';

/**
 * #505 (user): a member who may only read a space sees it whole and changes
 * nothing — no confirm on the review, no new event, no setting — and what
 * such a device had already changed there is undone with one notice.
 */
const SPACE = 's-shared';

const spaceAs = (role: 'reader' | 'owner') => [{ id: SPACE, name: 'Eukesh', kind: 'shared' as const, role }];

/** the device as it stands before the app opens: the space, its rows, the role the server last named */
async function seed(role: 'reader' | 'owner', rows?: (repo: Repo) => Promise<void>) {
  const db = new MunniDB(USER_TEST_DB);
  await db.meta.put({ key: 'activeSpaceId', value: SPACE });
  await db.meta.put({ key: 'spaceRoles', value: { [SPACE]: role } });
  const repo = new Repo(new DexieBackend(db), new HlcClock('seed505'), { trackOutbox: false });
  await repo.upsert('space', SPACE, SPACE, { name: 'Eukesh', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
  await rows?.(repo);
  db.close();
}

async function stored<T>(read: (db: MunniDB) => Promise<T>): Promise<T> {
  const db = new MunniDB(USER_TEST_DB);
  try {
    return await read(db);
  } finally {
    db.close();
  }
}

describe('a space this member only reads (#505)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('the review shows the card but never confirms it — the button, the rows and Enter alike', async () => {
    await seed('reader', async (repo) => {
      await repo.upsert('account', SPACE, 'acc-joint', { name: 'Joint', balanceCents: 0, currency: 'EUR' });
      await repo.upsert('transaction', SPACE, 'tx-bakery', {
        accountId: 'acc-joint',
        date: '2026-11-01',
        amountCents: -1250,
        currency: 'EUR',
        merchant: 'Bakery',
        needsReview: 1,
      });
    });
    renderAppAsUser('/review', { spaces: spaceAs('reader') });

    await waitFor(() => expect(screen.getByTestId('review-card').textContent).toContain('Bakery'), { timeout: 8000 });
    expect(screen.getByTestId('review-readonly-note').textContent).toContain('read-only');
    expect((screen.getByTestId('review-confirm-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('review-cats').hasAttribute('inert')).toBe(true);

    fireEvent.keyDown(window, { key: 'Enter' });
    expect(await stored((db) => db.outbox.count())).toBe(0);
    expect(await stored((db) => db.txMeta.where('spaceId').equals(SPACE).count())).toBe(0);
  }, 20_000);

  it('the events list offers no new event and says why; the owner gets the door', async () => {
    await seed('reader');
    const first = renderAppAsUser('/events', { spaces: spaceAs('reader') });
    await screen.findByTestId('events-readonly-note', {}, { timeout: 8000 });
    expect(screen.queryByTestId('events-add')).toBeNull();
    first.unmount();

    indexedDB.deleteDatabase(USER_TEST_DB);
    await seed('owner');
    renderAppAsUser('/events', { spaces: spaceAs('owner') });
    await screen.findByTestId('events-add', {}, { timeout: 8000 });
    expect(screen.queryByTestId('events-readonly-note')).toBeNull();
  }, 20_000);

  it('the space’s own settings stay as they are — the name field is locked and the note says why', async () => {
    await seed('reader');
    renderAppAsUser(`/spaces/${SPACE}`, { spaces: spaceAs('reader') });

    await screen.findByTestId('space-reader-note', {}, { timeout: 8000 });
    expect((screen.getByTestId('space-edit-name') as HTMLInputElement).disabled).toBe(true);
  }, 20_000);

  it('a change this device made there before the fix is undone, and the notice says so once', async () => {
    await seed('reader', async (repo) => {
      // the reader's own event: written locally, its push refused and parked (#306)
      const parked = new Repo(repo.store, new HlcClock('reader-device'), { trackOutbox: true });
      await parked.upsert('event', SPACE, 'ev-mine', { name: 'Weekend away' });
      const ops = await repo.store.outboxAll();
      await repo.store.metaPut(`parkedOps_${SPACE}`, ops);
      await repo.store.outboxDelete(ops.map((op) => op.opId));
    });
    renderAppAsUser('/events', { spaces: spaceAs('reader') });

    const notice = await screen.findByTestId(`unsaved-undone-${SPACE}`, {}, { timeout: 10_000 });
    expect(notice.textContent).toContain('Eukesh');
    await waitFor(async () => expect(await stored((db) => db.events.get('ev-mine'))).toBeUndefined(), { timeout: 8000 });
    expect(await stored((db) => db.meta.get(`parkedOps_${SPACE}`))).toBeUndefined();

    fireEvent.click(screen.getByTestId('unsaved-undone-ok'));
    await waitFor(() => expect(screen.queryByTestId('unsaved-undone-sheet')).toBeNull());
    expect(await stored((db) => db.meta.get('unsavedUndone'))).toBeUndefined();
  }, 25_000);
});
