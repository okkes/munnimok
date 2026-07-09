import { describe, expect, it } from 'vitest';
import { balanceLastRow, primaryCatId, splitRemainderCents, splitsTotalCents, validateSplits } from './splits';

const split = (catId: string, amountCents: number) => ({ catId, amountCents });

describe('split math', () => {
  it('totals and remainder (works for negative expense amounts)', () => {
    expect(splitsTotalCents([])).toBe(0);
    expect(splitsTotalCents([split('a', 300), split('b', 700)])).toBe(1000);
    expect(splitRemainderCents(-1000, [split('a', 300)])).toBe(700);
    expect(splitRemainderCents(-1000, [split('a', 300), split('b', 900)])).toBe(-200); // over-assigned
    expect(splitRemainderCents(1000, [split('a', 1000)])).toBe(0); // income splits too
  });

  it('validates: needs 2+, positive, unique categories, exact balance', () => {
    expect(validateSplits(-1000, [split('a', 1000)])).toBe('tooFew');
    expect(validateSplits(-1000, [split('a', 1000), split('b', 0)])).toBe('emptyAmount');
    expect(validateSplits(-1000, [split('a', 500), split('a', 500)])).toBe('duplicateCategory');
    expect(validateSplits(-1000, [split('a', 500), split('b', 400)])).toBe('notBalanced');
    expect(validateSplits(-1000, [split('a', 500), split('b', 501)])).toBe('notBalanced');
    expect(validateSplits(-1000, [split('a', 500), split('b', 500)])).toBeNull();
    expect(validateSplits(-1000, [split('a', 1), split('b', 1), split('c', 998)])).toBeNull();
  });

  it('primary category is the largest slice', () => {
    expect(primaryCatId([])).toBeUndefined();
    expect(primaryCatId([split('small', 100), split('big', 900)])).toBe('big');
  });

  it('balanceLastRow fills exactly the open remainder, floored at zero', () => {
    expect(balanceLastRow(-1000, [split('a', 300), split('b', 0)])).toEqual([split('a', 300), split('b', 700)]);
    expect(balanceLastRow(-1000, [split('a', 1200), split('b', 500)])).toEqual([split('a', 1200), split('b', 0)]);
    expect(balanceLastRow(-1000, [])).toEqual([]);
    // a balanced result validates
    const balanced = balanceLastRow(-1000, [split('a', 250), split('b', 1)]);
    expect(validateSplits(-1000, balanced)).toBeNull();
  });
});
