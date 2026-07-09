// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/test/harness';
import type { Theme } from './theme';
import { ThemeProvider, useTheme } from './theme';

let api: { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void };

function Probe() {
  api = useTheme();
  return <span data-testid="theme">{api.theme}</span>;
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('defaults to the light system preference and applies the data attribute', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#F7F4EE');
  });

  it('honors a stored theme over the system preference', () => {
    localStorage.setItem('munni_theme', 'dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });

  it('toggle flips and persists; setTheme sets explicitly', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => api.toggle());
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(localStorage.getItem('munni_theme')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#191714');
    act(() => api.setTheme('light'));
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(localStorage.getItem('munni_theme')).toBe('light');
  });

  it('useTheme outside the provider throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/within ThemeProvider/);
  });
});
