// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncStatus } from '@/sync/engine';
import { CARRY_WAIT_MS, useCarryGate, useCarryOver } from './carryGate';

function fakeEngine(status: SyncStatus, roundOk: boolean) {
  const listeners = new Set<(status: SyncStatus) => void>();
  const engine = {
    status,
    roundOk,
    getStatus: () => engine.status,
    lastRoundOk: () => engine.roundOk,
    onStatus: (listener: (status: SyncStatus) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: SyncStatus, ok: boolean) {
      engine.status = next;
      engine.roundOk = ok;
      for (const listener of listeners) listener(next);
    },
  };
  return engine;
}

describe('when the carry-over may run (#557)', () => {
  afterEach(() => vi.useRealTimers());

  it('an identity that never syncs carries at once', () => {
    expect(renderHook(() => useCarryGate(null, false)).result.current).toBe(true);
  });

  it('a session that has not finished a round, and a round in flight, are waited for — the round’s end lets it run', () => {
    const engine = fakeEngine('idle', false);
    const { result } = renderHook(() => useCarryGate(engine, false));
    expect(result.current).toBe(false);
    act(() => engine.set('syncing', false));
    expect(result.current).toBe(false);
    act(() => engine.set('idle', true));
    expect(result.current).toBe(true);
    // the next round is waited for as well: what it pulls may be this period's plan
    act(() => engine.set('syncing', false));
    expect(result.current).toBe(false);
  });

  it('a device that cannot reach the server carries at once', () => {
    const engine = fakeEngine('syncing', false);
    expect(renderHook(() => useCarryGate(engine, true)).result.current).toBe(true);
  });

  it('the plan carries over once per space and period; where this identity only reads, nothing is carried and nothing is waited for', async () => {
    const carry = vi.fn(async () => true);
    const own = { canEdit: true, continuable: true, carryKey: 'own:2026-03-01', synced: true, carry };
    const { result, rerender } = renderHook((props) => useCarryOver(props), { initialProps: own });
    expect(result.current).toBe(true);
    await waitFor(() => expect(carry).toHaveBeenCalledTimes(1));
    await act(async () => {
      await carry.mock.results[0].value;
    });
    // the plan arrived: nothing left to wait for
    rerender({ ...own, continuable: false });
    expect(result.current).toBe(false);

    // the same screen, now on a shared space this identity only reads, whose plan nobody carried over yet
    rerender({ ...own, canEdit: false, carryKey: 'shared:2026-03-01' });
    expect(result.current).toBe(false);
    expect(carry).toHaveBeenCalledTimes(1);
  });

  it('a carry-over that did nothing — the plan was made or started over elsewhere — gives the start screen back', async () => {
    const carry = vi.fn(async () => false);
    const { result } = renderHook(() => useCarryOver({ canEdit: true, continuable: true, carryKey: 'own:2026-03-01', synced: true, carry }));
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('while the round is waited for the screen already reads as carrying', () => {
    const carry = vi.fn(async () => true);
    const { result } = renderHook(() => useCarryOver({ canEdit: true, continuable: true, carryKey: 'own:2026-03-01', synced: false, carry }));
    expect(result.current).toBe(true);
    expect(carry).not.toHaveBeenCalled();
  });

  it('a round that does not come within the engine’s poll interval is not waited for any longer', () => {
    vi.useFakeTimers();
    const engine = fakeEngine('idle', false);
    const { result } = renderHook(() => useCarryGate(engine, false));
    act(() => {
      vi.advanceTimersByTime(CARRY_WAIT_MS - 1);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });
});
