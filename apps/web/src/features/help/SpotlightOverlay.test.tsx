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
