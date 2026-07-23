// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { addOfflineProfile, listOfflineProfiles, offlineProfileName } from './offlineProfiles';

describe('offline profile registry', () => {
  beforeEach(() => localStorage.clear());

  it('starts empty and holds exactly ONE profile per device', () => {
    expect(listOfflineProfiles()).toEqual([]);
    const a = addOfflineProfile('  Okkes ');
    expect(a.name).toBe('Okkes');
    // user ruling: no parallel profiles — spaces separate bookkeeping;
    // a second create returns the existing profile instead
    const b = addOfflineProfile('Partner');
    expect(b.id).toBe(a.id);
    expect(listOfflineProfiles().map((p) => p.name)).toEqual(['Okkes']);
    expect(offlineProfileName(a.id)).toBe('Okkes');
  });

  it('survives corrupted storage', () => {
    localStorage.setItem('munni_offline_profiles', '{nope');
    expect(listOfflineProfiles()).toEqual([]);
    localStorage.setItem('munni_offline_profiles', JSON.stringify([{ bad: true }, { id: 'x', name: 'ok', createdAt: 1 }]));
    expect(listOfflineProfiles()).toEqual([{ id: 'x', name: 'ok', createdAt: 1 }]);
  });

  it('unknown ids resolve to undefined', () => {
    expect(offlineProfileName('nope')).toBeUndefined();
  });
});
