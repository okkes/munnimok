import { describe, expect, it } from 'vitest';
import { fitWithin, isDataImage } from './image';

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
