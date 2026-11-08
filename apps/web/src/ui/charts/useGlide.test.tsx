// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { glideAt, glideDuration, useGlide } from './useGlide';
// harness registers RTL cleanup between tests
import '@/test/harness';

/** frames on demand: each step hands the queued callback a clock `ms` later */
function manualFrames() {
  let queued: FrameRequestCallback | null = null;
  let clock = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
    queued = cb;
    return 1;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {
    queued = null;
  });
  return {
    step(ms: number) {
      clock += ms;
      const cb = queued;
      queued = null;
      act(() => cb?.(clock));
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('useGlide (#500: the dot travels to the tapped point)', () => {
  it('eases out from where it stands to where it goes, quick for a neighbour and capped for a long trip', () => {
    expect(glideAt(2, 6, 0)).toBe(2);
    expect(glideAt(2, 6, 1)).toBe(6);
    expect(glideAt(2, 6, 9)).toBe(6);
    // past halfway after half the time: it leaves fast and settles
    expect(glideAt(0, 10, 0.5)).toBeGreaterThan(5);
    expect(glideDuration(1)).toBeLessThan(glideDuration(5));
    expect(glideDuration(100)).toBe(glideDuration(1000));
  });

  it('moves frame by frame to a new target, turns mid-flight, and snaps while a finger drags', () => {
    vi.stubEnv('MODE', 'development');
    const frames = manualFrames();
    type Props = { target: number | null; snap?: boolean };
    const { result, rerender } = renderHook(({ target, snap }: Props) => useGlide(target, 0, snap), {
      initialProps: { target: 2 } as Props,
    });
    // the first render stands where it is meant to
    expect(result.current).toBe(2);
    rerender({ target: 6 });
    frames.step(0);
    expect(result.current).toBe(2);
    frames.step(100);
    const midway = result.current!;
    expect(midway).toBeGreaterThan(2);
    expect(midway).toBeLessThan(6);
    // a new target mid-flight starts from where the marker is
    rerender({ target: 0 });
    frames.step(0);
    expect(result.current).toBeCloseTo(midway, 10);
    frames.step(1_000);
    expect(result.current).toBe(0);
    // a drag follows directly
    rerender({ target: 5, snap: true });
    expect(result.current).toBe(5);
  });

  it('a marker that appears glides in from its origin; null takes it away; reduced motion and tests jump', () => {
    vi.stubEnv('MODE', 'development');
    const frames = manualFrames();
    const { result, rerender } = renderHook(({ target }: { target: number | null }) => useGlide(target, 9), { initialProps: { target: null as number | null } });
    expect(result.current).toBeNull();
    rerender({ target: 3 });
    frames.step(0);
    expect(result.current).toBe(9);
    frames.step(1_000);
    expect(result.current).toBe(3);
    rerender({ target: null });
    expect(result.current).toBeNull();

    vi.spyOn(globalThis, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    rerender({ target: 7 });
    expect(result.current).toBe(7);
    vi.stubEnv('MODE', 'test');
    rerender({ target: 1 });
    expect(result.current).toBe(1);
  });
});
