import { create } from 'zustand';

/**
 * Where a start stands while there is no app to show yet (#594: a phone sat on "Connecting to your
 * account" with nothing to tell which wait it was). A module store: the boot runs outside React.
 */
export type BootStep = { step: 'opening' } | { step: 'signin' } | { step: 'server' } | { step: 'spaces'; done: number; total: number; changes: number };

/** the step as the Diagnose text names it: for the spaces with the counts, so two reports a minute apart say whether it moves */
export const bootStepText = (at: BootStep): string => (at.step === 'spaces' ? `spaces ${at.done}/${at.total}, ${at.changes} changes` : at.step);

/** in the order a first start takes them */
export const BOOT_STEPS = ['opening', 'signin', 'server', 'spaces'] as const;

export const useBootStep = create<{ at: BootStep; set: (at: BootStep) => void }>((set) => ({
  at: { step: 'opening' },
  set: (at) => set({ at }),
}));
