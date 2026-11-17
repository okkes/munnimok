// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '@/app/session';
import type { NativeExits } from './platform';

const reported = vi.hoisted(() => ({ calls: [] as { scope: string; message: string; extra: Record<string, unknown> }[] }));
vi.mock('./report', () => ({
  reportErrorWith: (scope: string, err: Error, extra: Record<string, unknown>) => reported.calls.push({ scope, message: err.message, extra }),
}));

import { reportNativeExits, watchNativeExits } from './nativeExit';

type Global = { Capacitor?: unknown };

function androidShell(answer: NativeExits | (() => Promise<NativeExits>)) {
  const recent = vi.fn(typeof answer === 'function' ? answer : async () => answer);
  (globalThis as Global).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { ExitReasons: { recent } } };
  return recent;
}

const MIB = 1024;

describe('what ended the Android app last time (#594)', () => {
  beforeEach(() => {
    reported.calls.length = 0;
    localStorage.clear();
    useSession.setState({ identity: null });
  });
  afterEach(() => {
    delete (globalThis as Global).Capacitor;
  });

  it('reports a crash and a kill while the app was on screen, with what Android knew about it', async () => {
    androidShell({
      exits: [
        { at: 3000, reason: 4, description: 'crash', importance: 100, rssKb: 412 * MIB, pssKb: 380 * MIB, process: 'app.munni.nas.prod' },
        { at: 2000, reason: 3, importance: 100, rssKb: 900 * MIB, process: 'app.munni.nas.prod' },
      ],
    });

    expect(await reportNativeExits()).toBe(2);

    expect(reported.calls.map((c) => c.message)).toEqual(['Android ended the app: crash: crash', 'Android ended the app: low memory']);
    expect(reported.calls[0]).toMatchObject({ scope: 'android-exit', extra: { residentMb: 412, proportionalMb: 380, process: 'app.munni.nas.prod', importance: 100 } });
  });

  it('says nothing about what somebody chose, or about a resting app Android cleared away', async () => {
    androidShell({
      exits: [
        { at: 5000, reason: 10, importance: 100 }, // swiped away
        { at: 4000, reason: 11, importance: 100 }, // stopped in the settings
        { at: 3000, reason: 3, importance: 400 }, // low memory, while cached
        { at: 2000, reason: 2, importance: 400 }, // killed, while cached
        { at: 1000, reason: 16, importance: 100 }, // updated
      ],
    });

    expect(await reportNativeExits()).toBe(0);
    expect(reported.calls).toEqual([]);
  });

  it('reports each exit once: the next start tells only what happened since', async () => {
    androidShell({ exits: [{ at: 3000, reason: 5, description: 'SIGSEGV', importance: 100 }] });
    expect(await reportNativeExits()).toBe(1);

    androidShell({ exits: [{ at: 4000, reason: 6, description: 'Input dispatching timed out', importance: 100 }, { at: 3000, reason: 5, description: 'SIGSEGV', importance: 100 }] });
    expect(await reportNativeExits()).toBe(1);

    expect(reported.calls.map((c) => c.message)).toEqual(['Android ended the app: native crash: SIGSEGV', 'Android ended the app: not responding: Input dispatching timed out']);
  });

  it('carries the stack trace the shell noted, and the web view process that died', async () => {
    androidShell({
      exits: [],
      javaCrash: '1763300000000\nmain\njava.lang.OutOfMemoryError: Failed to allocate a 67108880 byte allocation\n\tat org.json.JSONObject.toString(JSONObject.java:1)\n\tat a.b.c(Unknown Source)',
      renderer: '1763300001000\nkilled\n2',
    });

    expect(await reportNativeExits()).toBe(2);

    expect(reported.calls[0].message).toBe('Android crash: java.lang.OutOfMemoryError: Failed to allocate a 67108880 byte allocation');
    expect(reported.calls[0].extra).toMatchObject({ thread: 'main' });
    expect(String(reported.calls[0].extra.trace)).toContain('org.json.JSONObject.toString');
    expect(reported.calls[1].message).toBe('Android ended the app: its web view process killed');
  });

  it('is silent anywhere else: a browser, an iPhone, an Android shell from before it could say, a plugin that fails', async () => {
    expect(await reportNativeExits()).toBe(0);

    (globalThis as Global).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { ExitReasons: { recent: async () => ({ exits: [{ at: 1, reason: 4 }] }) } } };
    expect(await reportNativeExits()).toBe(0);

    (globalThis as Global).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} };
    expect(await reportNativeExits()).toBe(0);

    androidShell(async () => {
      throw new Error('not implemented');
    });
    expect(await reportNativeExits()).toBe(0);
    expect(reported.calls).toEqual([]);
  });

  it('waits for a signed-in identity: nothing is asked or sent for nobody, or for an identity that chose to stay offline', async () => {
    const recent = androidShell({ exits: [{ at: 3000, reason: 4, importance: 100 }] });

    watchNativeExits();
    expect(recent).not.toHaveBeenCalled();
    useSession.getState().login({ kind: 'demo' });
    expect(recent).not.toHaveBeenCalled();

    useSession.getState().login({ kind: 'user', sub: 'u1', testAuth: true });
    await vi.waitFor(() => expect(reported.calls).toHaveLength(1));
    useSession.getState().login({ kind: 'user', sub: 'u1', testAuth: true });
    expect(recent).toHaveBeenCalledTimes(1);
  });
});
