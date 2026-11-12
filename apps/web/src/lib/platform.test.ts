// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_CALLBACK_KEY, deepLinkToPath, ensurePersistentStorage, getNativePushToken, initDeepLinks, isNativeApp } from './platform';

type CapacitorStub = {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
};

const setCapacitor = (stub: CapacitorStub | undefined) => {
  (globalThis as { Capacitor?: CapacitorStub }).Capacitor = stub;
};

afterEach(() => setCapacitor(undefined));

describe('platform seam', () => {
  // universal-link host checks derive from publicOrigin now (the real
  // domain is a secret) — pin it for the fixtures
  beforeEach(() => vi.stubEnv('VITE_PUBLIC_ORIGIN', 'https://munni.munni.example'));
  afterEach(() => vi.unstubAllEnvs());

  it('detects the shell only through the injected global', () => {
    expect(isNativeApp()).toBe(false);
    setCapacitor({ isNativePlatform: () => true });
    expect(isNativeApp()).toBe(true);
    setCapacitor({ isNativePlatform: () => false }); // capacitor serve (web)
    expect(isNativeApp()).toBe(false);
  });

  it('maps munni:// urls onto app paths and rejects foreign urls', () => {
    expect(deepLinkToPath('munni://gc-callback?ref=r-1&code=c-1')).toBe('/gc-callback?ref=r-1&code=c-1');
    expect(deepLinkToPath('munni://auth-callback?code=x')).toBe('/auth-callback?code=x');
    expect(deepLinkToPath('munni-dev://auth-callback?code=x')).toBe('/auth-callback?code=x'); // staging app scheme
    // the platform model's scheme carries two dashes (munni-<env>-<platform>): the hosted /native-auth bounce and the
    // bank's return both arrive on it
    expect(deepLinkToPath('munni-prod-nas://native-auth?code=x&state=s')).toBe('/native-auth?code=x&state=s');
    expect(deepLinkToPath('munni-dev-lcl://gc-callback?ref=r-1')).toBe('/gc-callback?ref=r-1');
    expect(deepLinkToPath('munni://')).toBe('/');
    expect(deepLinkToPath('https://evil.example/gc-callback')).toBeNull();
    expect(deepLinkToPath('intent://foo')).toBeNull();
  });

  it('universal links map allowed https paths and refuse everything else (UL2)', () => {
    expect(deepLinkToPath('https://munni.munni.example/gc-callback?ref=r-1')).toBe('/gc-callback?ref=r-1');
    expect(deepLinkToPath('https://munni-test.munni.example/splits/join/tok-1')).toBe('/splits/join/tok-1');
    // outside the allowlist: never routed into the shell
    expect(deepLinkToPath('https://munni.munni.example/auth-callback?code=x')).toBeNull();
    expect(deepLinkToPath('https://munni.munni.example/')).toBeNull();
    expect(deepLinkToPath('https://evil.example/splits/join/tok-1')).toBeNull();
  });

  it('an auth deep link stashes the RAW munni:// url for the code exchange', () => {
    sessionStorage.clear();
    const listeners: Record<string, (data: never) => void> = {};
    const assign = vi.fn();
    Object.defineProperty(globalThis, 'location', { value: { assign }, configurable: true });
    const cancel = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    setCapacitor({
      isNativePlatform: () => true,
      Plugins: {
        App: { addListener: (event: string, cb: (data: never) => void) => (listeners[event] = cb) },
        AuthSession: { cancel },
        Browser: { close },
      },
    });
    initDeepLinks();

    listeners.appUrlOpen({ url: 'munni://auth-callback?code=abc&state=xyz' } as never);
    // the localhost translation drives the webview…
    expect(assign).toHaveBeenCalledWith('/auth-callback?code=abc&state=xyz');
    // …but the original url is kept so the SDK sees the real redirect_uri
    expect(sessionStorage.getItem(NATIVE_CALLBACK_KEY)).toBe('munni://auth-callback?code=abc&state=xyz');

    // an auth callback leaves the session alone: it ended itself on the scheme
    expect(cancel).not.toHaveBeenCalled();

    // a bank callback navigates but never stashes — and closes the sheet the
    // consent was opened in, which the bank's app left behind on a page that
    // will not finish (user ss 2026-10-03)
    listeners.appUrlOpen({ url: 'munni://gc-callback?ref=r1' } as never);
    expect(assign).toHaveBeenLastCalledWith('/gc-callback?ref=r1');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    // §5 shortcuts: any other target is a hash route, not a real path
    listeners.appUrlOpen({ url: 'munni://review' } as never);
    expect(assign).toHaveBeenLastCalledWith('/#/review');
  });

  it('asks the browser to persist storage on web, never on native', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, 'storage', { value: { persist }, configurable: true });
    await ensurePersistentStorage();
    expect(persist).toHaveBeenCalledTimes(1);

    setCapacitor({ isNativePlatform: () => true });
    await ensurePersistentStorage();
    expect(persist).toHaveBeenCalledTimes(1); // native: untouched
  });

  it('resolves the native push token through the plugin events', async () => {
    const listeners = new Map<string, (data: unknown) => void>();
    setCapacitor({
      isNativePlatform: () => true,
      Plugins: {
        PushNotifications: {
          requestPermissions: () => Promise.resolve({ receive: 'granted' }),
          register: () => {
            queueMicrotask(() => listeners.get('registration')?.({ value: 'fcm-tok-1' }));
            return Promise.resolve();
          },
          addListener: (event: string, cb: (data: unknown) => void) => listeners.set(event, cb),
        },
      },
    });
    await expect(getNativePushToken()).resolves.toBe('fcm-tok-1');
  });

  it('yields null without the shell or without permission', async () => {
    await expect(getNativePushToken()).resolves.toBeNull();
    setCapacitor({
      isNativePlatform: () => true,
      Plugins: {
        PushNotifications: {
          requestPermissions: () => Promise.resolve({ receive: 'denied' }),
          register: () => Promise.resolve(),
          addListener: () => undefined,
        },
      },
    });
    await expect(getNativePushToken()).resolves.toBeNull();
  });
});

describe('isIOS (#134)', () => {
  const setNav = (platform: string, maxTouchPoints = 0, uaDataPlatform?: string) => {
    Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
    Object.defineProperty(navigator, 'userAgentData', {
      value: uaDataPlatform === undefined ? undefined : { platform: uaDataPlatform },
      configurable: true,
    });
  };

  it('spots iPhone/iPad platforms and iPadOS-as-Mac, nothing else', async () => {
    const { isIOS } = await import('./platform');
    setNav('iPhone');
    expect(isIOS()).toBe(true);
    setNav('iPad');
    expect(isIOS()).toBe(true);
    setNav('MacIntel', 5); // iPadOS masquerading as macOS
    expect(isIOS()).toBe(true);
    setNav('MacIntel', 0); // real macOS
    expect(isIOS()).toBe(false);
    setNav('Win32');
    expect(isIOS()).toBe(false);
    setNav('Linux armv81', 5, 'Android'); // userAgentData wins where present
    expect(isIOS()).toBe(false);
  });
});

describe('§5 niceties seam', () => {
  it('haptics + share are strict no-ops on the web', async () => {
    setCapacitor(undefined);
    const { hapticNotify, shareNativeFile } = await import('./platform');
    expect(() => hapticNotify('SUCCESS')).not.toThrow();
    expect(await shareNativeFile('x.csv', 'a;b')).toBe('unavailable');
  });

  it('native share writes to the cache and opens the OS sheet', async () => {
    const writeFile = vi.fn().mockResolvedValue({ uri: 'file:///cache/x.csv' });
    const share = vi.fn().mockResolvedValue({});
    setCapacitor({
      isNativePlatform: () => true,
      Plugins: { Filesystem: { writeFile }, Share: { share } },
    });
    const { shareNativeFile } = await import('./platform');
    expect(await shareNativeFile('x.csv', 'a;b')).toBe('shared');
    expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'x.csv', directory: 'CACHE' }));
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ files: ['file:///cache/x.csv'] }));

    // a closed sheet is not a saved file, and not a reason to try a download the shell cannot do
    share.mockRejectedValue(new Error('Share canceled'));
    expect(await shareNativeFile('x.csv', 'a;b')).toBe('dismissed');

    writeFile.mockRejectedValue(new Error('no space left'));
    expect(await shareNativeFile('x.csv', 'a;b')).toBe('failed');
  });

  it('notification taps hand the PARSED payload to the bridge', async () => {
    const listeners: Record<string, (data: never) => void> = {};
    setCapacitor({
      isNativePlatform: () => true,
      Plugins: {
        PushNotifications: { addListener: (event: string, cb: (data: never) => void) => (listeners[event] = cb) },
      },
    });
    const { onNativePushTap } = await import('./platform');
    const seen: unknown[] = [];
    onNativePushTap((payload) => seen.push(payload));

    listeners.pushNotificationActionPerformed({
      notification: { data: { payload: '{"type":"new-transactions","count":3}' } },
    } as never);
    expect(seen).toEqual([{ type: 'new-transactions', count: 3 }]);

    listeners.pushNotificationActionPerformed({ notification: { data: { payload: 'not-json' } } } as never);
    expect(seen).toHaveLength(1); // malformed payloads are ignored
  });

  it('the shell names its own store id through App.getInfo and fails soft', async () => {
    const { getNativeAppId, nativePlatform } = await import('./platform');
    expect(await getNativeAppId()).toBeNull(); // web: no shell
    expect(nativePlatform()).toBeUndefined();

    setCapacitor({
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: { App: { getInfo: () => Promise.resolve({ id: 'app.munni.nas.prod', build: '26940909' }) } },
    } as never);
    expect(await getNativeAppId()).toBe('app.munni.nas.prod');
    expect(nativePlatform()).toBe('ios');

    setCapacitor({
      isNativePlatform: () => true,
      Plugins: { App: { getInfo: () => Promise.resolve({}) } },
    });
    expect(await getNativeAppId()).toBeNull();

    setCapacitor({
      isNativePlatform: () => true,
      Plugins: { App: { getInfo: () => Promise.reject(new Error('boom')) } },
    });
    expect(await getNativeAppId()).toBeNull();
  });

  it('a bundle built outside the pipeline carries no commit count — the update check then has nothing to compare', async () => {
    const { bundledWebBuild } = await import('./platform');
    const { updateAvailable } = await import('@/domain/updateCheck');
    expect(updateAvailable(bundledWebBuild(), 1880)).toBe(false);
  });

  it('native photo capture returns a File and degrades to null', async () => {
    const { takeNativePhoto } = await import('./platform');
    expect(await takeNativePhoto()).toBeNull(); // web: input capture path

    setCapacitor({
      isNativePlatform: () => true,
      Plugins: {
        Camera: { getPhoto: () => Promise.resolve({ base64String: btoa('img-bytes'), format: 'png' }) },
      },
    });
    const file = await takeNativePhoto();
    expect(file?.name).toBe('receipt.png');
    expect(file?.type).toBe('image/png');

    setCapacitor({
      isNativePlatform: () => true,
      Plugins: { Camera: { getPhoto: () => Promise.reject(new Error('cancelled')) } },
    });
    expect(await takeNativePhoto()).toBeNull();

    setCapacitor({
      isNativePlatform: () => true,
      Plugins: { Camera: { getPhoto: () => Promise.resolve({}) } },
    });
    expect(await takeNativePhoto()).toBeNull(); // no bytes returned
  });

  it('the camera door asks the plugin for the camera; the library door of a receipt for the photos (#166, #496)', async () => {
    const { takeNativePhoto } = await import('./platform');
    const getPhoto = vi.fn(() => Promise.resolve({ base64String: btoa('img-bytes'), format: 'jpeg' }));
    setCapacitor({ isNativePlatform: () => true, Plugins: { Camera: { getPhoto } } });
    const file = await takeNativePhoto();
    expect(file?.type).toBe('image/jpeg');
    expect(getPhoto).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'CAMERA' }));
    await takeNativePhoto('PHOTOS');
    expect(getPhoto).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'PHOTOS' }));
  });

  it('biometric availability reflects the plugin and fails closed', async () => {
    const { nativeBiometricAvailable } = await import('./platform');
    expect(await nativeBiometricAvailable()).toBe(false); // web

    setCapacitor({
      isNativePlatform: () => true,
      Plugins: { NativeBiometric: { isAvailable: () => Promise.resolve({ isAvailable: true }) } },
    });
    expect(await nativeBiometricAvailable()).toBe(true);

    setCapacitor({
      isNativePlatform: () => true,
      Plugins: { NativeBiometric: { isAvailable: () => Promise.reject(new Error('no hw')) } },
    });
    expect(await nativeBiometricAvailable()).toBe(false);
  });

  it('#506: a web search for a title opens in a new tab on the web and in the in-app browser on the shells', async () => {
    const { openExternal, webSearchUrl } = await import('./platform');
    const url = webSearchUrl('  PM *Z2U HongKong ');
    expect(url).toBe('https://www.google.com/search?q=PM%20*Z2U%20HongKong');
    const open = vi.fn();
    vi.stubGlobal('open', open);
    openExternal(url);
    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener');

    const browserOpen = vi.fn(() => Promise.resolve());
    setCapacitor({ isNativePlatform: () => true, Plugins: { Browser: { open: browserOpen } } });
    openExternal(url);
    expect(browserOpen).toHaveBeenCalledWith({ url });
    expect(open).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
