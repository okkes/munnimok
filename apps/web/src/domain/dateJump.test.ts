import { describe, expect, it } from 'vitest';
import { nearestDateIndex } from './dateJump';

describe('nearestDateIndex (#502 jump to date)', () => {
  // newest first, the way the pickers list their rows
  const rows = [{ date: '2026-07-20' }, { date: '2026-07-08' }, { date: '2026-07-04' }, { date: '2026-06-30' }];

  it('lands on the closest day on either side of the target', () => {
    expect(nearestDateIndex(rows, '2026-07-07')).toBe(1);
    expect(nearestDateIndex(rows, '2026-07-05')).toBe(2);
    expect(nearestDateIndex(rows, '2026-07-04')).toBe(2);
    expect(nearestDateIndex(rows, '2026-12-31')).toBe(0);
    expect(nearestDateIndex(rows, '2025-01-01')).toBe(3);
  });

  it('between two rows equally far the one listed first wins; an empty list has no row', () => {
    expect(nearestDateIndex([{ date: '2026-07-08' }, { date: '2026-07-06' }], '2026-07-07')).toBe(0);
    expect(nearestDateIndex([], '2026-07-07')).toBe(-1);
  });
});
