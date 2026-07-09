// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSheetStackLock } from './useSheetStackLock';

describe('useSheetStackLock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('locks immediately when the child opens', () => {
    const { result, rerender } = renderHook(({ open }) => useSheetStackLock(open), {
      initialProps: { open: false },
    });
    expect(result.current).toBe(false);
    rerender({ open: true });
    expect(result.current).toBe(true);
  });

  it('holds the lock through the child close animation, then releases', () => {
    const { result, rerender } = renderHook(({ open }) => useSheetStackLock(open), {
      initialProps: { open: true },
    });
    rerender({ open: false });
    // still locked right after close — the closing tap must not dismiss the parent
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(400));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toBe(false);
  });

  it('re-opening during the release window keeps the lock', () => {
    const { result, rerender } = renderHook(({ open }) => useSheetStackLock(open), {
      initialProps: { open: true },
    });
    rerender({ open: false });
    act(() => vi.advanceTimersByTime(300));
    rerender({ open: true });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(true);
  });
});
