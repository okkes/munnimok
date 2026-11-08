import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { SPACE_ROLES_KEY, SpaceAccess, noteUnsavedUndone, readUnsavedUndone } from './spaceAccess';

let dbCounter = 0;

describe('SpaceAccess (#505)', () => {
  let db: MunniDB;
  let store: DexieBackend;
  beforeEach(() => {
    db = new MunniDB(`space_access_${++dbCounter}`);
    store = new DexieBackend(db);
  });
  afterEach(async () => {
    await db.delete();
  });

  it('knows each space’s role from the round’s heads and keeps it on the device', async () => {
    const access = new SpaceAccess(store);
    await access.record([
      { spaceId: 'mine', role: 'owner' },
      { spaceId: 'theirs', role: 'reader' },
      { spaceId: 'feed', role: 'reader' },
    ]);

    expect(access.isReadOnly('theirs')).toBe(true);
    expect(access.isReadOnly('mine')).toBe(false);
    // a later boot knows it before any round — offline too
    const reborn = new SpaceAccess(store);
    await reborn.hydrate();
    expect(reborn.roleOf('theirs')).toBe('reader');
  });

  it('a space the server never named is writable', () => {
    expect(new SpaceAccess(store).isReadOnly('fresh')).toBe(false);
    expect(new SpaceAccess(null).isReadOnly('anything')).toBe(false);
  });

  it('the heads replace the whole picture — a space they no longer name is forgotten', async () => {
    const access = new SpaceAccess(store);
    await access.record([{ spaceId: 'a', role: 'reader' }]);
    await access.record([{ spaceId: 'b', role: 'contributor' }]);

    expect(access.roleOf('a')).toBeUndefined();
    expect((await db.meta.get(SPACE_ROLES_KEY))?.value).toEqual({ b: 'contributor' });
  });

  it('heads that name no role (a server before #505) change nothing', async () => {
    const access = new SpaceAccess(store);
    await access.record([{ spaceId: 'a', role: 'reader' }]);
    await access.record([{ spaceId: 'a' }, { spaceId: 'b', role: 'admin' }]);
    expect(access.roleOf('a')).toBe('reader');
  });

  it('a role learned outside a round updates one space and tells its listeners, once per change', async () => {
    const access = new SpaceAccess(store);
    await access.record([{ spaceId: 'a', role: 'owner' }]);
    const listener = vi.fn();
    access.subscribe(listener);

    await access.note('b', 'reader');
    await access.note('b', 'reader');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(access.snapshot()).toEqual({ a: 'owner', b: 'reader' });
  });

  it('the undone-changes notice adds up per space', async () => {
    await noteUnsavedUndone(store, { spaceId: 's1', spaceName: 'Home', count: 2 });
    await noteUnsavedUndone(store, { spaceId: 's2', spaceName: 'Trip', count: 1 });
    await noteUnsavedUndone(store, { spaceId: 's1', spaceName: 'Home', count: 3 });

    expect(await readUnsavedUndone(store)).toEqual([
      { spaceId: 's1', spaceName: 'Home', count: 5 },
      { spaceId: 's2', spaceName: 'Trip', count: 1 },
    ]);
  });
});
