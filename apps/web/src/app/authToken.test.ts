import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REFRESH_RETRY_AFTER_MS,
  TOKEN_MINT_WAIT_MS,
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

  it('a session restore that never reports back holds the app for a while, not for good (#594)', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const fresh = await import('./authToken');
    let ready = false;
    void fresh.waitForAuthReady().then(() => {
      ready = true;
    });
    await vi.advanceTimersByTimeAsync(fresh.AUTH_READY_WAIT_MS - 1);
    expect(ready).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(ready).toBe(true);
    expect(fresh.authWaits().restore).toBe('timed out');
  });

  it('a restore that reports back in time is not marked', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const fresh = await import('./authToken');
    const waiting = fresh.waitForAuthReady();
    fresh.signalAuthReady();
    await waiting;
    await vi.advanceTimersByTimeAsync(fresh.AUTH_READY_WAIT_MS + 1);
    expect(fresh.authWaits().restore).toBe('done');
  });

  it('a token mint that never answers is a failed one: no bearer after the wait, and the callers after it do not queue behind it (#594)', async () => {
    vi.useFakeTimers();
    const stuck = vi.fn(() => new Promise<string | undefined>(() => undefined));
    setAccessTokenGetter(stuck);
    const first = getAccessToken();
    await vi.advanceTimersByTimeAsync(TOKEN_MINT_WAIT_MS + 1);
    expect(await first).toBeUndefined();
    // the cooldown of a failed refresh: nobody asks for a while
    expect(await getAccessToken()).toBeUndefined();
    expect(stuck).toHaveBeenCalledTimes(1);

    // afterwards a mint that answers is used, whatever the stuck one still holds
    await vi.advanceTimersByTimeAsync(REFRESH_RETRY_AFTER_MS + 1);
    setAccessTokenGetter(async () => 'tok-2');
    const next = getAccessToken();
    await vi.advanceTimersByTimeAsync(1);
    expect(await next).toBe('tok-2');
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
