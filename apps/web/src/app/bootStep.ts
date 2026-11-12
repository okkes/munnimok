import { create } from 'zustand';

/**
 * Where a start stands while there is no app to show yet (#594: a phone sat on "Connecting to your
 * account" with nothing to tell which wait it was). A module store: the boot runs outside React.
 */
export type BootStep = { step: 'opening' } | { step: 'signin' } | { step: 'server' } | { step: 'spaces'; done: number; total: number };

/** in the order a first start takes them */
export const BOOT_STEPS = ['opening', 'signin', 'server', 'spaces'] as const;

export const useBootStep = create<{ at: BootStep; set: (at: BootStep) => void }>((set) => ({
  at: { step: 'opening' },
  set: (at) => set({ at }),
}));
