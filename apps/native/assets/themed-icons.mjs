#!/usr/bin/env node
// Derives the themed app icons from the icons the shells already ship (#659):
//   Android  the monochrome layer of the adaptive icon — the leaf alone, the launcher colours it
//   iOS      the dark variant (the leaf alone, the system lays its dark background under it) and the tinted variant
//            (a greyscale leaf on black, the system colours it)
// The leaf is read out of each icon by how far a pixel is from the icon's own background, so it keeps the exact
// place and edge of the icon it comes from. Run from the repository root: node apps/native/assets/themed-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const native = join(dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_RES = join(native, 'android/app/src/app/res/mipmap-xxxhdpi');
const IOS_ASSETS = join(native, 'ios/App/App/Assets.xcassets');

const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** how much of each pixel is leaf, 0–1: its distance from the corner's colour towards the leaf's own */
async function leafMask(file) {
  const image = await loadImage(readFileSync(file));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);
  const lum = new Float32Array(image.width * image.height);
  for (let i = 0; i < lum.length; i++) lum[i] = luminance(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  const background = lum[0];
  // the leaf's own tone is the far end of the spread, not one stray pixel
  const sorted = Float32Array.from(lum).sort();
  const far = background > 128 ? sorted[Math.floor(sorted.length * 0.02)] : sorted[Math.floor(sorted.length * 0.98)];
  const mask = new Float32Array(lum.length);
  for (let i = 0; i < lum.length; i++) {
    const t = (lum[i] - background) / (far - background);
    mask[i] = t < 0.08 ? 0 : Math.min(1, t);
  }
  return { mask, width: image.width, height: image.height };
}

/** the leaf in one colour; `backdrop` makes the picture opaque */
function paint({ mask, width, height }, [r, g, b], backdrop) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const out = ctx.createImageData(width, height);
  for (let i = 0; i < mask.length; i++) {
    const a = mask[i];
    if (backdrop) {
      out.data[i * 4] = Math.round(backdrop[0] + (r - backdrop[0]) * a);
      out.data[i * 4 + 1] = Math.round(backdrop[1] + (g - backdrop[1]) * a);
      out.data[i * 4 + 2] = Math.round(backdrop[2] + (b - backdrop[2]) * a);
      out.data[i * 4 + 3] = 255;
    } else {
      out.data[i * 4] = r;
      out.data[i * 4 + 1] = g;
      out.data[i * 4 + 2] = b;
      out.data[i * 4 + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas.toBuffer('image/png');
}

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
// the brand as the app's dark theme wears it: the icon's own dark green would sink into the system's dark background
const BRAND_ON_DARK = [111, 174, 151];

const android = await leafMask(join(ANDROID_RES, 'ic_launcher_dev.png'));
writeFileSync(join(ANDROID_RES, 'ic_launcher_monochrome.png'), paint(android, WHITE));

const store = await leafMask(join(IOS_ASSETS, 'AppIcon.appiconset/AppIcon-512@2x.png'));
writeFileSync(join(IOS_ASSETS, 'AppIcon.appiconset/AppIcon-Dark.png'), paint(store, BRAND_ON_DARK));
writeFileSync(join(IOS_ASSETS, 'AppIcon.appiconset/AppIcon-Tinted.png'), paint(store, WHITE, BLACK));

const staging = await leafMask(join(IOS_ASSETS, 'AppIcon-Dev.appiconset/AppIcon-Dev-512@2x.png'));
writeFileSync(join(IOS_ASSETS, 'AppIcon-Dev.appiconset/AppIcon-Dev-Dark.png'), paint(staging, WHITE));
writeFileSync(join(IOS_ASSETS, 'AppIcon-Dev.appiconset/AppIcon-Dev-Tinted.png'), paint(staging, WHITE, BLACK));

console.log('themed icons written: 1 Android layer, 4 iOS variants');
