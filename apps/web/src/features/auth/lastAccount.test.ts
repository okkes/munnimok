// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { continueOptions, forgetLastAccount, readLastAccount, readSignInWay, rememberLastAccount, signInWayOf } from './lastAccount';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('the account step: who signed in last, and how they get back in (#559)', () => {
  afterEach(() => {
    forgetLastAccount();
    vi.unstubAllGlobals();
  });

  it('remembers the name with the way in, and reads back only what is well-formed', () => {
    rememberLastAccount('Okkes', { social: 'google' });
    expect(readLastAccount()).toMatchObject({
      name: 'Okkes',
      social: 'google',
    });
    localStorage.setItem(
      'munni_last_account',
      JSON.stringify({
        name: 'Okkes',
        at: 1,
        social: 'Google!<script>',
        username: '  ',
      }),
    );
    expect(readLastAccount()).toEqual({ name: 'Okkes', at: 1 });
    localStorage.setItem('munni_last_account', '{oops');
    expect(readLastAccount()).toBeNull();
  });

  it('a sign-in without a name to show takes the previous person’s record off the login screen', () => {
    rememberLastAccount('Okkes', { social: 'google' });
    // another account signs in on this device — one that carries no name, username or e-mail to display
    rememberLastAccount(undefined, { social: 'apple' });
    expect(readLastAccount()).toBeNull();
    rememberLastAccount('Okkes', { social: 'google' });
    rememberLastAccount('   ');
    expect(readLastAccount()).toBeNull();
  });

  it('the way in: the one social identity first, else the username, else unknown', () => {
    expect(signInWayOf({ username: null, identities: { google: { userId: 'g1' } } })).toEqual({ social: 'google' });
    // a username account that linked Google gets back in through Google — the quicker door
    expect(
      signInWayOf({
        username: 'okkes',
        identities: { google: { userId: 'g1' } },
      }),
    ).toEqual({ social: 'google' });
    expect(signInWayOf({ username: 'okkes', identities: {} })).toEqual({
      username: 'okkes',
    });
    // two providers and no username: guessing would send the person to the wrong one
    expect(signInWayOf({ username: null, identities: { google: {}, apple: {} } })).toEqual({});
  });

  it('continuing goes straight to the provider or fills in the username; unknown asks nothing extra', () => {
    expect(continueOptions({ name: 'A', at: 1, social: 'apple' })).toEqual({
      directSignIn: { method: 'social', target: 'apple' },
    });
    expect(continueOptions({ name: 'A', at: 1, username: 'a' })).toEqual({
      loginHint: 'a',
    });
    expect(continueOptions({ name: 'A', at: 1 })).toBeNull();
    expect(continueOptions(null)).toBeNull();
  });

  it('reads the identities off Logto’s userinfo with the fresh token — a failure only leaves them unknown', async () => {
    const fetchMock = vi.fn(async () => json({ sub: 'u1', identities: { google: { userId: 'g1' } } }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await readSignInWay('https://auth.example', null, async () => 'tok')).toEqual({ social: 'google' });
    expect(fetchMock).toHaveBeenCalledWith(new URL('https://auth.example/oidc/me'), { headers: { Authorization: 'Bearer tok' } });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({}, 401)),
    );
    expect(await readSignInWay('https://auth.example/', 'okkes', async () => 'tok')).toEqual({ username: 'okkes' });
    // no token to ask with: the ID token's username is all there is
    expect(await readSignInWay('https://auth.example', 'okkes', async () => undefined)).toEqual({ username: 'okkes' });
  });
});
