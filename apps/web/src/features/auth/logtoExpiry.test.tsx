// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { isSessionExpired, resetSessionExpiryForTests } from '@/app/sessionExpiry';
import {
  REFRESH_RETRY_AFTER_MS,
  getAccessToken,
  isRefreshBackedOff,
  resetRefreshBackoffForTests,
  setAccessTokenGetter,
} from '@/app/authToken';

// #222: the SDK swallows invalid_grant into the shared context error; the bridge must name the state and silently
// re-enter sign-in once
let mockError: Error | null = null;
/** whether the SDK restored a session */
let mockAuthenticated = true;
const mockSignIn = vi.fn(async () => undefined);
/** what the SDK's getAccessToken answers: a token, undefined (the hook swallowed a failure) or a throw (a client that does not) */
const mockGetAccessToken = vi.fn(async (): Promise<string | undefined> => undefined);

vi.mock('@logto/react', () => ({
  LogtoProvider: ({ children }: { children: ReactNode }) => children,
  useLogto: () => ({
    error: mockError,
    getIdTokenClaims: async () => undefined,
    getAccessToken: () => mockGetAccessToken(),
    isAuthenticated: mockAuthenticated,
    isLoading: false,
    signIn: mockSignIn,
    signOut: async () => undefined,
  }),
  useHandleSignInCallback: () => ({ error: null, isAuthenticated: false, isLoading: false }),
}));

vi.mock('@/app/config', () => ({
  config: { logto: { endpoint: 'https://idp.test', appId: 'app-id', resource: 'https://api.test' } },
  logtoConfigured: true,
  publicOrigin: () => 'https://app.test',
}));

vi.mock('@/lib/report', () => ({ reportError: vi.fn() }));
import { isStaleCallbackError } from './logto';

describe('isStaleCallbackError (GlitchTip 16)', () => {
  it('a state mismatch is a sign-in started over — the fresh sign-in answers it, no event', () => {
    expect(isStaleCallbackError(new Error('State mismatched in the callback URI'))).toBe(true);
    expect(isStaleCallbackError({ name: 'LogtoError', message: 'state mismatch' })).toBe(false);   // not an Error: the message is not read
    expect(isStaleCallbackError(new Error('Grant request is invalid.'))).toBe(false);
    expect(isStaleCallbackError('State mismatch')).toBe(true);
  });
});

const invalidGrant = () => {
  const err = new Error('Grant request is invalid.');
  err.name = 'LogtoRequestError';
  return err;
};

describe('TokenBridge invalid_grant handling (#222)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetSessionExpiryForTests();
    resetRefreshBackoffForTests();
    setAccessTokenGetter(null);
    mockSignIn.mockClear();
    mockGetAccessToken.mockReset();
    mockGetAccessToken.mockResolvedValue(undefined);
    mockError = null;
    mockAuthenticated = true;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it('marks the session expired and silently re-enters sign-in, once', async () => {
    mockError = invalidGrant();
    const { LogtoAppProvider } = await import('./logto');
    render(<LogtoAppProvider>{null}</LogtoAppProvider>);
    await waitFor(() => expect(isSessionExpired()).toBe(true));
    await waitFor(() => expect(mockSignIn).toHaveBeenCalledWith({ redirectUri: `${window.location.origin}/auth-callback`, clearTokens: false }));
    expect(sessionStorage.getItem('munni_grant_reheal')).toBe('1');
    expect(await getAccessToken()).toBeUndefined();
  });

  it('#559: the re-entry goes the way the person signs in — a Google account straight to Google', async () => {
    localStorage.setItem('munni_last_account', JSON.stringify({ name: 'Okkes', at: 1, social: 'google' }));
    mockError = invalidGrant();
    const { LogtoAppProvider } = await import('./logto');
    render(<LogtoAppProvider>{null}</LogtoAppProvider>);
    await waitFor(() =>
      expect(mockSignIn).toHaveBeenCalledWith({
        redirectUri: `${window.location.origin}/auth-callback`,
        clearTokens: false,
        directSignIn: { method: 'social', target: 'google' },
      }),
    );
  });

  it('a NEW invalid_grant in the same visit shows the banner instead of redirecting again', async () => {
    sessionStorage.setItem('munni_grant_reheal', '1'); // the one attempt is spent
    mockError = invalidGrant();
    const { LogtoAppProvider } = await import('./logto');
    render(<LogtoAppProvider>{null}</LogtoAppProvider>);
    await waitFor(() => expect(isSessionExpired()).toBe(true));
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('other context errors (network hiccups) never mark the session expired', async () => {
    mockError = new TypeError('Failed to fetch');
    const { LogtoAppProvider } = await import('./logto');
    render(<LogtoAppProvider>{null}</LogtoAppProvider>);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isSessionExpired()).toBe(false);
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('on the phone a dead grant is named but never re-entered by itself — the auth session would pop the OS prompt (user ss 2026-10-08)', async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    mockError = invalidGrant();
    const { LogtoAppProvider } = await import('./logto');
    render(<LogtoAppProvider>{null}</LogtoAppProvider>);
    await waitFor(() => expect(isSessionExpired()).toBe(true));
    // the banner's Sign in button is the door; no attempt was spent
    expect(mockSignIn).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('munni_grant_reheal')).toBeNull();
  });

  // #654: every call went out without a token and came back 401 while the app showed nothing
  describe('a signed-in person whose SDK holds no session', () => {
    const signedIn = (identity: object) => localStorage.setItem('munni_session', JSON.stringify(identity));

    it('is told to sign in again when the SDK restores nothing (keys wiped, a sign-in started and left) — no redirect by itself', async () => {
      signedIn({ kind: 'user', sub: 'u1' });
      mockAuthenticated = false;
      const { LogtoAppProvider } = await import('./logto');
      render(<LogtoAppProvider>{null}</LogtoAppProvider>);
      await waitFor(() => expect(isSessionExpired()).toBe(true));
      expect(mockSignIn).not.toHaveBeenCalled();
      expect(await getAccessToken()).toBeUndefined();
    });

    it('nobody signed in, or a test identity, has no session to miss', async () => {
      mockAuthenticated = false;
      const { LogtoAppProvider } = await import('./logto');
      render(<LogtoAppProvider>{null}</LogtoAppProvider>);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(isSessionExpired()).toBe(false);
      cleanup();
      signedIn({ kind: 'user', sub: 'u1', testAuth: true });
      render(<LogtoAppProvider>{null}</LogtoAppProvider>);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(isSessionExpired()).toBe(false);
    });

    it('is told too when the SDK says it has nothing to mint with (another tab left for a sign-in) — and never redirected for it', async () => {
      signedIn({ kind: 'user', sub: 'u1' });
      mockError = Object.assign(new Error('Not authenticated.'), { name: 'LogtoClientError', code: 'not_authenticated' });
      const { LogtoAppProvider } = await import('./logto');
      render(<LogtoAppProvider>{null}</LogtoAppProvider>);
      await waitFor(() => expect(isSessionExpired()).toBe(true));
      expect(mockSignIn).not.toHaveBeenCalled();
      expect(sessionStorage.getItem('munni_grant_reheal')).toBeNull();
    });
  });

  // prod Logto logs 2026-10-08: nothing may ask Logto to refresh a dead grant in a loop
  describe('the token getter (the attempt site)', () => {
    it('an invalid_grant the SDK throws marks the session expired at once — the next call asks nobody; the web re-enters once', async () => {
      mockGetAccessToken.mockRejectedValueOnce(invalidGrant());
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { LogtoAppProvider } = await import('./logto');
      render(<LogtoAppProvider>{null}</LogtoAppProvider>);
      expect(await getAccessToken()).toBeUndefined();
      expect(isSessionExpired()).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1); // a breadcrumb, not an event
      expect(await getAccessToken()).toBeUndefined();
      expect(mockGetAccessToken).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(mockSignIn).toHaveBeenCalledWith({ redirectUri: `${window.location.origin}/auth-callback`, clearTokens: false }));
    });

    it('a transient failure is connectivity, not identity: no mark, but the next 15 s ask nobody — a later token clears the cooldown', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      mockGetAccessToken.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const { LogtoAppProvider } = await import('./logto');
      render(<LogtoAppProvider>{null}</LogtoAppProvider>);
      expect(await getAccessToken()).toBeUndefined();
      expect(isSessionExpired()).toBe(false);
      expect(isRefreshBackedOff()).toBe(true);
      mockGetAccessToken.mockResolvedValue('tok-fresh');
      expect(await getAccessToken()).toBeUndefined();
      expect(mockGetAccessToken).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(REFRESH_RETRY_AFTER_MS);
      expect(await getAccessToken()).toBe('tok-fresh');
      expect(isRefreshBackedOff()).toBe(false);
      expect(await getAccessToken()).toBe('tok-fresh');
      expect(mockGetAccessToken).toHaveBeenCalledTimes(3);
    });

    it('the hook answering undefined (a failure swallowed into its context error — the 4.x shape) is a failed attempt too', async () => {
      const { LogtoAppProvider } = await import('./logto');
      render(<LogtoAppProvider>{null}</LogtoAppProvider>);
      expect(await getAccessToken()).toBeUndefined();
      expect(isRefreshBackedOff()).toBe(true);
      expect(isSessionExpired()).toBe(false); // the verdict, if any, is the error effect's to read
      expect(await getAccessToken()).toBeUndefined();
      expect(mockGetAccessToken).toHaveBeenCalledTimes(1);
    });
  });
});
