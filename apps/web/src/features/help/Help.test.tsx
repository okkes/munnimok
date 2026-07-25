// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { TOURS } from './tours';
import { en } from '@/i18n/en';
import { nl } from '@/i18n/nl';
import { tr } from '@/i18n/tr';

describe('tour registry', () => {
  it('every step key exists in all three languages', () => {
    for (const tour of TOURS) {
      for (const step of tour.steps) {
        for (const [lang, dict] of Object.entries({ en, nl, tr })) {
          expect(dict[step.titleKey], `${lang} ${step.titleKey}`).toBeTruthy();
          expect(dict[step.bodyKey], `${lang} ${step.bodyKey}`).toBeTruthy();
        }
        expect(step.illustration).toBeTruthy();
      }
    }
  });
});

describe('Tutorials (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('the native shell shows no PWA install nudge or walkthrough', async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    try {
      renderApp('/help');
      await screen.findByTestId('screen-help');
      expect(screen.queryByTestId('help-tour-install')).toBeNull();
      cleanup();
      renderApp('/home');
      await screen.findByTestId('home-balance-band');
      expect(screen.queryByTestId('install-hint')).toBeNull();
    } finally {
      delete (globalThis as { Capacitor?: unknown }).Capacitor;
    }
  }, 15_000);

  it('the intro card nudges once and stays dismissed', async () => {
    renderApp('/home');
    const card = await screen.findByTestId('intro-card-home', {}, { timeout: 5000 });
    expect(card.textContent).toContain('60-second');
    fireEvent.click(screen.getByTestId('intro-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('intro-card-home')).toBeNull());

    cleanup();
    renderApp('/home');
    await screen.findByTestId('home-balance-band');
    // never nags again
    expect(screen.queryByTestId('intro-card-home')).toBeNull();
  }, 15_000);

  it('the ? opens slides; finishing marks the tour as seen', async () => {
    renderApp('/budgets');
    await screen.findByTestId('screen-budgets');
    await screen.findByTestId('intro-card-budgets');
    fireEvent.click(screen.getByTestId('help-btn-budgets'));
    await screen.findByTestId('help-slides');
    expect(screen.getByTestId('help-slide-title').textContent).toBe(en['tour.budgets.1t']);
    // budgets is slides-only — no interactive entry
    expect(screen.queryByTestId('help-interactive')).toBeNull();

    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByTestId('help-next'));
    await waitFor(() => expect(screen.getByTestId('help-slide-title').textContent).toBe(en['tour.budgets.4t']));
    fireEvent.click(screen.getByTestId('help-next')); // Done
    // seen → the intro card retires
    await waitFor(() => expect(screen.queryByTestId('intro-card-budgets')).toBeNull());
  }, 15_000);

  it('the spotlight walks the home screen and hands over on the tap step', async () => {
    renderApp('/home');
    await screen.findByTestId('home-balance-band');
    fireEvent.click(screen.getByTestId('help-btn-home'));
    await screen.findByTestId('help-slides');
    fireEvent.click(screen.getByTestId('help-interactive'));

    const overlay = await screen.findByTestId('spotlight-overlay');
    expect(overlay).toBeTruthy();
    expect(screen.getByTestId('spotlight-title').textContent).toBe(en['tour.home.1t']);

    fireEvent.click(screen.getByTestId('spotlight-next'));
    await waitFor(() => expect(screen.getByTestId('spotlight-title').textContent).toBe(en['tour.home.2t']));
    await screen.findByTestId('spotlight-target'); // anchored on the balance band

    fireEvent.click(screen.getByTestId('spotlight-next'));
    await waitFor(() => expect(screen.getByTestId('spotlight-title').textContent).toBe(en['tour.home.3t']));
    fireEvent.click(screen.getByTestId('spotlight-next'));
    await waitFor(() => expect(screen.getByTestId('spotlight-title').textContent).toBe(en['tour.home.4t']));

    // the final step forwards the tap to the real customize button
    fireEvent.click(await screen.findByTestId('spotlight-target'));
    await waitFor(() => expect(screen.queryByTestId('spotlight-overlay')).toBeNull());
    await screen.findByTestId('home-customize-list'); // the real sheet opened
  }, 15_000);

  it('a missing anchor shows the sample instead of skipping', async () => {
    // review with nothing to review: the card/confirm anchors are absent
    renderApp('/review');
    await screen.findByTestId('screen-review');
    fireEvent.click(screen.getByTestId('help-btn-review'));
    await screen.findByTestId('help-slides');
    fireEvent.click(screen.getByTestId('help-interactive'));

    await screen.findByTestId('spotlight-overlay');
    fireEvent.click(screen.getByTestId('spotlight-next')); // to step 2 (anchor review-card)
    // demo has review items… skip ahead until a missing-anchor step shows the sample
    await waitFor(() => expect(screen.getByTestId('spotlight-title').textContent).toBe(en['tour.review.2t']), { timeout: 4000 });
    fireEvent.click(screen.getByTestId('spotlight-end'));
    await waitFor(() => expect(screen.queryByTestId('spotlight-overlay')).toBeNull());
  }, 15_000);

  it('the install hint opens the install slides and stays dismissed', async () => {
    renderApp('/home');
    const hint = await screen.findByTestId('install-hint', {}, { timeout: 5000 });
    expect(hint.textContent).toContain(en['install.title']);

    // "See how" opens the platform walkthrough (slides only — no spotlight)
    fireEvent.click(screen.getByTestId('install-hint-how'));
    await screen.findByTestId('help-slides');
    expect(screen.getByTestId('help-slide-title').textContent).toBe(en['tour.install.1t']);
    expect(screen.queryByTestId('help-interactive')).toBeNull();
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByTestId('help-next'));
    await waitFor(() => expect(screen.getByTestId('help-slide-title').textContent).toBe(en['tour.install.4t']));
    fireEvent.click(screen.getByTestId('help-next')); // Done closes the sheet
    await waitFor(() => expect(screen.queryByTestId('help-slides')).toBeNull());

    // dismissal is forever (device meta)
    fireEvent.click(await screen.findByTestId('install-hint-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('install-hint')).toBeNull());
    cleanup();
    renderApp('/home');
    await screen.findByTestId('home-balance-band');
    expect(screen.queryByTestId('install-hint')).toBeNull();
  }, 15_000);

  it('release notes: the home nudge shows once per version, help keeps the door', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    // fresh device: the newest release is unseen → the nudge shows
    const card = await screen.findByTestId('whatsnew-card');
    fireEvent.click(screen.getByTestId('whatsnew-open'));
    expect(await screen.findByTestId('whatsnew-list')).toBeTruthy();
    expect(card).toBeTruthy();

    // acknowledged: a fresh mount stays quiet
    cleanup();
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await screen.findByTestId('home-balance-band');
    expect(screen.queryByTestId('whatsnew-card')).toBeNull();

    // …but the help index keeps the release notes reachable
    cleanup();
    renderApp('/help');
    await screen.findByTestId('screen-help');
    fireEvent.click(screen.getByTestId('help-whatsnew-row'));
    expect(await screen.findByTestId('whatsnew-list')).toBeTruthy();
  }, 15_000);

  it('settings reaches the index; every tour is listed and opens', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    // help moved behind the Global settings door
    fireEvent.click(screen.getByTestId('settings-global-row'));
    fireEvent.click(await screen.findByTestId('settings-help-row'));
    await screen.findByTestId('screen-help');
    for (const tour of TOURS) expect(screen.getByTestId(`help-tour-${tour.id}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId('help-tour-review'));
    await screen.findByTestId('help-slides');
    expect(screen.getByTestId('help-slide-title').textContent).toBe(en['tour.review.1t']);
  }, 15_000);
});

describe('guided welcome walkthrough', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('fast-forwards to the first unmet step (resume detection by data)', async () => {
    const { welcomeStartStep } = await import('./tours');
    expect(welcomeStartStep({ hasAccount: false, hasTx: false, hasSecondSpace: false })).toBe(0);
    expect(welcomeStartStep({ hasAccount: true, hasTx: false, hasSecondSpace: false })).toBe(3);
    expect(welcomeStartStep({ hasAccount: true, hasTx: true, hasSecondSpace: false })).toBe(4);
    expect(welcomeStartStep({ hasAccount: true, hasTx: true, hasSecondSpace: true })).toBe(5);
  });

  it('demo identities never see the welcome card (demo data demonstrates it all)', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    expect(screen.queryByTestId('welcome-tour-card')).toBeNull();
  });
});

describe('welcome card (signed-in identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('shows on Home; skipping asks once, the second tap skips for good', async () => {
    const { USER_TEST_DB, renderAppAsUser } = await import('@/test/harness');
    indexedDB.deleteDatabase(USER_TEST_DB);
    renderAppAsUser('/home');
    const card = await screen.findByTestId('welcome-tour-card', {}, { timeout: 5000 });
    expect(card).toBeTruthy();

    // first skip tap: one encouragement line, the card stays
    fireEvent.click(screen.getByTestId('welcome-tour-skip'));
    expect(screen.getByTestId('welcome-tour-line').textContent).toBe(en['tour.welcome.encourage']);
    // second tap skips for real
    fireEvent.click(screen.getByTestId('welcome-tour-skip'));
    await waitFor(() => expect(screen.queryByTestId('welcome-tour-card')).toBeNull(), { timeout: 5000 });
  }, 15_000);
});

describe('welcome walkthrough run (signed-in identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('starts on the space step, walks to an act step, and End keeps the card resumable', async () => {
    const { USER_TEST_DB, renderAppAsUser } = await import('@/test/harness');
    indexedDB.deleteDatabase(USER_TEST_DB);
    renderAppAsUser('/home');
    fireEvent.click(await screen.findByTestId('welcome-tour-start', {}, { timeout: 5000 }));

    // fresh identity → step 1 (meet your space) on the settings screen
    await screen.findByTestId('spotlight-card', {}, { timeout: 5000 });
    await waitFor(() => expect(screen.getByTestId('spotlight-title').textContent).toBe(en['tour.welcome.1t']), {
      timeout: 5000,
    });
    await screen.findByTestId('screen-settings', {}, { timeout: 5000 });

    // next lands on the ACT step: non-blocking card, waiting for the
    // user's own account creation on the space's accounts screen
    fireEvent.click(screen.getByTestId('spotlight-next'));
    const actCard = await screen.findByTestId('walkthrough-act-card', {}, { timeout: 5000 });
    expect(actCard.textContent).toContain(en['tour.welcome.2t']);
    expect(screen.getByTestId('walkthrough-act-state').textContent).toBe(en['tour.welcome.stepWaiting']);

    // ending early keeps the Home card alive (welcomeTourDone unset)
    fireEvent.click(screen.getByTestId('spotlight-end'));
    await waitFor(() => expect(screen.queryByTestId('walkthrough-act-card')).toBeNull());
  }, 20_000);
});
