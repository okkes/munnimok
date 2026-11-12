// @vitest-environment happy-dom
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// harness registers RTL cleanup between tests
import '@/test/harness';
import { Picture } from '@/ui/Picture';
import { pictureStats, plateFor } from './picturePlate';

type Rgba = [number, number, number, number];

/** a 10×10 picture: a share of ink pixels, the rest see-through (or an own background) */
function picture(ink: [number, number, number], inkShare: number, rest: Rgba = [0, 0, 0, 0]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(100 * 4);
  for (let i = 0; i < 100; i += 1) out.set(i < inkShare * 100 ? [...ink, 255] : rest, i * 4);
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

describe('#522: the backdrop a see-through picture needs', () => {
  it('a dark logo on nothing reads bare in light mode and gets the light plate in dark mode', () => {
    const stats = pictureStats(picture([20, 20, 20], 0.4));
    expect(stats.cutout).toBe(true);
    expect(plateFor(stats, 'light')).toBeNull();
    expect(plateFor(stats, 'dark')).toBe('light');
  });

  it('a white logo on nothing gets the dark plate in light mode and reads bare in dark mode', () => {
    const stats = pictureStats(picture([250, 250, 250], 0.4));
    expect(plateFor(stats, 'light')).toBe('dark');
    expect(plateFor(stats, 'dark')).toBeNull();
  });

  it('a colourful logo that reads on both grounds stays bare', () => {
    const stats = pictureStats(picture([229, 9, 20], 0.4));
    expect(plateFor(stats, 'light')).toBeNull();
    expect(plateFor(stats, 'dark')).toBeNull();
  });

  it('an opaque picture — a photo, a logo on its own background, a rounded icon — never gets one', () => {
    expect(plateFor(pictureStats(picture([20, 20, 20], 0.4, [255, 255, 255, 255])), 'dark')).toBeNull();
    // rounded corners: a few see-through pixels make no cut-out
    const corners = pictureStats(picture([250, 250, 250], 0.95));
    expect(corners.cutout).toBe(false);
    expect(plateFor(corners, 'light')).toBeNull();
    expect(plateFor(null, 'dark')).toBeNull();
  });
});

describe('#522: <Picture>', () => {
  /** happy-dom decodes nothing: the stub "loads" as soon as it has a source, and the canvas hands out these pixels */
  function stubDecoding(pixels: Uint8ClampedArray) {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(), getImageData: () => ({ data: pixels }) } as never);
    class LoadingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 10;
      naturalHeight = 10;
      crossOrigin = '';
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', LoadingImage);
    return getContext;
  }

  it('wears the plate the theme needs, and follows a theme change', async () => {
    stubDecoding(picture([20, 20, 20], 0.4));
    document.documentElement.dataset.theme = 'dark';
    render(<Picture src="data:image/png;base64,dark-logo" data-testid="pic" />);
    await waitFor(() => expect(screen.getByTestId('pic').dataset.plate).toBe('light'));
    expect(screen.getByTestId('pic').style.backgroundColor).toBe('var(--m-plate-light)');
    act(() => {
      document.documentElement.dataset.theme = 'light';
    });
    await waitFor(() => expect(screen.getByTestId('pic').dataset.plate).toBeUndefined());
  });

  it('a picture that cannot be measured stays bare, beside one that gets its plate', async () => {
    // the first canvas asked for hands out no context — that picture cannot be read; the next one can
    stubDecoding(picture([20, 20, 20], 0.4)).mockReturnValueOnce(null);
    document.documentElement.dataset.theme = 'dark';
    render(
      <>
        <Picture src="data:image/png;base64,unreadable" data-testid="bare" className="h-6 w-6" />
        <Picture src="data:image/png;base64,dark-logo-beside" data-testid="plated" />
      </>,
    );
    // pictures are measured in order: once the second wears its plate, the first one's answer is in as well
    await waitFor(() => expect(screen.getByTestId('plated').dataset.plate).toBe('light'));
    expect(screen.getByTestId('bare').dataset.plate).toBeUndefined();
    expect(screen.getByTestId('bare').className).toBe('h-6 w-6');
  });
});
