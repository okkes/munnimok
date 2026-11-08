import { create } from 'zustand';
import type { OverviewKind } from '@/domain/overview';

/**
 * #530 (user): hide the sensitive figures while showing munni to someone —
 * the balances, what comes in and what is put aside read as stars. A device
 * preference, never synced: it is about THIS screen being watched (the app
 * lock that guards switching it off is per device too), and a demo on the
 * phone must not blank the numbers on the laptop. Stored like the theme and
 * the language — read synchronously, so the first paint never shows the
 * figures it should hide.
 */
const KEY = 'munni_hide_sensitive';

/** what a hidden figure reads — one width for every amount, so its length says nothing */
export const MASK = '*****';

/** the overview kinds that are private: what you earn, save and invest */
export const SENSITIVE_KINDS: ReadonlySet<OverviewKind> = new Set<OverviewKind>(['income', 'saving', 'investment']);

const readStored = (): boolean => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

interface HideSensitiveState {
  on: boolean;
  set: (on: boolean) => void;
}

export const useHideSensitive = create<HideSensitiveState>((set) => ({
  on: readStored(),
  set: (on) => {
    try {
      if (on) localStorage.setItem(KEY, '1');
      else localStorage.removeItem(KEY);
    } catch {
      // storage refused (private mode): the switch still holds for this session
    }
    set({ on });
  },
}));

// another tab of this device switched it
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === KEY || event.key === null) useHideSensitive.setState({ on: readStored() });
  });
}

/** the Home info button's door: Global settings brings the row into view and flashes it (read once) */
let focusPending = false;

export const setHideSensitiveFocusIntent = (): void => {
  focusPending = true;
};

export const takeHideSensitiveFocusIntent = (): boolean => {
  const take = focusPending;
  focusPending = false;
  return take;
};
