import { useCallback } from 'react';
import { useDark } from '@/app/theme';
import { hexToHsl, hslToHex } from './ColorPicker';

/**
 * #592: a colour somebody picked is stored as picked and has no dark counterpart the way a design token
 * has. Drawn as ink (an icon, a label, a line) on the dark surface, a dark pick vanished — the default
 * space colour is the dark brand green. On dark, a pick that does not stand out is made lighter until it
 * does; the hue stays, so it is still "their" colour. Fills keep the pick as it is: what sits on a fill
 * brings its own contrast.
 */
export const DARK_INK_CONTRAST = 4;
/** the dark theme's card colour (--m-surface): the darkest thing picked ink is drawn on is close to it */
const DARK_SURFACE = '#262420';
/** a lifted colour at full saturation glows on dark */
const LIFTED_SATURATION = 60;

const channel = (value: number): number => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

/** WCAG relative luminance of a #rrggbb colour */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => channel(Number.parseInt(hex.slice(at, at + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** how far a #rrggbb colour stands out from the dark surface (1 = not at all, 21 = white on black) */
export function contrastOnDark(hex: string): number {
  return (luminance(hex) + 0.05) / (luminance(DARK_SURFACE) + 0.05);
}

export function inkOnDark(color: string): string {
  const hsl = hexToHsl(color);
  if (!hsl || contrastOnDark(color) >= DARK_INK_CONTRAST) return color;
  const saturation = Math.min(hsl.s, LIFTED_SATURATION);
  for (let lightness = Math.ceil(hsl.l); lightness <= 100; lightness += 2) {
    const lifted = hslToHex(hsl.h, saturation, lightness);
    if (contrastOnDark(lifted) >= DARK_INK_CONTRAST) return lifted;
  }
  return '#FFFFFF';
}

/** the colour to draw a picked colour with in the current theme; design tokens pass through */
export function useUserInk(): <T extends string | undefined>(color: T) => T | string {
  const dark = useDark();
  return useCallback((color) => (dark && color ? inkOnDark(color) : color), [dark]);
}
