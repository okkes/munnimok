import { create } from 'zustand';

/** where a start stands while there is no app to show yet (#594); a module store: the boot runs outside React */
export type BootStep = { step: 'opening' } | { step: 'signin' } | { step: 'server' } | { step: 'spaces'; done: number; total: number; changes: number };

/** the Diagnose text's name for the step; spaces carry counts, so two reports a minute apart show whether it moves */
export const bootStepText = (at: BootStep): string => (at.step === 'spaces' ? `spaces ${at.done}/${at.total}, ${at.changes} changes` : at.step);

export const BOOT_STEPS = ['opening', 'signin', 'server', 'spaces'] as const;

export const useBootStep = create<{ at: BootStep; set: (at: BootStep) => void }>((set) => ({
  at: { step: 'opening' },
  set: (at) => set({ at }),
}));
