import { create } from 'zustand';

/** #173: being kicked out of a space must not be a silent vanish; a module store, the engine has no React */
export interface EvictedInfo {
  spaceId: string;
  spaceName: string;
  /** #615: its owner deleted the space — nobody was taken out of it */
  deleted?: boolean;
  /** filled by the data provider when it had to switch the active space */
  switchedToName?: string;
}

interface EvictedState {
  evicted: EvictedInfo | null;
  report: (info: EvictedInfo) => void;
  markSwitched: (name: string) => void;
  clear: () => void;
}

export const useEvicted = create<EvictedState>((set) => ({
  evicted: null,
  report: (info) => set({ evicted: info }),
  markSwitched: (name) => set((s) => (s.evicted ? { evicted: { ...s.evicted, switchedToName: name } } : s)),
  clear: () => set({ evicted: null }),
}));

export const reportEviction = (info: EvictedInfo): void => useEvicted.getState().report(info);
