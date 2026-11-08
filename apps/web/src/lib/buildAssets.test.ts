import { describe, expect, it } from 'vitest';
import { assetFileName } from './buildAssets';

describe('build asset names (#552)', () => {
  it('a module asset (.mjs) leaves as .js, so every host serves it as JavaScript; every other asset keeps its extension', () => {
    expect(assetFileName({ names: ['pdf.worker.min.mjs'] })).toBe('assets/[name]-[hash].js');
    expect(assetFileName({ names: ['logo.svg'] })).toBe('assets/[name]-[hash][extname]');
    expect(assetFileName({ names: ['index.css'] })).toBe('assets/[name]-[hash][extname]');
    expect(assetFileName({ names: [] })).toBe('assets/[name]-[hash][extname]');
  });
});
