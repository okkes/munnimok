import { describe, expect, it } from 'vitest';
import { UNCOVERED_AFTER_MS, fetchingConnectionIds, ownsFeed, reconnectNeedOf, uncoveredSince } from './accountCoverage';

const NOW = Date.parse('2026-10-04T20:00:00Z');
const live = new Set(['conn-live']);

describe('account coverage (#445)', () => {
  it('a party-fed row whose connection is gone is uncovered since its last sync', () => {
    expect(uncoveredSince({ source: 'connector', connectionId: 'conn-gone', lastSyncedAt: '2026-09-30T08:00:00Z' }, live, true, NOW)).toBe('2026-09-30T08:00:00Z');
    expect(uncoveredSince({ source: 'connector', connectionId: 'conn-gone' }, live, true, NOW)).toBe('');
  });

  it('a live connection covers it, whatever the clock says', () => {
    expect(uncoveredSince({ source: 'connector', connectionId: 'conn-live', lastSyncedAt: '2026-01-01T00:00:00Z' }, live, true, NOW)).toBeNull();
  });

  it('a row stamped before connection ids existed is read the slow way: a week without a fetch', () => {
    const eightDays = new Date(NOW - UNCOVERED_AFTER_MS - 86_400_000).toISOString();
    const twoDays = new Date(NOW - 2 * 86_400_000).toISOString();
    expect(uncoveredSince({ source: 'connector', lastSyncedAt: eightDays }, live, true, NOW)).toBe(eightDays);
    expect(uncoveredSince({ source: 'connector', lastSyncedAt: twoDays }, live, true, NOW)).toBeNull();
    expect(uncoveredSince({ source: 'connector' }, live, true, NOW)).toBeNull();
  });

  it('a manual or imported row is nobody’s to fetch', () => {
    expect(uncoveredSince({ source: 'manual', connectionId: 'conn-gone', lastSyncedAt: '2026-01-01T00:00:00Z' }, live, true, NOW)).toBeNull();
    expect(uncoveredSince({ source: 'camt053', lastSyncedAt: '2026-01-01T00:00:00Z' }, live, true, NOW)).toBeNull();
  });

  it('an account somebody else feeds is not the viewer’s to tell: their connection is not in this device’s ids (user ss 2026-10-08)', () => {
    const gone = { source: 'connector', connectionId: 'conn-gone', lastSyncedAt: '2026-09-30T08:00:00Z' } as const;
    expect(uncoveredSince(gone, live, false, NOW)).toBeNull();
    const old = { source: 'connector', lastSyncedAt: new Date(NOW - UNCOVERED_AFTER_MS - 86_400_000).toISOString() } as const;
    expect(uncoveredSince(old, live, false, NOW)).toBeNull();
  });

  it('whose feed it is: the feeds the viewer registered decide; a nameless link never reads as mine (user ss 2026-10-09)', () => {
    const mine = new Set(['feed-mine']);
    expect(ownsFeed('feed-mine', mine, [], 'me')).toBe(true);
    expect(ownsFeed('feed-elo', mine, [], 'me')).toBe(false);
    // the set is the source of truth: a name on the link neither adds a feed nor takes one away
    expect(ownsFeed('feed-elo', mine, [{ attachedBy: 'me' }], 'me')).toBe(false);
    expect(ownsFeed('feed-mine', mine, [{ attachedBy: 'elo' }], 'me')).toBe(true);
    // the set out of reach (offline): the attacher's name is the next best word, over every attachment
    expect(ownsFeed('feed-x', undefined, [{ attachedBy: 'me' }], 'me')).toBe(true);
    expect(ownsFeed('feed-x', undefined, [{ attachedBy: 'elo' }], 'me')).toBe(false);
    expect(ownsFeed('feed-x', undefined, [{ attachedBy: 'elo' }, { attachedBy: 'me' }], 'me')).toBe(true);
    expect(ownsFeed('feed-x', undefined, [{ attachedBy: 'elo' }], undefined)).toBe(false);
    // neither: unknown, and the caller stays quiet
    expect(ownsFeed('feed-x', undefined, [{}], 'me')).toBeUndefined();
    expect(ownsFeed('feed-x', undefined, [], 'me')).toBeUndefined();
  });

  it('an unknown owner is read as not the viewer’s: no banner beats a wrong one', () => {
    const gone = { source: 'connector', connectionId: 'conn-gone', lastSyncedAt: '2026-09-30T08:00:00Z' } as const;
    expect(uncoveredSince(gone, live, undefined, NOW)).toBeNull();
  });
});

describe('which connections fetch an account (#524)', () => {
  const reachedBy = new Map([['acc-asn', ['conn-live']]]);

  it('the relay’s per-person record wins over the row’s stamp, which names whoever fetched it last', () => {
    // a co-owner's connection fetched the shared IBAN feed last: the row's stamp is theirs
    const coOwned = { id: 'acc-asn', source: 'connector', connectionId: 'conn-partner', lastSyncedAt: '2026-10-01T08:00:00Z' } as const;
    expect(fetchingConnectionIds(coOwned, reachedBy)).toEqual(['conn-live']);
    expect(uncoveredSince(coOwned, live, true, NOW, reachedBy)).toBeNull();
    // without the relay's word (offline) the stamp is all there is
    expect(fetchingConnectionIds(coOwned, undefined)).toEqual(['conn-partner']);
    expect(uncoveredSince(coOwned, live, true, NOW)).toBe('2026-10-01T08:00:00Z');
  });

  it('an account the relay lists only under connections that are gone is not fetched any more', () => {
    const orphan = { id: 'acc-old', source: 'connector', connectionId: 'conn-live', lastSyncedAt: '2026-09-01T08:00:00Z' } as const;
    expect(uncoveredSince(orphan, live, true, NOW, new Map([['acc-old', ['conn-gone']]]))).toBe('2026-09-01T08:00:00Z');
  });
});

describe('when an account asks for a reconnect (#528)', () => {
  const account = (extra: Record<string, unknown> = {}) => ({ id: 'acc-1', source: 'connector' as const, connectionId: 'conn-eb', lastSyncedAt: '2026-09-25T08:00:00Z', ...extra });
  const states = (eb: { unattended: boolean; ended: boolean }) => new Map([['conn-eb', eb]]);

  it('a living consent never asks — however long ago its last sync (user 2026-10-21: it lasts half a year)', () => {
    expect(reconnectNeedOf(account(), true, states({ unattended: true, ended: false }), undefined, NOW)).toBeNull();
  });

  it('a party that syncs by itself and lost its session asks for that connection', () => {
    expect(reconnectNeedOf(account(), true, states({ unattended: true, ended: true }), undefined, NOW)).toEqual({ kind: 'signin', connectionId: 'conn-eb' });
  });

  it('a party that needs the person for every sync is synced, not reconnected', () => {
    expect(reconnectNeedOf(account(), true, states({ unattended: false, ended: true }), undefined, NOW)).toBeNull();
  });

  it('a connection that is gone asks since the last sync', () => {
    expect(reconnectNeedOf(account({ connectionId: 'conn-gone' }), true, states({ unattended: true, ended: false }), undefined, NOW)).toEqual({
      kind: 'gone',
      since: '2026-09-25T08:00:00Z',
    });
  });

  it('one connection that still fetches it is enough; an account that is not the viewer’s asks nothing', () => {
    const both = new Map([
      ['conn-eb', { unattended: true, ended: true }],
      ['conn-ing', { unattended: false, ended: false }],
    ]);
    expect(reconnectNeedOf(account(), true, both, new Map([['acc-1', ['conn-eb', 'conn-ing']]]), NOW)).toBeNull();
    expect(reconnectNeedOf(account(), false, states({ unattended: true, ended: true }), undefined, NOW)).toBeNull();
    expect(reconnectNeedOf({ ...account(), source: 'manual' }, true, states({ unattended: true, ended: true }), undefined, NOW)).toBeNull();
  });
});
