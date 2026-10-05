// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_CALLBACK_KEY } from '@/lib/platform';
import { landingFor, nativeCallbackUri, nativeNavigate, nativeSignedOutUri, startAuthSession } from './nativeAuth';

interface Stub {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
}
const setCapacitor = (stub: Stub | undefined) => {
  (globalThis as { Capacitor?: Stub }).Capacitor = stub;
};

afterEach(() => {
  setCapacitor(undefined);
  sessionStorage.clear();
});

describe('startAuthSession — a session that would not start gets one more try (GlitchTip 15)', () => {
  it('the second start answers; the first refusal is a breadcrumb', async () => {
    const start = vi
      .fn<(o: { url: string; callbackScheme: string }) => Promise<{ url: string | null }>>()
      .mockRejectedValueOnce(new Error('the auth session could not start'))
      .mockResolvedValueOnce({ url: 'munni-prod-nas://auth-callback?code=c' });
    const pause = vi.fn(async () => {});
    const result = await startAuthSession({ start }, { url: 'https://logto.example/oidc/auth', callbackScheme: 'munni-prod-nas' }, pause);
    expect(result.url).toBe('munni-prod-nas://auth-callback?code=c');
    expect(start).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledWith(400);
  });

  it('a second refusal is the failure the login screen names', async () => {
    const start = vi.fn(async () => { throw new Error('The operation could not be completed. (ASWebAuthenticationSessionError error 3.)'); });
    await expect(startAuthSession({ start }, { url: 'https://logto.example/oidc/auth', callbackScheme: 'munni-prod-nas' }, async () => {})).rejects.toThrow(/error 3/);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('a cancellation is an answer, not a refusal — no second try', async () => {
    const start = vi.fn(async () => ({ url: null, cancelled: true }));
    expect(await startAuthSession({ start }, { url: 'u', callbackScheme: 's' }, async () => {})).toEqual({ url: null, cancelled: true });
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe('nativeNavigate — sign-in in the platform auth session (RFC 8252)', () => {
  it('iOS: the auth session hands the callback URL back; it is stored for the exchange screen, no browser bounce', async () => {
    const start = vi.fn(async () => ({ url: 'munni-prod-nas://auth-callback?code=c&state=s' }));
    const go = vi.fn();
    setCapacitor({ isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { AuthSession: { start } } });
    await nativeNavigate('https://logto.example/oidc/auth?client_id=x', go);
    expect(start).toHaveBeenCalledWith({ url: 'https://logto.example/oidc/auth?client_id=x', callbackScheme: expect.any(String) });
    expect(sessionStorage.getItem(NATIVE_CALLBACK_KEY)).toBe('munni-prod-nas://auth-callback?code=c&state=s');
    expect(go).toHaveBeenCalledWith('/auth-callback');
  });

  it('iOS: a cancelled session leaves the app where it was', async () => {
    const go = vi.fn();
    setCapacitor({ isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { AuthSession: { start: async () => ({ url: null, cancelled: true }) } } });
    await nativeNavigate('https://logto.example/oidc/auth', go);
    expect(go).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(NATIVE_CALLBACK_KEY)).toBeNull();
  });

  it('iOS: the end-session round-trip lands on the login screen', async () => {
    const go = vi.fn();
    setCapacitor({ isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { AuthSession: { start: async () => ({ url: 'munni-prod-nas://signed-out' }) } } });
    await nativeNavigate('https://logto.example/oidc/session/end', go);
    expect(go).toHaveBeenCalledWith('/#/login');
  });

  it('Android: the Custom Tab opens the URL; the scheme intent brings the app back through the deep-link handler', async () => {
    const open = vi.fn(async () => undefined);
    const go = vi.fn();
    setCapacitor({ isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { Browser: { open } } });
    await nativeNavigate('https://logto.example/oidc/auth', go);
    expect(open).toHaveBeenCalledWith({ url: 'https://logto.example/oidc/auth' });
    expect(go).not.toHaveBeenCalled();
  });

  it('without either plugin the navigation falls back to the plain assign', async () => {
    const go = vi.fn();
    setCapacitor({ isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} });
    await nativeNavigate('https://logto.example/oidc/auth', go);
    expect(go).toHaveBeenCalledWith('https://logto.example/oidc/auth');
  });

  it('the callback URIs are the scheme form Logto registered for the native app', () => {
    expect(nativeCallbackUri()).toMatch(/^munni[\w-]*:\/\/auth-callback$/);
    expect(nativeSignedOutUri()).toMatch(/^munni[\w-]*:\/\/signed-out$/);
    expect(landingFor('munni-prod-nas://signed-out')).toBe('/#/login');
    expect(landingFor('munni-prod-nas://auth-callback?code=c')).toBe('/auth-callback');
  });
});
