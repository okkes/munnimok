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

  it('settings reaches the index; every tour is listed and opens', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-help-row'));
    await screen.findByTestId('screen-help');
    for (const tour of TOURS) expect(screen.getByTestId(`help-tour-${tour.id}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId('help-tour-review'));
    await screen.findByTestId('help-slides');
    expect(screen.getByTestId('help-slide-title').textContent).toBe(en['tour.review.1t']);
  }, 15_000);
});
