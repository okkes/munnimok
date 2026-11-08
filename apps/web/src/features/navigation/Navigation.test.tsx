// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USER_TEST_DB, renderApp, renderAppAsUser, renderWithData } from '@/test/harness';
import { useNavTabs } from './useNavTabs';

/** the phone bar's entries, left to right */
const barIds = () =>
  [...screen.getByTestId('tab-bar').querySelectorAll('a[data-testid^="tab-"]')].map((el) => el.getAttribute('data-testid')!.replace('tab-', ''));

/** a viewport answer for the side panel's breakpoint only */
function stubSideNav(shown: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === '(min-width: 48rem)' ? shown : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

async function openEditor() {
  renderApp('/settings');
  await screen.findByTestId('screen-settings');
  fireEvent.click(screen.getByTestId('settings-navigation-row'));
  await screen.findByTestId('nav-edit-bar');
}

describe('navigation (demo identity)', () => {
  let restore: (() => void) | undefined;
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
    restore = stubSideNav(false);
  });
  afterEach(() => restore?.());

  it('a space that never picked keeps the bar it always had', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    expect(barIds()).toEqual(['home', 'transactions', 'planning', 'portfolio', 'settings']);
    // the shortcuts stand in only for what the bar dropped
    expect(screen.queryByTestId('home-shortcuts')).toBeNull();
  });

  it('#523: the side panel lists every feature; splits wait for a signed-in account', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    for (const id of ['home', 'transactions', 'planning', 'portfolio', 'budgets', 'goals', 'debts', 'upcoming', 'recurring', 'events', 'receipts', 'insights', 'trends', 'settings']) {
      expect(screen.getByTestId(`side-tab-${id}`)).toBeTruthy();
    }
    expect(screen.queryByTestId('side-tab-splits')).toBeNull();
    fireEvent.click(screen.getByTestId('side-tab-goals'));
    expect(await screen.findByTestId('screen-goals')).toBeTruthy();
    expect(screen.getByTestId('side-tab-goals').className).toContain('bg-accent-soft');
  });

  it('a feature joins the bar before a closing Settings, and the space history says who changed it', async () => {
    await openEditor();
    expect(screen.getByTestId('nav-count').textContent).toBe('5 of 8');
    expect(screen.getByTestId('nav-row-home').textContent).toContain('Always first');

    fireEvent.click(screen.getByTestId('nav-add-goals'));
    await waitFor(() => expect(barIds()).toEqual(['home', 'transactions', 'planning', 'portfolio', 'goals', 'settings']));
    await waitFor(() => expect(screen.getByTestId('nav-count').textContent).toBe('6 of 8'));
    expect(screen.queryByTestId('nav-more-row-goals')).toBeNull();

    fireEvent.click(screen.getByTestId('tab-goals'));
    expect(await screen.findByTestId('screen-goals')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tab-home'));
    await screen.findByTestId('screen-home');
    fireEvent.click(screen.getByTestId('home-notifications'));
    fireEvent.click(await screen.findByTestId('notif-tab-activity'));
    expect((await screen.findByTestId('history-list')).textContent).toContain('changed the navigation bar');
  }, 15_000);

  it('the bar holds eight at most — Home and seven picks', async () => {
    await openEditor();
    fireEvent.click(screen.getByTestId('nav-add-goals'));
    await screen.findByTestId('tab-goals');
    fireEvent.click(screen.getByTestId('nav-add-budgets'));
    await screen.findByTestId('tab-budgets');
    fireEvent.click(screen.getByTestId('nav-add-debts'));
    await screen.findByTestId('tab-debts');

    await waitFor(() => expect(screen.getByTestId('nav-count').textContent).toBe('8 of 8'));
    expect(screen.getByTestId('nav-full')).toBeTruthy();
    const add = screen.getByTestId('nav-add-events') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(barIds()).toHaveLength(8);
  }, 15_000);

  it('Settings can leave the bar: the space menu keeps its door, and Back to the default bar brings it back', async () => {
    await openEditor();
    fireEvent.click(screen.getByTestId('nav-tab-toggle-settings'));
    await waitFor(() => expect(barIds()).toEqual(['home', 'transactions', 'planning', 'portfolio']));
    expect(await screen.findByTestId('nav-settings-note')).toBeTruthy();

    fireEvent.click(screen.getByTestId('tab-home'));
    await screen.findByTestId('screen-home');
    fireEvent.click(screen.getByTestId('home-space-switcher'));
    fireEvent.click(await screen.findByTestId('space-switcher-settings'));
    expect(await screen.findByTestId('screen-settings')).toBeTruthy();

    fireEvent.click(screen.getByTestId('settings-navigation-row'));
    fireEvent.click(await screen.findByTestId('nav-reset'));
    await waitFor(() => expect(barIds()).toEqual(['home', 'transactions', 'planning', 'portfolio', 'settings']));
    await waitFor(() => expect(screen.queryByTestId('nav-reset')).toBeNull());
  }, 15_000);

  it('dragging a pick reorders the bar', async () => {
    await openEditor();
    fireEvent.click(screen.getByTestId('nav-add-goals'));
    await screen.findByTestId('nav-tab-drag-goals');
    // happy-dom has no layout: each row fakes its box
    const rows = () => [...document.querySelectorAll('[data-testid^="nav-tab-row-"]')];
    rows().forEach((el, i) => {
      (el as HTMLElement).getBoundingClientRect = () => ({ top: i * 40, height: 40, left: 0, width: 320 }) as DOMRect;
    });
    const handle = screen.getByTestId('nav-tab-drag-goals');
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 3 * 40 + 20 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 5 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    await waitFor(() => expect(barIds()).toEqual(['home', 'goals', 'transactions', 'planning', 'portfolio', 'settings']));
  }, 15_000);

  it('what leaves the bar gets a Home shortcut on the phone', async () => {
    await openEditor();
    fireEvent.click(screen.getByTestId('nav-tab-toggle-transactions'));
    await waitFor(() => expect(barIds()).not.toContain('transactions'));
    fireEvent.click(screen.getByTestId('nav-tab-toggle-portfolio'));
    await waitFor(() => expect(barIds()).not.toContain('portfolio'));

    fireEvent.click(screen.getByTestId('tab-home'));
    const block = await screen.findByTestId('home-shortcuts');
    expect(block.textContent).toContain('Transactions');
    expect(screen.queryByTestId('home-shortcut-planning')).toBeNull();
    fireEvent.click(screen.getByTestId('home-shortcut-portfolio'));
    expect(await screen.findByTestId('screen-portfolio')).toBeTruthy();
  }, 15_000);

  it('no shortcuts where the side panel lists everything', async () => {
    restore?.();
    restore = stubSideNav(true);
    await openEditor();
    fireEvent.click(screen.getByTestId('nav-tab-toggle-transactions'));
    await waitFor(() => expect(screen.queryByTestId('nav-tab-row-transactions')).toBeNull());
    fireEvent.click(screen.getByTestId('side-tab-home'));
    await screen.findByTestId('home-customize');
    expect(screen.queryByTestId('home-shortcuts')).toBeNull();
  }, 15_000);

  it('a cold start draws the bar this device drew last until the space row is read', async () => {
    const seen: string[][] = [];
    function Probe() {
      seen.push(useNavTabs());
      return null;
    }
    localStorage.setItem('munni_nav_tabs', JSON.stringify({ demo: { demo_space: ['goals', 'unknown-later-feature'] } }));
    renderWithData(<Probe />);
    await waitFor(() => expect(seen.at(-1)).toEqual(['transactions', 'planning', 'portfolio', 'settings']));
    expect(seen[0]).toEqual(['goals']);
    // and the device remembers what it drew for the next cold start
    expect(JSON.parse(localStorage.getItem('munni_nav_tabs')!).demo.demo_space).toEqual(['transactions', 'planning', 'portfolio', 'settings']);
  });

  it('the Settings screen keeps a door to every feature the bar may drop', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-transactions-row'));
    expect(await screen.findByTestId('screen-transactions')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tab-settings'));
    fireEvent.click(await screen.findByTestId('settings-portfolio-row'));
    expect(await screen.findByTestId('screen-portfolio')).toBeTruthy();
  }, 15_000);
});

describe('names or icons in the phone bar', () => {
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  let barWidth = 0;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
    // the bar is measured, not guessed: the bar's width against each label's own
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === 'tab-bar' ? barWidth : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.parentElement?.dataset.testid === 'tab-bar-measure' ? 60 : 0;
      },
    });
  });

  afterEach(() => {
    if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
    else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    if (offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth);
    else delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
  });

  it('shows the names while they fit and only the icons once one does not', async () => {
    barWidth = 400; // 80 per slot: the 60-wide labels fit
    renderApp('/home');
    await screen.findByTestId('screen-home');
    expect(screen.getByTestId('tab-bar').dataset.labels).toBe('shown');
    expect(screen.getByTestId('tab-transactions').textContent).toBe('Transactions');

    cleanup();
    barWidth = 300; // 60 per slot: no room left around a 60-wide label
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await waitFor(() => expect(screen.getByTestId('tab-bar').dataset.labels).toBe('icons'));
    const tab = screen.getByTestId('tab-transactions');
    expect(tab.textContent).toBe('');
    expect(tab.getAttribute('aria-label')).toBe('Transactions');
  });
});

describe('a side panel taller than the screen', () => {
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
    const sized = (value: number) => ({
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === 'side-nav' ? value : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', sized(300));
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', sized(600));
  });

  afterEach(() => {
    if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
    else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    if (scrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeight);
    else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  });

  it('fades the edge that hides more — scrollbars are hidden everywhere', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    expect(screen.getByTestId('side-nav').getAttribute('style') ?? '').toContain('transparent');
  });
});

describe('navigation (signed-in user)', () => {
  const ME = '11111111-1111-1111-1111-111111111111';
  const BOB = '22222222-2222-2222-2222-222222222222';
  const member = (userId: string, name: string, role: string) => ({ userId, displayName: name, role, picture: null });

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('splits join the side panel; a reader sees the bar but cannot change it', async () => {
    renderAppAsUser('/spaces/s-user/navigation', {
      spaces: [{ id: 's-user', name: 'Personal', kind: 'shared' }],
      api: {
        'GET /me': () => ({ userId: ME, displayName: 'Me' }),
        'GET /spaces/s-user/members': () => [member(BOB, 'Bob', 'owner'), member(ME, 'Me', 'reader')],
      },
    });
    await screen.findByTestId('nav-reader-note', {}, { timeout: 5000 });
    expect(screen.getByTestId('side-tab-splits')).toBeTruthy();
    expect(screen.getByTestId('nav-more-row-splits')).toBeTruthy();
    fireEvent.click(screen.getByTestId('nav-add-goals'));
    // nothing changes: the write never leaves a reader's device
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(barIds()).toEqual(['home', 'transactions', 'planning', 'portfolio', 'settings']);
  }, 15_000);
});
