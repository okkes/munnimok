// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mergedRange, accountRangeKey } from '@/application/connections';
import { manifestOf } from '@/test/connectorFixtures';
import { manageRouteFor, renewalOf, sessionOver, syncsByHand } from './connectionRules';
import type { SyncableConnection } from './connectionRules';

describe('what a connection says about renewing it (#528)', () => {
  const consent = { unattendedFetch: true, secretCustody: 'server' as const };

  it('the relay’s binding is the word for a session it keeps', () => {
    expect(renewalOf({ status: 'ok' }, { state: 'active' }, { state: 'needs_reauth', scheduled: true }, true, consent)).toEqual({ unattended: true, ended: true });
    expect(renewalOf({ status: 'ok' }, undefined, { state: 'active', scheduled: true }, true, consent)).toEqual({ unattended: true, ended: false });
  });

  it('a consent the relay no longer keeps has ended — but only once the relay was heard', () => {
    expect(renewalOf({ status: 'ok' }, { state: 'active' }, undefined, true, consent).ended).toBe(true);
    // offline: this device's row and the synced status speak instead
    expect(renewalOf({ status: 'ok' }, { state: 'active' }, undefined, false, consent).ended).toBe(false);
    expect(renewalOf({ status: 'expired' }, { state: 'active' }, undefined, false, consent).ended).toBe(true);
  });

  it('a party in the person’s own custody is read from this device', () => {
    const own = { unattendedFetch: false, secretCustody: 'client' as const };
    expect(renewalOf({ status: 'ok' }, { state: 'needs_reauth' }, undefined, true, own)).toEqual({ unattended: false, ended: true });
    expect(renewalOf({ status: 'ok' }, { state: 'active' }, undefined, true, own)).toEqual({ unattended: false, ended: false });
  });

  it('without a manifest the relay’s own schedule says whether it syncs by itself', () => {
    expect(renewalOf({ status: 'ok' }, undefined, { state: 'expired', scheduled: true }, true, undefined)).toEqual({ unattended: true, ended: true });
  });

  it('banks are managed on All accounts, shops and registries under Connected services (#527)', () => {
    expect(manageRouteFor('bank')).toBe('/accounts');
    expect(manageRouteFor(undefined)).toBe('/accounts');
    expect(manageRouteFor('store')).toBe('/connections');
    expect(manageRouteFor('registry')).toBe('/connections');
  });
});

describe('the quick sync’s connections (#548)', () => {
  const view = (extra: Partial<SyncableConnection> = {}): SyncableConnection => ({
    device: { state: 'active', refreshedAt: '2026-10-01T10:00:00Z' },
    hasBundle: true,
    ...extra,
  });

  it('only a party that needs the person for every sync is listed', () => {
    const manifests = new Map([
      ['ing-nl', { unattendedFetch: false }],
      ['ah', { unattendedFetch: true }],
    ]);
    expect(syncsByHand({ store: 'ing-nl' }, manifests)).toBe(true);
    expect(syncsByHand({ store: 'ah' }, manifests)).toBe(false);
    expect(syncsByHand({ store: 'unknown' }, manifests)).toBe(false);
  });

  it('a session past the party’s own clock is signed in again first; a refreshable one never is', () => {
    const ing = manifestOf({ id: 'ing-nl', auth: { ...manifestOf().auth, session: { ttlSeconds: 900, refreshable: false, rotatesOnUse: false } } });
    const at = Date.parse('2026-10-01T10:00:00Z');
    expect(sessionOver(view(), ing, at + 60_000)).toBe(false);
    expect(sessionOver(view(), ing, at + 901_000)).toBe(true);
    expect(sessionOver(view(), manifestOf(), at + 365 * 86_400_000)).toBe(false);
    expect(sessionOver(view({ hasBundle: false }), ing, at)).toBe(true);
  });
});

describe('a bank connection’s range is its own accounts’ (#524)', () => {
  it('merges the accounts it fetches, and nothing else', () => {
    const ranges = {
      [accountRangeKey('a')]: { count: 2, from: '2026-01-01', to: '2026-02-01' },
      [accountRangeKey('b')]: { count: 3, from: '2025-06-01', to: '2026-01-15' },
      [accountRangeKey('c')]: { count: 9, from: '2020-01-01', to: '2026-10-01' },
    };
    expect(mergedRange(ranges, ['a', 'b'])).toEqual({ count: 5, from: '2025-06-01', to: '2026-02-01' });
    expect(mergedRange(ranges, ['missing'])).toBeUndefined();
  });
});
