import { describe, expect, it } from 'vitest';
import { UNCOVERED_AFTER_MS, uncoveredSince } from './accountCoverage';

const NOW = Date.parse('2026-10-04T20:00:00Z');
const live = new Set(['conn-live']);

describe('account coverage (#445)', () => {
  it('a party-fed row whose connection is gone is uncovered since its last sync', () => {
    expect(uncoveredSince({ source: 'connector', connectionId: 'conn-gone', lastSyncedAt: '2026-09-30T08:00:00Z' }, live, NOW)).toBe('2026-09-30T08:00:00Z');
    expect(uncoveredSince({ source: 'connector', connectionId: 'conn-gone' }, live, NOW)).toBe('');
  });

  it('a live connection covers it, whatever the clock says', () => {
    expect(uncoveredSince({ source: 'connector', connectionId: 'conn-live', lastSyncedAt: '2026-01-01T00:00:00Z' }, live, NOW)).toBeNull();
  });

  it('a row stamped before connection ids existed is read the slow way: a week without a fetch', () => {
    const eightDays = new Date(NOW - UNCOVERED_AFTER_MS - 86_400_000).toISOString();
    const twoDays = new Date(NOW - 2 * 86_400_000).toISOString();
    expect(uncoveredSince({ source: 'connector', lastSyncedAt: eightDays }, live, NOW)).toBe(eightDays);
    expect(uncoveredSince({ source: 'connector', lastSyncedAt: twoDays }, live, NOW)).toBeNull();
    expect(uncoveredSince({ source: 'connector' }, live, NOW)).toBeNull();
  });

  it('a manual or imported row is nobody’s to fetch', () => {
    expect(uncoveredSince({ source: 'manual', connectionId: 'conn-gone', lastSyncedAt: '2026-01-01T00:00:00Z' }, live, NOW)).toBeNull();
    expect(uncoveredSince({ source: 'camt053', lastSyncedAt: '2026-01-01T00:00:00Z' }, live, NOW)).toBeNull();
  });
});
