// @vitest-environment happy-dom
import { Suspense } from 'react';
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

const pwa = vi.hoisted(() => ({ needRefresh: false, update: vi.fn() }));
const report = vi.hoisted(() => ({ reportWarning: vi.fn() }));
vi.mock('./pwa', () => ({ usePwa: { getState: () => pwa } }));
vi.mock('@/lib/report', () => report);

let show: (ui: ReactNode) => void = () => undefined;
/** a fresh module per test (the once-per-page reload flag starts clear), with the language provider of the same graph */
const fresh = async () => {
  vi.resetModules();
  const [lazy, { LangProvider }] = await Promise.all([import('./lazyScreen'), import('@/i18n')]);
  show = (ui) => render(<LangProvider>{ui}</LangProvider>);
  return lazy;
};

const helloChunk = { Hello: ({ who }: Readonly<{ who: string }>) => <p data-testid="hello">hello {who}</p> };
const goneAs = <M,>(): Promise<M> =>
  Promise.reject(new TypeError('Failed to fetch dynamically imported module: https://munni.test/assets/Hello-abc.js'));
const gone = goneAs<typeof helloChunk>;

describe('lazyScreen (#554: a screen in a chunk of its own)', () => {
  let reload: Mock<() => void>;

  beforeEach(() => {
    localStorage.setItem('munni_lang', 'en');
    sessionStorage.clear();
    pwa.needRefresh = false;
    pwa.update.mockClear();
    report.reportWarning.mockClear();
    reload = vi.fn<() => void>();
    vi.spyOn(window.location, 'reload').mockImplementation(reload);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads on the first visit, renders with its props, and leaves the router nothing to wait for afterwards', async () => {
    const { lazyScreen } = await fresh();
    const Hello = lazyScreen(() => Promise.resolve(helloChunk), 'Hello');
    expect(Hello.preload).toBeTypeOf('function');
    await Hello.preload?.();
    expect(Hello.preload).toBeUndefined();
    show(<Hello who="Ada" />);
    expect(screen.getByTestId('hello').textContent).toBe('hello Ada');
  });

  it('rendered inside a layout before it loaded, it suspends until the chunk is there', async () => {
    const { lazyScreen } = await fresh();
    let arrive: (value: typeof helloChunk) => void = () => undefined;
    const Hello = lazyScreen(() => new Promise<typeof helloChunk>((resolve) => (arrive = resolve)), 'Hello');
    // React drops the retry of a render that suspended inside an act it was not awaited for
    await act(async () =>
      show(
        <Suspense fallback={<p data-testid="waiting" />}>
          <Hello who="Ada" />
        </Suspense>,
      ),
    );
    expect(screen.getByTestId('waiting')).toBeTruthy();
    await act(async () => arrive(helloChunk));
    expect((await screen.findByTestId('hello')).textContent).toBe('hello Ada');
  });

  it('a layout route waits for every screen it renders, then has nothing left to load', async () => {
    const { lazyScreen, withScreens } = await fresh();
    const Hello = lazyScreen(() => Promise.resolve(helloChunk), 'Hello');
    const Layout = withScreens(() => <Hello who="list" />, Hello);
    await Layout.preload?.();
    expect(Layout.preload).toBeUndefined();
    show(<Layout />);
    expect(screen.getByTestId('hello').textContent).toBe('hello list');
  });

  it('a chunk that is gone takes the waiting service worker (the update toast’s path) instead of a blank screen', async () => {
    const { lazyScreen } = await fresh();
    pwa.needRefresh = true;
    const Hello = lazyScreen(gone, 'Hello');
    await Hello.preload?.();
    show(<Hello who="Ada" />);
    expect(await screen.findByTestId('screen-pending')).toBeTruthy();
    expect(pwa.update).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('with no worker waiting it reloads once — a second gone screen waits for that reload', async () => {
    const { lazyScreen } = await fresh();
    const Hello = lazyScreen(gone, 'Hello');
    const Other = lazyScreen(gone, 'Hello');
    await Promise.all([Hello.preload?.(), Other.preload?.()]);
    show(
      <>
        <Hello who="Ada" />
        <Other who="Bob" />
      </>,
    );
    expect(await screen.findAllByTestId('screen-pending')).toHaveLength(2);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('screen-load-failed')).toBeNull();
  });

  it('failing again right after such a reload, it stops looping and offers the reload itself', async () => {
    const { lazyScreen } = await fresh();
    sessionStorage.setItem('munni_chunk_reload', String(Date.now() - 5_000));
    const Hello = lazyScreen(gone, 'Hello');
    await Hello.preload?.();
    show(<Hello who="Ada" />);
    const failed = await screen.findByTestId('screen-load-failed');
    expect(failed.textContent).toContain('This screen could not be loaded');
    expect(reload).not.toHaveBeenCalled();
    expect(report.reportWarning).toHaveBeenCalledWith('chunk', 'a screen failed to load', expect.objectContaining({ error: expect.stringContaining('Hello-abc.js') }));
    fireEvent.click(screen.getByTestId('screen-load-failed-reload'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('offline, it never reloads into an error page: the screen says so, and nothing is reported', async () => {
    const { lazyScreen } = await fresh();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const Hello = lazyScreen(gone, 'Hello');
    await Hello.preload?.();
    show(<Hello who="Ada" />);
    expect(await screen.findByTestId('screen-load-failed')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    expect(report.reportWarning).not.toHaveBeenCalled();
  });

  it('without storage to guard the loop it never reloads by itself — the screen offers it', async () => {
    const { lazyScreen } = await fresh();
    const denied = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.stubGlobal('sessionStorage', { getItem: denied, setItem: denied });
    const Hello = lazyScreen(gone, 'Hello');
    await Hello.preload?.();
    show(<Hello who="Ada" />);
    expect(await screen.findByTestId('screen-load-failed')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it('through the router: a screen whose chunk is gone keeps the shell on screen while it reloads into the current build', async () => {
    const { ScreenPending, lazyScreen } = await fresh();
    const Gone = lazyScreen(goneAs<{ Away: () => ReactNode }>, 'Away');
    const root = createRootRoute({
      component: () => (
        <>
          <nav data-testid="shell" />
          <Outlet />
        </>
      ),
    });
    const home = createRoute({ getParentRoute: () => root, path: '/', component: () => <p data-testid="home" /> });
    const away = createRoute({ getParentRoute: () => root, path: '/away', component: Gone });
    const history = createMemoryHistory({ initialEntries: ['/'] });
    const router = createRouter({ routeTree: root.addChildren([home, away]), history, defaultPendingComponent: ScreenPending });
    await act(async () => show(<RouterProvider router={router} />));
    await screen.findByTestId('home');
    await act(async () => history.push('/away'));
    expect(await screen.findByTestId('screen-pending')).toBeTruthy();
    expect(screen.getByTestId('shell')).toBeTruthy();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the next visit tries the chunk again', async () => {
    const { lazyScreen } = await fresh();
    let attempts = 0;
    const Hello = lazyScreen(() => (++attempts === 1 ? gone() : Promise.resolve(helloChunk)), 'Hello');
    await Hello.preload?.();
    expect(Hello.preload).toBeTypeOf('function');
    await Hello.preload?.();
    show(<Hello who="Ada" />);
    expect(screen.getByTestId('hello').textContent).toBe('hello Ada');
    expect(attempts).toBe(2);
  });
});
