// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// harness registers RTL cleanup between tests
import '@/test/harness';

const mocks = vi.hoisted(() => ({ settleReviewed: vi.fn(() => Promise.resolve()), store: {} }));
vi.mock('@/app/data', () => ({ useData: () => ({ store: mocks.store }) }));
vi.mock('@/application/deliveredResolve', () => ({ settleReviewed: mocks.settleReviewed }));

import { useReviewedSettle } from './useReviewedSettle';

describe('useReviewedSettle (#614)', () => {
  afterEach(() => mocks.settleReviewed.mockClear());

  it('asks the phone to let go only on the step from some to none', () => {
    const { rerender } = renderHook(({ waiting }: { waiting: number | undefined }) => useReviewedSettle(waiting), {
      initialProps: { waiting: undefined as number | undefined },
    });
    // a list that is still loading, then an empty one: nothing was reviewed here
    rerender({ waiting: 0 });
    expect(mocks.settleReviewed).not.toHaveBeenCalled();

    rerender({ waiting: 3 });
    rerender({ waiting: 1 });
    expect(mocks.settleReviewed).not.toHaveBeenCalled();

    rerender({ waiting: 0 });
    expect(mocks.settleReviewed).toHaveBeenCalledTimes(1);
    expect(mocks.settleReviewed).toHaveBeenCalledWith(mocks.store);

    rerender({ waiting: 0 });
    expect(mocks.settleReviewed).toHaveBeenCalledTimes(1);
  });
});
