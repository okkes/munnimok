// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downscaleImage, fitWithin, hasTransparency, isDataImage } from './image';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('fitWithin', () => {
  it('keeps small images untouched', () => {
    expect(fitWithin(100, 80, 256)).toEqual({ width: 100, height: 80 });
  });

  it('scales down preserving aspect ratio on the long side', () => {
    expect(fitWithin(1024, 512, 256)).toEqual({ width: 256, height: 128 });
    expect(fitWithin(512, 1024, 256)).toEqual({ width: 128, height: 256 });
    expect(fitWithin(3000, 3000, 128)).toEqual({ width: 128, height: 128 });
  });

  it('never collapses a dimension to zero', () => {
    expect(fitWithin(10_000, 1, 128).height).toBe(1);
  });
});

describe('isDataImage', () => {
  it('detects data-URL images and nothing else', () => {
    expect(isDataImage('data:image/jpeg;base64,abc')).toBe(true);
    expect(isDataImage('account-outline|#08372B')).toBe(false);
    expect(isDataImage('data:text/plain;base64,x')).toBe(false);
    expect(isDataImage(null)).toBe(false);
    expect(isDataImage(undefined)).toBe(false);
  });
});

/** a 2×1 RGBA picture: opaque, or with a see-through pixel */
const pixels = (transparent: boolean) => new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, transparent ? 0 : 255]);

/** the canvas a downscale draws on — what it was asked to encode, and what it was given */
function stubCanvas(rgba: Uint8ClampedArray, encodes: (type: string) => string) {
  const drawn = { fillRect: vi.fn(), drawImage: vi.fn(), composite: '' };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        drawImage: drawn.drawImage,
        fillRect: drawn.fillRect,
        getImageData: () => ({ data: rgba }),
        set globalCompositeOperation(value: string) {
          drawn.composite = value;
        },
        fillStyle: '',
      }) as never,
  );
  const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation((type?: string) => encodes(type ?? 'image/png'));
  return { drawn, toDataURL };
}

describe('#522: a transparent picture never comes back on black', () => {
  it('spots a see-through pixel', () => {
    expect(hasTransparency(pixels(false))).toBe(false);
    expect(hasTransparency(pixels(true))).toBe(true);
  });

  it('a small transparent picture keeps its alpha — WebP where the browser encodes it', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 64, height: 64, close: vi.fn() }));
    stubCanvas(pixels(true), (type) => `data:${type};base64,x`);
    expect(await downscaleImage(new Blob(['x']), 256)).toBe('data:image/webp;base64,x');
  });

  it('…and PNG where it cannot (WebKit hands back PNG for a WebP ask)', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 64, height: 64, close: vi.fn() }));
    stubCanvas(pixels(true), () => 'data:image/png;base64,x');
    expect(await downscaleImage(new Blob(['x']), 256)).toBe('data:image/png;base64,x');
  });

  it('a large transparent picture lands on a white page, still a JPEG', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 2000, height: 1000, close: vi.fn() }));
    const { drawn, toDataURL } = stubCanvas(pixels(true), (type) => `data:${type};base64,x`);
    expect(await downscaleImage(new Blob(['x']), 1080, 0.72)).toBe('data:image/jpeg;base64,x');
    expect(drawn.composite).toBe('destination-over');
    expect(drawn.fillRect).toHaveBeenCalled();
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.72);
  });
});

describe('downscaleImage', () => {
  it('downscales the bitmap to the fitted size and returns the JPEG data URL', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 1000, height: 500, close }));
    const drawImage = vi.fn();
    let canvas: HTMLCanvasElement | undefined;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      canvas = this;
      return { drawImage, getImageData: () => ({ data: pixels(false) }) } as never;
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,tiny');

    const url = await downscaleImage(new Blob(['x']), 256);
    expect(url).toBe('data:image/jpeg;base64,tiny');
    // 1000×500 fits a 256 square as 256×128 — the canvas IS that size
    expect(canvas?.width).toBe(256);
    expect(canvas?.height).toBe(128);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalled(); // bitmap released on success
  });

  it('releases the bitmap when the canvas is unavailable', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 10, height: 10, close }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await expect(downscaleImage(new Blob(['x']))).rejects.toThrow('canvas unavailable');
    expect(close).toHaveBeenCalled();
  });
});
