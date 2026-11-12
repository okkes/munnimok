// @vitest-environment happy-dom
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/harness';
import { SpotlightOverlay } from './SpotlightOverlay';
import { tourById } from './tours';

const noop = () => undefined;

describe('the tour step card (#558)', () => {
  const innerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  beforeEach(() => {
    localStorage.setItem('munni_lang', 'en');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 });
  });
  afterEach(() => {
    document.querySelector('[data-app-frame]')?.remove();
    if (innerWidth) Object.defineProperty(window, 'innerWidth', innerWidth);
  });

  it('spans the app frame — side panel to content edge — not the whole window', () => {
    const frame = document.createElement('div');
    frame.dataset.appFrame = '';
    frame.getBoundingClientRect = () => ({ left: 260, right: 1660, width: 1400, top: 0, bottom: 900, height: 900 }) as DOMRect;
    document.body.appendChild(frame);

    renderWithProviders(<SpotlightOverlay tour={tourById('install')} step={0} onStep={noop} onEnd={noop} />);
    const card = screen.getByTestId('spotlight-card');
    expect(card.style.left).toBe('276px');
    expect(card.style.right).toBe('276px');
  });

  it('keeps its gutters to the screen where no frame is measured', () => {
    renderWithProviders(<SpotlightOverlay tour={tourById('install')} step={0} onStep={noop} onEnd={noop} />);
    const card = screen.getByTestId('spotlight-card');
    expect(card.style.left).toBe('');
    expect(card.style.right).toBe('');
  });
});

describe('the anchor a tour step points at', () => {
  // the accounts tour's last step points at the bank hub, which All accounts keeps in the page but hidden for a profile without banks
  const tour = tourById('accounts');
  const step = tour.steps.findIndex((s) => s.anchor === 'bank-connections');
  const box = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
  let anchor: HTMLElement;

  beforeEach(() => {
    localStorage.setItem('munni_lang', 'en');
    anchor = document.createElement('div');
    anchor.dataset.testid = 'bank-connections';
    document.body.appendChild(anchor);
    // the test DOM lays nothing out: give the page a size, as every browser does
    document.documentElement.getBoundingClientRect = () => box(0, 0, 1280, 900);
  });
  afterEach(() => {
    anchor.remove();
    delete (document.documentElement as Partial<HTMLElement>).getBoundingClientRect;
  });

  it('spotlights an anchor the page draws', async () => {
    anchor.getBoundingClientRect = () => box(40, 300, 400, 120);
    renderWithProviders(<SpotlightOverlay tour={tour} step={step} onStep={noop} onEnd={noop} />);
    const target = await screen.findByTestId('spotlight-target');
    expect(target.style.top).toBe('294px');
    expect(target.style.height).toBe('132px');
    expect(screen.queryByTestId('spotlight-sample-note')).toBeNull();
  });

  it('shows the sample for an anchor that is in the page but hidden: a browser draws no box for it', async () => {
    anchor.hidden = true;
    anchor.getClientRects = () => [] as unknown as DOMRectList;
    renderWithProviders(<SpotlightOverlay tour={tour} step={step} onStep={noop} onEnd={noop} />);
    expect(await screen.findByTestId('spotlight-sample-note', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByTestId('spotlight-target')).toBeNull();
  });

  it('shows the sample for an anchor without any area', async () => {
    anchor.getBoundingClientRect = () => box(0, 0, 0, 0);
    renderWithProviders(<SpotlightOverlay tour={tour} step={step} onStep={noop} onEnd={noop} />);
    expect(await screen.findByTestId('spotlight-sample-note', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByTestId('spotlight-target')).toBeNull();
  });
});
