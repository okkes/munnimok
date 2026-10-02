// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { config, publicOrigin } from '@/app/config';
import { openPartyPage } from './redirect';

type Started = { url: string; callbackScheme: string };

/** the shell as the page sees it: iOS or Android, with the plugins each registers */
function shell(platform: 'ios' | 'android', plugins: Record<string, unknown>) {
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    Plugins: plugins,
  };
}

describe('openPartyPage — a party that comes back to the app’s own return page', () => {
  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it('on iOS runs in the auth session with the app’s own scheme and answers the https landing (user ss 2026-10-03)', async () => {
    const started: Started[] = [];
    shell('ios', {
      AuthSession: {
        start: async (options: Started) => {
          started.push(options);
          return { url: `${config.nativeScheme}://gc-callback?state=ST-1&code=c-1` };
        },
      },
      Browser: { open: async () => undefined },
    });

    const landing = await openPartyPage('https://bank.example/consent', `${publicOrigin()}/gc-callback*`);

    expect(started).toEqual([{ url: 'https://bank.example/consent', callbackScheme: config.nativeScheme }]);
    expect(landing).toBe(`${publicOrigin()}/gc-callback?state=ST-1&code=c-1`);
  });

  it('on iOS a session the person closed answers nothing', async () => {
    shell('ios', { AuthSession: { start: async () => ({ url: null, cancelled: true }) } });

    expect(await openPartyPage('https://bank.example/consent', `${publicOrigin()}/gc-callback*`)).toBeNull();
  });

  it('on Android opens the Custom Tab and leaves the return to the app’s link', async () => {
    const opened: string[] = [];
    shell('android', { Browser: { open: async ({ url }: { url: string }) => void opened.push(url) } });

    expect(await openPartyPage('https://bank.example/consent', `${publicOrigin()}/gc-callback*`)).toBeNull();
    expect(opened).toEqual(['https://bank.example/consent']);
  });

  it('a party with a scheme of its own still gets the session on that scheme', async () => {
    const started: Started[] = [];
    shell('ios', {
      AuthSession: {
        start: async (options: Started) => {
          started.push(options);
          return { url: 'appie://login-exit?token=t' };
        },
      },
    });

    expect(await openPartyPage('https://party.example/login', 'appie://login-exit*')).toBe('appie://login-exit?token=t');
    expect(started[0].callbackScheme).toBe('appie');
  });
});
