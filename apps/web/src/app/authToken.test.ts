import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REFRESH_RETRY_AFTER_MS,
  getAccessToken,
  isRefreshBackedOff,
  noteRefreshFailed,
  noteRefreshSucceeded,
  oidcSignOut,
  resetRefreshBackoffForTests,
  setAccessTokenGetter,
  setOidcSignOut,
} from './authToken';

describe('authToken bridge', () => {
  afterEach(() => {
    setAccessTokenGetter(null);
    setOidcSignOut(null);
    resetRefreshBackoffForTests();
    vi.useRealTimers();
  });

  it('returns undefined while no getter is registered', async () => {
    expect(await getAccessToken()).toBeUndefined();
  });

  it('delegates to the registered getter and can be unregistered', async () => {
    setAccessTokenGetter(async () => 'tok-123');
    expect(await getAccessToken()).toBe('tok-123');
    setAccessTokenGetter(null);
    expect(await getAccessToken()).toBeUndefined();
  });

  it('after a failed refresh the getter is left alone for 15 s — a minted token ends the cooldown at once (prod Logto logs 2026-10-08: 669 refreshes of a dead grant in three minutes)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const getter = vi.fn(async () => 'tok-1');
    setAccessTokenGetter(getter);
    noteRefreshFailed();
    expect(isRefreshBackedOff()).toBe(true);
    expect(await getAccessToken()).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REFRESH_RETRY_AFTER_MS - 1);
    expect(await getAccessToken()).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(await getAccessToken()).toBe('tok-1');
    expect(getter).toHaveBeenCalledTimes(1);
    // a token lifts a cooldown armed meanwhile (the revival probe minted)
    noteRefreshFailed();
    noteRefreshSucceeded();
    expect(isRefreshBackedOff()).toBe(false);
    expect(await getAccessToken()).toBe('tok-1');
    expect(getter).toHaveBeenCalledTimes(2);
  });

  it('oidcSignOut reports false without a handler, true after one runs', async () => {
    expect(await oidcSignOut('https://app/')).toBe(false);
    const handler = vi.fn(async () => undefined);
    setOidcSignOut(handler);
    expect(await oidcSignOut('https://app/')).toBe(true);
    expect(handler).toHaveBeenCalledWith('https://app/');
  });
});
