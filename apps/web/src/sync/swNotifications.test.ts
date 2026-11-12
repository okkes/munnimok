// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { buildNotification, readWorkerLang } from './swNotifications';

describe('buildNotification', () => {
  it('renders the test push in every language, landing back on its space’s notifications row', () => {
    expect(buildNotification({ type: 'test' }, 'en')).toMatchObject({ title: 'munni', body: 'Test notification — push reaches this device ✓', tag: 'test', url: './#/settings', pull: false });
    expect(buildNotification({ type: 'test' }, 'nl')!.body).toContain('Testmelding');
    expect(buildNotification({ type: 'test' }, 'tr')!.body).toContain('Test bildirimi');
    // #551: sent from a space's settings it names that space and returns there
    expect(buildNotification({ type: 'test', spaceId: 's2', spaceName: 'Trip' }, 'en')).toMatchObject({ title: 'Trip', url: './#/settings?space=s2' });
  });

  it('announces new transactions with count, per-space tag and a pre-sync pull', () => {
    const one = buildNotification({ type: 'new-transactions', spaceId: 's1', spaceName: 'Household', count: 1 }, 'en')!;
    expect(one).toMatchObject({ body: '1 new transaction arrived', tag: 'new-tx-s1', pull: true, pullSpaceId: 's1' });
    // #551: the lock screen says which space the transactions landed in
    expect(one.title).toBe('Household');
    // #132: the tap lands in the announced space's REVIEW — the space
    // rides the hash query so cold starts carry it too
    expect(one.url).toBe('./#/review?space=s1');
    const many = buildNotification({ type: 'new-transactions', count: 7 }, 'nl')!;
    expect(many.body).toBe('7 nieuwe transacties ontvangen');
    expect(many.title).toBe('munni'); // no name to give
    expect(many.tag).toBe('new-tx-all');
    expect(many.url).toBe('./#/review');
  });

  it('a space id that is not an id never rides into a route', () => {
    const odd = buildNotification({ type: 'new-transactions', spaceId: '../x?y', count: 1 }, 'en')!;
    expect(odd).toMatchObject({ url: './#/review', tag: 'new-tx-all', pullSpaceId: undefined });
  });

  it('localizes social events and routes their clicks', () => {
    const request = buildNotification({ type: 'friend-request', fromName: 'Elif' }, 'tr')!;
    expect(request.body).toBe('Elif sana arkadaşlık isteği gönderdi');
    expect(request).toMatchObject({ url: './#/friends', pull: false });

    const invite = buildNotification({ type: 'space-invite', fromName: 'Elif', spaceName: 'Big Family' }, 'en')!;
    expect(invite.body).toBe('Elif invited you to "Big Family"');
    expect(invite.url).toBe('./#/spaces');

    const join = buildNotification({ type: 'space-join', spaceName: 'Big Family' }, 'nl')!;
    expect(join.body).toBe('Iemand doet nu mee in "Big Family"'); // missing name falls back
    // #551: with the space named, the tap opens that space's members
    expect(buildNotification({ type: 'space-join', fromName: 'Bob', spaceId: 'sp7', spaceName: 'Big Family' }, 'en')!.url).toBe('./#/spaces/sp7/members');
  });

  it('words what happens in a split (#538): settled by the receiver’s own figure, and the tap opens the split — or the list when they are not in it', () => {
    const split = { type: 'split', splitId: 'sp-1', splitName: 'Ski trip', currency: 'EUR', fromName: 'Anna' };
    const invited = buildNotification({ ...split, kind: 'invited' }, 'en')!;
    expect(invited.body).toBe('Anna invited you to the split "Ski trip"');
    expect(invited).toMatchObject({ url: './#/splits', pull: false, tag: 'split-invited-sp-1' });
    expect(buildNotification({ ...split, kind: 'approved' }, 'nl')!).toMatchObject({ body: 'Je doet mee: "Ski trip"', url: './#/splits/sp-1' });
    expect(buildNotification({ ...split, kind: 'removed' }, 'tr')!.url).toBe('./#/splits');

    expect(buildNotification({ ...split, kind: 'settled', cents: 4250 }, 'en')!.body).toBe('"Ski trip" is settled: you get 42.50 EUR');
    expect(buildNotification({ ...split, kind: 'settled', cents: -20_450 }, 'nl')!.body).toBe('"Ski trip" is afgerekend: je betaalt 204.50 EUR');
    expect(buildNotification({ ...split, kind: 'settled', cents: 0 }, 'tr')!.body).toBe('"Ski trip" hesaplaşıldı: borcun da alacağın da yok');
    expect(buildNotification({ ...split, kind: 'payment-paid', cents: 1500 }, 'en')!.body).toBe('Anna marked a payment of 15.00 EUR as paid in "Ski trip"');
    // every kind the server sends has its words in every language
    for (const lang of ['en', 'nl', 'tr']) {
      for (const kind of ['join-request', 'refused', 'invite-accepted', 'invite-declined', 'delete-planned', 'delete-stopped', 'made-owner']) {
        expect(buildNotification({ ...split, kind }, lang)!.body).toContain('Ski trip');
      }
    }
    // a kind this build does not know shows nothing; a split id that is no id never rides into a route
    expect(buildNotification({ ...split, kind: 'something-new' }, 'en')).toBeNull();
    expect(buildNotification({ ...split, splitId: '../x?y', kind: 'approved', fromName: undefined }, 'en')!.url).toBe('./#/splits');
  });

  it('localizes membership pushes for the affected member (#172/#173)', () => {
    const removed = buildNotification({ type: 'member-removed', fromName: 'Alice', spaceName: 'Big Family' }, 'en')!;
    expect(removed.body).toBe('You were removed from "Big Family" by Alice');
    expect(removed).toMatchObject({ url: './#/spaces', pull: false, tag: 'member-removed' });

    // the role NAME localizes too, and unknown roles pass through raw
    const role = buildNotification({ type: 'member-role', spaceName: 'Aile', role: 'reader' }, 'tr')!;
    expect(role.body).toBe('"Aile" alanındaki rolün artık okuyucu');
    const roleNl = buildNotification({ type: 'member-role', spaceName: 'Huis', role: 'wizard' }, 'nl')!;
    expect(roleNl.body).toBe('Je rol in "Huis" is nu wizard');
    expect(buildNotification({ type: 'member-role', spaceId: 'sp7', spaceName: 'Huis', role: 'reader' }, 'en')!.url).toBe('./#/spaces/sp7/members');
  });

  it('unknown payloads and unknown languages degrade safely', () => {
    expect(buildNotification({ type: 'mystery' }, 'en')).toBeNull();
    expect(buildNotification({}, 'en')).toBeNull();
    const fallback = buildNotification({ type: 'friend-accept', fromName: 'Bob' }, 'xx')!;
    expect(fallback.body).toBe('Bob accepted your friend request'); // en fallback
  });
});

describe('readWorkerLang', () => {
  it("returns the mirrored language, or 'en' when nothing is stored", async () => {
    expect(await readWorkerLang()).toBe('en');
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('munni_sw', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onsuccess = () => {
        const txn = open.result.transaction('kv', 'readwrite');
        txn.objectStore('kv').put('tr', 'lang');
        txn.oncomplete = () => {
          open.result.close();
          resolve();
        };
        txn.onerror = () => reject(txn.error as Error);
      };
      open.onerror = () => reject(open.error as Error);
    });
    expect(await readWorkerLang()).toBe('tr');
  });
});
