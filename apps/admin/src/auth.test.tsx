// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminConfig } from './config';

const CONFIG: AdminConfig = { apiUrl: 'http://api.test', logtoEndpoint: 'https://idp.test', logtoAppId: 'app-admin', logtoResource: 'https://api.test', labUrl: '' };

let mockError: Error | null = null;
let mockLoading = false;
const mockSignIn = vi.fn(async () => undefined);
const mockGetAccessToken = vi.fn(async (): Promise<string | undefined> => 'tok');

vi.mock('@logto/react', () => ({
  useLogto: () => ({
    error: mockError,
    isAuthenticated: true,
    isLoading: mockLoading,
    signIn: mockSignIn,
    signOut: async () => undefined,
    getAccessToken: () => mockGetAccessToken(),
  }),
  useHandleSignInCallback: () => undefined,
}));

/** the portal stands in: it shows the session it was handed and fetches a token on a press */
vi.mock('./AdminApp', () => ({
  AdminApp: ({ getToken, session }: { getToken: (() => Promise<string | undefined>) | null; session?: { expired: boolean; signIn: () => void } }) => (
    <div data-testid="admin-app" data-expired={String(session?.expired ?? false)}>
      <button data-testid="get-token" onClick={() => void getToken?.()}>
        token
      </button>
      <button data-testid="session-signin" onClick={session?.signIn}>
        sign in
      </button>
    </div>
  ),
}));

import { LogtoGate, REFRESH_RETRY_AFTER_MS, fetchTokenGuarded, isGrantDead, isInvalidGrantError, markGrantDead, resetAuthForTests } from './auth';

const invalidGrant = () => {
  const err = new Error('Grant request is invalid.');
  err.name = 'LogtoRequestError';
  return err;
};

describe('the token guard (prod Logto logs 2026-10-08: a dead grant refreshed 669 times in three minutes)', () => {
  beforeEach(() => resetAuthForTests());
  afterEach(() => vi.useRealTimers());

  it('recognizes Logto’s invalid_grant in both error shapes', () => {
    expect(isInvalidGrantError({ code: 'oidc.invalid_grant', message: 'Grant request is invalid.' })).toBe(true);
    expect(isInvalidGrantError(invalidGrant())).toBe(true);
    expect(isInvalidGrantError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isInvalidGrantError(undefined)).toBe(false);
  });

  it('concurrent callers share one fetch; a failed one backs off 15 s; a token clears the cooldown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchToken = vi.fn(async (): Promise<string | undefined> => 'tok-1');
    const [a, b] = await Promise.all([fetchTokenGuarded(fetchToken), fetchTokenGuarded(fetchToken)]);
    expect([a, b]).toEqual(['tok-1', 'tok-1']);
    expect(fetchToken).toHaveBeenCalledTimes(1);
    // the SDK swallows a failure into undefined — a failed attempt
    fetchToken.mockResolvedValueOnce(undefined);
    expect(await fetchTokenGuarded(fetchToken)).toBeUndefined();
    expect(await fetchTokenGuarded(fetchToken)).toBeUndefined();
    expect(fetchToken).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(REFRESH_RETRY_AFTER_MS - 1);
    expect(await fetchTokenGuarded(fetchToken)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(await fetchTokenGuarded(fetchToken)).toBe('tok-1');
    expect(fetchToken).toHaveBeenCalledTimes(3);
    // a throw is a failed attempt as well
    fetchToken.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await fetchTokenGuarded(fetchToken)).toBeUndefined();
    expect(await fetchTokenGuarded(fetchToken)).toBeUndefined();
    expect(fetchToken).toHaveBeenCalledTimes(4);
  });

  it('a dead grant asks nobody, however long it waits', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchToken = vi.fn(async (): Promise<string | undefined> => 'tok-1');
    expect(markGrantDead()).toBe(true);
    expect(markGrantDead()).toBe(false); // the transition is reported once
    expect(isGrantDead()).toBe(true);
    expect(await fetchTokenGuarded(fetchToken)).toBeUndefined();
    vi.advanceTimersByTime(60 * 60_000);
    expect(await fetchTokenGuarded(fetchToken)).toBeUndefined();
    expect(fetchToken).not.toHaveBeenCalled();
  });
});

describe('LogtoGate', () => {
  beforeEach(() => {
    resetAuthForTests();
    mockError = null;
    mockLoading = false;
    mockSignIn.mockClear();
    mockGetAccessToken.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('hands the portal the guarded token path — a token press reaches the SDK once per call', async () => {
    render(<LogtoGate config={CONFIG} />);
    expect(screen.getByTestId('admin-app').dataset.expired).toBe('false');
    fireEvent.click(screen.getByTestId('get-token'));
    await waitFor(() => expect(mockGetAccessToken).toHaveBeenCalledTimes(1));
  });

  it('invalid_grant in the SDK’s shared error: the grant is dead — the portal is told, no token call reaches the SDK, Sign in re-enters the flow', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockError = invalidGrant();
    render(<LogtoGate config={CONFIG} />);
    await waitFor(() => expect(screen.getByTestId('admin-app').dataset.expired).toBe('true'));
    expect(warn).toHaveBeenCalledTimes(1); // a breadcrumb, not an event
    fireEvent.click(screen.getByTestId('get-token'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockGetAccessToken).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('session-signin'));
    expect(mockSignIn).toHaveBeenCalledWith(`${window.location.origin}/auth-callback`);
  });

  it('other errors (a network hiccup) never mark the grant dead', async () => {
    mockError = new TypeError('Failed to fetch');
    render(<LogtoGate config={CONFIG} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(isGrantDead()).toBe(false);
    expect(screen.getByTestId('admin-app').dataset.expired).toBe('false');
  });

  it('stays mounted through the SDK’s isLoading flips once signed in — every token call flipped it, and a remount reloaded the portal', () => {
    const { rerender } = render(<LogtoGate config={CONFIG} />);
    expect(screen.getByTestId('admin-app')).toBeTruthy();
    mockLoading = true;
    rerender(<LogtoGate config={CONFIG} />);
    expect(screen.getByTestId('admin-app')).toBeTruthy();
  });
});
