// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { adoptOfflineProfile } from '@/features/auth/offlineProfiles';
import { identityKey, readSessionIdentity, useSession } from './session';

describe('session persistence (local-first: restarts must not sign out)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useSession.setState({ identity: null });
  });

  it('login persists the identity in localStorage', () => {
    useSession.getState().login({ kind: 'demo' });
    expect(JSON.parse(localStorage.getItem('munni_session')!)).toEqual({ kind: 'demo' });
    expect(readSessionIdentity()).toEqual({ kind: 'demo' });
  });

  it('survives a simulated app restart (fresh read from storage)', () => {
    useSession.getState().login({ kind: 'user', sub: 'abc', testAuth: true });
    // "restart": nothing but storage remains
    expect(readSessionIdentity()).toEqual({ kind: 'user', sub: 'abc', testAuth: true });
  });

  it('logout clears the stored identity', () => {
    useSession.getState().login({ kind: 'demo' });
    useSession.getState().logout();
    expect(localStorage.getItem('munni_session')).toBeNull();
    expect(readSessionIdentity()).toBeNull();
  });

  it('rejects corrupted or unknown identities', () => {
    localStorage.setItem('munni_session', '{broken');
    expect(readSessionIdentity()).toBeNull();
    localStorage.setItem('munni_session', JSON.stringify({ kind: 'nonsense' }));
    expect(readSessionIdentity()).toBeNull();
  });

  it('a store an offline profile adopted is that profile’s: the same login signing in again gets a store of its own', () => {
    expect(identityKey({ kind: 'user', sub: 'abc' })).toBe('user_abc');
    const profile = adoptOfflineProfile('Was online', undefined, 'user_abc');

    expect(identityKey({ kind: 'offline', profileId: profile.id })).toBe('user_abc');
    expect(identityKey({ kind: 'user', sub: 'abc' })).toBe('user_abc_2');
    // another login on the device is untouched
    expect(identityKey({ kind: 'user', sub: 'xyz' })).toBe('user_xyz');
  });

  it('the store a login moved to stays its store when the profile is deleted, and a second go-offline moves it on', () => {
    adoptOfflineProfile('First', undefined, 'user_abc');
    expect(identityKey({ kind: 'user', sub: 'abc' })).toBe('user_abc_2');

    localStorage.removeItem('munni_offline_profiles');
    expect(identityKey({ kind: 'user', sub: 'abc' })).toBe('user_abc_2');

    adoptOfflineProfile('Second', undefined, 'user_abc_2');
    expect(identityKey({ kind: 'user', sub: 'abc' })).toBe('user_abc_3');
  });

  it('identityKey sanitizes subs for db names', () => {
    expect(identityKey({ kind: 'user', sub: 'a.b|c d' })).toBe('user_a_b_c_d');
    expect(identityKey({ kind: 'demo' })).toBe('demo');
    expect(identityKey({ kind: 'offline', profileId: 'x1' })).toBe('offline_x1');
  });
});
