// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api';
import { disablePush, enablePush, getPushSubscription, pushSupported, refreshPushRegistration, refreshPushRegistrationOnce } from './push';

vi.mock('./api', () => ({ apiFetch: vi.fn() }));
const apiFetchMock = vi.mocked(apiFetch);

interface FakeSubscription {
  endpoint: string;
  toJSON: () => { keys?: { p256dh?: string; auth?: string } };
  unsubscribe: () => Promise<boolean>;
}

/** installs the push-capable browser surface happy-dom lacks */
function installPushEnv(existing: FakeSubscription | null) {
  const subscription: FakeSubscription = existing ?? {
    endpoint: 'https://push.example/abc',
    toJSON: () => ({ keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(existing),
    subscribe: vi.fn().mockResolvedValue(subscription),
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager }) },
  });
  Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: { requestPermission: vi.fn().mockResolvedValue('granted') },
  });
  return { subscription, pushManager };
}

afterEach(() => {
  apiFetchMock.mockReset();
});

describe('push subscription management', () => {
  it('pushSupported is false on a bare environment', () => {
    expect(pushSupported()).toBe(false);
  });

  it('enablePush asks permission, subscribes and registers with the API', async () => {
    const { pushManager } = installPushEnv(null);
    apiFetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    expect(await enablePush('BPtestkey-_123')).toBe('registered');
    expect(pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.anything() }),
    );
    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/me/push-subscriptions');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      endpoint: 'https://push.example/abc',
      p256dh: 'p',
      auth: 'a',
      lang: 'en', // the server localizes native/visible text per device
    });
  });

  it('enablePush answers no-permission when the browser refuses or the prompt is closed — nothing subscribes', async () => {
    const { pushManager } = installPushEnv(null);
    (window.Notification.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue('denied');
    expect(await enablePush('key')).toBe('no-permission');
    (window.Notification.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue('default');
    expect(await enablePush('key')).toBe('no-permission');
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('enablePush answers failed — never throws — when the server or the push service does not take it', async () => {
    const { pushManager } = installPushEnv(null);
    apiFetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await enablePush('BPtestkey-_123')).toBe('failed');
    apiFetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    expect(await enablePush('BPtestkey-_123')).toBe('failed');
    pushManager.subscribe.mockRejectedValueOnce(new Error('Registration failed - push service error'));
    expect(await enablePush('BPtestkey-_123')).toBe('failed');
  });

  it('the phone: a refused permission is no-permission, a token that never comes is failed, a filed token is registered', async () => {
    const listeners = new Map<string, (data: unknown) => void>();
    let receive = 'denied';
    let answer: 'registration' | 'registrationError' = 'registrationError';
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        PushNotifications: {
          requestPermissions: () => Promise.resolve({ receive }),
          register: () => {
            queueMicrotask(() => listeners.get(answer)?.({ value: 'tok-1' }));
            return Promise.resolve();
          },
          addListener: (event: string, cb: (data: unknown) => void) => listeners.set(event, cb),
        },
      },
    };
    apiFetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      expect(await enablePush('key')).toBe('no-permission');
      expect(apiFetchMock).not.toHaveBeenCalled();

      receive = 'granted';
      expect(await enablePush('key')).toBe('failed');
      expect(localStorage.getItem('munni_fcm_token')).toBeNull();

      answer = 'registration';
      expect(await enablePush('key')).toBe('registered');
      expect(localStorage.getItem('munni_fcm_token')).toBe('tok-1');
    } finally {
      delete (globalThis as { Capacitor?: unknown }).Capacitor;
      localStorage.removeItem('munni_fcm_token');
    }
  });

  it('disablePush removes the server row and unsubscribes the browser', async () => {
    const existing: FakeSubscription = {
      endpoint: 'https://push.example/old',
      toJSON: () => ({}),
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    installPushEnv(existing);
    apiFetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    expect(await getPushSubscription()).toBe(existing);
    await disablePush();
    expect(apiFetchMock).toHaveBeenCalledWith(
      `/me/push-subscriptions?endpoint=${encodeURIComponent('https://push.example/old')}`,
      { method: 'DELETE' },
    );
    expect(existing.unsubscribe).toHaveBeenCalled();
  });

  it('disablePush is a no-op without a subscription', async () => {
    installPushEnv(null);
    await disablePush();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  const held = (): FakeSubscription => ({
    endpoint: 'https://push.example/held',
    toJSON: () => ({}),
    unsubscribe: vi.fn().mockResolvedValue(true),
  });

  it('disablePush lets the browser go at once — a server that never answers does not hold it', async () => {
    const existing = held();
    installPushEnv(existing);
    apiFetchMock.mockReturnValue(new Promise<Response>(() => undefined));
    void disablePush();
    await vi.waitFor(() => expect(existing.unsubscribe).toHaveBeenCalled());
  });

  it('disablePush without the server — a device it refuses, an account it erased — only lets the device go', async () => {
    const existing = held();
    installPushEnv(existing);
    apiFetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await disablePush({ server: false });
    expect(existing.unsubscribe).toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('the phone unregisters its token itself — also when the server cannot be told', async () => {
    localStorage.setItem('munni_fcm_token', 'tok-1');
    const unregister = vi.fn().mockResolvedValue(undefined);
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { PushNotifications: { unregister } },
    };
    apiFetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    try {
      await disablePush();
      expect(apiFetchMock).toHaveBeenCalledWith('/me/push-subscriptions?endpoint=tok-1', { method: 'DELETE' });
      expect(unregister).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('munni_fcm_token')).toBeNull();
    } finally {
      delete (globalThis as { Capacitor?: unknown }).Capacitor;
      localStorage.removeItem('munni_fcm_token');
    }
  });
});

describe('refreshPushRegistration (the server hears again about a device it should know)', () => {
  const kept = (): FakeSubscription => ({
    endpoint: 'https://push.example/kept',
    toJSON: () => ({ keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  });

  it('sends the browser’s existing subscription again, without asking for permission — and nothing where there is none', async () => {
    installPushEnv(kept());
    apiFetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    expect(await refreshPushRegistration()).toBe(true);
    const [path, init] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/me/push-subscriptions');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(init!.body as string)).toMatchObject({ endpoint: 'https://push.example/kept', p256dh: 'p', auth: 'a', lang: 'en' });
    expect(window.Notification.requestPermission).not.toHaveBeenCalled();

    installPushEnv(null);
    apiFetchMock.mockClear();
    expect(await refreshPushRegistration()).toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('a server out of reach or refusing answers false', async () => {
    installPushEnv(kept());
    apiFetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await refreshPushRegistration()).toBe(false);
    apiFetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    expect(await refreshPushRegistration()).toBe(false);
  });

  it('the phone files the token the plugin holds now — a rotated one replaces the remembered one', async () => {
    localStorage.setItem('munni_fcm_token', 'tok-old');
    const listeners = new Map<string, (data: unknown) => void>();
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        PushNotifications: {
          requestPermissions: () => Promise.resolve({ receive: 'granted' }),
          register: () => {
            queueMicrotask(() => listeners.get('registration')?.({ value: 'tok-new' }));
            return Promise.resolve();
          },
          addListener: (event: string, cb: (data: unknown) => void) => listeners.set(event, cb),
        },
      },
    };
    apiFetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      expect(await refreshPushRegistration()).toBe(true);
      expect(JSON.parse(apiFetchMock.mock.calls[0][1]!.body as string)).toMatchObject({ kind: 'fcm', endpoint: 'tok-new', lang: 'en' });
      expect(localStorage.getItem('munni_fcm_token')).toBe('tok-new');

      // a phone that never switched notifications on has nothing to send
      localStorage.removeItem('munni_fcm_token');
      apiFetchMock.mockClear();
      expect(await refreshPushRegistration()).toBe(false);
      expect(apiFetchMock).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as { Capacitor?: unknown }).Capacitor;
      localStorage.removeItem('munni_fcm_token');
    }
  });

  it('once per session: asked again it sends nothing more — a new session, or one whose attempt failed, sends again', async () => {
    installPushEnv(kept());
    apiFetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const session = {};
    await refreshPushRegistrationOnce(session);
    await refreshPushRegistrationOnce(session);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    await refreshPushRegistrationOnce({});
    expect(apiFetchMock).toHaveBeenCalledTimes(2);

    const offline = {};
    apiFetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await refreshPushRegistrationOnce(offline);
    await refreshPushRegistrationOnce(offline);
    expect(apiFetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('pushEnabled (settings toggle source of truth)', () => {
  it('native: reads the stored FCM token, not the web subscription', async () => {
    localStorage.setItem('munni_fcm_token', 'tok-1');
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    try {
      const { pushEnabled } = await import('./push');
      expect(await pushEnabled()).toBe(true); // survives app kills — no SW involved
      localStorage.removeItem('munni_fcm_token');
      expect(await pushEnabled()).toBe(false);
    } finally {
      delete (globalThis as { Capacitor?: unknown }).Capacitor;
    }
  });
});
