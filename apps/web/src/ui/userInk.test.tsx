// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeProvider } from '@/app/theme';
import { hexToHsl } from './ColorPicker';
import { Icon } from './Icon';
import { DARK_INK_CONTRAST, contrastOnDark, inkOnDark } from './userInk';

/** the DOM hands a colour back as rgb(): bring it to the hex the helpers read */
function asHex(color: string): string {
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color);
  if (!rgb) return color.toUpperCase();
  return `#${[rgb[1], rgb[2], rgb[3]].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** #592: colours people pick are stored as they were picked — the default is the dark brand green — and vanished as ink on the dark surface */
describe('a picked colour as ink', () => {
  beforeEach(() => localStorage.clear());

  it('a pick that does not stand out from the dark surface is made lighter until it does, keeping its hue', () => {
    expect(contrastOnDark('#08372B')).toBeLessThan(2);
    const lifted = inkOnDark('#08372B');
    expect(contrastOnDark(lifted)).toBeGreaterThanOrEqual(DARK_INK_CONTRAST);
    expect(Math.abs(hexToHsl(lifted)!.h - hexToHsl('#08372B')!.h)).toBeLessThan(3);
    // black has no hue to keep: it becomes a readable grey
    expect(contrastOnDark(inkOnDark('#000000'))).toBeGreaterThanOrEqual(DARK_INK_CONTRAST);
  });

  it('the bright picks of the palette, a design token and a broken value are left alone', () => {
    for (const bright of ['#3498DB', '#27AE60', '#E74C3C', '#F39C12', '#16A085', '#FFFFFF']) expect(inkOnDark(bright)).toBe(bright);
    expect(inkOnDark('var(--m-ink-2)')).toBe('var(--m-ink-2)');
    expect(inkOnDark('teal')).toBe('teal');
  });

  const glyphColor = (theme: 'light' | 'dark' | null, color: string) => {
    if (theme) localStorage.setItem('munni_theme', theme);
    const ui = <Icon name="leaf" color={color} />;
    const { container, unmount } = render(theme ? <ThemeProvider>{ui}</ThemeProvider> : ui);
    const value = (container.querySelector('i') as HTMLElement).style.color;
    unmount();
    return asHex(value);
  };

  it('every icon drawn in a picked colour follows: lifted in dark mode, untouched in light mode and outside a theme', () => {
    expect(glyphColor('dark', '#08372B')).toBe(inkOnDark('#08372B'));
    expect(glyphColor('light', '#08372B')).toBe('#08372B');
    expect(glyphColor(null, '#08372B')).toBe('#08372B');
    expect(glyphColor('dark', 'var(--m-ink-2)')).toBe('VAR(--M-INK-2)');
  });
});
