// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onSettingsArrived, settingChanged } from '@/lib/settingsBus';

const apiFetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
vi.mock('@/lib/api', () => ({ apiFetch: (path: string, init?: RequestInit) => apiFetch(path, init) }));
const session: { identity: { kind: string; sub?: string } | null; store: unknown } = { identity: null, store: null };
vi.mock('@/app/data', () => ({ useData: () => ({ store: session.store }) }));
vi.mock('@/app/session', () => ({ readSessionIdentity: () => session.identity }));

const { syncAccountSettings, useAccountSettingsSync, useSettingsArrivals } = await import('./accountSettings');

interface Entry {
  value: string | null;
  at: string;
}

/** the account as the API keeps it: a newer choice of a setting wins */
function account(held: Record<string, Entry> = {}) {
  const puts: Record<string, Entry>[] = [];
  apiFetch.mockImplementation(async (_path, init) => {
    if (init?.method === 'PUT') {
      const asked = (JSON.parse(String(init.body)) as { settings: Record<string, Entry> }).settings;
      puts.push(asked);
      for (const [key, entry] of Object.entries(asked)) {
        if (!held[key] || Date.parse(entry.at) > Date.parse(held[key].at)) held[key] = entry;
      }
    }
    return new Response(JSON.stringify({ settings: held }), { status: 200 });
  });
  return { held, puts };
}

function device() {
  const meta = new Map<string, unknown>();
  return {
    meta,
    metaGet: async (key: string) => (meta.has(key) ? { key, value: meta.get(key) } : undefined),
    metaPut: async (key: string, value: unknown) => {
      meta.set(key, value);
    },
  };
}

const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 27, 10, minute));
const clock = (minute: number) => () => at(minute);

describe('#700: settings follow the account', () => {
  beforeEach(() => {
    localStorage.clear();
    apiFetch.mockReset();
  });

  it('a first meeting takes what the account holds and offers what only this device chose', async () => {
    const { held, puts } = account({ theme: { value: 'dark', at: at(0).toISOString() } });
    localStorage.setItem('munni_lang', 'nl');
    const arrived = vi.fn();
    const off = onSettingsArrived(arrived);

    expect(await syncAccountSettings(device(), 'sam', clock(5))).toBe(true);
    off();

    expect(localStorage.getItem('munni_theme')).toBe('dark');
    expect(arrived).toHaveBeenCalledTimes(1);
    // a setting at its default is never offered: an untouched device must not reset the others
    expect(puts).toEqual([{ lang: { value: 'nl', at: at(5).toISOString() } }]);
    expect(held.lang.value).toBe('nl');
  });

  it('where both chose, the account wins the first meeting', async () => {
    const { puts } = account({ theme: { value: 'dark', at: at(0).toISOString() } });
    localStorage.setItem('munni_theme', 'light');

    await syncAccountSettings(device(), 'sam', clock(5));

    expect(localStorage.getItem('munni_theme')).toBe('dark');
    expect(puts).toEqual([]);
  });

  it('a change made here goes to the account with its moment; a later one from another device comes back', async () => {
    const { held, puts } = account();
    const store = device();
    await syncAccountSettings(store, 'sam', clock(0));
    expect(puts).toEqual([]);

    localStorage.setItem('munni_theme', 'dark');
    localStorage.setItem('munni_receipt_auto_read', 'yes');
    await syncAccountSettings(store, 'sam', clock(1));
    expect(puts).toEqual([{ theme: { value: 'dark', at: at(1).toISOString() }, receiptAutoRead: { value: 'yes', at: at(1).toISOString() } }]);

    // nothing changed: a look, nothing sent
    await syncAccountSettings(store, 'sam', clock(2));
    expect(puts).toHaveLength(1);

    held.theme = { value: 'light', at: at(3).toISOString() };
    const arrived = vi.fn();
    const off = onSettingsArrived(arrived);
    await syncAccountSettings(store, 'sam', clock(4));
    off();
    expect(localStorage.getItem('munni_theme')).toBe('light');
    expect(localStorage.getItem('munni_receipt_auto_read')).toBe('yes');
    expect(arrived).toHaveBeenCalledTimes(1);
    expect(puts).toHaveLength(1);
  });

  it('back to the default is a choice that travels too', async () => {
    const { held } = account();
    const store = device();
    localStorage.setItem('munni_week_start', 'sunday');
    await syncAccountSettings(store, 'sam', clock(0));
    expect(held.weekStart.value).toBe('sunday');

    localStorage.removeItem('munni_week_start');
    await syncAccountSettings(store, 'sam', clock(1));
    expect(held.weekStart).toEqual({ value: null, at: at(1).toISOString() });

    // on the other device the default arrives as a removal
    const other = device();
    localStorage.setItem('munni_week_start', 'sunday');
    await syncAccountSettings(other, 'sam-on-laptop', clock(2));
    expect(localStorage.getItem('munni_week_start')).toBeNull();
  });

  it('out of reach, the change waits and goes out with the moment it was made', async () => {
    const { puts } = account();
    const store = device();
    await syncAccountSettings(store, 'sam', clock(0));
    localStorage.setItem('munni_lang', 'tr');
    apiFetch.mockRejectedValueOnce(new Error('offline'));
    expect(await syncAccountSettings(store, 'sam', clock(1))).toBe(false);
    expect(puts).toEqual([]);

    account();
    apiFetch.mockImplementationOnce(async (_path, init) => {
      puts.push((JSON.parse(String(init?.body)) as { settings: Record<string, Entry> }).settings);
      return new Response(JSON.stringify({ settings: {} }), { status: 200 });
    });
    expect(await syncAccountSettings(store, 'sam', clock(9))).toBe(true);
    expect(puts).toEqual([{ lang: { value: 'tr', at: at(1).toISOString() } }]);
  });

  it('a choice the account lost goes out again, and an older one on the account never undoes a newer one here', async () => {
    const { held, puts } = account();
    const store = device();
    await syncAccountSettings(store, 'sam', clock(0));
    localStorage.setItem('munni_theme', 'dark');
    await syncAccountSettings(store, 'sam', clock(1));
    expect(puts).toHaveLength(1);

    // two devices saved in the same instant and this one's choice was dropped
    delete held.theme;
    await syncAccountSettings(store, 'sam', clock(2));
    await syncAccountSettings(store, 'sam', clock(3));
    expect(puts.at(-1)).toEqual({ theme: { value: 'dark', at: at(1).toISOString() } });
    expect(held.theme.value).toBe('dark');
    expect(localStorage.getItem('munni_theme')).toBe('dark');
  });

  it('the tips switch lives in the device meta and travels the same way', async () => {
    const { held } = account();
    const store = device();
    await syncAccountSettings(store, 'sam', clock(0));
    await store.metaPut('tipsDisabled', true);
    await syncAccountSettings(store, 'sam', clock(1));
    expect(held.tipsOff).toEqual({ value: '1', at: at(1).toISOString() });

    const other = device();
    await syncAccountSettings(other, 'sam-on-laptop', clock(2));
    expect(other.meta.get('tipsDisabled')).toBe(true);
  });

  it('signed in, the app meets the account at start and again soon after a change here; an offline profile asks nothing', async () => {
    const { held, puts } = account({ lang: { value: 'tr', at: at(0).toISOString() } });
    session.store = device();
    session.identity = { kind: 'offline' };
    const quiet = renderHook(() => useAccountSettingsSync());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(apiFetch).not.toHaveBeenCalled();
    quiet.unmount();

    session.identity = { kind: 'user', sub: 'sam' };
    const arrivals = renderHook(() => useSettingsArrivals());
    const mounted = renderHook(() => useAccountSettingsSync());
    await waitFor(() => expect(localStorage.getItem('munni_lang')).toBe('tr'));
    await waitFor(() => expect(arrivals.result.current).toBe(1));

    localStorage.setItem('munni_theme', 'dark');
    settingChanged();
    await waitFor(() => expect(held.theme?.value).toBe('dark'), { timeout: 3000 });
    expect(puts).toHaveLength(1);

    // back in front, it looks again
    const calls = apiFetch.mock.calls.length;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(apiFetch.mock.calls.length).toBeGreaterThan(calls));
    mounted.unmount();
    arrivals.unmount();
    session.identity = null;
  });

  it('each account keeps its own bookkeeping on a shared device', async () => {
    account({ theme: { value: 'dark', at: at(0).toISOString() } });
    await syncAccountSettings(device(), 'sam', clock(1));
    expect(localStorage.getItem('munni_theme')).toBe('dark');

    // another person signs in on it: their account has no choice, so the device's is offered to it
    const { puts } = account();
    await syncAccountSettings(device(), 'kim', clock(2));
    expect(puts).toEqual([{ theme: { value: 'dark', at: at(2).toISOString() } }]);
  });
});
