// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LabConfig } from './config';

const CONFIG: LabConfig = { apiUrl: 'http://api.test', logtoEndpoint: 'https://idp.test', logtoAppId: 'app-lab', logtoResource: 'https://api.test' };

let mockError: Error | null = null;
let mockLoading = false;
let mockAuthenticated = true;
const mockSignIn = vi.fn(async () => undefined);
const mockGetAccessToken = vi.fn(async (): Promise<string | undefined> => 'tok');

vi.mock('@logto/react', () => ({
  useLogto: () => ({
    error: mockError,
    isAuthenticated: mockAuthenticated,
    isLoading: mockLoading,
    signIn: mockSignIn,
    signOut: async () => undefined,
    getAccessToken: () => mockGetAccessToken(),
  }),
  useHandleSignInCallback: () => undefined,
}));

let mounts = 0;
vi.mock('./app/LabApp', async () => {
  const { useEffect } = await import('react');
  return {
    LabApp: ({ getToken }: { getToken: (() => Promise<string | undefined>) | null }) => {
      useEffect(() => {
        mounts += 1;
      }, []);
      return (
        <div data-testid="console-app">
          <button data-testid="get-token" onClick={() => void getToken?.()}>
            token
          </button>
        </div>
      );
    },
  };
});

import { LogtoGate, REFRESH_RETRY_AFTER_MS, fetchTokenGuarded, isGrantDead, isInvalidGrantError, markGrantDead, resetAuthForTests } from './auth';

const invalidGrant = () => {
  const err = new Error('Grant request is invalid.');
  err.name = 'LogtoRequestError';
  return err;
};

describe('the token guard (#681: a dead grant was refreshed without end and the console flickered)', () => {
  beforeEach(() => resetAuthForTests());
  afterEach(() => vi.useRealTimers());

  it('recognizes Logto’s invalid_grant in both error shapes', () => {
    expect(isInvalidGrantError({ code: 'oidc.invalid_grant', message: 'Grant request is invalid.' })).toBe(true);
    expect(isInvalidGrantError(invalidGrant())).toBe(true);
    expect(isInvalidGrantError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isInvalidGrantError(undefined)).toBe(false);
  });

  it('concurrent callers share one fetch; a failed one backs off; a token clears the cooldown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchToken = vi.fn(async (): Promise<string | undefined> => 'tok-1');
    const [a, b] = await Promise.all([fetchTokenGuarded(fetchToken), fetchTokenGuarded(fetchToken)]);
    expect([a, b]).toEqual(['tok-1', 'tok-1']);
    expect(fetchToken).toHaveBeenCalledTimes(1);
    fetchToken.mockResolvedValueOnce(undefined);
    expect(await fetchTokenGuarded(fetchToken)).toBeUndefined();
    expect(await fetchTokenGuarded(fetchToken)).toBeUndefined();
    expect(fetchToken).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(REFRESH_RETRY_AFTER_MS - 1);
    expect(await fetchTokenGuarded(fetchToken)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(await fetchTokenGuarded(fetchToken)).toBe('tok-1');
    expect(fetchToken).toHaveBeenCalledTimes(3);
    fetchToken.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await fetchTokenGuarded(fetchToken)).toBeUndefined();
    expect(await fetchTokenGuarded(fetchToken)).toBeUndefined();
    expect(fetchToken).toHaveBeenCalledTimes(4);
  });

  it('a dead grant asks nobody, however long it waits', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchToken = vi.fn(async (): Promise<string | undefined> => 'tok-1');
    expect(markGrantDead()).toBe(true);
    expect(markGrantDead()).toBe(false);
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
    mockAuthenticated = true;
    mounts = 0;
    mockSignIn.mockClear();
    mockGetAccessToken.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('hands the console the guarded token path — a token press reaches the SDK once per call', async () => {
    render(<LogtoGate config={CONFIG} />);
    fireEvent.click(screen.getByTestId('get-token'));
    await waitFor(() => expect(mockGetAccessToken).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('session-expired')).toBeNull();
  });

  it('stays mounted through the SDK’s isLoading flips once signed in — every token call flipped it, and the remount was the flicker', () => {
    const { rerender } = render(<LogtoGate config={CONFIG} />);
    expect(screen.getByTestId('console-app')).toBeTruthy();
    mockLoading = true;
    rerender(<LogtoGate config={CONFIG} />);
    mockLoading = false;
    rerender(<LogtoGate config={CONFIG} />);
    expect(screen.getByTestId('console-app')).toBeTruthy();
    expect(mounts).toBe(1);
  });

  it('a dead grant ends at the sign-in door with the reason — the console is not shown and nobody is asked for a token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockError = invalidGrant();
    render(<LogtoGate config={CONFIG} />);
    expect((await screen.findByTestId('session-expired')).textContent).toContain('sign in again');
    expect(screen.queryByTestId('console-app')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(mockGetAccessToken).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('signin'));
    expect(mockSignIn).toHaveBeenCalledWith(`${window.location.origin}/auth-callback`);
  });

  it('other errors (a network hiccup) never mark the grant dead', async () => {
    mockError = new TypeError('Failed to fetch');
    render(<LogtoGate config={CONFIG} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(isGrantDead()).toBe(false);
    expect(screen.getByTestId('console-app')).toBeTruthy();
  });

  it('nobody signed in: the door without a reason; the first restore shows the dots', () => {
    mockAuthenticated = false;
    const { rerender } = render(<LogtoGate config={CONFIG} />);
    expect(screen.getByTestId('signin')).toBeTruthy();
    expect(screen.queryByTestId('session-expired')).toBeNull();
    mockLoading = true;
    rerender(<LogtoGate config={CONFIG} />);
    expect(screen.queryByTestId('signin')).toBeNull();
    expect(document.body.textContent).toContain('…');
  });
});
