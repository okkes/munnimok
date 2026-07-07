// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { hashPin, randomSalt, readLockConfig, shouldLock, useLock, validPin, writeLockConfig } from './lock';
import type { LockConfig } from './lock';

const config = (overrides: Partial<LockConfig> = {}): LockConfig => ({
  enabled: true,
  pinSalt: 'salt',
  pinHash: 'hash',
  timeoutSec: 60,
  ...overrides,
});

describe('lock config + pin', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips through localStorage and rejects broken payloads', () => {
    expect(readLockConfig()).toBeNull();
    writeLockConfig(config());
    expect(readLockConfig()?.timeoutSec).toBe(60);
    writeLockConfig(null);
    expect(readLockConfig()).toBeNull();
    localStorage.setItem('munni_lock', 'not json');
    expect(readLockConfig()).toBeNull();
    localStorage.setItem('munni_lock', JSON.stringify({ enabled: true })); // missing pinHash
    expect(readLockConfig()).toBeNull();
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
