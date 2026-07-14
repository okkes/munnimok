// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deepLinkToPath, ensurePersistentStorage, getNativePushToken, isNativeApp } from './platform';

type CapacitorStub = {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
};

const setCapacitor = (stub: CapacitorStub | undefined) => {
  (globalThis as { Capacitor?: CapacitorStub }).Capacitor = stub;
};

afterEach(() => setCapacitor(undefined));

describe('platform seam', () => {
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
    expect(deepLinkToPath('munni://')).toBe('/');
    expect(deepLinkToPath('https://evil.example/gc-callback')).toBeNull();
    expect(deepLinkToPath('intent://foo')).toBeNull();
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
