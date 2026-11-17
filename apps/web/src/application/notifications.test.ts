// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import {
  appendNotification,
  clearInboxUpTo,
  clearScopeUpTo,
  clearScopesNow,
  GENERAL_SCOPE,
  notificationTitle,
  readClearedBy,
  readInbox,
  readInboxClearedAt,
  stampNotifSeen,
  unreadNotifCount,
} from './notifications';

describe('notification inbox (arc 6)', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });
  const fresh = () => {
    const store = new DexieBackend(new MunniDB(`munni_ni_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    return store;
  };

  it('appends newest-first; a dedupe key makes an event once-only', async () => {
    const store = fresh();
    await appendNotification(store, 'whatsnew', { version: '2.27.0' }, 'v2.27.0');
    await appendNotification(store, 'recurringDue', { name: 'Rent', date: '1 Aug' }, 'rec_1');
    await appendNotification(store, 'whatsnew', { version: '2.27.0' }, 'v2.27.0');

    const list = await readInbox(store);
    expect(list).toHaveLength(2);
    expect(list[0].kind).toBe('recurringDue');
    expect(list[1].payload?.version).toBe('2.27.0');
  });

  it('caps the list at 50 — the oldest fall off', async () => {
    const store = fresh();
    for (let i = 0; i < 55; i++) await appendNotification(store, 'digest', { n: String(i) });
    const list = await readInbox(store);
    expect(list).toHaveLength(50);
    expect(list[0].payload?.n).toBe('54');
  });

  it('unread counts the rows of the parts asked for that came after the part was last looked at', async () => {
    const store = fresh();
    await appendNotification(store, 'whatsnew', { version: '5.23.0' });
    await appendNotification(store, 'digest', { n: '3', spaceId: 's1' });
    await appendNotification(store, 'planOverspent', { names: 'Rent', spaceId: 's2' });
    expect(await unreadNotifCount(store, [GENERAL_SCOPE, 's1'])).toBe(2);

    // #614: looking at the bell in one space does not read another space's rows
    await stampNotifSeen(store, [GENERAL_SCOPE, 's1']);
    expect(await unreadNotifCount(store, [GENERAL_SCOPE, 's1'])).toBe(0);
    expect(await unreadNotifCount(store, [GENERAL_SCOPE, 's2'])).toBe(1);

    await new Promise((r) => setTimeout(r, 5));
    await appendNotification(store, 'debtRate', { name: 'Car loan', spaceId: 's1' });
    expect(await unreadNotifCount(store, [GENERAL_SCOPE, 's1'])).toBe(1);
  });

  it('a part not looked at since the list was split keeps the one moment of before', async () => {
    const store = fresh();
    await appendNotification(store, 'digest', { n: '3', spaceId: 's1' });
    await new Promise((r) => setTimeout(r, 5));
    await store.metaPut('notifSeenAt', new Date().toISOString());
    expect(await unreadNotifCount(store, [GENERAL_SCOPE, 's1'])).toBe(0);
  });

  it('#614: the person’s own Clear takes the parts the bell showed and leaves another space’s rows', async () => {
    const store = fresh();
    await appendNotification(store, 'whatsnew', { version: '5.23.0' }, 'v5.23.0');
    await appendNotification(store, 'digest', { n: '3', spaceId: 's1' });
    await appendNotification(store, 'planOverspent', { names: 'Rent', spaceId: 's2' });

    const gone = await clearScopesNow(store, [GENERAL_SCOPE, 's1']);
    expect(gone.map((e) => e.kind).sort()).toEqual(['digest', 'whatsnew']);
    expect((await readInbox(store)).map((e) => e.kind)).toEqual(['planOverspent']);
    // the whole-list moment of #580 is another thing and stays where it was
    expect(await readInboxClearedAt(store)).toBeUndefined();
    expect(Object.keys(await readClearedBy(store)).sort()).toEqual(['general', 's1']);

    // a once-only event that was cleared does not come back
    await appendNotification(store, 'whatsnew', { version: '5.23.0' }, 'v5.23.0');
    expect((await readInbox(store)).map((e) => e.kind)).toEqual(['planOverspent']);
  });

  it('#614: a part cleared on another device drops that part’s older rows, once', async () => {
    const store = fresh();
    await appendNotification(store, 'digest', { n: '3', spaceId: 's1' });
    await appendNotification(store, 'digest', { n: '2', spaceId: 's2' });
    await new Promise((r) => setTimeout(r, 5));
    const moment = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await appendNotification(store, 'debtRate', { name: 'Car loan', spaceId: 's1' });

    expect((await clearScopeUpTo(store, 's1', moment))?.map((e) => e.kind)).toEqual(['digest']);
    expect((await readInbox(store)).map((e) => `${e.kind}:${e.payload?.spaceId}`)).toEqual(['debtRate:s1', 'digest:s2']);
    expect(await clearScopeUpTo(store, 's1', moment)).toBeNull();
    expect(await clearScopeUpTo(store, 's1', '2020-01-01T00:00:00.000Z')).toBeNull();
  });

  it('#580: a clear drops what came before its moment, keeps what came after, and never moves back', async () => {
    const store = fresh();
    await appendNotification(store, 'debtRate', { name: 'Car loan' });
    await new Promise((r) => setTimeout(r, 5));
    const moment = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await appendNotification(store, 'digest', { n: '2' });

    expect(await clearInboxUpTo(store, moment)).toBe(true);
    expect((await readInbox(store)).map((e) => e.kind)).toEqual(['digest']);
    expect(await readInboxClearedAt(store)).toBe(moment);
    expect(await clearInboxUpTo(store, '2020-01-01T00:00:00.000Z')).toBe(false);
    expect(await readInbox(store)).toHaveLength(1);
  });

  it('#580: a cleared once-only notice never comes back — a new one still arrives', async () => {
    const store = fresh();
    await appendNotification(store, 'whatsnew', { version: '5.20.0' }, 'v5.20.0');
    await clearInboxUpTo(store, new Date(Date.now() + 1000).toISOString());
    // the bell asks again on the next open while the release is unseen
    await appendNotification(store, 'whatsnew', { version: '5.20.0' }, 'v5.20.0');
    expect(await readInbox(store)).toHaveLength(0);
    await appendNotification(store, 'whatsnew', { version: '5.21.0' }, 'v5.21.0');
    expect((await readInbox(store)).map((e) => e.payload?.version)).toEqual(['5.21.0']);
  });

  it('#580: a clear and a notification recorded at the same moment do not undo each other', async () => {
    const seeded = async () => {
      const store = fresh();
      await store.metaPut('notifInbox', [
        { id: 'old', kind: 'planOverspent', ts: '2026-01-01T08:00:00.000Z', payload: { names: 'Groceries', dedupe: 'plan_old' } },
      ]);
      return store;
    };
    const clearedElsewhere = '2026-01-02T08:00:00.000Z';

    // the app opens: the clear made on another device lands while a reminder is being recorded
    const first = await seeded();
    await Promise.all([
      clearInboxUpTo(first, clearedElsewhere),
      appendNotification(first, 'recurringDue', { name: 'Rent', date: '12 Nov' }, 'rec_rent'),
    ]);
    expect((await readInbox(first)).map((e) => e.kind)).toEqual(['recurringDue']);

    const second = await seeded();
    await Promise.all([
      appendNotification(second, 'recurringDue', { name: 'Rent', date: '12 Nov' }, 'rec_rent'),
      clearInboxUpTo(second, clearedElsewhere),
    ]);
    expect((await readInbox(second)).map((e) => e.kind)).toEqual(['recurringDue']);
  });

  it('#551: a notification about a space is titled with its name — munni without one', async () => {
    const store = fresh();
    const repo = new Repo(store, new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('space', 's1', 's1', { name: 'Household', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    expect(await notificationTitle(store, 's1')).toBe('Household');
    expect(await notificationTitle(store, 'gone')).toBe('munni');
    expect(await notificationTitle(store, undefined)).toBe('munni');
  });
});
