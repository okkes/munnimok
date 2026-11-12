// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { UpdateCard } from './UpdateCard';

// the commit count of the web bundle inside the shell is a build-time constant — the test stands in for it
const shell = vi.hoisted(() => ({ bundle: 1873 }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  bundledWebBuild: () => shell.bundle,
}));

const checked = () => JSON.parse(localStorage.getItem('munni_update_check') ?? '{}') as { lastCheckedAt?: number; dismissedBuild?: number };

/** a store build of the shell: the store numbers the binary by the clock, and every environment has its own app id */
const insideShell = (platform: 'android' | 'ios') => {
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    Plugins: { App: { getInfo: () => Promise.resolve({ id: 'app.munni.nas.prod', build: '26938498', version: '5.20.0' }) } },
  };
};

const hosted = (build: number, version: string) => {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ build, version })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const mount = () =>
  render(
    <LangProvider>
      <UpdateCard />
    </LangProvider>,
  );

describe('UpdateCard — the shell says when the store holds a newer release', () => {
  beforeEach(() => {
    localStorage.clear();
    shell.bundle = 1873;
  });
  afterEach(() => {
    cleanup();
    (globalThis as { Capacitor?: unknown }).Capacitor = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('appears when the hosted web is newer than the bundle in the shell — whatever number the store gave the binary — and opens the shell’s own store page', async () => {
    insideShell('android');
    const fetchMock = hosted(1880, '5.21.0');
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mount();

    expect((await screen.findByTestId('update-card')).textContent).toContain('munni 5.21.0 is ready in the store');
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/version\.json$/);
    fireEvent.click(screen.getByTestId('update-open-store'));
    expect(open).toHaveBeenCalledWith('market://details?id=app.munni.nas.prod', '_blank');

    fireEvent.click(screen.getByTestId('update-dismiss'));
    expect(screen.queryByTestId('update-card')).toBeNull();
    expect(checked().dismissedBuild).toBe(1880);
  });

  it('stays away while the hosted web is the bundle’s own build; on iOS a newer one links TestFlight', async () => {
    insideShell('ios');
    hosted(1873, '5.20.0');
    mount();
    await waitFor(() => expect(checked().lastCheckedAt).toBeGreaterThan(0));
    expect(screen.queryByTestId('update-card')).toBeNull();
    cleanup();

    localStorage.clear();
    hosted(1874, '5.20.1');
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mount();
    fireEvent.click(await screen.findByTestId('update-open-store'));
    expect(open).toHaveBeenCalledWith('itms-beta://', '_blank');
  });

  it('never asks on the web — a new build announces itself through the service worker there', () => {
    const fetchMock = hosted(9999, '9.9.9');
    mount();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('update-card')).toBeNull();
  });
});
