import { useEffect, useReducer, useRef, useState } from 'react';
import type { SyncEngine } from '@/sync/engine';

// the engine's own poll interval: a round that has not come by then is not coming, and a late carry-over overwrites nothing
export const CARRY_WAIT_MS = 10_000;

type GateEngine = Pick<SyncEngine, 'getStatus' | 'lastRoundOk' | 'onStatus'>;

// another device's plan for the period may still be on its way: mid-round, or no round finished yet in this session
const pulling = (engine: GateEngine): boolean => {
  const status = engine.getStatus();
  return status === 'syncing' || (status === 'idle' && !engine.lastRoundOk());
};

/** an identity that never syncs and a device that cannot reach the server carry at once — the plan works offline;
 *  otherwise the round is waited for, so the plan shown is the one the other devices already work with */
export function useCarryGate(engine: GateEngine | null, unreachable: boolean): boolean {
  const [, statusChanged] = useReducer((n: number) => n + 1, 0);
  useEffect(() => engine?.onStatus(statusChanged), [engine]);
  const waiting = !!engine && !unreachable && pulling(engine);
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setGaveUp(true), CARRY_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  return !waiting || gaveUp;
}

/** runs the carry-over once per space and period, and says whether the screen is still waiting for its plan */
export function useCarryOver({
  canEdit,
  continuable,
  carryKey,
  synced,
  carry,
}: Readonly<{ canEdit: boolean; continuable: boolean; carryKey: string | null; synced: boolean; carry: () => Promise<boolean> }>): boolean {
  const carried = useRef<string | null>(null);
  // by space and period: the screen stays mounted across a space switch, and one space's run says nothing about another's
  const [gaveNothing, setGaveNothing] = useState<string | null>(null);
  useEffect(() => {
    // #505: the carry-over writes the plan — the devices of those who may write it carry it
    if (!canEdit || !continuable || !carryKey || !synced || carried.current === carryKey) return;
    carried.current = carryKey;
    carry()
      .then((done) => !done && setGaveNothing(carryKey))
      .catch(() => setGaveNothing(carryKey));
  }, [canEdit, continuable, carryKey, synced, carry]);
  // waiting for the round reads as carrying too: the start screen would invite a second plan beside the one on its way
  return canEdit && continuable && gaveNothing !== carryKey;
}
