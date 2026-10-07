// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApiCapabilitiesCache } from '@/lib/api';
import { CLIENT_PROTOCOL } from '@/lib/protocol';
import { reportError } from '@/lib/report';
import { renderApp } from '@/test/harness';

// an invitation only means something with Logto configured (the sign-in it
// leads into); deterministic regardless of the developer's .env.local
const mockLogto = { value: true };
vi.mock('@/app/config', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/app/config')>();
  return {
    ...real,
    get logtoConfigured() {
      return mockLogto.value;
    },
    localCaUrl: () => null,
  };
});
const mockSignIn = vi.fn((_options?: unknown) => Promise.resolve());
vi.mock('@logto/react', () => ({
  Prompt: { None: 'none', Consent: 'consent', Login: 'login' },
  LogtoProvider: ({ children }: { children: unknown }) => children,
  useLogto: () => ({
    signIn: mockSignIn,
    signOut: vi.fn(),
    getAccessToken: vi.fn(async () => undefined),
    getIdTokenClaims: vi.fn(async () => undefined),
    isAuthenticated: false,
    isLoading: false,
    error: undefined,
  }),
  useHandleSignInCallback: () => ({ error: undefined, isAuthenticated: false }),
}));
vi.mock('@/lib/report', () => ({ reportError: vi.fn(), reportWarning: vi.fn() }));

// the invite screen itself is zero-network: the token reaches Logto through
// the SDK on the tap alone (the login screen behind "Not now" may ask /health)
const fetchSpy = vi.fn(() => Promise.reject(new Error('network disabled in test')));

const INVITE = '/invite?token=ott-123&email=ada%40example.com';

describe('InviteScreen (the landing of Logto’s magic link)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockLogto.value = true;
    mockSignIn.mockClear();
    vi.mocked(reportError).mockClear();
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockClear();
  });

  it('a complete link names the invitee; the tap — never the landing — hands Logto the one-time token and the e-mail', async () => {
    renderApp(INVITE, { signedIn: false });
    await screen.findByTestId('screen-invite');
    expect(screen.getByTestId('invite-body').textContent).toContain('ada@example.com');
    // landing spends nothing: a mail gateway that runs JavaScript would burn the single-use token
    expect(mockSignIn).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('invite-accept'));
    await waitFor(() => expect(mockSignIn).toHaveBeenCalledTimes(1));
    const options = mockSignIn.mock.calls[0][0] as { redirectUri: string; extraParams: Record<string, string> };
    expect(options.extraParams).toEqual({ one_time_token: 'ott-123', login_hint: 'ada@example.com' });
    expect(options.redirectUri).toContain('/auth-callback');
    expect(screen.queryByTestId('invite-accept-error')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a sign-in that cannot start is named on screen and reported (the login screen’s rule)', async () => {
    mockSignIn.mockRejectedValueOnce(new TypeError('Load failed'));
    renderApp(INVITE, { signedIn: false });
    fireEvent.click(await screen.findByTestId('invite-accept'));
    const err = await screen.findByTestId('invite-accept-error');
    expect(err.textContent).toContain('Load failed');
    expect(reportError).toHaveBeenCalledWith('auth', expect.any(Error));
  });

  it('an incomplete link gets the short refusal, no button, and the way to the login', async () => {
    renderApp('/invite?email=ada%40example.com', { signedIn: false });
    expect(await screen.findByTestId('invite-invalid')).toBeTruthy();
    expect(screen.queryByTestId('invite-accept')).toBeNull();
    expect(screen.queryByTestId('invite-body')).toBeNull();

    fireEvent.click(screen.getByTestId('invite-not-now'));
    expect(await screen.findByTestId('screen-login')).toBeTruthy();
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('a link whose token the search parser read as a number still carries it as text', async () => {
    renderApp('/invite?token=123456&email=ada%40example.com', { signedIn: false });
    fireEvent.click(await screen.findByTestId('invite-accept'));
    await waitFor(() => expect(mockSignIn).toHaveBeenCalledTimes(1));
    const options = mockSignIn.mock.calls[0][0] as { extraParams: Record<string, string> };
    expect(options.extraParams.one_time_token).toBe('123456');
  });

  it('offline the button waits, with the login screen’s note', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      renderApp(INVITE, { signedIn: false });
      const accept = (await screen.findByTestId('invite-accept')) as HTMLButtonElement;
      expect(accept.disabled).toBe(true);
      expect(screen.getByTestId('invite-offline-note')).toBeTruthy();
    } finally {
      onLine.mockRestore();
    }
  });
});

describe('the login screen of an invitation-only munni', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockLogto.value = true;
    resetApiCapabilitiesCache();
  });

  it('says sign-up is by invitation when /health carries the capability', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = url.endsWith('/health')
        ? { status: 'ok', capabilities: { inviteOnly: true }, protocol: CLIENT_PROTOCOL, minClientProtocol: 1 }
        : {};
      return new Response(JSON.stringify(body), { status: url.endsWith('/health') ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderApp('/login', { signedIn: false });
      await screen.findByTestId('login-signin-btn');
      expect(await screen.findByTestId('login-invite-only')).toBeTruthy();
      expect(fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.endsWith('/health'))).toHaveLength(1);
    } finally {
      resetApiCapabilitiesCache(); // the per-page cache must not leak into the next spec
    }
  });
});
