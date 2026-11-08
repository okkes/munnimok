/**
 * Client-side image downscaling for profile pictures and space images.
 * Local-first: the original file never leaves the device — only the
 * tiny (≤ maxPx, JPEG) data URL is stored and synced, so avatars ride
 * along in existing sync fields instead of needing a blob store.
 */

/** largest dimensions that fit `w × h` inside a `max` square, keeping ratio */
export function fitWithin(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= max && h <= max) return { width: w, height: h };
  const scale = Math.min(max / w, max / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export const isDataImage = (value: string | null | undefined): boolean => !!value?.startsWith('data:image/');

/** pictures up to this size are faces and logos — they keep their transparency; larger ones are photos and receipts */
const KEEP_ALPHA_MAX_PX = 512;

/** any pixel not fully opaque (RGBA bytes) */
export function hasTransparency(rgba: Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) return true;
  return false;
}

/** WebP keeps the alpha at a fraction of PNG's size; WebKit cannot encode it and hands back PNG */
function encodeWithAlpha(canvas: HTMLCanvasElement, quality: number): string {
  const webp = canvas.toDataURL('image/webp', quality);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}

/**
 * #522 (user): JPEG has no alpha — a transparent logo came back on BLACK,
 * which swallowed a dark logo whole. A small picture with transparency
 * keeps it (the screens choose a backdrop for it, ui/Picture); a large one
 * gets a white page under its transparent parts.
 */
export async function downscaleImage(file: Blob, maxPx = 256, quality = 0.82): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxPx);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (hasTransparency(ctx.getImageData(0, 0, width, height).data)) {
      if (maxPx <= KEEP_ALPHA_MAX_PX) return encodeWithAlpha(canvas, quality);
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }
    // JPEG: photos compress far better than PNG at avatar sizes
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    bitmap.close();
  }
}
