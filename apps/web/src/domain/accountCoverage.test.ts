import { describe, expect, it } from 'vitest';
import { UNCOVERED_AFTER_MS, ownsAccount, ownsLink, uncoveredSince } from './accountCoverage';

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

  it('whose account it is: the attacher’s, or the viewer’s when nothing says', () => {
    expect(ownsLink({ attachedBy: 'me' }, 'me')).toBe(true);
    expect(ownsLink({ attachedBy: 'elo' }, 'me')).toBe(false);
    expect(ownsLink({ attachedBy: 'elo' }, undefined)).toBe(false);
    expect(ownsLink({}, 'me')).toBe(true);
    expect(ownsLink(undefined, 'me')).toBe(true);
    // over every attachment: mine when any is, and an unattached row is mine (a friend's rows only arrive attached)
    expect(ownsAccount([], 'me')).toBe(true);
    expect(ownsAccount([{ attachedBy: 'elo' }], 'me')).toBe(false);
    expect(ownsAccount([{ attachedBy: 'elo' }, { attachedBy: 'me' }], 'me')).toBe(true);
    expect(ownsAccount([{ attachedBy: 'elo' }, {}], 'me')).toBe(true);
  });
});
