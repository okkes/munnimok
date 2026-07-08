// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { useSession } from '@/app/session';
import { hashPin, randomSalt, readLockConfig, shouldLock, useLock, validPin, writeLockConfig } from './lock';
import type { LockConfig } from './lock';

const config = (overrides: Partial<LockConfig> = {}): LockConfig => ({
  enabled: true,
  pinSalt: 'salt',
  pinHash: 'hash',
  timeoutSec: 60,
  ...overrides,
});

const signIn = (kind: 'demo' | 'offline' = 'demo') =>
  useSession.getState().login(kind === 'demo' ? { kind: 'demo' } : { kind: 'offline', profileId: 'p1' });

describe('lock config + pin (identity-scoped)', () => {
  beforeEach(() => {
    localStorage.clear();
    useSession.getState().logout();
  });

  it('round-trips through localStorage and rejects broken payloads', () => {
    signIn();
    expect(readLockConfig()).toBeNull();
    writeLockConfig(config());
    expect(readLockConfig()?.timeoutSec).toBe(60);
    writeLockConfig(null);
    expect(readLockConfig()).toBeNull();
    localStorage.setItem('munni_lock_demo', 'not json');
    expect(readLockConfig()).toBeNull();
    localStorage.setItem('munni_lock_demo', JSON.stringify({ enabled: true })); // missing pinHash
    expect(readLockConfig()).toBeNull();
  });

  it('signed out there is no lock config to read or write', () => {
    writeLockConfig(config()); // must be a no-op
    expect(localStorage).toHaveLength(0);
    expect(readLockConfig()).toBeNull();
  });

  it('each identity keeps its own lock; sign-out hides it, re-sign-in restores it', () => {
    signIn('demo');
    writeLockConfig(config({ timeoutSec: 300 }));
    useSession.getState().logout();
    expect(readLockConfig()).toBeNull(); // shared machine: login stays reachable

    signIn('offline');
    expect(readLockConfig()).toBeNull(); // someone else's lock never applies

    useSession.getState().logout();
    signIn('demo');
    expect(readLockConfig()?.timeoutSec).toBe(300); // same person: lock re-arms
  });

  it('migrates a pre-scoping device-global config to the active identity', () => {
    localStorage.setItem('munni_lock', JSON.stringify(config({ timeoutSec: 900 })));
    signIn('demo');
    expect(readLockConfig()?.timeoutSec).toBe(900);
    expect(localStorage.getItem('munni_lock')).toBeNull();
    expect(localStorage.getItem('munni_lock_demo')).toBeTruthy();
  });

  it('validPin: 4-8 digits only', () => {
    expect(validPin('1234')).toBe(true);
    expect(validPin('12345678')).toBe(true);
    expect(validPin('123')).toBe(false);
    expect(validPin('123456789')).toBe(false);
    expect(validPin('12a4')).toBe(false);
  });

  it('hashPin is salted and deterministic', async () => {
    const salt = randomSalt();
    expect(salt).toHaveLength(32);
    const a = await hashPin('1234', salt);
    expect(a).toBe(await hashPin('1234', salt));
    expect(a).not.toBe(await hashPin('1234', randomSalt()));
    expect(a).not.toBe(await hashPin('4321', salt));
  });
});

describe('shouldLock', () => {
  it('locks only when enabled and the timeout elapsed', () => {
    expect(shouldLock(null, 999_999)).toBe(false);
    expect(shouldLock(config({ timeoutSec: 60 }), 59_000)).toBe(false);
    expect(shouldLock(config({ timeoutSec: 60 }), 60_000)).toBe(true);
    expect(shouldLock(config({ timeoutSec: 0 }), 0)).toBe(true); // immediately
  });
});

describe('useLock store', () => {
  it('lock/unlock toggle the gate', () => {
    useLock.setState({ locked: false });
    useLock.getState().lock();
    expect(useLock.getState().locked).toBe(true);
    useLock.getState().unlock();
    expect(useLock.getState().locked).toBe(false);
  });
});
